import http from 'node:http';
import type { MemoryLogSink } from './memoryLogSink.js';

export type AbortMethod = 'abort-controller' | 'socket-destroy';
export type AbortTiming = 'before-first-delta' | 'after-first-delta';

export interface AbortOutcome {
  /** Raw response bytes the client received before it aborted (as UTF-8). */
  received: string;
}

export interface AbortRequestOptions {
  baseUrl: string;
  body: unknown;
  method: AbortMethod;
  timing: AbortTiming;
  /** Resolves once the server has started translating this request (the handler is running). */
  serverStarted: () => Promise<void>;
}

function sameOriginHeaders(baseUrl: string): Record<string, string> {
  return { origin: new URL(baseUrl).origin, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' };
}

async function viaAbortController(options: AbortRequestOptions): Promise<AbortOutcome> {
  const controller = new AbortController();
  const pending = fetch(`${options.baseUrl}/api/translations`, {
    method: 'POST',
    headers: sameOriginHeaders(options.baseUrl),
    body: JSON.stringify(options.body),
    signal: controller.signal,
  });
  if (options.timing === 'before-first-delta') {
    await options.serverStarted();
    controller.abort();
    let received = '';
    try {
      const response = await pending;
      received = `unexpected response ${response.status}`;
    } catch {
      // Expected: aborted before any response bytes arrived.
    }
    return { received };
  }
  const response = await pending;
  const reader = response.body!.getReader();
  const first = await reader.read();
  const received = first.value ? Buffer.from(first.value).toString('utf8') : '';
  controller.abort();
  await reader.closed.catch(() => undefined);
  return { received };
}

async function viaSocketDestroy(options: AbortRequestOptions): Promise<AbortOutcome> {
  const url = new URL(`${options.baseUrl}/api/translations`);
  const payload = JSON.stringify(options.body);
  return new Promise<AbortOutcome>((resolve, reject) => {
    let received = '';
    const req = http.request(url, {
      method: 'POST',
      agent: false,
      headers: { ...sameOriginHeaders(options.baseUrl), 'content-length': Buffer.byteLength(payload) },
    });
    req.on('error', () => undefined);
    req.on('close', () => resolve({ received }));
    req.on('response', (res) => {
      res.on('error', () => undefined);
      res.on('data', (chunk: Buffer) => {
        received += chunk.toString('utf8');
        if (options.timing === 'after-first-delta') req.socket?.destroy();
      });
    });
    req.end(payload);
    if (options.timing === 'before-first-delta') {
      options.serverStarted().then(() => req.socket?.destroy(), reject);
    }
  });
}

/** Sends a streaming translation request and aborts it from the client side at the requested time. */
export function abortTranslationRequest(options: AbortRequestOptions): Promise<AbortOutcome> {
  return options.method === 'abort-controller' ? viaAbortController(options) : viaSocketDestroy(options);
}

/** Waits until the sink contains the given number of client_aborted records, then a quiet period for late logs. */
export async function waitForClientAborted(sink: MemoryLogSink, fromIndex: number, timeoutMs = 10_000, quietMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (sink.records().slice(fromIndex).some((r) => r.errorCode === 'client_aborted')) {
      await new Promise((r) => setTimeout(r, quietMs));
      return;
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('client_aborted record did not appear in time');
}

/** The exact key set of the existing client_aborted record (FR-315), excluding optional request metadata. */
export const CLIENT_ABORTED_KEYS = ['durationMs', 'deltaCount', 'errorCode', 'event', 'kind', 'level', 'msg', 'reqId', 'textLength', 'time'];
export const CLIENT_ABORTED_OPTIONAL_KEYS = ['inputSource', 'sourceLanguage'];
