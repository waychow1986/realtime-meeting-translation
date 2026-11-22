import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { test as base, chromium, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { ensureSpeechWav, pcmOf, wavFromPcm, type SentenceSetName } from '../support/tts.js';
import { openPlayer, playerTitle, routePlayer } from '../support/player.js';
import { fakeMicrophoneArgs } from './audio.js';

const BASE_PORT = 18_180;
const LOG_DIR = path.resolve('test-results', 'server-logs');

export interface ServerHandle {
  baseURL: string;
  /** Everything the server process wrote to stdout/stderr so far (structured JSON log lines). */
  readLog(): Promise<string>;
  /**
   * Only what the server wrote since the current test started. The server is shared by all tests of a worker, so
   * assertions about this test's own requests (e.g. the detected language of its translations) must not see the log
   * lines of earlier tests (such as the Korean and Japanese material runs).
   */
  readTestLog(): Promise<string>;
}

interface WorkerServer extends ServerHandle {
  /** Called at the start of every test: remembers where this test's part of the log begins. */
  markTestStart(): Promise<void>;
}

export interface FrameRecord {
  at: number;
  direction: 'sent' | 'received';
  url: string;
  bytes: number;
  payload: string | Buffer;
}

export interface Harness {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  frames: FrameRecord[];
  /** Opens another page in the same context with the same instrumentation. */
  newPage(): Promise<Page>;
  /**
   * Opens the material player tab (title {@link playerTitle} of this worker, which the share picker auto-selects)
   * playing nothing yet; the app page is brought back to the front afterwards. `leadInMs` of silence is
   * prepended so playback can already run before the share starts (material time zero = playingAt + leadInMs).
   */
  openPlayer(set: SentenceSetName, leadInMs?: number): Promise<Page>;
}

interface Options {
  audioSet: SentenceSetName;
  grantMicrophone: boolean;
  /** Pre-mark the first-run guide as seen so it does not cover the page (the guide test turns this off). */
  guideSeen: boolean;
  /**
   * Tab title the share picker auto-selects (`--auto-select-tab-capture-source-by-title`); default is this
   * worker's player title. A title no tab has leaves the picker open (used to cancel it with Escape).
   */
  shareTabTitle: string | undefined;
  /** Extra Chromium flags, e.g. auto-selecting the entire screen instead of a tab. */
  extraBrowserArgs: string[];
}

/**
 * Records every MediaStreamTrack obtained via getUserMedia or getDisplayMedia (with the call counts and the
 * getDisplayMedia options) so tests can check which source was captured and that stop really ends capture,
 * the time the first capture started (the fake microphone plays the WAV from its start at that moment) and a
 * timeline of every caption change: { at, index (order of appearance), status, kind (`data-kind`, '' for normal
 * captions), text }. Caption-window samples serialize rows as [segmentId, status, text, kind].
 */
// Kept as browser source text: the test tsconfig has no DOM lib.
export const INSTRUMENTATION = `(() => {
  const record = {
    gumCalls: 0, tracks: [], displayCalls: 0, displayOptions: [], displayTracks: [],
    captureStartedAt: undefined, timeline: [],
  };
  Object.defineProperty(window, '__rtmt', { value: record });
  Object.defineProperty(window, '__rtmtDisplayTracks', { value: record.displayTracks });
  const indexes = new WeakMap();
  let nextIndex = 0;
  const snapshot = () => {
    const list = document.getElementById('captions');
    if (!list) return;
    for (const item of list.querySelectorAll('li.caption')) {
      if (!indexes.has(item)) indexes.set(item, { index: nextIndex++, last: '' });
      const state = indexes.get(item);
      const entry = { status: item.dataset.status || '', kind: item.dataset.kind || '', text: item.textContent || '' };
      const key = entry.status + '\\u0000' + entry.kind + '\\u0000' + entry.text;
      if (key === state.last) continue;
      state.last = key;
      record.timeline.push({ at: Date.now(), index: state.index, status: entry.status, kind: entry.kind, text: entry.text });
    }
    pipSample();
  };
  // Caption window (Document PiP): on every change of either list, both lists are serialized side by side.
  record.pip = { opened: 0, samples: [] };
  const serialize = (list) =>
    [...list.querySelectorAll('li.caption')].map((li) => [li.dataset.segmentId || '', li.dataset.status || '', li.textContent || '', li.dataset.kind || '']);
  const pipSample = () => {
    const pipWindow = window.documentPictureInPicture && window.documentPictureInPicture.window;
    const pipList = pipWindow && pipWindow.document.getElementById('pip-captions');
    const list = document.getElementById('captions');
    if (!pipList || !list) return;
    record.pip.samples.push({ at: Date.now(), main: serialize(list), pip: serialize(pipList) });
  };
  if (window.documentPictureInPicture) {
    window.documentPictureInPicture.addEventListener('enter', (event) => {
      record.pip.opened += 1;
      new MutationObserver(pipSample).observe(event.window.document.documentElement, {
        subtree: true, childList: true, characterData: true, attributes: true,
      });
    });
  }
  const observe = () => {
    const list = document.getElementById('captions');
    if (!list) return;
    new MutationObserver(snapshot).observe(list, { subtree: true, childList: true, characterData: true, attributes: true });
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', observe);
  else observe();
  const devices = navigator.mediaDevices;
  if (devices && devices.getDisplayMedia) {
    const originalDisplay = devices.getDisplayMedia.bind(devices);
    devices.getDisplayMedia = async (options) => {
      record.displayCalls += 1;
      record.displayOptions.push(JSON.parse(JSON.stringify(options ?? null)));
      const stream = await originalDisplay(options);
      if (record.captureStartedAt === undefined) record.captureStartedAt = Date.now();
      record.displayTracks.push(...stream.getTracks());
      return stream;
    };
  }
  if (!devices || !devices.getUserMedia) return;
  const original = devices.getUserMedia.bind(devices);
  devices.getUserMedia = async (constraints) => {
    record.gumCalls += 1;
    const stream = await original(constraints);
    if (record.captureStartedAt === undefined) record.captureStartedAt = Date.now();
    record.tracks.push(...stream.getTracks());
    return stream;
  };
})();`;

export const SEEN_GUIDE = `try { if (location.protocol.startsWith('http')) localStorage.setItem('rtmt.guideSeen', '1'); } catch {}`;

export interface CaptionEvent {
  at: number;
  index: number;
  status: string;
  /** `data-kind` of the entry ('notice' for the untranslated notice, '' otherwise). */
  kind: string;
  text: string;
}

async function waitForServer(baseURL: string, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited early with code ${child.exitCode}`);
    try {
      const response = await fetch(`${baseURL}/`);
      if (response.ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('server did not become ready');
}

export const test = base.extend<Options & { harness: Harness; serverLogMark: void }, { server: WorkerServer }>({
  audioSet: ['multi', { option: true }],
  grantMicrophone: [true, { option: true }],
  guideSeen: [true, { option: true }],
  shareTabTitle: [undefined, { option: true }],
  extraBrowserArgs: [[], { option: true }],

  server: [
    // eslint-disable-next-line no-empty-pattern -- Playwright requires a destructuring pattern here
    async ({}, use, workerInfo) => {
      await mkdir(LOG_DIR, { recursive: true });
      const port = BASE_PORT + workerInfo.workerIndex;
      const logFile = path.join(LOG_DIR, `server-${workerInfo.workerIndex}.log`);
      const out = createWriteStream(logFile, { flags: 'w' });
      const child = spawn(process.execPath, ['dist/server/main.js'], {
        env: { ...process.env, PORT: String(port), LOG_LEVEL: 'debug', TRUSTED_PROXY_HOPS: '0' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      child.stdout?.pipe(out);
      child.stderr?.pipe(out);
      const baseURL = `http://localhost:${port}`;
      try {
        await waitForServer(baseURL, child);
        let testStart = 0;
        await use({
          baseURL,
          readLog: () => readFile(logFile, 'utf8'),
          readTestLog: async () => (await readFile(logFile)).subarray(testStart).toString('utf8'),
          markTestStart: async () => {
            testStart = (await stat(logFile)).size;
          },
        });
      } finally {
        const exited = new Promise((resolve) => child.once('exit', resolve));
        child.kill('SIGTERM');
        await exited;
        out.end();
      }
    },
    { scope: 'worker' },
  ],

  serverLogMark: [
    async ({ server }, use) => {
      await server.markTestStart();
      await use();
    },
    { auto: true },
  ],

  harness: async ({ server, audioSet, grantMicrophone, guideSeen, shareTabTitle, extraBrowserArgs }, use, testInfo) => {
    // Headed full Chromium inside xvfb-run (TD-108): behaves like desktop Chrome, incl. fake audio capture and the
    // real share picker, which auto-selects the player tab by title (never --use-fake-ui-for-media-stream).
    const browser = await chromium.launch({
      channel: 'chromium',
      headless: false,
      args: [
        ...fakeMicrophoneArgs(audioSet),
        '--lang=zh-CN',
        '--autoplay-policy=no-user-gesture-required',
        `--auto-select-tab-capture-source-by-title=${shareTabTitle ?? playerTitle(testInfo.workerIndex)}`,
        ...extraBrowserArgs,
      ],
    });
    const context = await browser.newContext({
      baseURL: server.baseURL,
      locale: 'zh-CN',
      permissions: grantMicrophone ? ['microphone'] : [],
    });
    await context.addInitScript({ content: INSTRUMENTATION });
    if (guideSeen) await context.addInitScript({ content: SEEN_GUIDE });
    const frames: FrameRecord[] = [];
    const observe = (page: Page) => {
      page.on('websocket', (ws) => {
        ws.on('framesent', ({ payload }) =>
          frames.push({ at: Date.now(), direction: 'sent', url: ws.url(), bytes: Buffer.byteLength(payload), payload }),
        );
        ws.on('framereceived', ({ payload }) =>
          frames.push({ at: Date.now(), direction: 'received', url: ws.url(), bytes: Buffer.byteLength(payload), payload }),
        );
      });
    };
    context.on('page', observe);
    const page = await context.newPage();
    const openPlayerTab = async (set: SentenceSetName, leadInMs = 0) => {
      await routePlayer(context, playerTitle(testInfo.workerIndex), async () => {
        const pcm = pcmOf(await readFile(await ensureSpeechWav(set)));
        // 16 kHz mono 16-bit: 32 bytes of silence per millisecond.
        return wavFromPcm(Buffer.concat([Buffer.alloc(Math.round(leadInMs) * 32), pcm]));
      });
      const player = await openPlayer(context);
      await page.bringToFront();
      return player;
    };
    await use({ browser, context, page, frames, newPage: () => context.newPage(), openPlayer: openPlayerTab });
    await browser.close();
  },
});

