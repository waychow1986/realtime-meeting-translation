import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp, type AppDeps } from '../../src/server/http/app.js';
import { loadConfig } from '../../src/server/config.js';
import { createLogger } from '../../src/server/logger.js';
import { UpstreamError } from '../../src/server/errors.js';
import type { Translator, TranslateResult } from '../../src/server/translation/translator.js';
import { MemoryLogSink } from '../support/memoryLogSink.js';
import type { AddressInfo } from 'node:net';
import {
  abortTranslationRequest,
  CLIENT_ABORTED_KEYS,
  CLIENT_ABORTED_OPTIONAL_KEYS,
  waitForClientAborted,
  type AbortMethod,
  type AbortTiming,
} from '../support/abortClient.js';

const SECRET = 'unit-app-secret-key-123';
const ORIGIN = 'http://app.test';
const SAME = { origin: ORIGIN, host: 'app.test', 'sec-fetch-site': 'same-origin' };

let webRoot: string;

beforeAll(async () => {
  webRoot = await mkdtemp(path.join(os.tmpdir(), 'web-root-'));
  await writeFile(path.join(webRoot, 'index.html'), '<!doctype html><title>t</title>');
  await writeFile(path.join(webRoot, 'app.js'), 'console.debug(1)');
  await writeFile(path.join(webRoot, 'styles.css'), 'body{}');
});

afterAll(async () => {
  await rm(webRoot, { recursive: true, force: true });
});

function config(overrides: Record<string, string> = {}) {
  return loadConfig({
    AIDH_DEP_SPEECH_ENDPOINT: 'speech.example:443',
    AIDH_DEP_SPEECH_STT_HOST: 'eastus2.stt.speech.microsoft.com:443',
    AIDH_DEP_SPEECH_REGION: 'eastus2',
    AIDH_DEP_SPEECH_AUTH_MODE: 'credential',
    AIDH_DEP_SPEECH_KEY: SECRET,
    AIDH_DEP_CHAT_MODEL_ENDPOINT: 'llm.example:443',
    AIDH_DEP_CHAT_MODEL_DEPLOYMENT: 'gpt-5.1',
    AIDH_DEP_CHAT_MODEL_AUTH_MODE: 'credential',
    AIDH_DEP_CHAT_MODEL_KEY: SECRET,
    ...overrides,
  });
}

interface Harness {
  app: FastifyInstance;
  sink: MemoryLogSink;
}

async function harness(partial: Partial<AppDeps> = {}, env: Record<string, string> = {}): Promise<Harness> {
  const sink = new MemoryLogSink();
  const translator: Translator = {
    async translate(_req, { onDelta }): Promise<TranslateResult> {
      onDelta('你好');
      onDelta('世界');
      return { ok: true, deltaCount: 2, ttfbMs: 5, reasoningTokens: 0, model: 'gpt-5.1-2025-11-13' };
    },
  };
  const app = await buildApp({
    config: config(env),
    logger: createLogger({ level: 'info', destination: sink }),
    tokenService: { getToken: async () => 'speech-token-abc' },
    translator,
    webRoot,
    ...partial,
  });
  await app.ready();
  return { app, sink };
}

function ndjson(body: string): unknown[] {
  return body
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l));
}

describe('GET /healthz', () => {
  it('returns ok without touching upstreams', async () => {
    const { app } = await harness({
      tokenService: {
        getToken: async () => {
          throw new Error('should not be called');
        },
      },
    });
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
    await app.close();
  });
});

describe('static assets', () => {
  it('serves index.html with security headers', async () => {
    const { app } = await harness();
    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    const csp = String(res.headers['content-security-policy']);
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain('connect-src \'self\' wss://eastus2.stt.speech.microsoft.com https://eastus2.stt.speech.microsoft.com');
    expect(csp).toContain("frame-ancestors 'none'");
    expect(res.headers['permissions-policy']).toBe('microphone=(self), display-capture=(self)');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    await app.close();
  });

  it('serves app.js and styles.css and 404s unknown paths as JSON', async () => {
    const { app } = await harness();
    expect((await app.inject({ url: '/app.js' })).statusCode).toBe(200);
    expect((await app.inject({ url: '/styles.css' })).statusCode).toBe(200);
    const res = await app.inject({ url: '/history' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'not_found' });
    await app.close();
  });
});

