import type { Page } from '@playwright/test';
import { isChineseTranslation } from '../../src/shared/chineseText.js';
import { ensureSpeechAudio, sentencesOf, type SentenceSetName } from '../support/tts.js';
import {
  RUNNING,
  STATUS_LOG,
  UNTRANSLATED_NOTICE,
  captionEntries,
  captionTexts,
  captionTimeline,
  captureStartedAt,
  expect,
  startButton,
  startSystemAudio,
  statusLog,
  statusText,
  stopButton,
  test,
  waitForFinalCaptions,
  type CaptionEvent,
  type Harness,
} from './fixtures.js';
import { overrideTranslations, translationCalls, type OverrideRule, type TranslationCall } from './translationOverride.js';

/**
 * Controlled non-Chinese model output (TD-310): selected `/api/translations` responses are replaced in the page
 * by a Hangul stream, everything else uses the real dev services. IQA-303/304 (AC-4), IQA-305/307 (AC-5/AC-6),
 * IQA-306 (AC-12) and IQA-312 (stop during a retranslation).
 */

const HANGUL = /\p{Script=Hangul}/u;
const LEAD_IN_MS = 6_000;
type Input = 'system' | 'microphone';

/** Starts the run with the given input and returns the epoch ms of material time zero. */
async function start(harness: Harness, input: Input, set: SentenceSetName): Promise<number> {
  const { page } = harness;
  if (input === 'system') return startSystemAudio(harness, set, LEAD_IN_MS);
  await page.goto('/');
  await startButton(page).click();
  await expect(statusText(page)).toHaveText(RUNNING, { timeout: 15_000 });
  return captureStartedAt(page);
}

/** Waits until the material has been played completely (the fake microphone loops: stop before the replay). */
async function waitForMaterialEnd(page: Page, zero: number, durationMs: number): Promise<void> {
  const remaining = zero + durationMs - Date.now();
  if (remaining > 0) await page.waitForTimeout(remaining);
}

/** No caption ever showed Hangul or one of the spoken sentences (AC-4 / AC-12 core assertion). */
function expectNeverNonChinese(timeline: CaptionEvent[], sentences: string[]): void {
  const offending = timeline.filter((event) => HANGUL.test(event.text) || sentences.includes(event.text.trim()));
  expect(offending.map((event) => ({ index: event.index, status: event.status, hangul: HANGUL.test(event.text) }))).toEqual([]);
}

function finalCalls(calls: TranslationCall[], sentence: number): TranslationCall[] {
  return calls.filter((call) => call.kind === 'final' && call.sentence === sentence);
}

for (const input of ['system', 'microphone'] as const) {
  test.describe(`定稿非中文 → 重译得到中文（${input === 'system' ? '系统声音' : '麦克风'}）`, () => {
    test.use({ audioSet: 'ko-drama' });

    test(`IQA-${input === 'system' ? '303' : '304'} 第 2 句首次定稿返回谚文：字幕从不出现谚文，句末到定稿保持临时译文，恰一次重译后中文定稿`, async ({
      harness,
    }) => {
      test.setTimeout(180_000);
      const { page, context } = harness;
      const sentences = sentencesOf('ko-drama');
      const audio = await ensureSpeechAudio('ko-drama');
      await overrideTranslations(context, [{ kind: 'final', sentence: 2, attempt: 'first', action: 'hangul' }]);

      const zero = await start(harness, input, 'ko-drama');
      await waitForFinalCaptions(page, sentences.length, 120_000);
      await waitForMaterialEnd(page, zero, audio.durationMs - 1_000);
      const timeline = await captionTimeline(page);
      const calls = await translationCalls(page);
      const pending = [...(await captionTexts(page, 'interim')), ...(await captionTexts(page, 'finalizing'))];
      await stopButton(page).click();

      // The override really hit sentence 2's first final request.
      const second = finalCalls(calls, 2);
      expect(second[0]?.overridden).toBe('hangul');
      expect(second[0]?.retranslate).toBe(false);

      expectNeverNonChinese(timeline, sentences);

      const entries = captionEntries(timeline);
      expect(entries).toHaveLength(sentences.length);
      const events = entries[1]!;
      // From the end of the sentence until the final: the interim translation shown at the sentence end, unchanged.
      const finalizingAt = events.findIndex((event) => event.status === 'finalizing');
      const finalAt = events.findIndex((event) => event.status === 'final');
      expect(finalizingAt).toBeGreaterThanOrEqual(0);
      expect(finalAt).toBeGreaterThan(finalizingAt);
      const held = events[finalizingAt]!.text;
      expect(held.trim()).not.toBe('');
      expect(isChineseTranslation(held)).toBe(true);
      for (const event of events.slice(finalizingAt, finalAt)) expect(event.text).toBe(held);

      // Exactly one retranslation, then a Chinese final without notice.
      expect(second.filter((call) => call.retranslate)).toHaveLength(1);
      const last = events[events.length - 1]!;
      expect(last.status).toBe('final');
      expect(last.kind).toBe('');
      expect(isChineseTranslation(last.text)).toBe(true);

      // Every other sentence: one first final request, no retranslation; all finals Chinese, nothing pending.
      const finals = (await captionTexts(page, 'final')).filter((text) => text.trim());
      expect(finals).toHaveLength(sentences.length);
      for (const text of finals) expect(isChineseTranslation(text)).toBe(true);
      expect(pending).toEqual([]);
    });
  });
}

