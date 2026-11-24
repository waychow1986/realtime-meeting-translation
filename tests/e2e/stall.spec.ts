/**
 * IR-003: in 系统声音 mode the page must not keep showing “正在听” after speech recognition silently stops
 * producing results (design.md, 端到端测试设计). Real dependencies only; the fault is injected in the browser by
 * withholding the speech service's incoming WebSocket messages (tests/e2e/speechStall.ts).
 */
import type { Page } from '@playwright/test';
import { MESSAGES } from '../../src/web/messages.js';
import { ensureSpeechAudio, pcmOf, readWav, wavFromPcm, type SentenceSetName } from '../support/tts.js';
import {
  ERROR,
  NOT_RUNNING,
  RUNNING,
  STATUS_LOG,
  captionTexts,
  displayTracks,
  expect,
  selectSource,
  startButton,
  statusLog,
  statusText,
  stopButton,
  test,
  waitForFinalCaptions,
  type Harness,
} from './fixtures.js';
import { breakAudioChain, installSpeechStall, stallRecognizer, type AudioChainFault } from './speechStall.js';
import { TRANSLATION_FAILURE_SCRIPT, failFinalTranslations, failedFinals } from './translationOverride.js';

const BYTES_PER_MS = 32; // 16 kHz mono 16-bit
const STALL_LIMIT_MS = 30_000;
const STALL_WAIT_MS = 50_000;
const CONTINUOUS_SETS: SentenceSetName[] = ['meeting', 'multi', 'long', 'interference', 'single'];
const EDGE_THRESHOLD = 300; // ≈ −40 dBFS sample magnitude
const EDGE_MARGIN_MS = 30;

const silencePcm = (ms: number) => Buffer.alloc(Math.round(ms) * BYTES_PER_MS);

/** Trims a sentence clip's own leading/trailing near-silence so sentences join without audible pauses. */
function trimEdges(pcm: Buffer): Buffer {
  const samples = pcm.length >> 1;
  let first = 0;
  while (first < samples && Math.abs(pcm.readInt16LE(first * 2)) < EDGE_THRESHOLD) first += 1;
  let last = samples - 1;
  while (last > first && Math.abs(pcm.readInt16LE(last * 2)) < EDGE_THRESHOLD) last -= 1;
  const margin = EDGE_MARGIN_MS * 16;
  return pcm.subarray(Math.max(0, first - margin) * 2, Math.min(samples, last + 1 + margin) * 2);
}

/** Speech with no pauses between sentences (gap 0, edges trimmed), repeated to at least `minMs`. */
async function continuousSpeech(minMs: number): Promise<Buffer> {
  const clips: Buffer[] = [];
  for (const set of CONTINUOUS_SETS) {
    const audio = await ensureSpeechAudio(set, 0);
    const pcm = pcmOf(await readWav(audio.wav));
    for (const timing of audio.timings) {
      clips.push(trimEdges(pcm.subarray(timing.startMs * BYTES_PER_MS, timing.endMs * BYTES_PER_MS)));
    }
  }
  const parts: Buffer[] = [];
  let bytes = 0;
  for (let i = 0; bytes < minMs * BYTES_PER_MS; i += 1) {
    const clip = clips[i % clips.length]!;
    parts.push(clip);
    bytes += clip.length;
  }
  return Buffer.concat(parts);
}

/** The normal sentence group (2 s between sentences), without its trailing silence. */
async function normalSpeech(set: SentenceSetName): Promise<Buffer> {
  const audio = await ensureSpeechAudio(set);
  const pcm = pcmOf(await readWav(audio.wav));
  return pcm.subarray(0, audio.timings[audio.timings.length - 1]!.endMs * BYTES_PER_MS);
}

interface Segment {
  pcm: () => Promise<Buffer>;
}

interface Material {
  /** Epoch ms at which each segment starts playing. */
  segmentStarts: number[];
  /** The shared material player tab. */
  player: Page;
}

