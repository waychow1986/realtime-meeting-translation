import { describe, expect, it } from 'vitest';
import { ConfigError, hostToHttpsBase, loadConfig } from '../../src/server/config.js';

const SECRET_A = 'unit-test-secret-value-aaaa';
const SECRET_B = 'unit-test-secret-value-bbbb';

function baseEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    AIDH_DEP_SPEECH_ENDPOINT: 'example-speech.cognitiveservices.azure.com:443',
    AIDH_DEP_SPEECH_STT_HOST: 'eastus2.stt.speech.microsoft.com:443',
    AIDH_DEP_SPEECH_REGION: 'eastus2',
    AIDH_DEP_SPEECH_AUTH_MODE: 'credential',
    AIDH_DEP_SPEECH_KEY: SECRET_A,
    AIDH_DEP_CHAT_MODEL_ENDPOINT: 'example-llm.openai.azure.com:443',
    AIDH_DEP_CHAT_MODEL_DEPLOYMENT: 'gpt-5.1',
    AIDH_DEP_CHAT_MODEL_AUTH_MODE: 'credential',
    AIDH_DEP_CHAT_MODEL_KEY: SECRET_B,
    ...overrides,
  };
}

function captureError(fn: () => unknown): ConfigError {
  try {
    fn();
  } catch (err) {
    if (err instanceof ConfigError) return err;
    throw err;
  }
  throw new Error('expected ConfigError');
}

describe('loadConfig', () => {
  it('reads dependencies and applies documented defaults', () => {
    const cfg = loadConfig(baseEnv());
    expect(cfg.port).toBe(8080);
    expect(cfg.candidateLanguages).toEqual(['en-US', 'zh-CN', 'ja-JP', 'ko-KR']);
    expect(cfg.segmentationSilenceMs).toBe(800);
    expect(cfg.trustedProxyHops).toBe(1);
    expect(cfg.speech.stsBaseUrl).toBe('https://example-speech.cognitiveservices.azure.com');
    expect(cfg.speech.sttHost).toBe('eastus2.stt.speech.microsoft.com');
    expect(cfg.speech.sttEndpoint).toBe('wss://eastus2.stt.speech.microsoft.com/speech/universal/v2');
    expect(cfg.chat.baseUrl).toBe('https://example-llm.openai.azure.com');
    expect(cfg.chat.deployment).toBe('gpt-5.1');
    expect(cfg.speech.auth).toEqual({ mode: 'credential', key: SECRET_A });
  });

  it('keeps non-default ports in URLs', () => {
    expect(hostToHttpsBase('host.example:8443')).toBe('https://host.example:8443');
    expect(hostToHttpsBase('host.example')).toBe('https://host.example');
  });

  it('accepts platform-identity without keys', () => {
    const cfg = loadConfig(
      baseEnv({
        AIDH_DEP_SPEECH_AUTH_MODE: 'platform-identity',
        AIDH_DEP_SPEECH_KEY: undefined,
        AIDH_DEP_CHAT_MODEL_AUTH_MODE: 'platform-identity',
        AIDH_DEP_CHAT_MODEL_KEY: undefined,
      }),
    );
    expect(cfg.speech.auth.mode).toBe('platform-identity');
    expect(cfg.chat.auth.mode).toBe('platform-identity');
  });

  it('lists missing variable names without echoing secret values', () => {
    const err = captureError(() =>
      loadConfig(baseEnv({ AIDH_DEP_CHAT_MODEL_DEPLOYMENT: undefined, AIDH_DEP_SPEECH_KEY: '' })),
    );
    expect(err.problems).toContain('AIDH_DEP_CHAT_MODEL_DEPLOYMENT');
    expect(err.problems).toContain('AIDH_DEP_SPEECH_KEY');
    expect(err.message).not.toContain(SECRET_B);
    expect(JSON.stringify(err.problems)).not.toContain(SECRET_B);
  });

  it('rejects unknown auth modes', () => {
    const err = captureError(() => loadConfig(baseEnv({ AIDH_DEP_SPEECH_AUTH_MODE: 'anonymous' })));
    expect(err.problems).toContain('AIDH_DEP_SPEECH_AUTH_MODE');
  });

  it.each([
    ['CANDIDATE_LANGUAGES', ''],
    ['CANDIDATE_LANGUAGES', 'en-US,<script>'],
    ['CANDIDATE_LANGUAGES', Array.from({ length: 11 }, () => 'en-US').join(',')],
    ['SEGMENTATION_SILENCE_MS', '299'],
    ['SEGMENTATION_SILENCE_MS', '2001'],
    ['SEGMENTATION_SILENCE_MS', '8x'],
    ['TRUSTED_PROXY_HOPS', '4'],
    ['TRUSTED_PROXY_HOPS', '-1'],
    ['PORT', '70000'],
  ])('rejects invalid %s=%s', (name, value) => {
    const err = captureError(() => loadConfig(baseEnv({ [name]: value })));
    expect(err.problems).toContain(name);
  });

  it('accepts valid overrides', () => {
    const cfg = loadConfig(
      baseEnv({ CANDIDATE_LANGUAGES: 'en-US, ja-JP', SEGMENTATION_SILENCE_MS: '1000', TRUSTED_PROXY_HOPS: '0' }),
    );
    expect(cfg.candidateLanguages).toEqual(['en-US', 'ja-JP']);
    expect(cfg.segmentationSilenceMs).toBe(1000);
    expect(cfg.trustedProxyHops).toBe(0);
  });
});
