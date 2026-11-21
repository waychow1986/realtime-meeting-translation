import type { InputSource, TranslationErrorCode, TranslationLine, TranslationRequest } from '../shared/contracts.js';

export type TranslateFailureReason =
  | TranslationErrorCode
  | 'network'
  | 'aborted'
  | 'rate_limited'
  | 'invalid_request'
  | 'forbidden'
  | 'http_error';

export type TranslateOutcome = { ok: true } | { ok: false; reason: TranslateFailureReason; retryAfterSeconds?: number };

export interface TranslateCallOptions {
  signal: AbortSignal;
  onDelta: (text: string) => void;
  fetch?: (input: string, init?: RequestInit) => Promise<Response>;
}

export type TranslateFn = (request: TranslationRequest, options: TranslateCallOptions) => Promise<TranslateOutcome>;

const TRANSLATION_ERROR_CODES: readonly string[] = ['upstream_unavailable', 'upstream_throttled', 'upstream_rejected', 'timeout'];

function isTranslationLine(value: unknown): value is TranslationLine {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (v.type === 'delta') return typeof v.text === 'string';
  if (v.type === 'done') return true;
  if (v.type === 'error') return typeof v.code === 'string' && TRANSLATION_ERROR_CODES.includes(v.code);
  return false;
}

export async function* parseNdjson(body: ReadableStream<Uint8Array>): AsyncGenerator<TranslationLine> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const parse = (line: string): TranslationLine | undefined => {
    if (!line.trim()) return undefined;
    try {
      const value: unknown = JSON.parse(line);
      return isTranslationLine(value) ? value : undefined;
    } catch {
      return undefined;
    }
  };
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const parsed = parse(buffer.slice(0, idx));
        buffer = buffer.slice(idx + 1);
        if (parsed) yield parsed;
      }
    }
    buffer += decoder.decode();
    const parsed = parse(buffer);
    if (parsed) yield parsed;
  } finally {
    reader.releaseLock();
  }
}

function httpFailure(response: Response): TranslateOutcome {
  switch (response.status) {
    case 429: {
      const retryAfter = Number(response.headers.get('Retry-After'));
      return {
        ok: false,
        reason: 'rate_limited',
        ...(Number.isFinite(retryAfter) && retryAfter > 0 ? { retryAfterSeconds: retryAfter } : {}),
      };
    }
    case 400:
    case 413:
      return { ok: false, reason: 'invalid_request' };
    case 403:
      return { ok: false, reason: 'forbidden' };
    default:
      return { ok: false, reason: 'http_error' };
  }
}

export const requestTranslation: TranslateFn = async (request, options) => {
  const fetchImpl = options.fetch ?? ((input: string, init?: RequestInit) => fetch(input, init));
  const aborted = (): TranslateOutcome => ({ ok: false, reason: 'aborted' });
  let response: Response;
  try {
    response = await fetchImpl('/api/translations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
      signal: options.signal,
      credentials: 'same-origin',
    });
  } catch {
    return options.signal.aborted ? aborted() : { ok: false, reason: 'network' };
  }
  if (!response.ok || !response.body) {
    await response.body?.cancel().catch(() => undefined);
    return httpFailure(response);
  }
  try {
    for await (const line of parseNdjson(response.body)) {
      if (options.signal.aborted) return aborted();
      if (line.type === 'delta') options.onDelta(line.text);
      else if (line.type === 'done') return { ok: true };
      else return { ok: false, reason: line.code };
    }
  } catch {
    return options.signal.aborted ? aborted() : { ok: false, reason: 'network' };
  }
  return options.signal.aborted ? aborted() : { ok: false, reason: 'network' };
};

/** Tags every request with the input source of the run that produced it (TD-112). */
export function withInputSource(source: () => InputSource, translate: TranslateFn = requestTranslation): TranslateFn {
  return (request, options) => translate({ ...request, inputSource: source() }, options);
}
