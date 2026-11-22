import type { AppLogger } from './logger.js';

const CLIENT_ABORT_CODES = new Set(['ABORT_ERR', 'ERR_STREAM_PREMATURE_CLOSE', 'ERR_STREAM_DESTROYED']);

/**
 * True only for errors caused by an aborted operation or a stream closed early (TD-303).
 * Timeouts and network errors (ECONNRESET, EPIPE, ...) are deliberately excluded so that
 * upstream problems are never downgraded. On its own this is not proof of a client abort:
 * callers must also know that the client actually closed the response.
 */
export function isClientAbortError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const { name, code } = err as { name?: unknown; code?: unknown };
  return name === 'AbortError' || (typeof code === 'string' && CLIENT_ABORT_CODES.has(code));
}

function errorClass(err: unknown): string {
  return err instanceof Error || err instanceof DOMException ? err.name : 'UnknownError';
}

/** Process-level unhandledRejection handler: abort-class rejections are a warning, anything else is fatal (TD-303). */
export function handleUnhandledRejection(logger: AppLogger, exit: (code: number) => void): (reason: unknown) => void {
  return (reason) => {
    if (isClientAbortError(reason)) {
      logger.warn('unhandled_error', 'unhandled rejection after client abort', { errorClass: errorClass(reason) });
      return;
    }
    logger.fatal('unhandled_error', 'unhandled rejection', { errorClass: errorClass(reason) });
    logger.flush();
    exit(1);
  };
}
