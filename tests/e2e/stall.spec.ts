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
import { installSpeechStall, stallRecognizer } from './speechStall.js';

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
  return { segmentStarts };
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
