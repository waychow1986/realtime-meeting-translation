import { describe, expect, it } from 'vitest';
import { containsForbiddenScript, isChineseTranslation } from '../../src/shared/chineseText.js';

describe('isChineseTranslation (FR-301)', () => {
  it.each([
    '今天晚上我们全家要在奶奶家一起吃晚饭。',
    '我们的iPhone销量在Q3增长了12%。',
    'OK，没问题！',
    '价格上涨了１５％，ＡＢＣ公司确认。',
    '请把合同发给Michael。',
    '咖啡、茶・果汁——都可以。',
  ])('accepts Chinese text: %s', (text) => {
    expect(isChineseTranslation(text)).toBe(true);
  });

  it('accepts Chinese with the Common-script marks 。、・ー', () => {
    expect(isChineseTranslation('第一、第二・第三——ー结束。')).toBe(true);
  });

  it('accepts all-Han Japanese (accepted limitation)', () => {
    expect(isChineseTranslation('東京都庁舎')).toBe(true);
  });

  it.each([
    ['Hangul syllables', '오늘 저녁에 가족과 함께'],
    ['Hangul mixed into Chinese', '今天晚上 가족 一起吃饭'],
    ['Hangul compatibility jamo', '好的ㅋㅋㅋ'],
    ['Hiragana', '明日の朝早く出発します'],
    ['Katakana', '这个ケーキ很好吃'],
    ['half-width Katakana', '这个ｹｰｷ很好吃'],
    ['Cyrillic', '你好 привет'],
    ['Thai', '你好 สวัสดี'],
    ['Arabic', '你好 مرحبا'],
    ['Greek', '阿尔法 α'],
  ])('rejects %s', (_label, text) => {
    expect(isChineseTranslation(text)).toBe(false);
  });

  it.each(['', '   ', 'Hello everyone', '12, 34%!', '。、'])('rejects text without any Han character: %j', (text) => {
    expect(isChineseTranslation(text)).toBe(false);
  });
});

describe('containsForbiddenScript', () => {
  it('is true for Hangul, kana and other non Han/Latin/Bopomofo letters', () => {
    expect(containsForbiddenScript('안녕')).toBe(true);
    expect(containsForbiddenScript('ありがとう')).toBe(true);
    expect(containsForbiddenScript('привет')).toBe(true);
  });

  it('is false for Han, Latin, Bopomofo, digits and punctuation', () => {
    expect(containsForbiddenScript('你好 Hello ㄅㄆㄇ 123，。、・ー')).toBe(false);
    expect(containsForbiddenScript('')).toBe(false);
  });
});
