import { LANGUAGE_CODE_PATTERN } from '../shared/contracts.js';

export type AuthConfig = { mode: 'credential'; key: string } | { mode: 'platform-identity' };

export interface AppConfig {
  port: number;
  logLevel: string;
  candidateLanguages: string[];
  segmentationSilenceMs: number;
  trustedProxyHops: number;
  speech: {
    stsBaseUrl: string;
    sttHost: string;
    sttEndpoint: string;
    region: string;
    auth: AuthConfig;
  };
  chat: {
    baseUrl: string;
    deployment: string;
    auth: AuthConfig;
  };
}

/** Thrown when configuration is invalid. `problems` contains variable names only, never values. */
export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`invalid configuration: ${problems.join(', ')}`);
    this.name = 'ConfigError';
  }
}

const DEFAULT_LANGUAGES = ['en-US', 'zh-CN', 'ja-JP', 'ko-KR'];
const LOG_LEVELS = new Set(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']);
const HOST_PATTERN = /^[A-Za-z0-9.-]+(:\d{1,5})?$/;

export function stripDefaultHttpsPort(host: string): string {
  return host.endsWith(':443') ? host.slice(0, -4) : host;
}

export function hostToHttpsBase(host: string): string {
  return `https://${stripDefaultHttpsPort(host)}`;
}

export function loadConfig(env: NodeJS.ProcessEnv): AppConfig {
  const problems: string[] = [];

  const required = (name: string): string => {
    const value = env[name]?.trim();
    if (!value) {
      problems.push(name);
      return '';
    }
    return value;
  };

  const host = (name: string): string => {
    const value = required(name);
    if (value && !HOST_PATTERN.test(value)) problems.push(name);
    return value;
  };

  const auth = (prefix: string): AuthConfig => {
    const modeName = `${prefix}_AUTH_MODE`;
    const mode = required(modeName);
    if (mode === 'credential') {
      return { mode: 'credential', key: required(`${prefix}_KEY`) };
    }
    if (mode === 'platform-identity') return { mode: 'platform-identity' };
    if (mode) problems.push(modeName);
    return { mode: 'platform-identity' };
  };

  const integer = (name: string, fallback: number, min: number, max: number): number => {
    const raw = env[name]?.trim();
    if (raw === undefined || raw === '') {
      if (raw === '' && name !== 'PORT') problems.push(name);
      return fallback;
    }
    if (!/^-?\d+$/.test(raw)) {
      problems.push(name);
      return fallback;
    }
    const n = Number(raw);
    if (n < min || n > max) problems.push(name);
    return n;
  };

  const speechEndpoint = host('AIDH_DEP_SPEECH_ENDPOINT');
  const sttHost = host('AIDH_DEP_SPEECH_STT_HOST');
  const region = required('AIDH_DEP_SPEECH_REGION');
  const speechAuth = auth('AIDH_DEP_SPEECH');
  const chatEndpoint = host('AIDH_DEP_CHAT_MODEL_ENDPOINT');
  const deployment = required('AIDH_DEP_CHAT_MODEL_DEPLOYMENT');
  const chatAuth = auth('AIDH_DEP_CHAT_MODEL');

  const port = integer('PORT', 8080, 1, 65535);
  const segmentationSilenceMs = integer('SEGMENTATION_SILENCE_MS', 800, 300, 2000);
  const trustedProxyHops = integer('TRUSTED_PROXY_HOPS', 1, 0, 3);

  const logLevel = env.LOG_LEVEL?.trim() || 'info';
  if (!LOG_LEVELS.has(logLevel)) problems.push('LOG_LEVEL');

  let candidateLanguages = DEFAULT_LANGUAGES;
  const rawLanguages = env.CANDIDATE_LANGUAGES;
  if (rawLanguages !== undefined) {
    const list = rawLanguages
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (list.length < 1 || list.length > 10 || !list.every((l) => LANGUAGE_CODE_PATTERN.test(l))) {
      problems.push('CANDIDATE_LANGUAGES');
    } else {
      candidateLanguages = list;
    }
  }

  if (problems.length > 0) throw new ConfigError([...new Set(problems)]);

  const sttBareHost = stripDefaultHttpsPort(sttHost);
  return {
    port,
    logLevel,
    candidateLanguages,
    segmentationSilenceMs,
    trustedProxyHops,
    speech: {
      stsBaseUrl: hostToHttpsBase(speechEndpoint),
      sttHost: sttBareHost,
      sttEndpoint: `wss://${sttBareHost}/speech/universal/v2`,
      region,
      auth: speechAuth,
    },
    chat: {
      baseUrl: hostToHttpsBase(chatEndpoint),
      deployment,
      auth: chatAuth,
    },
  };
}