describe('POST /api/speech-token', () => {
  it('returns a short-lived token and recognition settings for same-origin callers', async () => {
    const { app, sink } = await harness();
    const res = await app.inject({ method: 'POST', url: '/api/speech-token', headers: SAME });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.json()).toEqual({
      token: 'speech-token-abc',
      sttEndpoint: 'wss://eastus2.stt.speech.microsoft.com/speech/universal/v2',
      candidateLanguages: ['en-US', 'zh-CN', 'ja-JP', 'ko-KR'],
      segmentationSilenceMs: 800,
      refreshAfterSeconds: 240,
    });
    expect(res.body).not.toContain(SECRET);
    expect(sink.raw()).not.toContain('speech-token-abc');
    await app.close();
  });

  it.each([
    [{ host: 'app.test' }],
    [{ origin: 'http://evil.test', host: 'app.test' }],
    [{ origin: ORIGIN, host: 'app.test', 'sec-fetch-site': 'cross-site' }],
    [{ origin: 'null', host: 'app.test' }],
  ])('rejects cross-origin callers %j', async (headers) => {
    const { app } = await harness();
    const res = await app.inject({ method: 'POST', url: '/api/speech-token', headers });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'forbidden_origin' });
    await app.close();
  });

  it('accepts the forwarded host behind a trusted proxy', async () => {
    const { app } = await harness();
    const res = await app.inject({
      method: 'POST',
      url: '/api/speech-token',
      headers: { origin: 'https://public.example', host: 'internal:8080', 'x-forwarded-host': 'public.example' },
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('ignores the forwarded host when no proxy is trusted', async () => {
    const { app } = await harness({}, { TRUSTED_PROXY_HOPS: '0' });
    const res = await app.inject({
      method: 'POST',
      url: '/api/speech-token',
      headers: { origin: 'https://public.example', host: 'internal:8080', 'x-forwarded-host': 'public.example' },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('maps upstream failures to 502 and logs speech_token_failed without detail', async () => {
    const { app, sink } = await harness({
      tokenService: {
        getToken: async () => {
          throw new UpstreamError('speech-sts', 401);
        },
      },
    });
    const res = await app.inject({ method: 'POST', url: '/api/speech-token', headers: SAME });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({ error: 'upstream_unavailable' });
    const failure = sink.records().find((r) => r.event === 'speech_token_failed');
    expect(failure).toMatchObject({ level: 'error', upstream: 'speech-sts', upstreamStatus: 401 });
    await app.close();
  });

  it('rate limits per client address with Retry-After', async () => {
    const { app } = await harness({ limits: { speechTokenPerMinute: 2, partialPerMinute: 10, finalPerMinute: 10 } });
    const call = (ip: string) =>
      app.inject({ method: 'POST', url: '/api/speech-token', headers: { ...SAME, 'x-forwarded-for': ip }, remoteAddress: '10.0.0.1' });
    expect((await call('203.0.113.1')).statusCode).toBe(200);
    expect((await call('203.0.113.1')).statusCode).toBe(200);
    const limited = await call('203.0.113.1');
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toEqual({ error: 'rate_limited' });
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    expect((await call('203.0.113.2')).statusCode).toBe(200);
    await app.close();
  });

  it('does not let clients spoof X-Forwarded-For beyond the trusted hop count', async () => {
    const { app } = await harness({ limits: { speechTokenPerMinute: 1, partialPerMinute: 10, finalPerMinute: 10 } });
    const call = (spoof: string) =>
      app.inject({
        method: 'POST',
        url: '/api/speech-token',
        headers: { ...SAME, 'x-forwarded-for': `${spoof}, 198.51.100.9` },
        remoteAddress: '10.0.0.1',
      });
    expect((await call('1.1.1.1')).statusCode).toBe(200);
    expect((await call('2.2.2.2')).statusCode).toBe(429);
    await app.close();
  });
});

describe('POST /api/translations', () => {
  const post = (app: FastifyInstance, payload: unknown, headers: Record<string, string> = SAME) =>
    app.inject({ method: 'POST', url: '/api/translations', headers: { ...headers, 'content-type': 'application/json' }, payload: JSON.stringify(payload) });

  it('streams NDJSON deltas and exactly one done line', async () => {
    const { app, sink } = await harness();
    const res = await post(app, { kind: 'final', text: 'Hello world', sourceLanguage: 'en-US' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/x-ndjson; charset=utf-8');
    expect(res.headers['cache-control']).toBe('no-store, no-transform');
    expect(res.headers['x-accel-buffering']).toBe('no');
    expect(ndjson(res.body)).toEqual([
      { type: 'delta', text: '你好' },
      { type: 'delta', text: '世界' },
      { type: 'done' },
    ]);
    const done = sink.records().find((r) => r.event === 'translation_completed');
    expect(done).toMatchObject({ kind: 'final', textLength: 11, deltaCount: 2, reasoningTokens: 0, sourceLanguage: 'en-US' });
    expect(sink.raw()).not.toContain('Hello world');
    expect(sink.raw()).not.toContain('你好');
    await app.close();
  });

  it('accepts inputSource and logs it with translation_completed (TD-112)', async () => {
    const { app, sink } = await harness();
    const res = await post(app, { kind: 'partial', text: 'Hello world', sourceLanguage: 'en-US', inputSource: 'system' });
    expect(res.statusCode).toBe(200);
    expect(ndjson(res.body).at(-1)).toEqual({ type: 'done' });
    const done = sink.records().find((r) => r.event === 'translation_completed');
    expect(done).toMatchObject({ kind: 'partial', inputSource: 'system', sourceLanguage: 'en-US' });
    expect(sink.raw()).not.toContain('Hello world');
    await app.close();
  });

  it('passes retranslate to the translator and logs it only on retranslation success/upstream_error records (TD-308, TD-312)', async () => {
    const seen: unknown[] = [];
    let fail = false;
    const { app, sink } = await harness({
      translator: {
        async translate(req, { onDelta }) {
          seen.push(req.retranslate);
          if (fail) return { ok: false, code: 'upstream_unavailable', upstreamStatus: 503, deltaCount: 0 };
          onDelta('你好');
          return { ok: true, deltaCount: 1 };
        },
      },
    });
    expect((await post(app, { kind: 'final', text: '안녕하세요', retranslate: true })).statusCode).toBe(200);
    expect((await post(app, { kind: 'final', text: '안녕하세요', retranslate: false })).statusCode).toBe(200);
    expect((await post(app, { kind: 'final', text: '안녕하세요' })).statusCode).toBe(200);
    expect((await post(app, { kind: 'partial', text: '안녕', retranslate: false })).statusCode).toBe(200);
    fail = true;
    expect((await post(app, { kind: 'final', text: '안녕하세요', retranslate: true })).statusCode).toBe(200);
    expect((await post(app, { kind: 'final', text: '안녕하세요' })).statusCode).toBe(200);
    expect(seen).toEqual([true, false, undefined, false, true, undefined]);

    const completed = sink.records().filter((r) => r.event === 'translation_completed');
    expect(completed.map((r) => r.retranslate)).toEqual([true, undefined, undefined, undefined]);
    const upstream = sink.records().filter((r) => r.event === 'upstream_error');
    expect(upstream.map((r) => r.retranslate)).toEqual([true, undefined]);
    expect(sink.raw()).not.toContain('안녕');
    await app.close();
  });

  it('does not add retranslate to client_aborted records (FR-315)', async () => {
    const { app, sink } = await harness({
      translator: { translate: async () => ({ ok: false, code: 'client_aborted', deltaCount: 0 }) },
    });
    await post(app, { kind: 'final', text: '안녕하세요', retranslate: true });
    const aborted = sink.records().filter((r) => r.errorCode === 'client_aborted');
    expect(aborted).toHaveLength(1);
    expect(aborted[0]).not.toHaveProperty('retranslate');
    await app.close();
  });

  it('ends the stream with an error line and logs upstream_error on upstream failure', async () => {
    const { app, sink } = await harness({
      translator: {
        async translate(_r, { onDelta }) {
          onDelta('部分');
          return { ok: false, code: 'upstream_throttled', upstreamStatus: 429, deltaCount: 1 };
        },
      },
    });
    const res = await post(app, { kind: 'final', text: 'Hi' });
    expect(res.statusCode).toBe(200);
    expect(ndjson(res.body)).toEqual([
      { type: 'delta', text: '部分' },
      { type: 'error', code: 'upstream_throttled' },
    ]);
    expect(sink.records().find((r) => r.event === 'upstream_error')).toMatchObject({
      level: 'warn',
      upstream: 'chat-model',
      upstreamStatus: 429,
      errorCode: 'upstream_throttled',
    });
    await app.close();
  });

  it.each([
    [{ kind: 'final' }],
    [{ kind: 'other', text: 'x' }],
    [{ kind: 'final', text: '   ' }],
    [{ kind: 'final', text: 'x'.repeat(2001) }],
    [{ kind: 'final', text: 'x', sourceLanguage: 'English!' }],
    [{ kind: 'final', text: 'x', extra: 1 }],
    [{ kind: 'final', text: 'x', inputSource: 'camera' }],
    [{ kind: 'final', text: 'x', inputSource: 1 }],
    [{ kind: 'final', text: 'x', retranslate: 'yes' }],
    [{ kind: 'final', text: 'x', retranslate: 1 }],
    [{ kind: 'partial', text: 'x', retranslate: true }],
  ])('rejects invalid bodies %#', async (payload) => {
    const { app } = await harness();
    const res = await post(app, payload);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'invalid_request' });
    await app.close();
  });

  it('rejects bodies over 8KB with 413', async () => {
    const { app } = await harness();
    const res = await post(app, { kind: 'final', text: 'x'.repeat(9000) });
    expect(res.statusCode).toBe(413);
    expect(res.json()).toEqual({ error: 'payload_too_large' });
    await app.close();
  });

  it('rejects malformed JSON with 400', async () => {
    const { app } = await harness();
    const res = await app.inject({
      method: 'POST',
      url: '/api/translations',
      headers: { ...SAME, 'content-type': 'application/json' },
      payload: '{"kind":',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'invalid_request' });
    await app.close();
  });

  it('rejects cross-origin translation requests', async () => {
    const { app } = await harness();
    const res = await post(app, { kind: 'final', text: 'x' }, { origin: 'http://evil.test', host: 'app.test' });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('uses separate rate buckets for partial and final', async () => {
    const { app } = await harness({ limits: { speechTokenPerMinute: 10, partialPerMinute: 1, finalPerMinute: 1 } });
    expect((await post(app, { kind: 'partial', text: 'a' })).statusCode).toBe(200);
    expect((await post(app, { kind: 'partial', text: 'a' })).statusCode).toBe(429);
    expect((await post(app, { kind: 'final', text: 'a' })).statusCode).toBe(200);
    await app.close();
  });
});

interface GatedTranslator {
  translator: Translator;
  started: () => Promise<void>;
}

/** Controlled translator: waits `firstDeltaMs` (or until aborted), then emits a delta every 50 ms until aborted. */
function gatedTranslator(firstDeltaMs: number, onAbort: 'return' | 'throw' = 'return'): GatedTranslator {
  let markStarted: () => void = () => undefined;
  const startedPromise = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const sleep = (ms: number, signal: AbortSignal) =>
    new Promise<boolean>((resolve) => {
      if (signal.aborted) return resolve(false);
      const timer = setTimeout(() => resolve(true), ms);
      signal.addEventListener('abort', () => {
        clearTimeout(timer);
        resolve(false);
      });
    });
  return {
    started: () => startedPromise,
    translator: {
      async translate(_req, { signal, onDelta }): Promise<TranslateResult> {
        markStarted();
        let deltaCount = 0;
        let ok = await sleep(firstDeltaMs, signal);
        while (ok && deltaCount < 200) {
          onDelta('译文片段');
          deltaCount += 1;
          ok = await sleep(50, signal);
        }
        if (onAbort === 'throw') throw new DOMException('This operation was aborted', 'AbortError');
        return { ok: false, code: 'client_aborted', deltaCount };
      },
    },
  };
}

describe('client aborts on /api/translations (TD-301, TD-302; AC-7, AC-8, AC-10)', () => {
  const SOURCE_TEXT = 'Sensitive source sentence for abort test';
  const scenarios: Array<[AbortTiming, AbortMethod]> = [
    ['before-first-delta', 'abort-controller'],
    ['before-first-delta', 'socket-destroy'],
    ['after-first-delta', 'abort-controller'],
    ['after-first-delta', 'socket-destroy'],
  ];

  async function listen(translator: GatedTranslator) {
    const h = await harness({ translator: translator.translator });
    await h.app.listen({ host: '127.0.0.1', port: 0 });
    const address = h.app.server.address() as AddressInfo;
    return { ...h, baseUrl: `http://127.0.0.1:${address.port}` };
  }

  it.each(scenarios)('%s via %s: no error/fatal logs and exactly one client_aborted record', async (timing, method) => {
    const gated = gatedTranslator(timing === 'before-first-delta' ? 60_000 : 0);
    const { app, sink, baseUrl } = await listen(gated);
    const outcome = await abortTranslationRequest({
      baseUrl,
      body: { kind: 'partial', text: SOURCE_TEXT, sourceLanguage: 'ko-KR', inputSource: 'system' },
      method,
      timing,
      serverStarted: gated.started,
    });
    if (timing === 'before-first-delta') expect(outcome.received).toBe('');
    else expect(outcome.received).toContain('"type":"delta"');

    await waitForClientAborted(sink, 0, 5_000);
    const records = sink.records();
    expect(records.filter((r) => r.level === 'error' || r.level === 'fatal')).toEqual([]);
    const aborted = records.filter((r) => r.errorCode === 'client_aborted');
    expect(aborted).toHaveLength(1);
    expect(aborted[0]).toMatchObject({ level: 'info', event: 'translation_completed', msg: 'translation aborted by client', kind: 'partial' });
    expect(Object.keys(aborted[0]!).sort()).toEqual([...CLIENT_ABORTED_KEYS, ...CLIENT_ABORTED_OPTIONAL_KEYS].sort());
    if (timing === 'before-first-delta') expect(aborted[0]!.deltaCount).toBe(0);
    else expect(aborted[0]!.deltaCount).toBeGreaterThanOrEqual(1);
    expect(sink.raw()).not.toContain(SOURCE_TEXT);
    expect(sink.raw()).not.toContain('译文片段');
    expect(sink.raw()).not.toContain(SECRET);
    await app.close();
  });

  it.each(scenarios)(
    '%s via %s: an abort-class exception from the translator after the client closed is logged as client_aborted (info)',
    async (timing, method) => {
      const gated = gatedTranslator(timing === 'before-first-delta' ? 60_000 : 0, 'throw');
      const { app, sink, baseUrl } = await listen(gated);
      await abortTranslationRequest({ baseUrl, body: { kind: 'final', text: SOURCE_TEXT }, method, timing, serverStarted: gated.started });
      await waitForClientAborted(sink, 0, 5_000);
      const records = sink.records();
      expect(records.filter((r) => r.level === 'error' || r.level === 'fatal')).toEqual([]);
      const aborted = records.filter((r) => r.errorCode === 'client_aborted');
      expect(aborted).toHaveLength(1);
      expect(Object.keys(aborted[0]!).sort()).toEqual([...CLIENT_ABORTED_KEYS].sort());
      if (timing === 'before-first-delta') expect(aborted[0]!.deltaCount).toBe(0);
      else expect(aborted[0]!.deltaCount).toBeGreaterThanOrEqual(1);
      await app.close();
    },
  );
});

describe('error handling', () => {
  it('logs an unexpected translator exception as one unhandled_error at error level (AC-9)', async () => {
    const { app, sink } = await harness({
      translator: {
        async translate() {
          throw new Error('boom');
        },
      },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/translations',
      headers: { ...SAME, 'content-type': 'application/json' },
      payload: JSON.stringify({ kind: 'final', text: 'x' }),
    });
    expect(ndjson(res.body)).toEqual([{ type: 'error', code: 'upstream_unavailable' }]);
    const errors = sink.records().filter((r) => r.level === 'error' || r.level === 'fatal');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ level: 'error', event: 'unhandled_error', route: '/api/translations', errorCode: 'internal_error' });
    expect(sink.records().some((r) => r.errorCode === 'client_aborted')).toBe(false);
    await app.close();
  });

  it('still logs an abort-class exception at error level when the client did not close (AC-9)', async () => {
    const { app, sink } = await harness({
      translator: {
        async translate() {
          throw new DOMException('This operation was aborted', 'AbortError');
        },
      },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/translations',
      headers: { ...SAME, 'content-type': 'application/json' },
      payload: JSON.stringify({ kind: 'final', text: 'x' }),
    });
    expect(ndjson(res.body)).toEqual([{ type: 'error', code: 'upstream_unavailable' }]);
    const errors = sink.records().filter((r) => r.level === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ event: 'unhandled_error', errorClass: 'AbortError', errorCode: 'internal_error' });
    expect(sink.records().some((r) => r.errorCode === 'client_aborted')).toBe(false);
    await app.close();
  });

  it('logs an exception thrown after deltas were written at error level (AC-9)', async () => {
    const { app, sink } = await harness({
      translator: {
        async translate(_r, { onDelta }) {
          onDelta('部分');
          throw new Error('late boom');
        },
      },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/translations',
      headers: { ...SAME, 'content-type': 'application/json' },
      payload: JSON.stringify({ kind: 'final', text: 'x' }),
    });
    expect(ndjson(res.body)).toEqual([
      { type: 'delta', text: '部分' },
      { type: 'error', code: 'upstream_unavailable' },
    ]);
    expect(sink.records().filter((r) => r.level === 'error')).toHaveLength(1);
    await app.close();
  });

  it('returns internal_error without leaking details', async () => {
    const { app, sink } = await harness({
      translator: {
        async translate() {
          throw new Error(`boom ${SECRET}`);
        },
      },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/translations',
      headers: { ...SAME, 'content-type': 'application/json' },
      payload: JSON.stringify({ kind: 'final', text: 'x' }),
    });
    expect(res.body).not.toContain(SECRET);
    expect(sink.raw()).not.toContain(SECRET);
    expect(sink.raw()).not.toContain('boom');
    await app.close();
  });
});