type PipRow = [string, string, string, string];
interface PipSample {
  at: number;
  main: PipRow[];
  pip: PipRow[];
}

interface CaptionStyle {
  color: string;
  fontSize: number;
  fontStyle: string;
  borderLeft: string;
  animationName: string;
  transitionDuration: string;
  background: string;
}

/** Computed style of the first notice and of the first normal final caption, in the main page or the caption window. */
function captionStyles(page: Page, where: 'main' | 'pip'): Promise<{ notice: CaptionStyle; normal: CaptionStyle }> {
  return page.evaluate<{ notice: CaptionStyle; normal: CaptionStyle }>(`(() => {
    const win = ${where === 'pip' ? 'documentPictureInPicture.window' : 'window'};
    const list = win.document.getElementById(${where === 'pip' ? "'pip-captions'" : "'captions'"});
    const opaque = (el) => {
      for (let node = el; node; node = node.parentElement) {
        const bg = win.getComputedStyle(node).backgroundColor;
        const m = bg.match(/rgba?\\(([^)]+)\\)/);
        if (m) { const parts = m[1].split(',').map(Number); if (parts.length === 3 || parts[3] === 1) return bg; }
      }
      return 'rgb(255, 255, 255)';
    };
    const describe = (li) => {
      const s = win.getComputedStyle(li);
      return {
        color: s.color, fontSize: parseFloat(s.fontSize), fontStyle: s.fontStyle,
        borderLeft: s.borderLeftWidth + ' ' + s.borderLeftStyle + ' ' + s.borderLeftColor,
        animationName: s.animationName, transitionDuration: s.transitionDuration, background: opaque(li),
      };
    };
    const items = [...list.querySelectorAll('li.caption')];
    return {
      notice: describe(items.find((li) => li.dataset.kind === 'notice')),
      normal: describe(items.find((li) => li.dataset.status === 'final' && !li.dataset.kind && li.textContent.trim())),
    };
  })()`);
}

function rgb(color: string): [number, number, number] {
  const [r, g, b] = color.match(/[\d.]+/g)!.map(Number);
  return [r!, g!, b!];
}

