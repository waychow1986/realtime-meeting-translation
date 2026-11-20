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

function setup() {
  const view = new FakeView();
  const t = scriptedTranslate();
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
  });
  return { view, t, pipeline, sleeps, unavailable: () => unavailable };
}

describe('CaptionPipeline', () => {
  it('creates a segment on recognizing without displaying source text', () => {
    const { view, pipeline, t } = setup();
    const epoch = pipeline.beginRun();
    pipeline.handleRecognizing(epoch, 'Good morning every', 'en-US');
    pipeline.handleRecognizing(epoch, 'Good morning everyone', 'en-US');
    expect(view.order).toEqual([1]);
    expect(view.visible()).toEqual([]);
    expect(t.calls).toHaveLength(0);
  });

  it('translates the recognized text, streams deltas and freezes the final caption', async () => {
    const { view, pipeline, t } = setup();
    const epoch = pipeline.beginRun();
    pipeline.handleRecognizing(epoch, 'Good morning', 'en-US');
    pipeline.handleRecognized(epoch, 'Good morning everyone.', 'en-US');
    expect(t.calls[0]?.req).toEqual({ kind: 'final', text: 'Good morning everyone.', sourceLanguage: 'en-US' });
    t.calls[0]?.onDelta('大家');
    expect(view.visible()).toEqual(['大家']);
    t.calls[0]?.onDelta('早上好。');
    t.calls[0]?.resolve({ ok: true });
    await flush();
    expect(view.visible()).toEqual(['大家早上好。']);
    expect(view.status.get(1)).toBe('final');
  });

  it('keeps speech order even when translations finish out of order', async () => {
    const { view, pipeline, t } = setup();
    const epoch = pipeline.beginRun();
    pipeline.handleRecognized(epoch, 'First.', 'en-US');
    pipeline.handleRecognizing(epoch, 'Second', 'en-US');
    pipeline.handleRecognized(epoch, 'Second.', 'en-US');
    t.calls[1]?.onDelta('第二');
    t.calls[1]?.resolve({ ok: true });
    t.calls[0]?.onDelta('第一');
    t.calls[0]?.resolve({ ok: true });
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
    const { view, pipeline, t } = setup();
    const epoch = pipeline.beginRun();
    pipeline.handleRecognizing(epoch, 'uh', 'en-US');
    pipeline.handleRecognized(epoch, '   ', undefined);
    expect(view.order).toEqual([]);
    expect(t.calls).toHaveLength(0);
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
    pipeline.endRun();
    expect(t.calls[0]?.signal.aborted).toBe(true);
    const snapshot = view.visible();
    t.calls[0]?.onDelta('句');
    pipeline.handleRecognizing(epoch, 'Two more', 'en-US');
    pipeline.handleRecognized(epoch, 'Two more words.', 'en-US');
    await flush();
    expect(view.visible()).toEqual(snapshot);
    expect(t.calls).toHaveLength(1);
    expect(view.order).toEqual([1, 2]);
  });

  it('marks leftover segments interrupted on restart and appends new ones after them', async () => {
    const { view, pipeline, t } = setup();
    const first = pipeline.beginRun();
    pipeline.handleRecognized(first, 'One.', 'en-US');
    t.calls[0]?.onDelta('第一');
    pipeline.handleRecognizing(first, 'Two', 'en-US');
    pipeline.endRun();
    await flush();

    const second = pipeline.beginRun();
    expect(second).not.toBe(first);
    expect(view.status.get(1)).toBe('interrupted');
    expect(view.status.get(2)).toBe('interrupted');
    pipeline.handleRecognized(second, 'Again.', 'en-US');
    t.calls[1]?.onDelta('再次');
    t.calls[1]?.resolve({ ok: true });
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