export { expect };

export const RUNNING = /正在听/;
export const NOT_RUNNING = /未开始|已停止/;
export const ERROR = /出错/;

export function startButton(page: Page) {
  return page.getByRole('button', { name: '开始' });
}

export function stopButton(page: Page) {
  return page.getByRole('button', { name: '停止' });
}

export function statusText(page: Page) {
  return page.getByRole('status');
}

export async function captionTexts(page: Page, status?: string): Promise<string[]> {
  const selector = status ? `#captions li.caption[data-status="${status}"]` : '#captions li.caption';
  return page.locator(selector).allTextContents();
}

export async function waitForFinalCaptions(page: Page, count: number, timeoutMs = 90_000): Promise<string[]> {
  await expect
    .poll(async () => (await captionTexts(page, 'final')).filter((text) => text.trim()).length, { timeout: timeoutMs })
    .toBeGreaterThanOrEqual(count);
  return (await captionTexts(page, 'final')).filter((text) => text.trim());
}

export async function trackStates(page: Page): Promise<{ gumCalls: number; states: string[] }> {
  return page.evaluate<{ gumCalls: number; states: string[] }>(
    '({ gumCalls: window.__rtmt.gumCalls, states: window.__rtmt.tracks.map((track) => track.readyState) })',
  );
}

