import { annotationsOf, ensureSpeechAudio, sentencesOf } from '../support/tts.js';
import {
  RUNNING,
  captionTexts,
  captionTimeline,
  captureStartedAt,
  expect,
  hanRatio,
  startButton,
  statusText,
  stopButton,
  test,
  waitForFinalCaptions,
  waitUntilAudioOffset,
} from './fixtures.js';

test.use({ audioSet: 'meeting' });

/** Latin spellings the reference translation may legitimately keep (names, quarter abbreviations). */
const ALLOWED_LATIN = /Michael|Q3/gi;

function words(text: string): string[] {
  return text.toLowerCase().match(/[a-z']+/g) ?? [];
}

function occurrences(texts: string[], pattern: RegExp): number[] {
  return texts.flatMap((text, index) => (pattern.test(text) ? [index] : []));
}

test('IQA-002/004/005 六句会议发言：句中流式更新中文字幕，定稿与含义一致，按顺序不重不漏', async ({ harness }) => {
  const { page } = harness;
  const audio = await ensureSpeechAudio('meeting');
  const annotations = annotationsOf('meeting');
  const sentences = sentencesOf('meeting');
  expect(audio.timings).toHaveLength(sentences.length);
  const s1 = audio.timings[0]!;
  expect(s1.endMs - s1.startMs).toBeGreaterThanOrEqual(8_000);

  const partialRequests: number[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && /"kind"\s*:\s*"partial"/.test(request.postData() ?? '')) partialRequests.push(Date.now());
  });

  await page.goto('/');
  await startButton(page).click();
  await expect(statusText(page)).toHaveText(RUNNING, { timeout: 10_000 });
  const t0 = await captureStartedAt(page);

  // AC-05: wait for all six finals, then let the trailing silence pass (but stop before the looping WAV replays).
  await waitForFinalCaptions(page, sentences.length, 120_000);
  await waitUntilAudioOffset(page, audio.durationMs);
  const finals = (await captionTexts(page, 'final')).filter((text) => text.trim());
  const pending = [...(await captionTexts(page, 'interim')), ...(await captionTexts(page, 'finalizing'))];
  const timeline = await captionTimeline(page);
  await stopButton(page).click();

  // IQA-002 (AC-02): the first caption appears and keeps changing while S1 is still being spoken.
  const s1End = t0 + s1.endMs;
  const firstCaption = timeline.filter((event) => event.index === 0 && event.text.trim());
  expect(firstCaption.length).toBeGreaterThan(0);
  expect(firstCaption[0]!.at).toBeLessThan(s1End);
  const textsDuringS1 = new Set(firstCaption.filter((event) => event.at < s1End).map((event) => event.text));
  expect(textsDuringS1.size).toBeGreaterThanOrEqual(2);
  expect(partialRequests.filter((at) => at < s1End).length).toBeGreaterThanOrEqual(1);

  // IQA-005 (AC-05): exactly one final caption per sentence, in order, nothing left half-way.
  expect(pending).toEqual([]);
  expect(finals).toHaveLength(sentences.length);
  annotations.forEach((annotation, index) => {
    expect(occurrences(finals, new RegExp(annotation.anchor, 'i'))).toEqual([index]);
  });
  // A final caption never changes after it was marked final.
  const finalIndexes = new Set(timeline.filter((event) => event.status === 'final').map((event) => event.index));
  for (const index of finalIndexes) {
    const events = timeline.filter((event) => event.index === index);
    const firstFinal = events.findIndex((event) => event.status === 'final');
    expect(new Set(events.slice(firstFinal).map((event) => event.text)).size).toBe(1);
  }

  // IQA-004 (AC-04): every final is Chinese and carries all key points of the reference translation.
  annotations.forEach((annotation, index) => {
    const caption = finals[index]!;
    expect(hanRatio(caption.replace(ALLOWED_LATIN, ''))).toBeGreaterThanOrEqual(0.7);
    for (const keyPoint of annotation.keyPoints) expect(caption).toMatch(new RegExp(keyPoint, 'i'));
  });
  const pageText = (await page.locator('body').innerText()).toLowerCase();
  for (const sentence of sentences) {
    const sentenceWords = words(sentence);
    for (let i = 0; i + 4 <= sentenceWords.length; i += 1) {
      expect(pageText).not.toContain(sentenceWords.slice(i, i + 4).join(' '));
    }
  }
});
