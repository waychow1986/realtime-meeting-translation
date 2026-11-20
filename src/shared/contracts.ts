export const LANGUAGE_CODE_PATTERN = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8}){0,2}$/;
export const LANGUAGE_CODE_PATTERN_SOURCE = '^[a-z]{2,3}(-[A-Za-z0-9]{2,8}){0,2}$';

export const MAX_TRANSLATION_TEXT_LENGTH = 2000;
export const MAX_REQUEST_BODY_BYTES = 8 * 1024;

export type TranslationKind = 'partial' | 'final';

export interface TranslationRequest {
  kind: TranslationKind;
  text: string;
  sourceLanguage?: string;
}

export type TranslationErrorCode =
  | 'upstream_unavailable'
  | 'upstream_throttled'
  | 'upstream_rejected'
  | 'timeout';

export type TranslationLine =
  | { type: 'delta'; text: string }
  | { type: 'done' }
  | { type: 'error'; code: TranslationErrorCode };

export interface SpeechTokenResponse {
  token: string;
  sttEndpoint: string;
  candidateLanguages: string[];
  segmentationSilenceMs: number;
  refreshAfterSeconds: number;
}

export type ApiErrorCode =
  | 'invalid_request'
  | 'forbidden_origin'
  | 'payload_too_large'
  | 'rate_limited'
  | 'upstream_unavailable'
  | 'not_found'
  | 'internal_error';

export interface ApiError {
  error: ApiErrorCode;
}
