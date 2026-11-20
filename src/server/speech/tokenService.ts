import type { AuthProvider } from '../auth/azureAuth.js';
import { UpstreamError } from '../errors.js';
import type { FetchLike } from '../translation/translator.js';

export interface SpeechTokenService {
  getToken(): Promise<string>;
}

export interface SpeechTokenServiceOptions {
  stsBaseUrl: string;
  auth: AuthProvider;
  fetch?: FetchLike;
  now?: () => number;
  /** Tokens are valid for 10 minutes; reuse them for at most this long. */
  cacheMs?: number;
  retryDelayMs?: number;
  requestTimeoutMs?: number;
}

export function createSpeechTokenService(options: SpeechTokenServiceOptions): SpeechTokenService {
  const fetchImpl = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const cacheMs = options.cacheMs ?? 240_000;
  const retryDelayMs = options.retryDelayMs ?? 300;
  const timeoutMs = options.requestTimeoutMs ?? 10_000;
  const url = `${options.stsBaseUrl}/sts/v1.0/issueToken`;

  let cached: { token: string; expiresAt: number } | undefined;
  let inflight: Promise<string> | undefined;

  async function issueOnce(): Promise<string> {
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers: { ...(await options.auth.headers()), 'Content-Length': '0' },
        body: '',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new UpstreamError('speech-sts');
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new UpstreamError('speech-sts', response.status);
    }
    const token = (await response.text()).trim();
    if (!token) throw new UpstreamError('speech-sts', response.status);
    return token;
  }

  async function issueWithRetry(): Promise<string> {
    try {
      return await issueOnce();
    } catch {
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      return issueOnce();
    }
  }

  return {
    async getToken() {
      if (cached && now() < cached.expiresAt) return cached.token;
      inflight ??= issueWithRetry()
        .then((token) => {
          cached = { token, expiresAt: now() + cacheMs };
          return token;
        })
        .finally(() => {
          inflight = undefined;
        });
      return inflight;
    },
  };
}
