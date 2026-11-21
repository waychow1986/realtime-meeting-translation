import { isChineseTranslation } from '../../src/shared/chineseText.js';
import { ensureSpeechAudio, sentencesOf, type SentenceSetName } from '../support/tts.js';
import {
  captionEntries,
  captionTexts,
  captionTimeline,
  expect,
  startSystemAudio,
  stopButton,
  test,
  waitForFinalCaptions,
} from './fixtures.js';

/**
 * IQA-301 / IQA-302 (AC-1, AC-2, AC-3, AC-6): Korean and Japanese drama material played through 系统声音 against
 * the real dev speech and chat-model services, three independent runs each (fresh browser context, retries 0).
 * Japanese source text is detected by kana (an all-Han untranslated Japanese sentence cannot be told from Chinese;
 * accepted limitation). The first Korean run also opens the caption window and compares it with the main page.
 */

const LEAD_IN_MS = 6_000;
const SOURCE_SCRIPT: Record<'ko-drama' | 'ja-drama', RegExp> = {
  'ko-drama': /\p{Script=Hangul}/u,
  'ja-drama': /[\p{Script=Hiragana}\p{Script=Katakana}]/u,
};

type PipRow = [string, string, string, string];

for (const set of ['ko-drama', 'ja-drama'] as const satisfies readonly SentenceSetName[]) {
  const language = set === 'ko-drama' ? '韩语' : '日语';
  test.describe(`${language}素材：定稿字幕全部是中文（系统声音，真实服务）`, () => {
    test.use({ audioSet: set });

    for (const run of [1, 2, 3]) {
      const withPip = set === 'ko-drama' && run === 1;
      test(`${set === 'ko-drama' ? 'IQA-301' : 'IQA-302'} 第 ${run} 次运行${withPip ? '（小窗打开）' : ''}：每条定稿是中文、无提示，任何时刻不出现${set === 'ko-drama' ? '谚文' : '假名'}或原句`, async ({
        harness,
      }) => {
        test.setTimeout(180_000);
        const { page } = harness;
        const sentences = sentencesOf(set);
        const audio = await ensureSpeechAudio(set);
        const source = SOURCE_SCRIPT[set];

        const zero = await startSystemAudio(harness, set, LEAD_IN_MS);
        let pipOpenedAt = 0;
        if (withPip) {
          await page.locator('#pip-button').click();
          await expect.poll(() => page.evaluate<boolean>('!!documentPictureInPicture.window')).toBe(true);
          pipOpenedAt = Date.now();
        }
        await waitForFinalCaptions(page, sentences.length, 120_000);
        const remaining = zero + audio.durationMs - 1_000 - Date.now();
        if (remaining > 0) await page.waitForTimeout(remaining);
        const timeline = await captionTimeline(page);
        const finals = (await captionTexts(page, 'final')).filter((text) => text.trim());
        const pending = [...(await captionTexts(page, 'interim')), ...(await captionTexts(page, 'finalizing'))];
        const samples = withPip
          ? await page.evaluate<{ at: number; main: PipRow[]; pip: PipRow[] }[]>('window.__rtmt.pip.samples.slice()')
          : [];
        await stopButton(page).click();

        // Counts only in the assertion messages (no caption content in the report).
        expect(finals.length, 'final caption count').toBe(sentences.length);
        expect(finals.filter((text) => !isChineseTranslation(text)).length, 'non-Chinese finals').toBe(0);
        expect(timeline.filter((event) => event.kind === 'notice').length, 'notices').toBe(0);
        expect(timeline.filter((event) => source.test(event.text)).length, 'events with source script').toBe(0);
        expect(timeline.filter((event) => sentences.includes(event.text.trim())).length, 'events equal to a source sentence').toBe(0);
        expect(captionEntries(timeline)).toHaveLength(sentences.length);
        expect(pending.filter((text) => text.trim())).toEqual([]);

        if (withPip) {
          const open = samples.filter((sample) => sample.at >= pipOpenedAt);
          expect(open.length).toBeGreaterThan(0);
          let mismatches = 0;
          for (const sample of open) if (JSON.stringify(sample.pip) !== JSON.stringify(sample.main)) mismatches += 1;
          expect(mismatches, 'caption window samples differing from the main page').toBe(0);
          const rows = open[open.length - 1]!.pip.filter((row) => row[2].trim());
          expect(rows.filter((row) => row[1] === 'final' && isChineseTranslation(row[2]) && !row[3]).length).toBe(
            sentences.length,
          );
          expect(open.some((sample) => sample.pip.some((row) => source.test(row[2])))).toBe(false);
        }
      });
    }
  });
}
