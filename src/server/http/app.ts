import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { PassThrough } from 'node:stream';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyError, type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import {
  INPUT_SOURCES,
  LANGUAGE_CODE_PATTERN_SOURCE,
  MAX_REQUEST_BODY_BYTES,
  MAX_TRANSLATION_TEXT_LENGTH,
  type ApiErrorCode,
  type SpeechTokenResponse,
  type TranslationLine,
  type TranslationRequest,
} from '../../shared/contracts.js';
import { isClientAbortError } from '../clientAbort.js';
import type { AppConfig } from '../config.js';
import { UpstreamError } from '../errors.js';
import type { AppLogger } from '../logger.js';
import type { SpeechTokenService } from '../speech/tokenService.js';
import type { Translator } from '../translation/translator.js';
import { TokenBucketLimiter } from './rateLimit.js';

export interface RateLimits {
  speechTokenPerMinute: number;
  partialPerMinute: number;
  finalPerMinute: number;
}

export const DEFAULT_LIMITS: RateLimits = { speechTokenPerMinute: 120, partialPerMinute: 2400, finalPerMinute: 1200 };

export interface AppDeps {
  config: AppConfig;
  logger: AppLogger;
  tokenService: SpeechTokenService;
  translator: Translator;
  webRoot: string;
  limits?: RateLimits;
}

const TOKEN_REFRESH_SECONDS = 240;

/** Requests whose streaming response was closed by the client before it finished (TD-301). */
const clientClosedRequests = new WeakSet<IncomingMessage>();

const translationBodySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'text'],
  properties: {
    kind: { type: 'string', enum: ['partial', 'final'] },
    text: { type: 'string', minLength: 1, maxLength: MAX_TRANSLATION_TEXT_LENGTH, pattern: '\\S' },
    sourceLanguage: { type: 'string', pattern: LANGUAGE_CODE_PATTERN_SOURCE },
    inputSource: { type: 'string', enum: INPUT_SOURCES },
    retranslate: { type: 'boolean' },
  },
} as const;

function sendError(reply: FastifyReply, status: number, error: ApiErrorCode): FastifyReply {
  return reply.code(status).header('Cache-Control', 'no-store').send({ error });
}

export function securityHeaders(config: AppConfig): Record<string, string> {
  const stt = config.speech.sttHost;
  return {
    'Content-Security-Policy': [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self'",
      "img-src 'self' data:",
      `connect-src 'self' wss://${stt} https://${stt}`,
      "frame-ancestors 'none'",
      "base-uri 'none'",
      "form-action 'none'",
    ].join('; '),
    'Permissions-Policy': 'microphone=(self), display-capture=(self)',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
  };
}

