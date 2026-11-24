import type { BrowserContext, Page } from '@playwright/test';

/**
 * Controlled trigger for non-Chinese model output (TD-310): an init script wraps `window.fetch` in the app page
 * and replaces only the matching `/api/translations` responses; every other request goes to the real service.
 * Playwright response routing is deliberately not used (it broke the caption window's stylesheet loading).
 * Production code has no test switch.
 */
export type OverrideRule =
  | {
      kind: 'final';
      /** 1-based sentence ordinal: order in which the recognized text first appears in a final request. */
      sentence: number;
      /** `first`: the sentence's first (non-retranslate) final request; `retranslate`: every retranslate request. */
      attempt: 'first' | 'retranslate';
      /** `hangul`: answer with a Hangul NDJSON stream; `delay`: forward to the real service after `delayMs`. */
      action: 'hangul' | 'delay';
      delayMs?: number;
    }
  | {
      kind: 'partial';
      /** 1-based ordinal among all partial requests of the page. */
      nth: number;
      action: 'hangul';
      delayMs?: number;
    };

export interface TranslationCall {
  at: number;
  kind: 'partial' | 'final';
  retranslate: boolean;
  /** Sentence ordinal for final requests, null for partial ones. */
  sentence: number | null;
  /** Ordinal among partial requests, null for final ones. */
  partialNth: number | null;
  overridden: 'hangul' | 'delay' | null;
  /**
   * Epoch ms at which a Hangul override delivered its first delta (null otherwise). The page can react to the
   * override only from this moment on; `at` is taken synchronously in the same task in which the app may have just
   * rendered the previous response, so caption changes recorded after `at` can still belong to that response.
   */
  firstDeltaAt: number | null;
}

/** Non-Chinese output used by the overrides: long enough to never be shorter than a shown interim caption. */
export const HANGUL_OUTPUT = [
  '비가 너무 많이 와서 ',
  '기차가 한 시간이나 늦게 도착했어요. ',
  '걱정하지 마세요, 제가 내일 아침까지 ',
  '모든 일을 끝낼게요. 우리가 처음 만났던 바닷가 카페에 다시 가 보고 싶어요.',
];

export function translationOverrideScript(rules: OverrideRule[]): string {
  return `(() => {
  const rules = ${JSON.stringify(rules)};
  const deltas = ${JSON.stringify(HANGUL_OUTPUT)};
  const calls = [];
  Object.defineProperty(window, '__rtmtTranslations', { value: calls });
  const sentences = new Map();
  let partials = 0;
  const original = window.fetch.bind(window);
  const abortError = () => new DOMException('The operation was aborted.', 'AbortError');
  const sleep = (ms, signal) => new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(abortError());
    const timer = setTimeout(resolve, ms);
    if (signal) signal.addEventListener('abort', () => { clearTimeout(timer); reject(abortError()); }, { once: true });
  });
  const hangulResponse = (signal, call) => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        try {
          for (const text of deltas) {
            await sleep(40, signal);
            if (call.firstDeltaAt === null) call.firstDeltaAt = Date.now();
            controller.enqueue(encoder.encode(JSON.stringify({ type: 'delta', text }) + '\\n'));
          }
          controller.enqueue(encoder.encode(JSON.stringify({ type: 'done' }) + '\\n'));
          controller.close();
        } catch (error) {
          controller.error(error);
        }
      },
    });
    return new Response(stream, { status: 200, headers: { 'Content-Type': 'application/x-ndjson' } });
  };
  window.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!/\\/api\\/translations$/.test(new URL(url, location.href).pathname) || !init || typeof init.body !== 'string') {
      return original(input, init);
    }
    let body;
    try { body = JSON.parse(init.body); } catch { return original(input, init); }
    const retranslate = body.retranslate === true;
    const call = { at: Date.now(), kind: body.kind, retranslate, sentence: null, partialNth: null, overridden: null, firstDeltaAt: null };
    let rule;
    if (body.kind === 'partial') {
      partials += 1;
      call.partialNth = partials;
      rule = rules.find((r) => r.kind === 'partial' && r.nth === partials);
    } else {
      if (!sentences.has(body.text)) sentences.set(body.text, { ordinal: sentences.size + 1, firsts: 0 });
      const state = sentences.get(body.text);
      call.sentence = state.ordinal;
      if (!retranslate) state.firsts += 1;
      const attempt = retranslate ? 'retranslate' : state.firsts === 1 ? 'first' : null;
      rule = rules.find((r) => r.kind === 'final' && r.sentence === state.ordinal && r.attempt === attempt);
    }
    calls.push(call);
    if (!rule) return original(input, init);
    call.overridden = rule.action;
    if (rule.delayMs) await sleep(rule.delayMs, init.signal);
    return rule.action === 'hangul' ? hangulResponse(init.signal, call) : original(input, init);
  };
})();`;
}

/** Installs the override in every page the context opens from now on (call before `page.goto`). */
export async function overrideTranslations(context: BrowserContext, rules: OverrideRule[]): Promise<void> {
  await context.addInitScript({ content: translationOverrideScript(rules) });
}

export function translationCalls(page: Page): Promise<TranslationCall[]> {
  return page.evaluate<TranslationCall[]>('(window.__rtmtTranslations || []).slice()');
}

export type InjectedFailureCode = 'upstream_rejected' | 'upstream_unavailable';

/**
 * Runtime-armed translation failures (IR-003 AC-7): `window.__rtmtTest.failFinals(code, sentences)` makes the final
 * translation of the next `sentences` distinct sentences end with an NDJSON `error` line of `code` — every request
 * of such a sentence, including the client's retry. Partial requests and all other sentences go to the real service.
 * `window.__rtmtTest.failedFinals()` lists `{ at, code }` of the sentences failed so far.
 */
export const TRANSLATION_FAILURE_SCRIPT = `(() => {
  const test = (window.__rtmtTest = window.__rtmtTest || {});
  let armed = null;
  const failed = new Map();
  const log = [];
  test.failFinals = (code, sentences) => { armed = { code, left: sentences }; };
  test.failedFinals = () => log.slice();
  const original = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!/\\/api\\/translations$/.test(new URL(url, location.href).pathname) || !init || typeof init.body !== 'string') {
      return original(input, init);
    }
    let body;
    try { body = JSON.parse(init.body); } catch { return original(input, init); }
    if (body.kind !== 'final') return original(input, init);
    let code = failed.get(body.text);
    if (!code && armed && armed.left > 0) {
      code = armed.code;
      armed.left -= 1;
      failed.set(body.text, code);
      log.push({ at: Date.now(), code });
    }
    if (!code) return original(input, init);
    const line = JSON.stringify({ type: 'error', code }) + '\\n';
    return new Response(line, { status: 200, headers: { 'Content-Type': 'application/x-ndjson' } });
  };
})();`;

/** Arms the failure of the next `sentences` final translations; returns the arming time (epoch ms). */
export function failFinalTranslations(page: Page, code: InjectedFailureCode, sentences: number): Promise<number> {
  return page.evaluate<number>(`(window.__rtmtTest.failFinals(${JSON.stringify(code)}, ${sentences}), Date.now())`);
}

export function failedFinals(page: Page): Promise<{ at: number; code: InjectedFailureCode }[]> {
  return page.evaluate('window.__rtmtTest.failedFinals()');
}
