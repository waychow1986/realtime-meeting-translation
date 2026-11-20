import { describe, expect, it } from 'vitest';
import { createSpeechTokenService } from '../../src/server/speech/tokenService.js';
import { staticHeaderAuth } from '../../src/server/auth/azureAuth.js';
import type { FetchLike } from '../../src/server/translation/translator.js';

const auth = staticHeaderAuth('Ocp-Apim-Subscription-Key', 'unit-key');

describe('speech token service', () => {
  it('posts to issueToken with an empty body and caches for four minutes', async () => {
    let now = 0;
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl: FetchLike = async (url, init) => {
      calls.push({ url: String(url), init });
      return new Response(`token-${calls.length}`, { status: 200 });
    };
    const svc = createSpeechTokenService({ stsBaseUrl: 'https://speech.example', auth, fetch: fetchImpl, now: () => now });
    expect(await svc.getToken()).toBe('token-1');
    expect(calls[0]?.url).toBe('https://speech.example/sts/v1.0/issueToken');
    expect(calls[0]?.init?.method).toBe('POST');
    expect((calls[0]?.init?.headers as Record<string, string>)['Ocp-Apim-Subscription-Key']).toBe('unit-key');
    expect((calls[0]?.init?.headers as Record<string, string>)['Content-Length']).toBe('0');
    now += 239_000;
    expect(await svc.getToken()).toBe('token-1');
    now += 2_000;
    expect(await svc.getToken()).toBe('token-2');
  });

  it('retries once and then fails with an upstream error', async () => {
    let count = 0;
    const svc = createSpeechTokenService({
      stsBaseUrl: 'https://speech.example',
      auth,
      fetch: async () => {
        count += 1;
        return new Response('nope', { status: 503 });
      },
      retryDelayMs: 1,
    });
    await expect(svc.getToken()).rejects.toMatchObject({ name: 'UpstreamError', upstreamStatus: 503 });
    expect(count).toBe(2);
  });

  it('succeeds when the retry succeeds', async () => {
    let count = 0;
    const svc = createSpeechTokenService({
      stsBaseUrl: 'https://speech.example',
      auth,
      fetch: async () => {
        count += 1;
        if (count === 1) throw new TypeError('fetch failed');
        return new Response('tok', { status: 200 });
      },
      retryDelayMs: 1,
    });
    expect(await svc.getToken()).toBe('tok');
  });

  it('shares one in-flight request between concurrent callers', async () => {
    let count = 0;
    const svc = createSpeechTokenService({
      stsBaseUrl: 'https://speech.example',
      auth,
      fetch: async () => {
        count += 1;
        await new Promise((r) => setTimeout(r, 5));
        return new Response('tok', { status: 200 });
      },
    });
    await Promise.all([svc.getToken(), svc.getToken(), svc.getToken()]);
    expect(count).toBe(1);
  });
});
