import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TranslationKind, TranslationLine } from '../../src/shared/contracts.js';
import { isChineseTranslation } from '../../src/shared/chineseText.js';
import { buildRealApp, type RealApp } from '../support/realApp.js';

/**
 * TD-311 / AC-13 evidence: Korean and Japanese drama-style lines (short replies, exclamations, fragments; partial and
 * final requests; some mislabeled as zh-CN like a misdetecting recognizer would) against the real chat-model
 * deployment with the new prompt. A final whose first result is not Chinese is retranslated once (`retranslate:
 * true`), like the client does; after that every final must be Chinese. Only counts are printed, never content.
 */

interface Sample {
  text: string;
  sourceLanguage: string;
  kind: TranslationKind;
}

const KO = [
  '네.',
  '아니요, 괜찮아요.',
  '진짜?',
  '어머, 세상에!',
  '오빠, 잠깐만요.',
  '사랑해.',
  '그게 무슨 말이야?',
  '미안해, 내가 다 잘못했어.',
  '빨리 와!',
  '어디 가는 거야',
  '우리 내일',
  '그 사람이 그렇게',
  '하지 마세요',
  '감사합니다, 선생님.',
  '왜 이제 와서 그런 말을 해?',
  '밥 먹었어?',
  '정말 보고 싶었어요.',
  '이 비밀은 아무한테도',
  '아이고, 큰일났다!',
  '나도 몰라.',
];

const JA = [
  'はい。',
  'いいえ、大丈夫です。',
  '本当？',
  'えっ、まさか！',
  'ちょっと待って。',
  '好きだよ。',
  'どういう意味？',
  'ごめんね、全部私のせい。',
  '早く来て！',
  'どこに行くの',
  '明日、私たち',
  'あの人がそんなに',
  'やめてください',
  'ありがとうございます、先生。',
  '今さら何を言ってるの？',
  'ご飯食べた？',
  'ずっと会いたかった。',
  'この秘密は誰にも',
  'やばい、大変だ！',
  '知らないよ。',
];

/** Every third line is a partial; every fourth is labeled zh-CN (misdetected language, TD-307). */
function samplesOf(lines: string[], language: string): Sample[] {
  return lines.map((text, i) => ({
    text,
    sourceLanguage: i % 4 === 3 ? 'zh-CN' : language,
    kind: i % 3 === 2 ? 'partial' : 'final',
  }));
}

const SAMPLES = [...samplesOf(KO, 'ko-KR'), ...samplesOf(JA, 'ja-JP')];

let real: RealApp;

beforeAll(async () => {
  real = await buildRealApp();
});

afterAll(async () => {
  await real.app.close();
});

async function translate(sample: Sample, retranslate: boolean): Promise<string> {
  const payload: Record<string, unknown> = { kind: sample.kind, text: sample.text, sourceLanguage: sample.sourceLanguage };
  if (retranslate) payload.retranslate = true;
  const response = await real.app.inject({
    method: 'POST',
    url: '/api/translations',
    headers: { ...real.sameOriginHeaders, 'content-type': 'application/json' },
    payload,
  });
  expect(response.statusCode).toBe(200);
  const lines = response.payload
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as TranslationLine);
  expect(lines.at(-1)?.type).toBe('done');
  return lines.map((line) => (line.type === 'delta' ? line.text : '')).join('');
}

async function inBatches<T, R>(items: T[], size: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  for (let i = 0; i < items.length; i += size) results.push(...(await Promise.all(items.slice(i, i + size).map(run))));
  return results;
}

describe('Korean/Japanese lines translate to Chinese with the real model (TD-307, TD-308, TD-311)', () => {
  it('every final is Chinese after at most one retranslation; counts reported without content', async () => {
    const results = await inBatches(SAMPLES, 5, async (sample) => {
      const first = isChineseTranslation(await translate(sample, false));
      if (first || sample.kind === 'partial') return { sample, first, after: first };
      return { sample, first, after: isChineseTranslation(await translate(sample, true)) };
    });

    const finals = results.filter((r) => r.sample.kind === 'final');
    const partials = results.filter((r) => r.sample.kind === 'partial');
    const counts = {
      finals: finals.length,
      finalsFirstNonChinese: finals.filter((r) => !r.first).length,
      finalsNonChineseAfterRetranslate: finals.filter((r) => !r.after).length,
      partials: partials.length,
      partialsNonChinese: partials.filter((r) => !r.first).length,
      mislabeledZh: results.filter((r) => r.sample.sourceLanguage === 'zh-CN').length,
      mislabeledZhFirstNonChinese: results.filter((r) => r.sample.sourceLanguage === 'zh-CN' && !r.first).length,
    };
    console.info(`translationChinese counts ${JSON.stringify(counts)}`);

    expect(counts.finalsNonChineseAfterRetranslate).toBe(0);
    // Retranslation requests are logged with retranslate=true and never with content.
    const retranslated = real.sink.records().filter((r) => r.event === 'translation_completed' && r.retranslate === true);
    expect(retranslated).toHaveLength(counts.finalsFirstNonChinese);
    const raw = real.sink.raw();
    for (const sample of SAMPLES) if (sample.text.length >= 4) expect(raw).not.toContain(sample.text);
  }, 300_000);
});
