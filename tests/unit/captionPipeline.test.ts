import { describe, expect, it } from 'vitest';
import { CaptionPipeline, type CaptionView, type SegmentStatus } from '../../src/web/captionPipeline.js';
import type { TranslateFn, TranslateOutcome } from '../../src/web/translateClient.js';
import type { TranslationRequest } from '../../src/shared/contracts.js';

class FakeView implements CaptionView {
  readonly order: number[] = [];
  readonly text = new Map<number, string>();
  readonly status = new Map<number, SegmentStatus>();
  writesAfterFinal = 0;

  append(id: number): void {
    this.order.push(id);
    this.text.set(id, '');
    this.status.set(id, 'interim');
  }
  setText(id: number, text: string): void {
    if (this.status.get(id) === 'final') this.writesAfterFinal += 1;
    this.text.set(id, text);
  }
  setStatus(id: number, status: SegmentStatus): void {
    this.status.set(id, status);
  }
  remove(id: number): void {
    this.order.splice(this.order.indexOf(id), 1);
    this.text.delete(id);
    this.status.delete(id);
  }
  visible(): string[] {
    return this.order.map((id) => this.text.get(id) ?? '').filter((t) => t.length > 0);
  }
}

interface Call {
  req: TranslationRequest;
  signal: AbortSignal;
  onDelta: (t: string) => void;
  resolve: (o: TranslateOutcome) => void;
}

function scriptedTranslate() {
  const calls: Call[] = [];
  const fn: TranslateFn = (req, { signal, onDelta }) =>
    new Promise<TranslateOutcome>((resolve) => {
      calls.push({ req, signal, onDelta, resolve });
      signal.addEventListener('abort', () => resolve({ ok: false, reason: 'aborted' }));
    });
  return { calls, fn };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

/** Manual clock + timer queue so the TD-006 throttle can be driven deterministically. */
function manualClock() {
  let now = 0;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => now,
    schedule: (fn: () => void, ms: number) => {
      seq += 1;
      const id = seq;
      timers.set(id, { at: now + ms, fn });
      return () => {
        timers.delete(id);
      };
    },
    pending: () => timers.size,
    advance(ms: number) {
      now += ms;
      for (const [id, timer] of [...timers.entries()].sort((a, b) => a[1].at - b[1].at)) {
        if (timer.at <= now && timers.delete(id)) timer.fn();
      }
    },
  };
}

function setup() {
  const view = new FakeView();
  const t = scriptedTranslate();
  const clock = manualClock();
  let unavailable = 0;
  const sleeps: number[] = [];
  const pipeline = new CaptionPipeline({
    view,
    translate: t.fn,
    onTranslationUnavailable: () => {
      unavailable += 1;
    },
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    now: clock.now,
    schedule: clock.schedule,
  });
  const finals = () => t.calls.filter((c) => c.req.kind === 'final');
  const partials = () => t.calls.filter((c) => c.req.kind === 'partial');
  return { view, t, pipeline, sleeps, clock, finals, partials, unavailable: () => unavailable };
}