/** Plays the composed material in the player tab and starts the page in 系统声音 mode. */
async function startWithMaterial(harness: Harness, segments: Segment[]): Promise<Material> {
  const { page } = harness;
  const pcms: Buffer[] = [];
  const player = await harness.openPlayerWav(async () => {
    for (const segment of segments) pcms.push(await segment.pcm());
    return wavFromPcm(Buffer.concat([...pcms, silencePcm(4_000)]));
  });
  await player.evaluate('window.__play()');
  await player.waitForFunction('window.__playerState().playingAt !== null');
  const playingAt = await player.evaluate<number>('window.__playerState().playingAt');
  await selectSource(page, '系统声音');
  await startButton(page).click();
  await expect(statusText(page)).toHaveText(RUNNING, { timeout: 15_000 });
  const segmentStarts: number[] = [];
  let offset = playingAt;
  for (const pcm of pcms) {
    segmentStarts.push(offset);
    offset += pcm.length / BYTES_PER_MS;
  }
  return { segmentStarts, player };
}

async function finalCount(page: Page): Promise<number> {
  return (await captionTexts(page, 'final')).filter((text) => text.trim()).length;
}

async function waitUntil(epochMs: number): Promise<void> {
  const delay = epochMs - Date.now();
  if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
}

/** First moment (epoch ms) after `since` at which the page status left “正在听”, or null. */
async function leftRunningAt(page: Page, since: number): Promise<{ at: number; status: string; notice: string } | null> {
  const entry = (await statusLog(page)).find((e) => e.at >= since && !RUNNING.test(e.status));
  return entry ?? null;
}

async function pipStatus(page: Page): Promise<string> {
  return page.evaluate<string>(
    `(() => { const w = documentPictureInPicture.window; return w ? (w.document.getElementById('pip-status')?.textContent || '') : ''; })()`,
  );
}

