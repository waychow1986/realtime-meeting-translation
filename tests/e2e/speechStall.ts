/**
 * Controlled fault injection for the IR-003 stall tests (design.md, 可测性约定).
 *
 * `stallInitScript(sttHost)` wraps `window.WebSocket`: once the test calls `window.__rtmtTest.stallRecognizer()`,
 * the connections to the speech-to-text host that are open at that moment stop delivering incoming messages to the SDK (no error, no close), while
 * sending keeps working — which is how the real fault looks to the page: audio keeps flowing, results stop.
 *
 * `MIX_CONTEXT_PROBE` records every `AudioContext` created by the page; `window.__rtmtTest.mixContext()` returns the
 * first one created without constructor arguments (the system-audio mixing context; the SDK passes a sample rate).
 */
import type { Page } from '@playwright/test';
import { requireEnv } from '../support/env.js';

function bareHost(host: string): string {
  return host
    .replace(/^[a-z]+:\/\//i, '')
    .replace(/\/.*$/, '')
    .replace(/:443$/, '')
    .toLowerCase();
}

export function stallInitScript(sttHost: string): string {
  return `(() => {
  const target = ${JSON.stringify(bareHost(sttHost))};
  const test = (window.__rtmtTest = window.__rtmtTest || {});
  // Only connections open at the moment of the trigger stall; a new run opens a new, healthy connection.
  const open = new Set();
  let stalledCount = 0;
  test.stallRecognizer = () => { for (const socket of open) socket.__stalled = true; stalledCount += open.size; };
  test.stalledConnections = () => stalledCount;
  const Native = window.WebSocket;
  class StallableWebSocket extends Native {
    constructor(url, protocols) {
      super(url, protocols);
      let host = '';
      try { host = new URL(String(url)).host.replace(/:443$/, '').toLowerCase(); } catch {}
      const gated = host === target;
      const socket = this;
      if (gated) {
        open.add(socket);
        super.addEventListener('close', () => open.delete(socket));
      }
      const wrap = (fn) => function (event) { if (gated && socket.__stalled) return; return fn.call(this, event); };
      let handler = null;
      Object.defineProperty(this, 'onmessage', {
        configurable: true,
        get: () => handler,
        set: (fn) => {
          handler = fn;
          super.onmessage = typeof fn === 'function' ? wrap(fn) : fn;
        },
      });
      const wrapped = new Map();
      this.addEventListener = (type, listener, options) => {
        if (type !== 'message' || !listener) return super.addEventListener(type, listener, options);
        const fn = typeof listener === 'function' ? listener : (e) => listener.handleEvent(e);
        const w = wrap(fn);
        wrapped.set(listener, w);
        return super.addEventListener(type, w, options);
      };
      this.removeEventListener = (type, listener, options) => {
        if (type !== 'message' || !wrapped.has(listener)) return super.removeEventListener(type, listener, options);
        const w = wrapped.get(listener);
        wrapped.delete(listener);
        return super.removeEventListener(type, w, options);
      };
    }
  }
  window.WebSocket = StallableWebSocket;
})();`;
}

export const MIX_CONTEXT_PROBE = `(() => {
  const test = (window.__rtmtTest = window.__rtmtTest || {});
  const created = [];
  const Native = window.AudioContext;
  if (!Native) return;
  class RecordedAudioContext extends Native {
    constructor(...args) {
      super(...args);
      created.push({ ctx: this, args: args.length });
    }
  }
  window.AudioContext = RecordedAudioContext;
  test.mixContext = () => (created.find((entry) => entry.args === 0) || {}).ctx || null;
})();`;

/** Installs the stall switch (and the AudioContext probe) on the app page; call before `page.goto`. */
export async function installSpeechStall(page: Page): Promise<void> {
  await page.addInitScript({ content: stallInitScript(requireEnv('AIDH_DEP_SPEECH_STT_HOST')) });
  await page.addInitScript({ content: MIX_CONTEXT_PROBE });
}

/** Stalls the open recognizer connections; returns the trigger time (epoch ms). Fails if none was open. */
export async function stallRecognizer(page: Page): Promise<number> {
  const { at, stalled } = await page.evaluate<{ at: number; stalled: number }>(
    '(window.__rtmtTest.stallRecognizer(), { at: Date.now(), stalled: window.__rtmtTest.stalledConnections() })',
  );
  if (stalled < 1) throw new Error('no open speech recognition connection to stall');
  return at;
}
