import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { test as base, chromium, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import type { SentenceSetName } from '../support/tts.js';
import { fakeMicrophoneArgs } from './audio.js';

const BASE_PORT = 18_180;
const LOG_DIR = path.resolve('test-results', 'server-logs');

export interface ServerHandle {
  baseURL: string;
  /** Everything the server process wrote to stdout/stderr so far (structured JSON log lines). */
  readLog(): Promise<string>;
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
}

interface Options {
  audioSet: SentenceSetName;
  grantMicrophone: boolean;
}

/** Records every MediaStreamTrack obtained via getUserMedia so tests can check that stop really ends capture. */
// Kept as browser source text: the test tsconfig has no DOM lib.
const INSTRUMENTATION = `(() => {
  const record = { gumCalls: 0, tracks: [] };
  Object.defineProperty(window, '__rtmt', { value: record });
  const devices = navigator.mediaDevices;
  if (!devices || !devices.getUserMedia) return;
  const original = devices.getUserMedia.bind(devices);
  devices.getUserMedia = async (constraints) => {
    record.gumCalls += 1;
    const stream = await original(constraints);
    record.tracks.push(...stream.getTracks());
    return stream;
  };
})();`;

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

export const test = base.extend<Options & { harness: Harness }, { server: ServerHandle }>({
  audioSet: ['multi', { option: true }],
  grantMicrophone: [true, { option: true }],

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
        await use({ baseURL, readLog: () => readFile(logFile, 'utf8') });
      } finally {
        const exited = new Promise((resolve) => child.once('exit', resolve));
        child.kill('SIGTERM');
        await exited;
        out.end();
      }
    },
    { scope: 'worker' },
  ],

  harness: async ({ server, audioSet, grantMicrophone }, use) => {
    // Full Chromium (new headless) behaves like desktop Chrome; the headless shell rejects fake audio capture.
    const browser = await chromium.launch({ channel: 'chromium', args: fakeMicrophoneArgs(audioSet) });
    const context = await browser.newContext({
      baseURL: server.baseURL,
      locale: 'zh-CN',
      permissions: grantMicrophone ? ['microphone'] : [],
    });
    await context.addInitScript({ content: INSTRUMENTATION });
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
    await use({ browser, context, page, frames, newPage: () => context.newPage() });
    await browser.close();
  },
});

export { expect };

export const RUNNING = /翻译中/;
export const NOT_RUNNING = /未开始|已停止/;

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

export function hanCount(text: string): number {
  return text.match(/\p{Script=Han}/gu)?.length ?? 0;
}

export function latinWordCount(text: string): number {
  return text.match(/[A-Za-z]+/g)?.length ?? 0;
}