test.describe('IR-003 系统声音：语音识别停滞', () => {
  test('识别器静默停止：持续有声音时不超过 30 秒转为“出错”并提示重新开始；重新开始后恢复', async ({ harness }) => {
    test.setTimeout(420_000);
    const { page } = harness;
    await installSpeechStall(page);
    await page.addInitScript({ content: STATUS_LOG });
    await page.goto('/');

    const { segmentStarts } = await startWithMaterial(harness, [
      { pcm: () => normalSpeech('meeting') },
      { pcm: () => continuousSpeech(240_000) },
    ]);
    await waitForFinalCaptions(page, 1);

    await page.locator('#pip-button').click();
    await expect.poll(() => pipStatus(page)).toMatch(RUNNING);

    // Trigger inside the continuous segment, right after a caption update.
    await waitUntil(segmentStarts[1]! + 3_000);
    const before = await finalCount(page);
    const snapshot = () => page.locator('#captions li.caption').evaluateAll((items) => items.map((li) => li.textContent).join('|'));
    const initial = await snapshot();
    await expect.poll(snapshot, { intervals: [100], timeout: 30_000 }).not.toBe(initial);
    const triggeredAt = await stallRecognizer(page);
    const captionsAtTrigger = (await captionTexts(page, 'final')).filter((text) => text.trim());
    expect(captionsAtTrigger.length).toBeGreaterThanOrEqual(before);

    // AC-1/AC-3: leaves “正在听” for “出错” within 30 s of the trigger (the test waits up to 50 s).
    await expect(statusText(page)).toHaveText(ERROR, { timeout: STALL_WAIT_MS });
    const left = await leftRunningAt(page, triggeredAt);
    expect(left, 'status timeline after the trigger').not.toBeNull();
    expect(left!.status).toMatch(ERROR);
    expect(left!.at - triggeredAt).toBeLessThanOrEqual(STALL_LIMIT_MS);
    await expect(page.locator('#notice')).toHaveText(MESSAGES.stalled);
    await expect.poll(() => pipStatus(page)).toMatch(ERROR);

    // Captions are kept, the run is really over and the user can start again.
    const kept = (await captionTexts(page, 'final')).filter((text) => text.trim());
    expect(kept.slice(0, captionsAtTrigger.length)).toEqual(captionsAtTrigger);
    await expect(startButton(page)).toBeEnabled();
    await expect(stopButton(page)).toBeDisabled();
    await expect
      .poll(async () => (await displayTracks(page)).tracks.filter((track) => track.readyState === 'live').length)
      .toBe(0);

    // AC-4: 开始 (the share picker re-selects the player tab) brings the translation back.
    const countBeforeRestart = await finalCount(page);
    await page.bringToFront();
    await startButton(page).click();
    await expect(statusText(page)).toHaveText(RUNNING, { timeout: 15_000 });
    await expect(page.locator('#notice')).toBeHidden();
    await expect.poll(() => finalCount(page), { timeout: 90_000 }).toBeGreaterThan(countBeforeRestart);
    await expect(statusText(page)).toHaveText(RUNNING);
  });

  test('长时间无声不误报：45 秒静音期间与之后始终“正在听”，静音后的语音仍出字幕', async ({ harness }) => {
    test.setTimeout(240_000);
    const { page } = harness;
    await page.addInitScript({ content: STATUS_LOG });
    await page.goto('/');

    const { segmentStarts } = await startWithMaterial(harness, [
      { pcm: () => normalSpeech('meeting') },
      { pcm: async () => silencePcm(45_000) },
      { pcm: () => normalSpeech('multi') },
    ]);
    const runningSince = Date.now();
    await waitForFinalCaptions(page, 1);

    await waitUntil(segmentStarts[2]!);
    const beforeSpeech = await finalCount(page);
    await expect.poll(() => finalCount(page), { timeout: 60_000 }).toBeGreaterThan(beforeSpeech);

    expect(await leftRunningAt(page, runningSince)).toBeNull();
    await expect(statusText(page)).toHaveText(RUNNING);
    await expect(page.locator('#notice')).toBeHidden();
  });

  test('正常持续 5 分钟不误报：始终“正在听”，每 60 秒内都有新的最终字幕', async ({ harness }) => {
    test.setTimeout(480_000);
    const { page } = harness;
    await page.addInitScript({ content: STATUS_LOG });
    await page.goto('/');

    const RUN_MS = 300_000;
    const WINDOW_MS = 60_000;
    const sets: SentenceSetName[] = ['meeting', 'multi', 'long', 'single'];
    await startWithMaterial(harness, [
      {
        pcm: async () => {
          const groups: Buffer[] = [];
          let bytes = 0;
          for (let i = 0; bytes < (RUN_MS + 20_000) * BYTES_PER_MS; i += 1) {
            const group = Buffer.concat([await normalSpeech(sets[i % sets.length]!), silencePcm(2_000)]);
            groups.push(group);
            bytes += group.length;
          }
          return Buffer.concat(groups);
        },
      },
    ]);
    const runningSince = Date.now();

    for (let window = 1; window * WINDOW_MS <= RUN_MS; window += 1) {
      const before = await finalCount(page);
      const windowEnd = runningSince + window * WINDOW_MS;
      await expect
        .poll(() => finalCount(page), { timeout: Math.max(1_000, windowEnd - Date.now()), message: `window ${window}` })
        .toBeGreaterThan(before);
      expect(await leftRunningAt(page, runningSince)).toBeNull();
      await waitUntil(windowEnd);
    }

    expect(await leftRunningAt(page, runningSince)).toBeNull();
    await expect(statusText(page)).toHaveText(RUNNING);
    await expect(page.locator('#notice')).toBeHidden();
  });
});