describe('CaptionPipeline', () => {
  it('creates a segment on recognizing and never displays source text', () => {
    const { view, pipeline } = setup();
    const epoch = pipeline.beginRun();
    pipeline.handleRecognizing(epoch, 'Good morning every', 'en-US');
    pipeline.handleRecognizing(epoch, 'Good morning everyone', 'en-US');
    expect(view.order).toEqual([1]);
    expect(view.visible()).toEqual([]);
  });

  it('translates the recognized text, streams deltas and freezes the final caption', async () => {
    const { view, pipeline, finals } = setup();
    const epoch = pipeline.beginRun();
    pipeline.handleRecognizing(epoch, 'Good morning', 'en-US');
    pipeline.handleRecognized(epoch, 'Good morning everyone.', 'en-US');
    expect(finals()).toHaveLength(1);
    expect(finals()[0]?.req).toEqual({ kind: 'final', text: 'Good morning everyone.', sourceLanguage: 'en-US' });
    finals()[0]?.onDelta('大家');
    expect(view.visible()).toEqual(['大家']);
    finals()[0]?.onDelta('早上好。');
    finals()[0]?.resolve({ ok: true });
    await flush();
    expect(view.visible()).toEqual(['大家早上好。']);
    expect(view.status.get(1)).toBe('final');
  });

  it('keeps speech order even when translations finish out of order', async () => {
    const { view, pipeline, finals } = setup();
    const epoch = pipeline.beginRun();
    pipeline.handleRecognized(epoch, 'First.', 'en-US');
    pipeline.handleRecognizing(epoch, 'Second', 'en-US');
    pipeline.handleRecognized(epoch, 'Second.', 'en-US');
    finals()[1]?.onDelta('第二');
    finals()[1]?.resolve({ ok: true });
    finals()[0]?.onDelta('第一');
    finals()[0]?.resolve({ ok: true });
    await flush();
    expect(view.visible()).toEqual(['第一', '第二']);
  });

  it('omits sourceLanguage when LID returned nothing usable', () => {
    const { pipeline, t } = setup();
    const epoch = pipeline.beginRun();
    pipeline.handleRecognized(epoch, 'Hello.', 'Unknown');
    expect(t.calls[0]?.req).toEqual({ kind: 'final', text: 'Hello.' });
  });

  it('removes segments for NoMatch / empty recognized results', () => {
    const { view, pipeline, finals, partials } = setup();
    const epoch = pipeline.beginRun();
    pipeline.handleRecognizing(epoch, 'uh', 'en-US');
    partials()[0]?.onDelta('呃');
    pipeline.handleRecognized(epoch, '   ', undefined);
    expect(view.order).toEqual([]);
    expect(finals()).toHaveLength(0);
    expect(partials()[0]?.signal.aborted).toBe(true);
  });

  it('retries a retryable failure once after clearing partial text', async () => {
    const { view, pipeline, t, sleeps } = setup();
    const epoch = pipeline.beginRun();
    pipeline.handleRecognized(epoch, 'Hello.', 'en-US');
    t.calls[0]?.onDelta('半');
    t.calls[0]?.resolve({ ok: false, reason: 'upstream_unavailable' });
    await flush();
    expect(sleeps).toEqual([1000]);
    expect(view.visible()).toEqual([]);
    expect(t.calls).toHaveLength(2);
    t.calls[1]?.onDelta('你好。');
    t.calls[1]?.resolve({ ok: true });
    await flush();
    expect(view.visible()).toEqual(['你好。']);
  });

  it('honours Retry-After (capped at 2s) for rate limited final requests', async () => {
    const { pipeline, t, sleeps } = setup();
    const epoch = pipeline.beginRun();
    pipeline.handleRecognized(epoch, 'Hello.', 'en-US');
    t.calls[0]?.resolve({ ok: false, reason: 'rate_limited', retryAfterSeconds: 30 });
    await flush();
    expect(sleeps).toEqual([2000]);
    expect(t.calls).toHaveLength(2);
  });

  it('drops a segment when the retry also fails and drops rejected content without retry', async () => {
    const { view, pipeline, t } = setup();
    const epoch = pipeline.beginRun();
    pipeline.handleRecognized(epoch, 'One.', 'en-US');
    t.calls[0]?.resolve({ ok: false, reason: 'timeout' });
    await flush();
    t.calls[1]?.resolve({ ok: false, reason: 'timeout' });
    await flush();
    expect(view.order).toEqual([]);

    pipeline.handleRecognized(epoch, 'Two.', 'en-US');
    t.calls[2]?.onDelta('不当');
    t.calls[2]?.resolve({ ok: false, reason: 'upstream_rejected' });
    await flush();
    expect(t.calls).toHaveLength(3);
    expect(view.order).toEqual([]);
  });

  it('reports the translation service unavailable after three consecutive failed segments', async () => {
    const { pipeline, t, unavailable } = setup();
    const epoch = pipeline.beginRun();
    for (let i = 0; i < 3; i += 1) {
      pipeline.handleRecognized(epoch, `S${i}.`, 'en-US');
      t.calls[t.calls.length - 1]?.resolve({ ok: false, reason: 'upstream_unavailable' });
      await flush();
      t.calls[t.calls.length - 1]?.resolve({ ok: false, reason: 'upstream_unavailable' });
      await flush();
    }
    expect(unavailable()).toBe(1);
  });

  it('resets the failure streak after a success', async () => {
    const { pipeline, t, unavailable } = setup();
    const epoch = pipeline.beginRun();
    const fail = async () => {
      pipeline.handleRecognized(epoch, 'x.', 'en-US');
      t.calls[t.calls.length - 1]?.resolve({ ok: false, reason: 'timeout' });
      await flush();
      t.calls[t.calls.length - 1]?.resolve({ ok: false, reason: 'timeout' });
      await flush();
    };
    await fail();
    await fail();
    pipeline.handleRecognized(epoch, 'ok.', 'en-US');
    t.calls[t.calls.length - 1]?.onDelta('好');
    t.calls[t.calls.length - 1]?.resolve({ ok: true });
    await flush();
    await fail();
    await fail();
    expect(unavailable()).toBe(0);
  });

  it('after endRun aborts in-flight work and ignores every late event', async () => {
    const { view, pipeline, t } = setup();
    const epoch = pipeline.beginRun();
    pipeline.handleRecognized(epoch, 'One.', 'en-US');
    t.calls[0]?.onDelta('第一');
    pipeline.handleRecognizing(epoch, 'Two', 'en-US');
    const callsBeforeStop = t.calls.length;
    pipeline.endRun();
    expect(t.calls.every((c) => c.signal.aborted)).toBe(true);
    const snapshot = view.visible();
    t.calls[0]?.onDelta('句');
    t.calls[1]?.onDelta('二');
    pipeline.handleRecognizing(epoch, 'Two more', 'en-US');
    pipeline.handleRecognized(epoch, 'Two more words.', 'en-US');
    await flush();
    expect(view.visible()).toEqual(snapshot);
    expect(t.calls).toHaveLength(callsBeforeStop);
    expect(view.order).toEqual([1, 2]);
  });

  it('marks leftover segments interrupted on restart and appends new ones after them', async () => {
    const { view, pipeline, finals } = setup();
    const first = pipeline.beginRun();
    pipeline.handleRecognized(first, 'One.', 'en-US');
    finals()[0]?.onDelta('第一');
    pipeline.handleRecognizing(first, 'Two', 'en-US');
    pipeline.endRun();
    await flush();

    const second = pipeline.beginRun();
    expect(second).not.toBe(first);
    expect(view.status.get(1)).toBe('interrupted');
    expect(view.status.get(2)).toBe('interrupted');
    pipeline.handleRecognized(second, 'Again.', 'en-US');
    finals()[1]?.onDelta('再次');
    finals()[1]?.resolve({ ok: true });
    await flush();
    expect(view.order).toEqual([1, 2, 3]);
    expect(view.visible()).toEqual(['第一', '再次']);
  });

  it('never rewrites a final caption', async () => {
    const { view, pipeline, t } = setup();
    const epoch = pipeline.beginRun();
    pipeline.handleRecognized(epoch, 'One.', 'en-US');
    t.calls[0]?.onDelta('第一');
    t.calls[0]?.resolve({ ok: true });
    await flush();
    t.calls[0]?.onDelta('改');
    expect(view.writesAfterFinal).toBe(0);
    expect(view.visible()).toEqual(['第一']);
  });
});

