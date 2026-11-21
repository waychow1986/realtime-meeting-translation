import { spawnSync } from 'node:child_process';
import { firefox, type Page } from '@playwright/test';
import { playMaterial, playerState, type PlayerState } from '../support/player.js';
import { SecretScanner } from '../support/secretScan.js';
import { annotationsOf, ensureSpeechAudio, sentencesOf } from '../support/tts.js';
import {
  ERROR,
  INSTRUMENTATION,
  NOT_RUNNING,
  RUNNING,
  SEEN_GUIDE,
  captionTexts,
  captionTimeline,
  displayTracks,
  expect,
  selectSource,
  startButton,
  statusText,
  stopButton,
  test,
  trackStates,
  waitForFinalCaptions,
} from './fixtures.js';

/**
 * System audio input (AC-01~08, AC-10): the real Chromium share picker auto-selects the material player tab by its
 * ASCII title (TD-108); cancel and "no audio" go through the real picker as well (TD-109).
 */

/** Chinese anchors per sentence of the `multi` fixture, in spoken order (same as captions.spec.ts). */
const MULTI_ANCHORS = [/早上好|早安|大家好/, /销售/, /(12|十二)\s*%|百分之十二/];
/** Silence prepended to the player material so playback already runs before the share starts. */
const LEAD_IN_MS = 6_000;
const QUIET_PERIOD_MS = 31_000;
/**
 * The project config emulates the Windows "Desktop Chrome" user agent; platform-specific texts are checked
 * against the real platform the browser runs on (Linux), whose capture behaviour IQA-102 measures.
 */
const LINUX_CHROME_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/159.0.0.0 Safari/537.36';

function words(text: string): string[] {
  return text.toLowerCase().match(/[a-z']+/g) ?? [];
}

function windows<T>(items: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let i = 0; i + size <= items.length; i += 1) result.push(items.slice(i, i + size));
  return result;
}

interface LogLine {
  event?: string;
  inputSource?: string;
  sourceLanguage?: string;
  reasoningTokens?: number;
  errorCode?: string;
}

function logLines(log: string): LogLine[] {
  return log
    .split('\n')
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line) as LogLine);
}

function notice(page: Page) {
  return page.locator('#notice');
}

async function sourceRadiosDisabled(page: Page): Promise<boolean[]> {
  return [
    await page.locator('#source-microphone').isDisabled(),
    await page.locator('#source-system').isDisabled(),
  ];
}

async function nonEmptyCaptions(page: Page): Promise<string[]> {
  return (await captionTexts(page)).filter((text) => text.trim());
}