export interface DisplayTrackInfo {
  kind: string;
  label: string;
  readyState: string;
  suppressLocalAudioPlayback: boolean | null;
}

/** getDisplayMedia call count and every track it returned (audio and video alike). */
export async function displayTracks(page: Page): Promise<{ displayCalls: number; gumCalls: number; tracks: DisplayTrackInfo[] }> {
  return page.evaluate(`({
    displayCalls: window.__rtmt.displayCalls,
    gumCalls: window.__rtmt.gumCalls,
    tracks: window.__rtmt.displayTracks.map((track) => ({
      kind: track.kind,
      label: track.label,
      readyState: track.readyState,
      suppressLocalAudioPlayback:
        track.kind === 'audio' ? (track.getSettings().suppressLocalAudioPlayback ?? null) : null,
    })),
  })`);
}

/** Selects the input source by its visible radio label (麦克风 / 系统声音). */
export async function selectSource(page: Page, name: '麦克风' | '系统声音'): Promise<void> {
  await page.getByRole('radio', { name }).check();
}

export async function captionTimeline(page: Page): Promise<CaptionEvent[]> {
  return page.evaluate<CaptionEvent[]>('window.__rtmt.timeline.slice()');
}

/** Epoch ms when the fake microphone started playing the WAV (first successful getUserMedia). */
export async function captureStartedAt(page: Page): Promise<number> {
  await expect.poll(() => page.evaluate<number | null>('window.__rtmt.captureStartedAt ?? null')).not.toBeNull();
  return page.evaluate<number>('window.__rtmt.captureStartedAt');
}

