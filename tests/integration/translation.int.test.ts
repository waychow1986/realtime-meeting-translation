import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TranslationLine } from '../../src/shared/contracts.js';
import { createTranslator } from '../../src/server/translation/translator.js';
import { chatAuth } from '../../src/server/auth/azureAuth.js';
import { buildRealApp, type RealApp } from '../support/realApp.js';
import { SecretScanner } from '../support/secretScan.js';

const SOURCE = 'Thank you all for coming, the quarterly budget review will start in five minutes.';
const CJK = /[\u4e00-\u9fff]/;

let real: RealApp;

beforeAll(async () => {
  real = await buildRealApp();
});

afterAll(async () => {
  await real.app.close();
});

function parseLines(payload: string): TranslationLine[] {
  return payload
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as TranslationLine);
}

describe('streaming Chinese translation with the real model deployment (AC-03, AC-07, AC-09)', () => {
  it('streams Chinese deltas with reasoning disabled and logs only whitelisted metadata', async () => {
    const response = await real.app.inject({
      method: 'POST',
      url: '/api/translations',
      headers: { ...real.sameOriginHeaders, 'content-type': 'application/json' },
      payload: { kind: 'final', text: SOURCE, sourceLanguage: 'en-US' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('application/x-ndjson');
    const lines = parseLines(response.payload);
    const deltas = lines.filter((line): line is { type: 'delta'; text: string } => line.type === 'delta');
    expect(lines.at(-1)).toEqual({ type: 'done' });
    expect(deltas.length).toBeGreaterThanOrEqual(2);
    const caption = deltas.map((d) => d.text).join('');
    expect(caption).toMatch(CJK);
    expect(caption).not.toMatch(/budget|review|minutes/i);

    const completed = real.sink.records().find((r) => r.event === 'translation_completed');
    expect(completed).toMatchObject({ kind: 'final', sourceLanguage: 'en-US', reasoningTokens: 0 });
    expect(String(completed?.model)).toMatch(/^gpt-/);

    const raw = real.sink.raw();
    expect(raw).not.toContain('budget');
    expect(raw).not.toContain(caption);
    for (const delta of deltas) if (delta.text.length >= 2) expect(raw).not.toContain(delta.text);
    const scanner = new SecretScanner();
    scanner.scan('server-log', raw);
    expect(scanner.hits).toEqual([]);
  });

  it('translates system-audio requests and logs inputSource=system without text (TD-112)', async () => {
    const before = real.sink.records().length;
    const response = await real.app.inject({
      method: 'POST',
      url: '/api/translations',
      headers: { ...real.sameOriginHeaders, 'content-type': 'application/json' },
      payload: { kind: 'final', text: SOURCE, sourceLanguage: 'en-US', inputSource: 'system' },
    });
    expect(response.statusCode).toBe(200);
    const lines = parseLines(response.payload);
    expect(lines.at(-1)).toEqual({ type: 'done' });
    const caption = lines.map((line) => (line.type === 'delta' ? line.text : '')).join('');
    expect(caption).toMatch(CJK);
    const completed = real.sink
      .records()
      .slice(before)
      .find((r) => r.event === 'translation_completed');
    expect(completed).toMatchObject({ kind: 'final', inputSource: 'system', sourceLanguage: 'en-US', reasoningTokens: 0 });
    const raw = real.sink.raw();
    expect(raw).not.toContain('budget');
    expect(raw).not.toContain(caption);

    const invalid = await real.app.inject({
      method: 'POST',
      url: '/api/translations',
      headers: { ...real.sameOriginHeaders, 'content-type': 'application/json' },
      payload: { kind: 'final', text: SOURCE, inputSource: 'screen' },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toEqual({ error: 'invalid_request' });
  });

  it('maps a missing model deployment to a safe error code without leaking upstream messages', async () => {
    const translator = createTranslator({
      baseUrl: real.config.chat.baseUrl,
      deployment: 'deployment-that-does-not-exist',
      auth: chatAuth(real.config.chat.auth),
    });
    const deltas: string[] = [];
    const result = await translator.translate(
      { kind: 'final', text: SOURCE, sourceLanguage: 'en-US' },
      { signal: new AbortController().signal, onDelta: (t) => deltas.push(t) },
    );
    expect(deltas).toEqual([]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(['upstream_unavailable', 'upstream_rejected']).toContain(result.code);
      expect(result.upstreamStatus).toBeGreaterThanOrEqual(400);
    }
  });
});