/**
 * Emulates a hidden translation page: Chromium wakes the timers of a hidden page at most once per second (aligned
 * to whole seconds). The test harness cannot really hide the page (Playwright gives each page its own window and
 * disables background throttling; Xvfb has no window manager to minimize it), so the page's main-thread
 * `setTimeout` is aligned the same way. Worker timers are untouched, as in the browser. Also records the URLs of the
 * workers the page starts and the CSP violations it reports.
 */
const HIDDEN_PAGE_TIMERS = `(() => {
  const nativeSetTimeout = window.setTimeout.bind(window);
  window.setTimeout = (handler, delay, ...args) => {
    const ms = Number(delay) || 0;
    if (ms <= 0) return nativeSetTimeout(handler, delay, ...args);
    const wake = Math.ceil((performance.now() + ms) / 1000) * 1000;
    return nativeSetTimeout(handler, wake - performance.now(), ...args);
  };
  const workers = (window.__workerUrls = []);
  const NativeWorker = window.Worker;
  window.Worker = class extends NativeWorker {
    constructor(url, options) { super(url, options); workers.push(String(url)); }
  };
  const violations = (window.__cspViolations = []);
  document.addEventListener('securitypolicyviolation', (e) => violations.push(e.effectiveDirective + ' ' + e.blockedURI));
})();`;

test.describe('IR-003 系统声音：翻译主页面在后台', () => {
  test('主页面定时器按后台节流对齐：45 秒静音前后始终“正在听”，静音后的语音仍及时出字幕', async ({ harness }) => {
    test.setTimeout(300_000);
    const { page } = harness;
    await page.addInitScript({ content: HIDDEN_PAGE_TIMERS });
    await page.addInitScript({ content: STATUS_LOG });
    await page.goto('/');

    const { segmentStarts } = await startWithMaterial(harness, [
      { pcm: () => normalSpeech('meeting') },
      { pcm: async () => silencePcm(45_000) },
      { pcm: () => normalSpeech('multi') },
      { pcm: () => normalSpeech('long') },
    ]);
    const runningSince = Date.now();
    await waitForFinalCaptions(page, 1);

    for (const segment of [2, 3]) {
      await waitUntil(segmentStarts[segment]!);
      const before = await finalCount(page);
      await expect
        .poll(() => finalCount(page), { timeout: 45_000, message: `segment ${segment}` })
        .toBeGreaterThan(before);
    }

    // The SDK paces audio upload with worker timers served by the page itself, not with throttled page timers.
    expect(await page.evaluate<string[]>('window.__workerUrls')).toContain('/sdk-timer-worker.js');
    expect(await page.evaluate<string[]>('window.__cspViolations')).toEqual([]);

    expect(await leftRunningAt(page, runningSince)).toBeNull();
    await expect(statusText(page)).toHaveText(RUNNING);
    await expect(page.locator('#notice')).toBeHidden();
  });
});

const QUIET_AFTER_END_MS = 35_000;

async function nonEmptyFinals(page: Page): Promise<string[]> {
  return (await captionTexts(page, 'final')).filter((text) => text.trim());
}

/** Waits for a caption change of the running page, so the chain is known to carry sound right now. */
async function waitForCaptionChange(page: Page): Promise<void> {
  const snapshot = () => page.locator('#captions li.caption').evaluateAll((items) => items.map((li) => li.textContent).join('|'));
  const initial = await snapshot();
  await expect.poll(snapshot, { intervals: [100], timeout: 30_000 }).not.toBe(initial);
}

/**
 * AC-2: within 30 s of `triggeredAt` the page left “正在听” for “出错” with the stall notice; the run is over (开始
 * enabled, 停止 disabled) and the captions shown at the trigger are kept.
 */
