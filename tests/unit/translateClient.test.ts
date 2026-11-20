import { describe, expect, it } from 'vitest';
import { parseNdjson, requestTranslation } from '../../src/web/translateClient.js';

function streamOf(parts: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) {
      for (const p of parts) c.enqueue(enc.encode(p));
      c.close();
    },
  });
}

describe('parseNdjson', () => {
  it('parses lines split across chunks including multi-byte characters', async () => {
    const text = '{"type":"delta","text":"大家好"}\n{"type":"done"}\n';
    const bytes = new TextEncoder().encode(text);
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(bytes.slice(0, 25));
        c.enqueue(bytes.slice(25, 27));
        c.enqueue(bytes.slice(27));
        c.close();
      },
    });
    const lines = [];
    for await (const line of parseNdjson(stream)) lines.push(line);
    expect(lines).toEqual([{ type: 'delta', text: '大家好' }, { type: 'done' }]);
  });

  it('skips malformed lines', async () => {
    const lines = [];
    for await (const line of parseNdjson(streamOf(['garbage\n{"type":"done"}']))) lines.push(line);
    expect(lines).toEqual([{ type: 'done' }]);
  });
});

describe('requestTranslation', () => {
  const ok = (body: string, init: ResponseInit = {}) => async () => new Response(streamOf([body]), { status: 200, ...init });

  it('posts JSON to /api/translations and forwards deltas', async () => {
    let seen: { url: string; init?: RequestInit } | undefined;
    const deltas: string[] = [];
    const outcome = await requestTranslation(
      { kind: 'final', text: 'Hello', sourceLanguage: 'en-US' },
      {
        signal: new AbortController().signal,
        onDelta: (t) => deltas.push(t),
        fetch: async (url, init) => {
          seen = { url: String(url), init };
          return new Response(streamOf(['{"type":"delta","text":"你"}\n{"type":"delta","text":"好"}\n{"type":"done"}\n']));
        },
      },
    );
    expect(outcome).toEqual({ ok: true });
    expect(deltas).toEqual(['你', '好']);
    expect(seen?.url).toBe('/api/translations');
    expect(seen?.init?.method).toBe('POST');
    expect(JSON.parse(String(seen?.init?.body))).toEqual({ kind: 'final', text: 'Hello', sourceLanguage: 'en-US' });
  });

  it('returns the upstream error code from an error line', async () => {
    const outcome = await requestTranslation(
      { kind: 'final', text: 'x' },
      { signal: new AbortController().signal, onDelta: () => undefined, fetch: ok('{"type":"error","code":"timeout"}\n') },
    );
    expect(outcome).toEqual({ ok: false, reason: 'timeout' });
  });

  it.each([
    [429, 'rate_limited'],
    [400, 'invalid_request'],
    [413, 'invalid_request'],
    [403, 'forbidden'],
    [502, 'http_error'],
  ])('maps HTTP %i to %s', async (status, reason) => {
    const outcome = await requestTranslation(
      { kind: 'final', text: 'x' },
      {
        signal: new AbortController().signal,
        onDelta: () => undefined,
        fetch: async () => new Response('{}', { status, headers: { 'Retry-After': '2' } }),
      },
    );
    expect(outcome).toMatchObject({ ok: false, reason });
    if (status === 429) expect(outcome).toMatchObject({ retryAfterSeconds: 2 });
  });

  it('distinguishes network failures from aborts', async () => {
    const net = await requestTranslation(
      { kind: 'final', text: 'x' },
      {
        signal: new AbortController().signal,
        onDelta: () => undefined,
        fetch: async () => {
          throw new TypeError('Failed to fetch');
        },
      },
    );
    expect(net).toEqual({ ok: false, reason: 'network' });

    const controller = new AbortController();
    controller.abort();
    const aborted = await requestTranslation(
      { kind: 'final', text: 'x' },
      {
        signal: controller.signal,
        onDelta: () => undefined,
        fetch: async () => {
          throw new DOMException('aborted', 'AbortError');
        },
      },
    );
    expect(aborted).toEqual({ ok: false, reason: 'aborted' });
  });

  it('treats a stream without a terminal line as a network failure', async () => {
    const outcome = await requestTranslation(
      { kind: 'final', text: 'x' },
      { signal: new AbortController().signal, onDelta: () => undefined, fetch: ok('{"type":"delta","text":"半"}\n') },
    );
    expect(outcome).toEqual({ ok: false, reason: 'network' });
  });
});