test.describe('系统声音：主流程', () => {
  // The fake microphone plays the interference set the whole time: it must never reach the captions (AC-03).
  test.use({ audioSet: 'interference' });

  test('IQA-102/117/104/105/114/112/115/116 共享播放中的标签页：只翻译该标签页的声音，原声照常播放，不使用画面', async ({
    harness,
    server,
  }) => {
    test.setTimeout(240_000);
    const { page, context, frames } = harness;
    const audio = await ensureSpeechAudio('multi');
    const contentTypes: string[] = [];
    const downloads: string[] = [];
    const scanner = new SecretScanner();
    const scans: Promise<void>[] = [];
    context.on('response', (response) => {
      scans.push(
        (async () => {
          const headers = await response.allHeaders();
          contentTypes.push(headers['content-type'] ?? '');
          scanner.scan(`response-headers ${response.url()}`, JSON.stringify(headers));
          if (!response.url().endsWith('.wav')) scanner.scan(`response-body ${response.url()}`, await response.body().catch(() => undefined));
        })(),
      );
    });
    context.on('request', (request) =>
      scanner.scan(`request ${request.url()}`, `${request.url()}\n${JSON.stringify(request.headers())}\n${request.postData() ?? ''}`),
    );
    context.on('page', (opened) => opened.on('download', (download) => downloads.push(download.suggestedFilename())));
    page.on('download', (download) => downloads.push(download.suggestedFilename()));

    await page.goto('/');
    const player = await harness.openPlayer('multi', LEAD_IN_MS);
    const playingAt = await playMaterial(player);
    const materialZero = playingAt + LEAD_IN_MS;
    const states: PlayerState[] = [await playerState(player)];

    await selectSource(page, '系统声音');
    await expect(page.locator('#system-panel')).toBeVisible();
    await startButton(page).click();
    await expect(statusText(page)).toHaveText(RUNNING, { timeout: 15_000 });
    expect(Date.now()).toBeLessThan(materialZero + audio.timings[0]!.startMs);

    // The share is the player tab's audio only; the microphone is never opened.
    const shared = await displayTracks(page);
    expect(shared.displayCalls).toBe(1);
    expect(shared.gumCalls).toBe(0);
    const audioTracks = shared.tracks.filter((track) => track.kind === 'audio');
    expect(audioTracks).toHaveLength(1);
    expect(audioTracks[0]!.label).toBe('Tab audio');
    expect(audioTracks[0]!.readyState).toBe('live');
    // A-03 (TD-116): local playback is not suppressed, the player keeps playing unchanged.
    expect(audioTracks[0]!.suppressLocalAudioPlayback).toBe(false);
    await page.waitForTimeout(2_000);
    states.push(await playerState(player));

    // AC-02/AC-05: one final caption per sentence of the shared material, in order.
    await waitForFinalCaptions(page, 3, 120_000);
    // Sampled within the trailing silence, while the material is still playing.
    states.push(await playerState(player));
    const untilEnd = materialZero + audio.durationMs - 500 - Date.now();
    if (untilEnd > 0) await page.waitForTimeout(untilEnd);
    const beforeStop = await displayTracks(page);
    expect(beforeStop.tracks.find((track) => track.kind === 'audio')!.suppressLocalAudioPlayback).toBe(false);
    const finals = (await captionTexts(page, 'final')).filter((text) => text.trim());
    const pending = [...(await captionTexts(page, 'interim')), ...(await captionTexts(page, 'finalizing'))];
    await stopButton(page).click();
    await expect(statusText(page)).toHaveText(NOT_RUNNING, { timeout: 3_000 });

    expect(pending).toEqual([]);
    expect(finals).toHaveLength(3);
    MULTI_ANCHORS.forEach((anchor, index) => {
      expect(finals.flatMap((text, i) => (anchor.test(text) ? [i] : []))).toEqual([index]);
    });
    // AC-03: nothing of the microphone/ambient interference shows up.
    const allCaptions = (await captionTexts(page)).join('\n');
    for (const annotation of annotationsOf('interference')) {
      for (const keyPoint of annotation.keyPoints) expect(allCaptions).not.toMatch(new RegExp(keyPoint, 'i'));
    }

    // A-03: the player was never muted, its volume never changed and it kept playing.
    for (const state of states) {
      expect(state.muted).toBe(false);
      expect(state.volume).toBe(states[0]!.volume);
      expect(state.paused).toBe(false);
    }
    expect(states[1]!.currentTime).toBeGreaterThan(states[0]!.currentTime);
    expect(states[2]!.currentTime).toBeGreaterThan(states[1]!.currentTime);

    // Video frames are never used: no image/video content anywhere, no video/canvas elements.
    await Promise.all(scans);
    for (const type of contentTypes) expect(type).not.toMatch(/^(image|video)\//i);
    for (const frame of frames) {
      if (typeof frame.payload === 'string') expect(frame.payload).not.toMatch(/content-type:\s*(image|video)\//i);
    }
    await expect(page.locator('video, canvas')).toHaveCount(0);

    // IQA-112: no extra window, no download, nothing to install.
    expect(context.pages()).toHaveLength(2);
    expect(harness.browser.contexts()).toHaveLength(1);
    expect(downloads).toEqual([]);

    // IQA-104/105/114: language detected automatically, translation logged with the input source.
    const completed = logLines(await server.readLog()).filter(
      (line) => line.event === 'translation_completed' && line.inputSource === 'system' && !line.errorCode,
    );
    expect(completed.length).toBeGreaterThanOrEqual(3);
    for (const line of completed) {
      expect(line.sourceLanguage).toBe('en-US');
      expect(line.reasoningTokens).toBe(0);
    }

    // IQA-115: no credential reaches the browser in system mode either.
    scanner.scan('dom', await page.content());
    for (const frame of frames) {
      scanner.scan(`ws-${frame.direction}`, typeof frame.payload === 'string' ? frame.payload : frame.payload.subarray(0, 4096));
    }
    expect(scanner.hits.map((hit) => `${hit.rule} @ ${hit.location}`)).toEqual([]);

    // IQA-116: the server log carries neither the spoken text nor the captions.
    const log = await server.readLog();
    const logLower = log.toLowerCase();
    for (const sentence of [...sentencesOf('multi'), ...sentencesOf('interference')]) {
      for (const window of windows(words(sentence), 5)) expect(logLower).not.toContain(window.join(' '));
    }
    for (const caption of await captionTexts(page)) {
      for (const window of windows([...caption.replace(/\s+/g, '')], 8)) expect(log).not.toContain(window.join(''));
    }
    const logScanner = new SecretScanner();
    logScanner.scan('server-log', log);
    expect(logScanner.hits).toEqual([]);
  });

  test('IQA-103 系统声音流式时序：长句播放完之前就出现中文字幕并持续更新，句末替换为定稿', async ({ harness }) => {
    test.setTimeout(180_000);
    const { page } = harness;
    const audio = await ensureSpeechAudio('long');
    const sentence = audio.timings[0]!;
    expect(sentence.endMs - sentence.startMs).toBeGreaterThanOrEqual(8_000);
    const partialRequests: number[] = [];
    page.on('request', (request) => {
      if (request.method() === 'POST' && /"kind"\s*:\s*"partial"/.test(request.postData() ?? '')) partialRequests.push(Date.now());
    });

    await page.goto('/');
    const player = await harness.openPlayer('long', LEAD_IN_MS);
    const materialZero = (await playMaterial(player)) + LEAD_IN_MS;
    await selectSource(page, '系统声音');
    await startButton(page).click();
    await expect(statusText(page)).toHaveText(RUNNING, { timeout: 15_000 });
    expect(Date.now()).toBeLessThan(materialZero + sentence.startMs);

    // Computed style of the streaming caption, sampled while it is still being updated.
    const interim = page.locator('#captions li.caption[data-status="interim"]').first();
    await expect(interim).not.toBeEmpty({ timeout: materialZero + sentence.endMs - Date.now() });
    const styleOf = (status: string) =>
      page.evaluate<string>(
        `(() => { const s = getComputedStyle(document.querySelector('#captions li.caption[data-status="${status}"]')); return [s.color, s.fontStyle, s.borderLeftStyle].join('|'); })()`,
      );
    const interimStyle = await styleOf('interim');

    await waitForFinalCaptions(page, 1, 60_000);
    const finalStyle = await styleOf('final');
    const timeline = await captionTimeline(page);
    await stopButton(page).click();
    await expect(statusText(page)).toHaveText(NOT_RUNNING, { timeout: 3_000 });

    const sentenceEnd = materialZero + sentence.endMs;
    const first = timeline.filter((event) => event.index === 0 && event.text.trim());
    expect(first.length).toBeGreaterThan(0);
    expect(first[0]!.at).toBeLessThan(sentenceEnd);
    const textsBeforeEnd = new Set(first.filter((event) => event.at < sentenceEnd).map((event) => event.text));
    expect(textsBeforeEnd.size).toBeGreaterThanOrEqual(2);
    expect(partialRequests.filter((at) => at < sentenceEnd).length).toBeGreaterThanOrEqual(1);
    const firstFinal = first.find((event) => event.status === 'final');
    expect(firstFinal).toBeDefined();
    expect(firstFinal!.at).toBeGreaterThanOrEqual(first[0]!.at);
    expect((await captionTexts(page, 'final')).join('')).toMatch(/预算/);
    expect(interimStyle).not.toBe(finalStyle);
  });
});

test.describe('系统声音：选择、停止与共享结束', () => {
  test.use({ audioSet: 'multi', userAgent: LINUX_CHROME_UA });

  test('IQA-101/108 默认麦克风；两种输入各只取对应来源；运行中不可切换；说明与支持列表可见', async ({ harness }) => {
    const { page } = harness;
    await page.goto('/');
    await expect(page.locator('#source-microphone')).toBeChecked();
    await expect(page.locator('#system-panel')).toBeHidden();

    // IQA-108: help and support matrix appear with the system choice.
    await selectSource(page, '系统声音');
    await expect(page.locator('#system-help')).toBeVisible();
    await expect(page.locator('#support-matrix')).toBeVisible();
    await expect(page.locator('#system-unsupported')).toBeHidden();
    const rows = await page.locator('#support-matrix tbody tr').allInnerTexts();
    for (const browser of [/Windows.*Chrome.*Edge/, /macOS.*Chrome.*Edge/, /Linux.*Chrome.*Edge/, /Firefox/, /Safari/]) {
      expect(rows.some((row) => browser.test(row))).toBe(true);
    }
    const linux = page.locator('#support-matrix tbody tr', { hasText: 'Linux · Chrome' });
    await expect(linux).toContainText('只有该标签页的声音');
    await expect(linux).toHaveAttribute('data-current', 'true');

    // System audio: only getDisplayMedia, never the microphone.
    await harness.openPlayer('single', 2_000);
    await startButton(page).click();
    await expect(statusText(page)).toHaveText(RUNNING, { timeout: 15_000 });
    expect(await sourceRadiosDisabled(page)).toEqual([true, true]);
    const system = await displayTracks(page);
    expect(system.displayCalls).toBe(1);
    expect(system.gumCalls).toBe(0);
    await stopButton(page).click();
    await expect(statusText(page)).toHaveText(NOT_RUNNING, { timeout: 3_000 });
    expect(await sourceRadiosDisabled(page)).toEqual([false, false]);

    // Reload: back to the microphone default, which only uses getUserMedia.
    await page.reload();
    await expect(page.locator('#source-microphone')).toBeChecked();
    await expect(page.locator('#system-panel')).toBeHidden();
    await startButton(page).click();
    await expect(statusText(page)).toHaveText(RUNNING, { timeout: 10_000 });
    expect(await sourceRadiosDisabled(page)).toEqual([true, true]);
    const microphone = await displayTracks(page);
    expect(microphone.displayCalls).toBe(0);
    expect(microphone.gumCalls).toBe(1);
    await stopButton(page).click();
    await expect(statusText(page)).toHaveText(NOT_RUNNING, { timeout: 3_000 });
  });

  test('IQA-106 句中点停止：共享立即结束、字幕不再变化；之后可改用麦克风，再选系统声音会重新共享', async ({ harness }) => {
    test.setTimeout(240_000);
    const { page, frames } = harness;
    await page.goto('/');
    const player = await harness.openPlayer('multi', LEAD_IN_MS);
    await playMaterial(player);
    await selectSource(page, '系统声音');
    await startButton(page).click();
    await expect(statusText(page)).toHaveText(RUNNING, { timeout: 15_000 });

    await waitForFinalCaptions(page, 1, 90_000);
    await page.waitForTimeout(1_500);
    await stopButton(page).click();
    const stoppedAt = Date.now();
    await expect.poll(async () => (await displayTracks(page)).tracks.map((track) => track.readyState), { timeout: 2_000 }).not.toContain('live');
    const { tracks, displayCalls } = await displayTracks(page);
    expect(tracks.length).toBeGreaterThan(0);
    expect(tracks.every((track) => track.readyState === 'ended')).toBe(true);
    await expect(statusText(page)).toHaveText(NOT_RUNNING);
    await expect(notice(page)).toBeHidden();

    await page.waitForTimeout(1_000);
    const snapshot = await captionTexts(page);
    await page.waitForTimeout(QUIET_PERIOD_MS);
    expect(await captionTexts(page)).toEqual(snapshot);
    const lateFrames = frames.filter((frame) => frame.direction === 'sent' && frame.at > stoppedAt + 2_000 && frame.bytes > 1024);
    expect(lateFrames).toHaveLength(0);

    // Switching to the microphone works and appends captions.
    const preserved = snapshot.filter((text) => text.trim());
    await selectSource(page, '麦克风');
    await startButton(page).click();
    await expect(statusText(page)).toHaveText(RUNNING, { timeout: 10_000 });
    await expect.poll(async () => (await nonEmptyCaptions(page)).length, { timeout: 60_000 }).toBeGreaterThan(preserved.length);
    await stopButton(page).click();
    await expect(statusText(page)).toHaveText(NOT_RUNNING, { timeout: 3_000 });
    expect((await trackStates(page)).states.every((state) => state === 'ended')).toBe(true);

    // Choosing system audio again asks for a new share.
    await selectSource(page, '系统声音');
    await startButton(page).click();
    await expect(statusText(page)).toHaveText(RUNNING, { timeout: 15_000 });
    expect((await displayTracks(page)).displayCalls).toBe(displayCalls + 1);
    await stopButton(page).click();
    await expect(statusText(page)).toHaveText(NOT_RUNNING, { timeout: 3_000 });
  });

  test('IQA-107 关闭被共享的标签页：翻译自动停止并提示共享已结束；重新共享可继续', async ({ harness }) => {
    test.setTimeout(240_000);
    const { page } = harness;
    await page.goto('/');
    const player = await harness.openPlayer('multi', LEAD_IN_MS);
    await playMaterial(player);
    await selectSource(page, '系统声音');
    await startButton(page).click();
    await expect(statusText(page)).toHaveText(RUNNING, { timeout: 15_000 });
    await waitForFinalCaptions(page, 1, 90_000);

    await player.close();
    await expect(statusText(page)).toHaveText(NOT_RUNNING, { timeout: 5_000 });
    await expect(notice(page)).toBeVisible();
    await expect(notice(page)).toContainText('共享已结束');
    const { tracks } = await displayTracks(page);
    expect(tracks.every((track) => track.readyState === 'ended')).toBe(true);
    await expect(stopButton(page)).toBeDisabled();
    await expect(startButton(page)).toBeEnabled();

    await page.waitForTimeout(1_000);
    const snapshot = await captionTexts(page);
    await page.waitForTimeout(QUIET_PERIOD_MS);
    expect(await captionTexts(page)).toEqual(snapshot);

    // Open the material again and share it: captions continue after the preserved ones.
    const preserved = snapshot.filter((text) => text.trim());
    const again = await harness.openPlayer('multi', LEAD_IN_MS);
    await playMaterial(again);
    await startButton(page).click();
    await expect(statusText(page)).toHaveText(RUNNING, { timeout: 15_000 });
    await expect(notice(page)).toBeHidden();
    await expect.poll(async () => (await nonEmptyCaptions(page)).length, { timeout: 90_000 }).toBeGreaterThan(preserved.length);
    expect((await nonEmptyCaptions(page)).slice(0, preserved.length)).toEqual(preserved);
    await stopButton(page).click();
    await expect(statusText(page)).toHaveText(NOT_RUNNING, { timeout: 3_000 });
  });
});

test.describe('系统声音：取消共享', () => {
  // No tab carries this title, so the real share picker stays open until it is dismissed.
  test.use({ shareTabTitle: 'RTMT-no-such-tab' });

  test('IQA-110 在共享弹窗中取消：显示出错与取消说明，不出字幕、不留采集', async ({ harness }) => {
    const { page } = harness;
    await page.goto('/');
    await harness.openPlayer('multi');
    await selectSource(page, '系统声音');
    await startButton(page).click();
    await page.waitForTimeout(1_500);
    const key = spawnSync('python3', ['-I', 'tests/support/xkey.py', 'Escape'], { encoding: 'utf8', timeout: 10_000 });
    expect(key.status, key.stderr).toBe(0);

    await expect(statusText(page)).toHaveText(ERROR, { timeout: 10_000 });
    await expect(notice(page)).toContainText('没有选择共享内容');
    const { displayCalls, gumCalls, tracks } = await displayTracks(page);
    expect(displayCalls).toBe(1);
    expect(gumCalls).toBe(0);
    expect(tracks).toEqual([]);
    expect(await nonEmptyCaptions(page)).toEqual([]);
    await expect(startButton(page)).toBeEnabled();
    expect(await sourceRadiosDisabled(page)).toEqual([false, false]);
  });
});

test.describe('系统声音：共享内容没有声音', () => {
  test.use({
    shareTabTitle: 'RTMT-no-such-tab',
    extraBrowserArgs: ['--auto-select-desktop-capture-source=Entire screen'],
    userAgent: LINUX_CHROME_UA,
  });

  test('IQA-111 共享整个屏幕（无声音）：显示出错与本平台可行的选择，所得轨道全部结束', async ({ harness }) => {
    const { page } = harness;
    await page.goto('/');
    await selectSource(page, '系统声音');
    await startButton(page).click();

    await expect(statusText(page)).toHaveText(ERROR, { timeout: 10_000 });
    await expect(notice(page)).toContainText('所选的共享内容没有包含声音');
    // Linux: only a tab carries audio, so the advice names the tab only.
    await expect(notice(page)).toContainText('标签页');
    await expect(notice(page)).not.toContainText('同时分享系统音频');
    const { displayCalls, tracks } = await displayTracks(page);
    expect(displayCalls).toBe(1);
    expect(tracks.length).toBeGreaterThan(0);
    expect(tracks.every((track) => track.kind === 'video')).toBe(true);
    await expect.poll(async () => (await displayTracks(page)).tracks.map((track) => track.readyState)).not.toContain('live');
    expect(await nonEmptyCaptions(page)).toEqual([]);
    await expect(stopButton(page)).toBeDisabled();
  });
});

test('IQA-109 不支持的浏览器（Firefox）：选系统声音即说明不支持且不能开始，麦克风照常可用', async ({ server }) => {
  const browser = await firefox.launch({
    headless: false,
    firefoxUserPrefs: { 'media.navigator.streams.fake': true, 'media.navigator.permission.disabled': true },
  });
  try {
    const context = await browser.newContext({ baseURL: server.baseURL, locale: 'zh-CN' });
    await context.addInitScript({ content: INSTRUMENTATION });
    await context.addInitScript({ content: SEEN_GUIDE });
    const page = await context.newPage();
    await page.goto('/');
    await expect(page.locator('#source-system')).toBeEnabled();
    await selectSource(page, '系统声音');
    await expect(page.locator('#system-unsupported')).toBeVisible();
    await expect(page.locator('#system-unsupported')).toContainText('当前浏览器不支持采集系统声音');
    await expect(startButton(page)).toBeDisabled();
    await expect(page.locator('#support-matrix')).toBeVisible();
    await expect(page.locator('#support-matrix tbody tr[data-current="true"]')).toHaveCount(0);
    expect((await displayTracks(page)).displayCalls).toBe(0);

    await selectSource(page, '麦克风');
    await expect(page.locator('#system-panel')).toBeHidden();
    await expect(startButton(page)).toBeEnabled();
    await startButton(page).click();
    // v1 的 Speech SDK 在 Playwright Firefox 中无法加载 blob AudioWorklet（CSP script-src 'self'），
    // 识别会话停在“正在启动…”；这是麦克风路径的既有限制，本批只验证改回麦克风后可以发起采集且不受系统声音影响。
    await expect.poll(async () => (await displayTracks(page)).gumCalls, { timeout: 10_000 }).toBe(1);
    await expect(statusText(page)).not.toHaveText(NOT_RUNNING);
    await expect(page.locator('#notice')).not.toContainText('系统声音');
    expect((await displayTracks(page)).displayCalls).toBe(0);
    await stopButton(page).click();
    await expect(statusText(page)).toHaveText(NOT_RUNNING, { timeout: 3_000 });
  } finally {
    await browser.close();
  }
});
