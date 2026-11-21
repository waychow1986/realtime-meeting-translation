import { pino, type DestinationStream, type Logger as PinoLogger } from 'pino';
import { INPUT_SOURCES, LANGUAGE_CODE_PATTERN, type InputSource } from '../shared/contracts.js';

export type LogEvent =
  | 'server_started'
  | 'server_stopping'
  | 'request_completed'
  | 'translation_completed'
  | 'upstream_error'
  | 'speech_token_failed'
  | 'config_invalid'
  | 'unhandled_error';

export const ERROR_CODES = [
  'invalid_request',
  'forbidden_origin',
  'payload_too_large',
  'rate_limited',
  'upstream_unavailable',
  'upstream_throttled',
  'upstream_rejected',
  'timeout',
  'client_aborted',
  'not_found',
  'internal_error',
  'content_filter',
] as const;
export type LoggedErrorCode = (typeof ERROR_CODES)[number];

/** The complete set of fields that may ever be written (TD-009). Anything else is dropped. */
export interface LogFields {
  reqId?: string;
  method?: string;
  route?: string;
  status?: number;
  durationMs?: number;
  kind?: 'partial' | 'final';
  textLength?: number;
  deltaCount?: number;
  ttfbMs?: number;
  reasoningTokens?: number;
  upstream?: 'speech-sts' | 'chat-model';
  upstreamStatus?: number;
  errorCode?: LoggedErrorCode;
  authMode?: string;
  sourceLanguage?: string;
  inputSource?: InputSource;
  /** Upstream model version string (metadata, evidence for the deployed model). */
  model?: string;
  /** Error class name only, never the message or stack. */
  errorClass?: string;
  /** Comma separated names (never values) of invalid configuration variables. */
  configKeys?: string;
}

type Validator = (value: unknown) => boolean;

const isFiniteNumber: Validator = (v) => typeof v === 'number' && Number.isFinite(v);
const matches =
  (re: RegExp): Validator =>
  (v) =>
    typeof v === 'string' && re.test(v);
const oneOf =
  (values: readonly string[]): Validator =>
  (v) =>
    typeof v === 'string' && values.includes(v);

const VALIDATORS: Record<keyof LogFields, Validator> = {
  reqId: matches(/^[A-Za-z0-9-]{1,64}$/),
  method: matches(/^[A-Z]{3,7}$/),
  route: matches(/^\/[A-Za-z0-9/_.:*-]{0,128}$/),
  status: isFiniteNumber,
  durationMs: isFiniteNumber,
  kind: oneOf(['partial', 'final']),
  textLength: isFiniteNumber,
  deltaCount: isFiniteNumber,
  ttfbMs: isFiniteNumber,
  reasoningTokens: isFiniteNumber,
  upstream: oneOf(['speech-sts', 'chat-model']),
  upstreamStatus: isFiniteNumber,
  errorCode: oneOf(ERROR_CODES),
  authMode: oneOf(['credential', 'platform-identity']),
  sourceLanguage: matches(LANGUAGE_CODE_PATTERN),
  inputSource: oneOf(INPUT_SOURCES),
  model: matches(/^[A-Za-z0-9._:-]{1,64}$/),
  errorClass: matches(/^[A-Za-z][A-Za-z0-9_]{0,63}$/),
  configKeys: matches(/^[A-Z0-9_]+(,[A-Z0-9_]+)*$/),
};

export function sanitizeFields(fields: object): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    const validate = (VALIDATORS as Record<string, Validator | undefined>)[key];
    if (validate && validate(value)) out[key] = value;
  }
  return out;
}

export interface AppLogger {
  info(event: LogEvent, msg: string, fields?: LogFields): void;
  warn(event: LogEvent, msg: string, fields?: LogFields): void;
  error(event: LogEvent, msg: string, fields?: LogFields): void;
  fatal(event: LogEvent, msg: string, fields?: LogFields): void;
  flush(): void;
}

export interface LoggerOptions {
  level: string;
  destination?: DestinationStream | NodeJS.WritableStream;
}

export function createLogger(options: LoggerOptions): AppLogger {
  const base: PinoLogger = pino(
    {
      level: options.level,
      base: undefined,
      messageKey: 'msg',
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: { level: (label) => ({ level: label }) },
    },
    (options.destination as DestinationStream | undefined) ?? pino.destination({ dest: 1, sync: true }),
  );

  const write =
    (level: 'info' | 'warn' | 'error' | 'fatal') =>
    (event: LogEvent, msg: string, fields: LogFields = {}) => {
      base[level]({ event, ...sanitizeFields(fields) }, msg);
    };

  return {
    info: write('info'),
    warn: write('warn'),
    error: write('error'),
    fatal: write('fatal'),
    flush: () => base.flush(),
  };
}