describe('CaptionPipeline interim translation (TD-006)', () => {
  it('sends the first partial immediately and shows its deltas directly as an interim caption', () => {
    const { view, pipeline, partials } = setup();
    const epoch = pipeline.beginRun();
    pipeline.handleRecognizing(epoch, 'Good morning', 'en-US');
    expect(partials()).toHaveLength(1);
    expect(partials()[0]?.req).toEqual({ kind: 'partial', text: 'Good morning', sourceLanguage: 'en-US' });
    partials()[0]?.onDelta('早');
    expect(view.visible()).toEqual(['早']);
    partials()[0]?.onDelta('上好');
    expect(view.visible()).toEqual(['早上好']);
    expect(view.status.get(1)).toBe('interim');
  });

  it('keeps a single partial in flight and resends the latest text once it completes after >= 500 ms', async () => {
    const { view, pipeline, partials, clock } = setup();
    const epoch = pipeline.beginRun();
    pipeline.handleRecognizing(epoch, 'Good', 'en-US');
    clock.advance(200);
    pipeline.handleRecognizing(epoch, 'Good morning', 'en-US');
    clock.advance(200);
    pipeline.handleRecognizing(epoch, 'Good morning every', 'en-US');
    clock.advance(200);
    pipeline.handleRecognizing(epoch, 'Good morning everyone', 'en-US');
    expect(partials()).toHaveLength(1);
    expect(partials()[0]?.signal.aborted).toBe(false);

    partials()[0]?.onDelta('好');
    partials()[0]?.resolve({ ok: true });
    await flush();
    expect(partials()).toHaveLength(2);
    expect(partials()[1]?.req.text).toBe('Good morning everyone');
    partials()[1]?.onDelta('大家早上好');
    expect(view.visible()).toEqual(['大家早上好']);
  });

  it('waits out the rest of the 500 ms interval when a partial completes early', async () => {
    const { pipeline, partials, clock } = setup();
    const epoch = pipeline.beginRun();
    pipeline.handleRecognizing(epoch, 'Good', 'en-US');
    clock.advance(100);
    pipeline.handleRecognizing(epoch, 'Good morning', 'en-US');
    partials()[0]?.resolve({ ok: true });
    await flush();
    expect(partials()).toHaveLength(1);
    clock.advance(399);
    expect(partials()).toHaveLength(1);
    clock.advance(1);
    expect(partials()).toHaveLength(2);
    expect(partials()[1]?.req.text).toBe('Good morning');
  });

  it('does not resend when the recognized text has not changed', async () => {
    const { pipeline, partials, clock } = setup();
    const epoch = pipeline.beginRun();
    pipeline.handleRecognizing(epoch, 'Good morning', 'en-US');
    clock.advance(600);
    pipeline.handleRecognizing(epoch, 'Good morning', 'en-US');
    partials()[0]?.onDelta('早上好');
    partials()[0]?.resolve({ ok: true });
    await flush();
    clock.advance(1000);
    expect(partials()).toHaveLength(1);
  });

  it('does not let a shorter newer partial overwrite a longer caption until its stream ends', async () => {
    const { view, pipeline, partials, clock } = setup();
    const epoch = pipeline.beginRun();
    pipeline.handleRecognizing(epoch, 'We will review', 'en-US');
    partials()[0]?.onDelta('我们将审查');
    clock.advance(600);
    pipeline.handleRecognizing(epoch, 'We will review the budget', 'en-US');
    partials()[0]?.resolve({ ok: true });
    await flush();
    partials()[1]?.onDelta('我们');
    expect(view.visible()).toEqual(['我们将审查']);
    partials()[1]?.onDelta('将审查预算');
    expect(view.visible()).toEqual(['我们将审查预算']);

    clock.advance(600);
    pipeline.handleRecognizing(epoch, 'We will review it', 'en-US');
    partials()[1]?.resolve({ ok: true });
    await flush();
    partials()[2]?.onDelta('审查');
    expect(view.visible()).toEqual(['我们将审查预算']);
    partials()[2]?.resolve({ ok: true });
    await flush();
    expect(view.visible()).toEqual(['审查']);
  });

  it('ignores partial failures and rate limits: keeps the caption, no error stop, retries on the next tick', async () => {
    const { view, pipeline, partials, clock, unavailable, sleeps } = setup();
    const epoch = pipeline.beginRun();
    pipeline.handleRecognizing(epoch, 'Hello', 'en-US');
    partials()[0]?.onDelta('你好');
    partials()[0]?.resolve({ ok: true });
    await flush();
    for (let i = 0; i < 4; i += 1) {
      clock.advance(600);
      pipeline.handleRecognizing(epoch, `Hello there ${i}`, 'en-US');
      const last = partials()[partials().length - 1];
      last?.resolve(i % 2 === 0 ? { ok: false, reason: 'rate_limited', retryAfterSeconds: 1 } : { ok: false, reason: 'network' });
      await flush();
    }
    expect(view.visible()).toEqual(['你好']);
    expect(view.order).toEqual([1]);
    expect(unavailable()).toBe(0);
    expect(sleeps).toEqual([]);
    const sent = partials().length;
    clock.advance(600);
    expect(partials()).toHaveLength(sent + 1);
    expect(partials()[sent]?.req.text).toBe('Hello there 3');
  });

  it('on recognized aborts the in-flight partial, cancels the throttle timer and lets the final replace the text', async () => {
    const { view, pipeline, partials, finals, clock } = setup();
    const epoch = pipeline.beginRun();
    pipeline.handleRecognizing(epoch, 'Good', 'en-US');
    partials()[0]?.onDelta('好的');
    clock.advance(100);
    pipeline.handleRecognizing(epoch, 'Good morning', 'en-US');
    pipeline.handleRecognized(epoch, 'Good morning everyone.', 'en-US');
    expect(partials()[0]?.signal.aborted).toBe(true);
    expect(view.status.get(1)).toBe('finalizing');
    expect(view.visible()).toEqual(['好的']);
    partials()[0]?.onDelta('迟到');
    expect(view.visible()).toEqual(['好的']);
    clock.advance(2000);
    expect(partials()).toHaveLength(1);
    finals()[0]?.onDelta('大家早上好。');
    expect(view.visible()).toEqual(['大家早上好。']);
    finals()[0]?.resolve({ ok: true });
    await flush();
    expect(view.status.get(1)).toBe('final');
  });

  it('removes a displayed interim caption when its final translation fails', async () => {
    const { view, pipeline, partials, finals } = setup();
    const epoch = pipeline.beginRun();
    pipeline.handleRecognizing(epoch, 'Hello', 'en-US');
    partials()[0]?.onDelta('你好');
    pipeline.handleRecognized(epoch, 'Hello.', 'en-US');
    finals()[0]?.resolve({ ok: false, reason: 'upstream_rejected' });
    await flush();
    expect(view.order).toEqual([]);
  });

  it('starts throttling afresh for the next segment and stops all partial timers on endRun', async () => {
    const { pipeline, partials, clock } = setup();
    const epoch = pipeline.beginRun();
    pipeline.handleRecognizing(epoch, 'One', 'en-US');
    pipeline.handleRecognized(epoch, 'One.', 'en-US');
    pipeline.handleRecognizing(epoch, 'Two', 'en-US');
    expect(partials()).toHaveLength(2);
    clock.advance(100);
    pipeline.handleRecognizing(epoch, 'Two words', 'en-US');
    partials()[1]?.resolve({ ok: true });
    await flush();
    expect(clock.pending()).toBe(1);
    pipeline.endRun();
    expect(clock.pending()).toBe(0);
    clock.advance(1000);
    expect(partials()).toHaveLength(2);
  });
});
