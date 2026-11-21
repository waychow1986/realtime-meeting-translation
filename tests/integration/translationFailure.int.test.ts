import { afterEach, describe, expect, it } from 'vitest';
import type { TranslationLine } from '../../src/shared/contracts.js';
import type { Translator } from '../../src/server/translation/translator.js';
import { buildRealApp, type RealApp } from '../support/realApp.js';
import { SecretScanner } from '../support/secretScan.js';

// AC-9 (decision D-301): a genuinely unexpected server-side exception is still logged at error level.
// The failure is injected around the real translator; everything else is the real application and model.
const SOURCE = '오늘 회의에 와 주셔서 감사합니다. 지난 분기 예산 검토 결과를 설명드리겠습니다.';

class InjectedFailure extends Error {
  override name = 'InjectedFailure';
}

const throwBeforeFirstDelta = (): Translator => ({
  async translate() {
    throw new InjectedFailure(`injected ${SOURCE}`);
  },
});

const throwAfterFirstDelta = (real: Translator): Translator => ({
  async translate(request, { signal, onDelta }) {
    const upstream = new AbortController();
    const combined = AbortSignal.any([signal, upstream.signal]);
    let firstDelta: (() => void) | undefined;
    const gotDelta = new Promise<void>((resolve) => {
      firstDelta = resolve;
    });
    const running = real.translate(request, {
      signal: combined,
      onDelta: (text) => {
        if (!firstDelta) return;
        onDelta(text);
        firstDelta();
        firstDelta = undefined;
      },
    });
    await Promise.race([gotDelta, running]);
    upstream.abort();
    await running;
    throw new InjectedFailure(`injected ${SOURCE}`);
  },
});

let real: RealApp | undefined;

afterEach(async () => {
  await real?.app.close();
  real = undefined;
});

async function translate(app: RealApp): Promise<TranslationLine[]> {
  const response = await app.app.inject({
    method: 'POST',
    url: '/api/translations',
    headers: { ...app.sameOriginHeaders, 'content-type': 'application/json' },
    payload: { kind: 'final', text: SOURCE, sourceLanguage: 'ko-KR', inputSource: 'system' },
  });
  expect(response.statusCode).toBe(200);
  return response.payload
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as TranslationLine);
}

function expectSingleErrorWithoutContent(app: RealApp): void {
  const records = app.sink.records();
  const errors = records.filter((r) => r.level === 'error' || r.level === 'fatal');
  expect(errors).toHaveLength(1);
  expect(errors[0]).toMatchObject({
    level: 'error',
    event: 'unhandled_error',
    route: '/api/translations',
    errorClass: 'InjectedFailure',
    errorCode: 'internal_error',
  });
  expect(records.some((r) => r.errorCode === 'client_aborted')).toBe(false);
  const raw = app.sink.raw();
  expect(raw).not.toContain(SOURCE.slice(0, 10));
  expect(raw).not.toContain('injected');
  const scanner = new SecretScanner();
  scanner.scan('server-log', raw);
  expect(scanner.hits).toEqual([]);
}

describe('unexpected exceptions on /api/translations (AC-9)', () => {
  it('logs one error-level unhandled_error when the failure happens before the first delta', async () => {
    real = await buildRealApp({}, { wrapTranslator: () => throwBeforeFirstDelta() });
    const lines = await translate(real);
    expect(lines).toEqual([{ type: 'error', code: 'upstream_unavailable' }]);
    expectSingleErrorWithoutContent(real);
  });

  it('logs one error-level unhandled_error when the failure happens after a delta was written', async () => {
    real = await buildRealApp({}, { wrapTranslator: throwAfterFirstDelta });
    const lines = await translate(real);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ type: 'delta' });
    expect(lines[1]).toEqual({ type: 'error', code: 'upstream_unavailable' });
    expectSingleErrorWithoutContent(real);
  });
});
