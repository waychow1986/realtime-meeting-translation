import type { Request, Response } from '@playwright/test';
import { SecretScanner } from '../support/secretScan.js';
import { ensureSpeechAudio, sentencesOf } from '../support/tts.js';
import {
  NOT_RUNNING,
  RUNNING,
  captionTexts,
  expect,
  hanCount,
  latinWordCount,
  startButton,
  statusText,
  stopButton,
  test,
  waitForFinalCaptions,
  waitUntilAudioOffset,
} from './fixtures.js';

test.use({ audioSet: 'multi' });

const LANGUAGE_WORDS = /语言|Language|英语|日语|English|中文\s*\(|Chinese/i;
/** Chinese anchors per sentence of the `multi` fixture, in spoken order. */
const ANCHORS = [/早上好|早安|大家好/, /销售/, /(12|十二)\s*%|百分之十二/];

function words(text: string): string[] {
  return text.toLowerCase().match(/[a-z']+/g) ?? [];
}

function windows<T>(items: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let i = 0; i + size <= items.length; i += 1) result.push(items.slice(i, i + size));
  return result;
}

async function assertNoLanguageControls(page: import('@playwright/test').Page): Promise<void> {
  for (const role of ['combobox', 'listbox'] as const) await expect(page.getByRole(role)).toHaveCount(0);
  // The only radio groups are input source, caption size and caption spacing (FR-101, FR-132, feature 008); none selects a language.
  await expect(
    page.locator('input[type="radio"]:not([name="input-source"]):not([name="caption-size"]):not([name="caption-spacing"])'),
  ).toHaveCount(0);
  await expect(page.locator('select, input[type="password"]')).toHaveCount(0);
  const controlTexts = await page.locator('button, a, label, [role="button"]').allInnerTexts();
  for (const text of controlTexts) expect(text).not.toMatch(LANGUAGE_WORDS);
}

test('IQA-001/003/007/008/009 打开即用：自动识别英语并逐句显示中文字幕，浏览器无长期凭据，服务端日志无客户内容', async ({
  harness,
  server,
}) => {
  const { page, frames } = harness;
  const scanner = new SecretScanner();
  const navigations: string[] = [];
  const scans: Promise<void>[] = [];
  const scanRequest = (request: Request) => {
    scanner.scan(`request ${request.url()}`, `${request.url()}\n${JSON.stringify(request.headers())}\n${request.postData() ?? ''}`);
  };
  const scanResponse = (response: Response) => {
    scans.push(
      (async () => {
        scanner.scan(`response-headers ${response.url()}`, JSON.stringify(await response.allHeaders()));
        const body = await response.body().catch(() => undefined);
        scanner.scan(`response-body ${response.url()}`, body);
      })(),
    );
  };
  page.on('request', scanRequest);
  page.on('response', scanResponse);
  page.on('framenavigated', (frame) => navigations.push(frame.url()));

  await page.goto('/');

  // IQA-001: Chinese UI, no install/login requirement, no language selection.
  await expect(page).toHaveTitle(/[\p{Script=Han}]/u);
  await expect(startButton(page)).toBeVisible();
  await expect(stopButton(page)).toBeDisabled();
  await expect(statusText(page)).toHaveText(NOT_RUNNING);
  const uiText = await page.locator('body').innerText();
  expect(hanCount(uiText)).toBeGreaterThan(latinWordCount(uiText));
  expect(uiText).not.toMatch(/安装|下载客户端|扩展程序|插件/);
  await assertNoLanguageControls(page);

  await startButton(page).click();
  await expect(statusText(page)).toHaveText(RUNNING, { timeout: 10_000 });
  await expect(stopButton(page)).toBeEnabled();

  // IQA-003: three spoken English sentences become exactly three Chinese captions in order, with no further
  // interaction. Counted after the trailing silence but before the looping WAV replays its first sentence.
  await waitForFinalCaptions(page, 3);
  await waitUntilAudioOffset(page, (await ensureSpeechAudio('multi')).durationMs);
  const finals = (await captionTexts(page, 'final')).filter((text) => text.trim());
  expect(finals).toHaveLength(3);
  expect([...(await captionTexts(page, 'interim')), ...(await captionTexts(page, 'finalizing'))]).toEqual([]);
  ANCHORS.forEach((anchor, index) => {
    expect(finals.flatMap((text, i) => (anchor.test(text) ? [i] : []))).toEqual([index]);
  });
  for (const text of finals) expect(hanCount(text)).toBeGreaterThan(latinWordCount(text));
  await assertNoLanguageControls(page);

  // Source English text is never rendered.
  const pageText = await page.locator('body').innerText();
  for (const sentence of sentencesOf('multi')) {
    for (const window of windows(words(sentence), 4)) expect(pageText.toLowerCase()).not.toContain(window.join(' '));
  }

  await stopButton(page).click();
  await expect(statusText(page)).toHaveText(NOT_RUNNING, { timeout: 3_000 });
  for (const url of navigations) expect(new URL(url).host).toBe(new URL(server.baseURL).host);

  // IQA-007: the browser talks to the real Azure speech service with streaming hypotheses and language detection.
  const speechFrames = frames.filter((frame) => /\.speech\.microsoft\.com$/.test(new URL(frame.url).hostname));
  expect(speechFrames.length).toBeGreaterThan(0);
  const receivedText = speechFrames
    .filter((frame) => frame.direction === 'received' && typeof frame.payload === 'string')
    .map((frame) => frame.payload as string)
    .join('\n');
  expect(receivedText).toMatch(/speech\.hypothesis/i);
  const sentText = speechFrames
    .filter((frame) => frame.direction === 'sent')
    .map((frame) => (typeof frame.payload === 'string' ? frame.payload : frame.payload.subarray(0, 4096).toString('latin1')))
    .join('\n');
  expect(`${sentText}\n${receivedText}`).toMatch(/languageId|LanguageDetection|PrimaryLanguage|lidEnabled/);

  // IQA-008: no long-lived credential anywhere the browser can see.
  await Promise.all(scans);
  scanner.scan('dom', await page.content());
  scanner.scan('storage', JSON.stringify(await harness.context.storageState()));
  scanner.scan(
    'web-storage',
    await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } })),
  );
  for (const frame of frames) {
    const payload = typeof frame.payload === 'string' ? frame.payload : frame.payload.subarray(0, 4096);
    scanner.scan(`ws-${frame.direction} ${frame.url}`, payload);
  }
  expect(scanner.scannedItems).toBeGreaterThan(10);
  expect(scanner.hits.map((hit) => `${hit.rule} @ ${hit.location}`)).toEqual([]);

  // IQA-009: server logs contain neither the spoken text nor the captions nor credentials.
  const log = await server.readLog();
  expect(log).toContain('"event":"translation_completed"');
  const logLower = log.toLowerCase();
  for (const sentence of sentencesOf('multi')) {
    for (const window of windows(words(sentence), 5)) expect(logLower).not.toContain(window.join(' '));
  }
  for (const caption of await captionTexts(page)) {
    for (const window of windows([...caption.replace(/\s+/g, '')], 8)) expect(log).not.toContain(window.join(''));
  }
  const logScanner = new SecretScanner();
  logScanner.scan('server-log', log);
  expect(logScanner.hits).toEqual([]);
});