function luminance(color: string): number {
  const [r, g, b] = rgb(color).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

function hue(color: string): number {
  const [r, g, b] = rgb(color).map((v) => v / 255);
  const max = Math.max(r!, g!, b!);
  const min = Math.min(r!, g!, b!);
  if (max === min) return 0;
  const d = max - min;
  const h = max === r ? ((g! - b!) / d) % 6 : max === g ? (b! - r!) / d + 2 : (r! - g!) / d + 4;
  return (h * 60 + 360) % 360;
}

function expectNoticeStyle(style: { notice: CaptionStyle; normal: CaptionStyle }): void {
  const { notice, normal } = style;
  expect(notice.color).toBe('rgb(201, 180, 143)');
  expect(notice.color).not.toBe(normal.color);
  // Not in the red family (hue 345°–15°).
  const h = hue(notice.color);
  expect(h > 15 && h < 345).toBe(true);
  expect(notice.fontSize).toBeCloseTo(normal.fontSize * 0.75, 1);
  expect(notice.fontStyle).toBe('normal');
  expect(notice.borderLeft).toBe('4px solid rgb(201, 180, 143)');
  expect(contrast(notice.color, notice.background)).toBeGreaterThanOrEqual(4.5);
  expect(notice.animationName).toBe('none');
  expect(notice.transitionDuration.split(',').every((d) => parseFloat(d) === 0)).toBe(true);
}

test.describe('重译仍非中文 → 中文提示，翻译继续（麦克风，小窗打开）', () => {
  test.use({ audioSet: 'ko-drama' });

  test('IQA-305/IQA-307 第 2～4 句首次与重译都返回谚文：三句显示中文提示、样式区分不刺眼、随字号变化，翻译不中断，小窗逐条一致', async ({
    harness,
  }) => {
    test.setTimeout(180_000);
    const { page, context } = harness;
    const sentences = sentencesOf('ko-drama');
    const audio = await ensureSpeechAudio('ko-drama');
    const rules: OverrideRule[] = [2, 3, 4].flatMap((sentence) => [
      { kind: 'final' as const, sentence, attempt: 'first' as const, action: 'hangul' as const },
      { kind: 'final' as const, sentence, attempt: 'retranslate' as const, action: 'hangul' as const },
    ]);
    await overrideTranslations(context, rules);
    await context.addInitScript({ content: STATUS_LOG });

    // Microphone input: the system-audio player tab needs Playwright routing in this context, which keeps the
    // caption window's stylesheet from applying, and this case asserts the window's computed styles.
    const zero = await start(harness, 'microphone', 'ko-drama');
    await page.locator('#pip-button').click();
    await expect.poll(() => page.evaluate<boolean>('!!documentPictureInPicture.window')).toBe(true);
    const pipOpenedAt = Date.now();
    await expect
      .poll(() =>
        page.evaluate<boolean>(
          `[...documentPictureInPicture.window.document.styleSheets].some((s) => (s.href || '').endsWith('/styles.css') && s.cssRules.length > 0)`,
        ),
      )
      .toBe(true);

    await waitForFinalCaptions(page, sentences.length, 120_000);
    await waitForMaterialEnd(page, zero, audio.durationMs - 1_000);
    const timeline = await captionTimeline(page);
    const calls = await translationCalls(page);
    const samples = await page.evaluate<PipSample[]>('window.__rtmt.pip.samples.slice()');

    // Style in both views at the default size, then the notice follows every caption size.
    expectNoticeStyle(await captionStyles(page, 'main'));
    expectNoticeStyle(await captionStyles(page, 'pip'));
    for (const [label, px] of [['小', 24], ['中', 32], ['大', 40], ['特大', 52]] as const) {
      await page.getByRole('radio', { name: label, exact: true }).check();
      await expect.poll(async () => (await captionStyles(page, 'main')).normal.fontSize).toBe(px);
      const main = await captionStyles(page, 'main');
      expect(main.notice.fontSize).toBeCloseTo(px * 0.75, 1);
      await expect.poll(async () => (await captionStyles(page, 'pip')).notice.fontSize).toBeCloseTo(px * 0.75, 1);
    }
    const log = await statusLog(page);
    await stopButton(page).click();

    for (const sentence of [2, 3, 4]) {
      const own = finalCalls(calls, sentence);
      expect(own.filter((call) => !call.retranslate)).toHaveLength(1);
      expect(own.filter((call) => call.retranslate)).toHaveLength(1);
      expect(own.every((call) => call.overridden === 'hangul')).toBe(true);
    }
    expectNeverNonChinese(timeline, sentences);

    const entries = captionEntries(timeline);
    expect(entries).toHaveLength(sentences.length);
    entries.forEach((events, i) => {
      const last = events[events.length - 1]!;
      expect(last.status).toBe('final');
      if (i >= 1 && i <= 3) {
        expect(last.kind).toBe('notice');
        expect(last.text).toBe(UNTRANSLATED_NOTICE);
        // Only the notice: no other final text was ever shown for this sentence.
        expect(events.filter((event) => event.status === 'final')).toHaveLength(1);
      } else {
        expect(last.kind).toBe('');
        expect(isChineseTranslation(last.text)).toBe(true);
      }
    });

    // The run continued: always 正在听, never 翻译已中断 (notices are not counted as failures).
    const running = log.slice(log.findIndex((entry) => RUNNING.test(entry.status)));
    expect(running.length).toBeGreaterThan(0);
    for (const entry of running) {
      expect(entry.status).toMatch(RUNNING);
      expect(entry.notice).not.toContain('翻译已中断');
    }

    // Caption window: every sample identical to the main page, including data-kind; it showed the notices too.
    const open = samples.filter((sample) => sample.at >= pipOpenedAt);
    expect(open.length).toBeGreaterThan(0);
    for (const sample of open) expect(sample.pip).toEqual(sample.main);
    const lastRows = open[open.length - 1]!.pip.filter((row) => row[2].trim());
    expect(lastRows.filter((row) => row[3] === 'notice').map((row) => row[2])).toEqual([
      UNTRANSLATED_NOTICE,
      UNTRANSLATED_NOTICE,
      UNTRANSLATED_NOTICE,
    ]);
    for (const row of lastRows) expect(HANGUL.test(row[2])).toBe(false);
  });
});

for (const input of ['system', 'microphone'] as const) {
  test.describe(`临时译文非中文（${input === 'system' ? '系统声音' : '麦克风'}）`, () => {
    test.use({ audioSet: 'long' });

    test('IQA-306 长句中第 3 个临时翻译返回谚文：不显示、保留上一条临时译文、不重译不提示，最终中文定稿', async ({ harness }) => {
      test.setTimeout(180_000);
      const { page, context } = harness;
      const sentences = sentencesOf('long');
      const audio = await ensureSpeechAudio('long');
      await overrideTranslations(context, [{ kind: 'partial', nth: 3, action: 'hangul' }]);

      const zero = await start(harness, input, 'long');
      await waitForFinalCaptions(page, sentences.length, 120_000);
      await waitForMaterialEnd(page, zero, audio.durationMs - 1_000);
      const timeline = await captionTimeline(page);
      const calls = await translationCalls(page);
      await stopButton(page).click();

      const third = calls.find((call) => call.partialNth === 3);
      expect(third?.overridden).toBe('hangul');
      // The overridden response can affect the page only once its first delta arrived. The previous response is
      // rendered in the same task that sends the overridden request, so its caption change may be recorded a few
      // milliseconds after `third.at`; it is part of "before", not a change caused by the overridden response.
      const from = third!.firstDeltaAt;
      expect(from).not.toBeNull();
      expect(from!).toBeGreaterThanOrEqual(third!.at);
      // A Chinese interim translation was already shown before the overridden response.
      const before = timeline.filter((event) => event.at < from! && event.status === 'interim' && event.text.trim());
      expect(before.length).toBeGreaterThan(0);
      expect(isChineseTranslation(before[before.length - 1]!.text)).toBe(true);
      // Until the next translation request the interim caption did not change (kept the previous one).
      const next = calls.find((call) => call.at > third!.at);
      const until = next?.at ?? Number.POSITIVE_INFINITY;
      expect(timeline.filter((event) => event.at >= from! && event.at < until && event.status === 'interim')).toEqual([]);

      expectNeverNonChinese(timeline, sentences);
      expect(calls.filter((call) => call.retranslate)).toEqual([]);
      expect(timeline.filter((event) => event.kind === 'notice')).toEqual([]);
      const finals = (await captionTexts(page, 'final')).filter((text) => text.trim());
      expect(finals).toHaveLength(sentences.length);
      for (const text of finals) expect(isChineseTranslation(text)).toBe(true);
    });
  });
}

test.describe('停止发生在重译期间（系统声音）', () => {
  test.use({ audioSet: 'ko-drama' });

  test('IQA-312 第 1 句首次定稿返回谚文、重译延迟 20 s，重译完成前停止：该句保持停止时的临时译文，不定稿、不提示、不出现非中文', async ({
    harness,
  }) => {
    test.setTimeout(180_000);
    const { page, context } = harness;
    const sentences = sentencesOf('ko-drama');
    await overrideTranslations(context, [
      { kind: 'final', sentence: 1, attempt: 'first', action: 'hangul' },
      { kind: 'final', sentence: 1, attempt: 'retranslate', action: 'delay', delayMs: 20_000 },
    ]);

    await startSystemAudio(harness, 'ko-drama', LEAD_IN_MS);
    await expect
      .poll(async () => finalCalls(await translationCalls(page), 1).some((call) => call.retranslate), { timeout: 60_000 })
      .toBe(true);
    const beforeStop = captionEntries(await captionTimeline(page))[0]!;
    const held = beforeStop[beforeStop.length - 1]!;
    await stopButton(page).click();
    const stoppedAt = Date.now();
    await page.waitForTimeout(30_000);

    const timeline = await captionTimeline(page);
    const entry = captionEntries(timeline)[0]!;
    expect(held.status).toBe('finalizing');
    expect(held.text.trim()).not.toBe('');
    expect(isChineseTranslation(held.text)).toBe(true);
    expect(entry.filter((event) => event.at > stoppedAt)).toEqual([]);
    const last = entry[entry.length - 1]!;
    expect(last.text).toBe(held.text);
    expect(last.kind).toBe('');
    expect(entry.some((event) => event.status === 'final')).toBe(false);
    expectNeverNonChinese(timeline, sentences);
  });
});