/** Same-origin requirement for POST APIs (TD-010). */
export function isSameOrigin(request: FastifyRequest): boolean {
  const fetchSite = request.headers['sec-fetch-site'];
  if (fetchSite !== undefined && fetchSite !== 'same-origin') return false;
  const origin = request.headers.origin;
  if (!origin) return false;
  let originHost: string;
  try {
    const parsed = new URL(origin);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    originHost = parsed.host;
  } catch {
    return false;
  }
  const requestHost = request.host.toLowerCase();
  return originHost.toLowerCase() === requestHost || originHost.toLowerCase() === requestHost.replace(/:(80|443)$/, '');
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const { config, logger } = deps;
  const limits = deps.limits ?? DEFAULT_LIMITS;
  const limiters = {
    speechToken: new TokenBucketLimiter({ perMinute: limits.speechTokenPerMinute }),
    partial: new TokenBucketLimiter({ perMinute: limits.partialPerMinute }),
    final: new TokenBucketLimiter({ perMinute: limits.finalPerMinute }),
  };
  const headers = securityHeaders(config);

  const app = Fastify({
    logger: false,
    // Fastify treats a numeric trustProxy as "trust nothing", so express the TD-010 hop count explicitly:
    // only the rightmost N X-Forwarded-* entries (appended by the platform gateway) are trusted.
    trustProxy: (_address: string, hop: number) => hop < config.trustedProxyHops,
    bodyLimit: MAX_REQUEST_BODY_BYTES,
    genReqId: () => randomUUID(),
    return503OnClosing: true,
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false, allErrors: false } },
  });

  app.addHook('onRequest', async (_request, reply) => {
    reply.headers(headers);
  });

  app.addHook('onResponse', async (request, reply) => {
    logger.info('request_completed', 'request completed', {
      reqId: request.id,
      method: request.method,
      route: request.routeOptions.url,
      status: reply.statusCode,
      durationMs: Math.round(reply.elapsedTime),
    });
  });

  const requireSameOrigin = async (request: FastifyRequest, reply: FastifyReply) => {
    if (!isSameOrigin(request)) return sendError(reply, 403, 'forbidden_origin');
  };

  const enforceLimit = (limiter: TokenBucketLimiter, request: FastifyRequest, reply: FastifyReply): boolean => {
    const result = limiter.take(request.ip ?? 'unknown');
    if (result.ok) return true;
    reply.header('Retry-After', String(result.retryAfterSeconds));
    sendError(reply, 429, 'rate_limited');
    return false;
  };

  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (error.statusCode === 413 || error.code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
      return sendError(reply, 413, 'payload_too_large');
    }
    if (error.validation || (error.statusCode !== undefined && error.statusCode >= 400 && error.statusCode < 500)) {
      return sendError(reply, 400, 'invalid_request');
    }
    // A stream closed by the client before the first delta surfaces here as ERR_STREAM_PREMATURE_CLOSE (TD-301).
    // The translation task writes the single client_aborted record for that request.
    if (clientClosedRequests.has(request.raw) && isClientAbortError(error)) {
      return sendError(reply, 500, 'internal_error');
    }
    logger.error('unhandled_error', 'unhandled error', {
      reqId: request.id,
      route: request.routeOptions.url,
      errorClass: error.name,
      errorCode: 'internal_error',
    });
    return sendError(reply, 500, 'internal_error');
  });

  app.setNotFoundHandler((_request, reply) => sendError(reply, 404, 'not_found'));

  app.get('/healthz', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return { status: 'ok' };
  });

  app.post('/api/speech-token', { onRequest: requireSameOrigin }, async (request, reply) => {
    if (!enforceLimit(limiters.speechToken, request, reply)) return reply;
    let token: string;
    try {
      token = await deps.tokenService.getToken();
    } catch (err) {
      logger.error('speech_token_failed', 'speech token failed', {
        reqId: request.id,
        upstream: 'speech-sts',
        upstreamStatus: err instanceof UpstreamError ? err.upstreamStatus : undefined,
        errorCode: 'upstream_unavailable',
        authMode: config.speech.auth.mode,
        errorClass: err instanceof Error ? err.name : undefined,
      });
      return sendError(reply, 502, 'upstream_unavailable');
    }
    const body: SpeechTokenResponse = {
      token,
      sttEndpoint: config.speech.sttEndpoint,
      candidateLanguages: config.candidateLanguages,
      segmentationSilenceMs: config.segmentationSilenceMs,
      refreshAfterSeconds: TOKEN_REFRESH_SECONDS,
    };
    reply.header('Cache-Control', 'no-store');
    return body;
  });

  app.post<{ Body: TranslationRequest }>(
    '/api/translations',
    { onRequest: requireSameOrigin, schema: { body: translationBodySchema } },
    async (request, reply) => {
      const body = request.body;
      // Interim translations are never retranslated (FR-304, TD-308).
      if (body.kind === 'partial' && body.retranslate === true) return sendError(reply, 400, 'invalid_request');
      const limiter = body.kind === 'partial' ? limiters.partial : limiters.final;
      if (!enforceLimit(limiter, request, reply)) return reply;

      const controller = new AbortController();
      const markClientClosed = () => {
        if (reply.raw.writableFinished) return;
        clientClosedRequests.add(request.raw);
        controller.abort();
      };
      if (reply.raw.destroyed) markClientClosed();
      else reply.raw.on('close', markClientClosed);

      const stream = new PassThrough();
      let deltasWritten = 0;
      const writeLine = (line: TranslationLine) => {
        if (stream.writableEnded) return;
        stream.write(`${JSON.stringify(line)}\n`);
        if (line.type === 'delta') deltasWritten += 1;
      };

      reply
        .code(200)
        .header('Content-Type', 'application/x-ndjson; charset=utf-8')
        .header('Cache-Control', 'no-store, no-transform')
        .header('X-Accel-Buffering', 'no')
        .send(stream);

      const started = performance.now();
      const baseFields = {
        reqId: request.id,
        kind: body.kind,
        textLength: body.text.length,
        sourceLanguage: body.sourceLanguage,
        inputSource: body.inputSource,
      };
      // TD-312: only on success and upstream_error records, never on client_aborted (FR-315).
      const retranslateField = body.retranslate === true ? { retranslate: true } : {};

      void (async () => {
        try {
          const result = await deps.translator.translate(body, {
            signal: controller.signal,
            onDelta: (text) => writeLine({ type: 'delta', text }),
          });
          if (result.ok) {
            writeLine({ type: 'done' });
            logger.info('translation_completed', 'translation completed', {
              ...baseFields,
              ...retranslateField,
              deltaCount: result.deltaCount,
              ttfbMs: result.ttfbMs,
              durationMs: Math.round(performance.now() - started),
              reasoningTokens: result.reasoningTokens,
              model: result.model,
            });
          } else if (result.code === 'client_aborted') {
            logger.info('translation_completed', 'translation aborted by client', {
              ...baseFields,
              deltaCount: result.deltaCount,
              errorCode: 'client_aborted',
              durationMs: Math.round(performance.now() - started),
            });
          } else {
            writeLine({ type: 'error', code: result.code });
            logger.warn('upstream_error', 'upstream error', {
              ...baseFields,
              ...retranslateField,
              upstream: 'chat-model',
              upstreamStatus: result.upstreamStatus,
              errorCode: result.upstreamErrorCode ?? result.code,
              deltaCount: result.deltaCount,
              authMode: config.chat.auth.mode,
              durationMs: Math.round(performance.now() - started),
            });
          }
        } catch (err) {
          if (clientClosedRequests.has(request.raw) && isClientAbortError(err)) {
            logger.info('translation_completed', 'translation aborted by client', {
              ...baseFields,
              deltaCount: deltasWritten,
              errorCode: 'client_aborted',
              durationMs: Math.round(performance.now() - started),
            });
            return;
          }
          writeLine({ type: 'error', code: 'upstream_unavailable' });
          logger.error('unhandled_error', 'translation failed unexpectedly', {
            reqId: request.id,
            route: '/api/translations',
            errorClass: err instanceof Error ? err.name : undefined,
            errorCode: 'internal_error',
          });
        } finally {
          stream.end();
        }
      })();

      return reply;
    },
  );

  await app.register(fastifyStatic, {
    root: deps.webRoot,
    wildcard: false,
    index: 'index.html',
    cacheControl: false,
    etag: true,
    lastModified: false,
    dotfiles: 'deny',
    setHeaders: (res: unknown) => {
      // @fastify/static passes the Fastify reply in v10 (older versions pass the raw response).
      const target = res as { header?: (k: string, v: string) => void; setHeader?: (k: string, v: string) => void };
      if (typeof target.header === 'function') target.header('Cache-Control', 'no-cache');
      else target.setHeader?.('Cache-Control', 'no-cache');
    },
  });

  return app;
}