async function expectStalled(page: Page, triggeredAt: number, captionsAtTrigger: string[]): Promise<void> {
  await expect(statusText(page)).toHaveText(ERROR, { timeout: STALL_WAIT_MS });
  const left = await leftRunningAt(page, triggeredAt);
  expect(left, 'status timeline after the trigger').not.toBeNull();
  expect(left!.status).toMatch(ERROR);
  expect(left!.at - triggeredAt).toBeLessThanOrEqual(STALL_LIMIT_MS);
  await expect(page.locator('#notice')).toHaveText(MESSAGES.stalled);
  await expect(page.locator('#notice')).toHaveAttribute('data-kind', 'error');
  await expect(startButton(page)).toBeEnabled();
  await expect(stopButton(page)).toBeDisabled();
  expect((await nonEmptyFinals(page)).slice(0, captionsAtTrigger.length)).toEqual(captionsAtTrigger);
}

/** 开始 again (the share picker re-selects the player tab) and wait until a new final caption arrives. */
async function restart(page: Page): Promise<void> {
  const before = await finalCount(page);
  await page.bringToFront();
  await startButton(page).click();
  await expect(statusText(page)).toHaveText(RUNNING, { timeout: 15_000 });
  await expect(page.locator('#notice')).toBeHidden();
  await expect.poll(() => finalCount(page), { timeout: 90_000 }).toBeGreaterThan(before);
}

/**
 * AC-7: from `since` on, for 35 s, every status/notice change keeps the expected end state and the stall notice
 * never appears; the page still shows that state afterwards.
 */
async function expectEndStateKept(page: Page, since: number, status: RegExp, notice: string): Promise<void> {
  await waitUntil(since + QUIET_AFTER_END_MS);
  const entries = (await statusLog(page)).filter((entry) => entry.at >= since);
  for (const entry of entries) {
    expect(entry.status).toMatch(status);
    expect(entry.notice).toBe(notice);
  }
  await expect(statusText(page)).toHaveText(status);
  if (notice) await expect(page.locator('#notice')).toHaveText(notice);
  else await expect(page.locator('#notice')).toBeHidden();
}

test.describe('IR-003 系统声音：混音链路中断（AC-2）', () => {
  test('有声音时混音链路被挂起、关闭或输出轨道停止：各自在 30 秒内转为“出错”并提示重新开始，字幕小窗同步', async ({
    harness,
  }) => {
    test.setTimeout(420_000);
    const { page } = harness;
    await installSpeechStall(page);
    await page.addInitScript({ content: STATUS_LOG });
    await page.goto('/');

    await startWithMaterial(harness, [{ pcm: () => normalSpeech('meeting') }, { pcm: () => continuousSpeech(300_000) }]);
    await waitForFinalCaptions(page, 1);
    await page.locator('#pip-button').click();
    await expect.poll(() => pipStatus(page)).toMatch(RUNNING);

    const faults: AudioChainFault[] = ['suspend', 'close', 'stop-track'];
    for (const [i, fault] of faults.entries()) {
      await test.step(fault, async () => {
        if (i > 0) await restart(page);
        await waitForCaptionChange(page);
        const triggeredAt = await breakAudioChain(page, fault);
        const captionsAtTrigger = await nonEmptyFinals(page);
        await expectStalled(page, triggeredAt, captionsAtTrigger);
        await expect.poll(() => pipStatus(page)).toMatch(ERROR);
      });
    }
  });

  test('静音期间混音链路被挂起：同样在 30 秒内转为“出错”并提示重新开始', async ({ harness }) => {
    test.setTimeout(240_000);
    const { page } = harness;
    await installSpeechStall(page);
    await page.addInitScript({ content: STATUS_LOG });
    await page.goto('/');

    const { segmentStarts } = await startWithMaterial(harness, [
      { pcm: () => normalSpeech('meeting') },
      { pcm: async () => silencePcm(45_000) },
      { pcm: () => normalSpeech('multi') },
    ]);
    await waitForFinalCaptions(page, 1);

    await waitUntil(segmentStarts[1]! + 5_000);
    const triggeredAt = await breakAudioChain(page, 'suspend');
    const captionsAtTrigger = await nonEmptyFinals(page);
    await expectStalled(page, triggeredAt, captionsAtTrigger);
    // Detected while the material was still silent.
    expect((await leftRunningAt(page, triggeredAt))!.at).toBeLessThan(segmentStarts[2]!);
  });
});