/**
 * Waits until the fake microphone is at `offsetMs` into the WAV. The file loops, so assertions about
 * "exactly N captions" must happen before the replay's first sentence (leading silence after durationMs).
 */
export async function waitUntilAudioOffset(page: Page, offsetMs: number): Promise<void> {
  const remaining = (await captureStartedAt(page)) + offsetMs - Date.now();
  if (remaining > 0) await page.waitForTimeout(remaining);
}

/** Count of the Han characters relative to all letters/digits (punctuation and whitespace ignored). */
export function hanRatio(text: string): number {
  const significant = text.match(/[\p{L}\p{N}]/gu)?.length ?? 0;
  return significant === 0 ? 0 : hanCount(text) / significant;
}

export function hanCount(text: string): number {
  return text.match(/\p{Script=Han}/gu)?.length ?? 0;
}

export function latinWordCount(text: string): number {
  return text.match(/[A-Za-z]+/g)?.length ?? 0;
}

/** The untranslated-notice text (TD-309), kept literal so the tests do not depend on the production module. */
export const UNTRANSLATED_NOTICE = '（此句未能翻译成中文）';

/** Every caption entry that ever showed text, in order of appearance, with its own timeline events. */
export function captionEntries(timeline: CaptionEvent[]): CaptionEvent[][] {
  const byIndex = new Map<number, CaptionEvent[]>();
  for (const event of timeline) {
    const events = byIndex.get(event.index) ?? [];
    events.push(event);
    byIndex.set(event.index, events);
  }
  return [...byIndex.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, events]) => events)
    .filter((events) => events.some((event) => event.text.trim()));
}

/**
 * Starts translating the material player tab: opens the player with `leadInMs` of silence, starts playback,
 * selects 系统声音 and presses 开始 before the first sentence. Returns the epoch ms of material time zero.
 */
export async function startSystemAudio(harness: Harness, set: SentenceSetName, leadInMs = 6_000): Promise<number> {
  const { page } = harness;
  if (!page.url().startsWith('http')) await page.goto('/');
  const player = await harness.openPlayer(set, leadInMs);
  await player.evaluate('window.__play()');
  await player.waitForFunction('window.__playerState().playingAt !== null');
  const playingAt = await player.evaluate<number>('window.__playerState().playingAt');
  await selectSource(page, '系统声音');
  await startButton(page).click();
  await expect(statusText(page)).toHaveText(RUNNING, { timeout: 15_000 });
  return playingAt + leadInMs;
}

/**
 * Records every change of the status text and of the page notice (`#notice`), so a test can assert that the
 * run was never interrupted: `window.__rtmtStatus = [{ at, status, notice }]`.
 */
export const STATUS_LOG = `(() => {
  const log = [];
  Object.defineProperty(window, '__rtmtStatus', { value: log });
  const take = () => {
    const status = document.getElementById('status');
    const notice = document.getElementById('notice');
    log.push({ at: Date.now(), status: status ? status.textContent : '', notice: notice && !notice.hidden ? notice.textContent : '' });
  };
  const observe = () => {
    for (const id of ['status', 'notice']) {
      const el = document.getElementById(id);
      if (el) new MutationObserver(take).observe(el, { subtree: true, childList: true, characterData: true, attributes: true });
    }
    take();
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', observe);
  else observe();
})();`;

export function statusLog(page: Page): Promise<{ at: number; status: string; notice: string }[]> {
  return page.evaluate('window.__rtmtStatus.slice()');
}
