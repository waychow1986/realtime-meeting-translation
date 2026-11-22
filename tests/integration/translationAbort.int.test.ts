import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TranslationLine } from '../../src/shared/contracts.js';
import {
  abortTranslationRequest,
  CLIENT_ABORTED_KEYS,
  CLIENT_ABORTED_OPTIONAL_KEYS,
  waitForClientAborted,
  type AbortMethod,
  type AbortTiming,
} from '../support/abortClient.js';
import { buildRealApp, type RealApp } from '../support/realApp.js';
import { SecretScanner } from '../support/secretScan.js';

// AC-7, AC-8, AC-10 with the real chat-model dev instance: client aborts are not logged as error/fatal.
const SOURCE =
  '오늘 회의에 와 주셔서 감사합니다. 지난 분기 예산 검토 결과를 자세히 설명드리고, 다음 분기 계획과 일정, 그리고 각 팀의 역할에 대해 하나씩 이야기하겠습니다.';
const CJK = /[\u4e00-\u9fff]/;

let real: RealApp;
let baseUrl: string;
let notifyStarted: (() => void) | undefined;

function nextTranslationStart(): () => Promise<void> {
  const started = new Promise<void>((resolve) => {
    notifyStarted = resolve;
  });
  return () => started;
}

beforeAll(async () => {
  real = await buildRealApp(
    {},
    {
      wrapTranslator: (translator) => ({
        translate(request, options) {
          notifyStarted?.();
          notifyStarted = undefined;
          return translator.translate(request, options);
        },
      }),
    },
  );
  await real.app.listen({ host: '127.0.0.1', port: 0 });
  baseUrl = `http://127.0.0.1:${(real.app.server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await real.app.close();
});

function deltaTexts(raw: string): string[] {
  return raw
    .split('\n')
    .filter((line) => line.trim().startsWith('{') && line.trim().endsWith('}'))
    .map((line) => JSON.parse(line) as TranslationLine)
    .flatMap((line) => (line.type === 'delta' ? [line.text] : []));
}

describe('client aborts of /api/translations against the real model (AC-7, AC-8, AC-10)', () => {
  const scenarios: Array<[AbortTiming, AbortMethod, string]> = [
    ['before-first-delta', 'abort-controller', 'AC-7'],
    ['before-first-delta', 'socket-destroy', 'AC-7'],
    ['after-first-delta', 'abort-controller', 'AC-8'],
    ['after-first-delta', 'socket-destroy', 'AC-8'],
  ];

  it.each(scenarios)('%s via %s (%s): no error/fatal logs, one client_aborted record, no content or credentials', async (timing, method) => {
    const from = real.sink.records().length;
    const outcome = await abortTranslationRequest({
      baseUrl,
      body: { kind: 'final', text: SOURCE, sourceLanguage: 'ko-KR', inputSource: 'system' },
      method,
      timing,
      serverStarted: nextTranslationStart(),
    });
    if (timing === 'before-first-delta') expect(outcome.received).toBe('');
    else expect(outcome.received).toContain('"type":"delta"');

    await waitForClientAborted(real.sink, from);
    const records = real.sink.records().slice(from);
    expect(records.filter((r) => r.level === 'error' || r.level === 'fatal')).toEqual([]);
    const aborted = records.filter((r) => r.errorCode === 'client_aborted');
    expect(aborted).toHaveLength(1);
    expect(aborted[0]).toMatchObject({
      level: 'info',
      event: 'translation_completed',
      msg: 'translation aborted by client',
      kind: 'final',
      sourceLanguage: 'ko-KR',
      inputSource: 'system',
    });
    expect(Object.keys(aborted[0]!).sort()).toEqual([...CLIENT_ABORTED_KEYS, ...CLIENT_ABORTED_OPTIONAL_KEYS].sort());

    const raw = real.sink.raw();
    expect(raw).not.toContain(SOURCE.slice(0, 10));
    for (const delta of deltaTexts(outcome.received)) if (delta.trim().length >= 2) expect(raw).not.toContain(delta);
    const scanner = new SecretScanner();
    scanner.scan('server-log', raw);
    expect(scanner.hits).toEqual([]);
  });

  it('keeps serving normal translations after the aborts', async () => {
    const response = await fetch(`${baseUrl}/api/translations`, {
      method: 'POST',
      headers: { origin: baseUrl, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'final', text: SOURCE, sourceLanguage: 'ko-KR', inputSource: 'system' }),
    });
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body.trim().split('\n').at(-1)).toBe('{"type":"done"}');
    expect(deltaTexts(body).join('')).toMatch(CJK);
    expect(real.sink.records().filter((r) => r.level === 'error' || r.level === 'fatal')).toEqual([]);
  });
});
