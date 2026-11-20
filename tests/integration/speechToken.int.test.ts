import { describe, expect, it } from 'vitest';
import { speechAuth } from '../../src/server/auth/azureAuth.js';
import { loadConfig } from '../../src/server/config.js';
import { createSpeechTokenService } from '../../src/server/speech/tokenService.js';

describe('speech token exchange against the real Speech STS endpoint (AC-07, AC-08)', () => {
  it('issues a short-lived JWT and caches it', async () => {
    const config = loadConfig(process.env);
    const service = createSpeechTokenService({ stsBaseUrl: config.speech.stsBaseUrl, auth: speechAuth(config.speech.auth) });
    const first = await service.getToken();
    expect(first.split('.')).toHaveLength(3);
    const payload = JSON.parse(Buffer.from(first.split('.')[1] ?? '', 'base64url').toString('utf8')) as { exp: number };
    const lifetimeSeconds = payload.exp - Date.now() / 1000;
    expect(lifetimeSeconds).toBeGreaterThan(0);
    expect(lifetimeSeconds).toBeLessThanOrEqual(15 * 60);
    expect(await service.getToken()).toBe(first);
    for (const [name, value] of Object.entries(process.env)) {
      if (/^AIDH_DEP_.*_KEY$/.test(name) && value) expect(first).not.toContain(value);
    }
  });
});
