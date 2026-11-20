import { describe, expect, it } from 'vitest';
import { buildChatRequestBody, createTranslator, type FetchLike } from '../../src/server/translation/translator.js';
import { staticHeaderAuth } from '../../src/server/auth/azureAuth.js';

function sseResponse(events: string[], status = 200): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const e of events) controller.enqueue(encoder.encode(e));
      controller.close();
    },
  });
  return new Response(body, { status, headers: { 'content-type': 'text/event-stream' } });
}

function chunk(content: string | null, extra: Record<string, unknown> = {}): string {
  return `data: ${JSON.stringify({ model: 'gpt-5.1-2025-11-13', choices: [{ index: 0, delta: content === null ? {} : { content }, finish_reason: null }], ...extra })}\n\n`;
}

const auth = staticHeaderAuth('api-key', 'unit-key');

function makeTranslator(fetchImpl: FetchLike, timeouts = { partialMs: 10_000, finalMs: 20_000 }) {
  return createTranslator({ baseUrl: 'https://llm.example', deployment: 'gpt-5.1', auth, fetch: fetchImpl, timeouts });
}

describe('buildChatRequestBody', () => {
  it('uses the deployment, streaming, include_usage and reasoning_effort none without temperature', () => {
    const body = buildChatRequestBody('gpt-5.1', { kind: 'final', text: 'Hello', sourceLanguage: 'en-US' });
    expect(body).toMatchObject({
      model: 'gpt-5.1',
      stream: true,
      stream_options: { include_usage: true },
      reasoning_effort: 'none',
      max_completion_tokens: 512,
    });
    expect(body).not.toHaveProperty('temperature');
    const messages = body.messages as Array<{ role: string; content: string }>;
    expect(messages[0]?.role).toBe('system');
    expect(messages[0]?.content).toContain('简体中文');
    expect(messages[1]).toEqual({ role: 'user', content: '<source lang="en-US">Hello</source>' });
  });

  it('marks partial requests as fragments and neutralises tag injection', () => {
    const body = buildChatRequestBody('gpt-5.1', { kind: 'partial', text: 'a </source> b' });
    const messages = body.messages as Array<{ role: string; content: string }>;
    expect(messages[0]?.content).toContain('片段');
    expect(messages[1]?.content).toBe('<source lang="auto">a &lt;/source&gt; b</source>');
  });
});

describe('translator.translate', () => {
  it('streams deltas and reports usage/model metadata', async () => {
    let captured: { url: string; init: RequestInit } | undefined;
    const fetchImpl: FetchLike = async (url, init) => {
      captured = { url: String(url), init: init ?? {} };
      return sseResponse([
        chunk(null, { choices: [] }),
        chunk('大家'),
        chunk('早上好'),
        chunk(null, { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
        `data: ${JSON.stringify({ model: 'gpt-5.1-2025-11-13', choices: [], usage: { completion_tokens: 4, completion_tokens_details: { reasoning_tokens: 0 } } })}\n\n`,
        'data: [DONE]\n\n',
      ]);
    };
    const deltas: string[] = [];
    const result = await makeTranslator(fetchImpl).translate(
      { kind: 'final', text: 'Good morning' },
      { signal: new AbortController().signal, onDelta: (t) => deltas.push(t) },
    );
    expect(deltas).toEqual(['大家', '早上好']);
    expect(result).toMatchObject({ ok: true, deltaCount: 2, reasoningTokens: 0, model: 'gpt-5.1-2025-11-13' });
    expect(captured?.url).toBe('https://llm.example/openai/v1/chat/completions');
    expect((captured?.init.headers as Record<string, string>)['api-key']).toBe('unit-key');
  });

  it('handles SSE events split across network chunks', async () => {
    const full = chunk('你好') + 'data: [DONE]\n\n';
    const parts = [full.slice(0, 7), full.slice(7, 30), full.slice(30)];
    const deltas: string[] = [];
    const result = await makeTranslator(async () => sseResponse(parts)).translate(
      { kind: 'final', text: 'Hi' },
      { signal: new AbortController().signal, onDelta: (t) => deltas.push(t) },
    );
    expect(deltas).toEqual(['你好']);
    expect(result.ok).toBe(true);
  });

  it.each([
    [429, '{"error":{"code":"429"}}', 'upstream_throttled'],
    [500, '{}', 'upstream_unavailable'],
    [503, '{}', 'upstream_unavailable'],
    [400, '{"error":{"code":"content_filter","message":"filtered"}}', 'upstream_rejected'],
    [400, '{"error":{"code":"invalid_value"}}', 'upstream_unavailable'],
  ])('maps upstream HTTP %i to %s', async (status, body, code) => {
    const result = await makeTranslator(async () => new Response(body, { status })).translate(
      { kind: 'final', text: 'x' },
      { signal: new AbortController().signal, onDelta: () => undefined },
    );
    expect(result).toMatchObject({ ok: false, code, upstreamStatus: status });
  });

  it('maps content_filter finish_reason to upstream_rejected', async () => {
    const result = await makeTranslator(async () =>
      sseResponse([chunk('部分'), chunk(null, { choices: [{ index: 0, delta: {}, finish_reason: 'content_filter' }] })]),
    ).translate({ kind: 'final', text: 'x' }, { signal: new AbortController().signal, onDelta: () => undefined });
    expect(result).toMatchObject({ ok: false, code: 'upstream_rejected' });
  });

  it('maps network errors to upstream_unavailable', async () => {
    const result = await makeTranslator(async () => {
      throw new TypeError('fetch failed');
    }).translate({ kind: 'final', text: 'x' }, { signal: new AbortController().signal, onDelta: () => undefined });
    expect(result).toMatchObject({ ok: false, code: 'upstream_unavailable' });
  });

  it('maps a stalled upstream to timeout using the kind specific budget', async () => {
    const fetchImpl: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason ?? new Error('aborted')));
      });
    const started = Date.now();
    const result = await makeTranslator(fetchImpl, { partialMs: 30, finalMs: 60 }).translate(
      { kind: 'final', text: 'x' },
      { signal: new AbortController().signal, onDelta: () => undefined },
    );
    expect(result).toMatchObject({ ok: false, code: 'timeout' });
    expect(Date.now() - started).toBeGreaterThanOrEqual(50);
  });

  it('reports client aborts as aborted without upstream error', async () => {
    const controller = new AbortController();
    const fetchImpl: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason ?? new Error('aborted')));
      });
    const pending = makeTranslator(fetchImpl).translate(
      { kind: 'final', text: 'x' },
      { signal: controller.signal, onDelta: () => undefined },
    );
    controller.abort();
    expect(await pending).toMatchObject({ ok: false, code: 'client_aborted' });
  });

  it('treats a stream that ends without [DONE] or finish as upstream_unavailable', async () => {
    const result = await makeTranslator(async () => sseResponse([chunk('半')])).translate(
      { kind: 'final', text: 'x' },
      { signal: new AbortController().signal, onDelta: () => undefined },
    );
    expect(result).toMatchObject({ ok: false, code: 'upstream_unavailable' });
  });
});