test.describe('IR-003 系统声音：既有结束路径不变（AC-7）', () => {
  test('点击停止与关闭被共享的标签页：各自照旧结束，之后 35 秒内不出现停滞提示', async ({ harness }) => {
    test.setTimeout(300_000);
    const { page } = harness;
    await page.addInitScript({ content: STATUS_LOG });
    await page.goto('/');

    const { player } = await startWithMaterial(harness, [{ pcm: () => continuousSpeech(240_000) }]);
    await waitForFinalCaptions(page, 1);

    await test.step('停止', async () => {
      await stopButton(page).click();
      await expect(statusText(page)).toHaveText(NOT_RUNNING, { timeout: 3_000 });
      await expect(page.locator('#notice')).toBeHidden();
      await expectEndStateKept(page, Date.now(), NOT_RUNNING, '');
    });

    await test.step('关闭被共享的标签页', async () => {
      await restart(page);
      await player.close();
      await expect(statusText(page)).toHaveText(NOT_RUNNING, { timeout: 5_000 });
      await expect(page.locator('#notice')).toHaveText(MESSAGES.shareEnded);
      await expectEndStateKept(page, Date.now(), NOT_RUNNING, MESSAGES.shareEnded);
    });
  });

  test('单句翻译被拒绝只丢弃该句、继续“正在听”；连续 3 句翻译不可用照旧“出错”并提示翻译已中断；均不出现停滞提示', async ({
    harness,
  }) => {
    test.setTimeout(360_000);
    const { page } = harness;
    await page.addInitScript({ content: TRANSLATION_FAILURE_SCRIPT });
    await page.addInitScript({ content: STATUS_LOG });
    await page.goto('/');

    const sets: SentenceSetName[] = ['meeting', 'multi', 'long', 'single'];
    await startWithMaterial(harness, [
      {
        pcm: async () => {
          const groups: Buffer[] = [];
          let bytes = 0;
          for (let i = 0; bytes < 200_000 * BYTES_PER_MS; i += 1) {
            const group = Buffer.concat([await normalSpeech(sets[i % sets.length]!), silencePcm(2_000)]);
            groups.push(group);
            bytes += group.length;
          }
          return Buffer.concat(groups);
        },
      },
    ]);
    const runningSince = Date.now();
    await waitForFinalCaptions(page, 1);

    await test.step('upstream_rejected 一句', async () => {
      await failFinalTranslations(page, 'upstream_rejected', 1);
      await expect.poll(async () => (await failedFinals(page)).length, { timeout: 60_000 }).toBe(1);
      const rejectedAt = (await failedFinals(page))[0]!.at;
      const afterRejection = await finalCount(page);
      await waitUntil(rejectedAt + QUIET_AFTER_END_MS);
      expect(await leftRunningAt(page, runningSince)).toBeNull();
      await expect(statusText(page)).toHaveText(RUNNING);
      await expect(page.locator('#notice')).toBeHidden();
      // Later sentences are still translated.
      expect(await finalCount(page)).toBeGreaterThan(afterRejection);
    });

    await test.step('连续 3 句 upstream_unavailable', async () => {
      await failFinalTranslations(page, 'upstream_unavailable', 3);
      await expect(statusText(page)).toHaveText(ERROR, { timeout: 90_000 });
      expect((await failedFinals(page)).filter((f) => f.code === 'upstream_unavailable')).toHaveLength(3);
      await expect(page.locator('#notice')).toHaveText(MESSAGES.interrupted);
      await expectEndStateKept(page, Date.now(), ERROR, MESSAGES.interrupted);
    });
  });
});
