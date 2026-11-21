/**
 * Chinese-translation check shared by the caption pipeline, the server prompt builder and the tests (TD-304,
 * FR-301). `Script` (not `Script_Extensions`) keeps marks shared with Japanese such as 。、・ー in Common.
 */
const HAN = /\p{Script=Han}/u;
// ー (U+30FC) is a Common-script *letter* (Lm); Common is allowed so FR-301's permitted marks really pass.
const FORBIDDEN_LETTER = /(?=\p{L})[^\p{Script=Han}\p{Script=Latin}\p{Script=Bopomofo}\p{Script=Common}]/u;

/** True when the text has a letter of any script other than Han, Latin or Bopomofo (Hangul, kana, Cyrillic…). */
export function containsForbiddenScript(text: string): boolean {
  return FORBIDDEN_LETTER.test(text);
}

/** At least one Han character and no letter outside Han/Latin/Bopomofo. All-Han Japanese passes (accepted). */
export function isChineseTranslation(text: string): boolean {
  return HAN.test(text) && !containsForbiddenScript(text);
}
