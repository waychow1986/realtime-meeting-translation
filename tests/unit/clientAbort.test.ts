import { describe, expect, it, vi } from 'vitest';
import { handleUnhandledRejection, isClientAbortError } from '../../src/server/clientAbort.js';
import { createLogger } from '../../src/server/logger.js';
import { MemoryLogSink } from '../support/memoryLogSink.js';

function codeError(code: string): Error {
  return Object.assign(new Error('x'), { code });
}

describe('isClientAbortError (TD-303)', () => {
  it.each([
    ['AbortError (DOMException)', new DOMException('aborted', 'AbortError')],
    ['AbortError (named Error)', Object.assign(new Error('aborted'), { name: 'AbortError' })],
    ['ABORT_ERR', codeError('ABORT_ERR')],
    ['ERR_STREAM_PREMATURE_CLOSE', codeError('ERR_STREAM_PREMATURE_CLOSE')],
    ['ERR_STREAM_DESTROYED', codeError('ERR_STREAM_DESTROYED')],
  ])('treats %s as a client abort', (_name, err) => {
    expect(isClientAbortError(err)).toBe(true);
  });

  it.each([
    ['TimeoutError', new DOMException('timeout', 'TimeoutError')],
    ['ECONNRESET', codeError('ECONNRESET')],
    ['EPIPE', codeError('EPIPE')],
    ['plain Error', new Error('boom')],
    ['TypeError', new TypeError('bad')],
    ['string', 'AbortError'],
    ['null', null],
    ['undefined', undefined],
    ['number', 42],
  ])('does not treat %s as a client abort', (_name, err) => {
    expect(isClientAbortError(err)).toBe(false);
  });
});

describe('handleUnhandledRejection (TD-303)', () => {
  const setup = () => {
    const sink = new MemoryLogSink();
    const logger = createLogger({ level: 'info', destination: sink });
    const exit = vi.fn();
    return { sink, handler: handleUnhandledRejection(logger, exit), exit };
  };

  it('logs abort-class rejections at warn and keeps the process running', () => {
    const { sink, handler, exit } = setup();
    handler(codeError('ERR_STREAM_PREMATURE_CLOSE'));
    expect(exit).not.toHaveBeenCalled();
    const records = sink.records();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ level: 'warn', event: 'unhandled_error', msg: 'unhandled rejection after client abort', errorClass: 'Error' });
  });

  it('logs any other rejection as fatal and exits with code 1', () => {
    const { sink, handler, exit } = setup();
    handler(new Error('secret detail'));
    expect(exit).toHaveBeenCalledWith(1);
    const records = sink.records();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ level: 'fatal', event: 'unhandled_error', msg: 'unhandled rejection', errorClass: 'Error' });
    expect(sink.raw()).not.toContain('secret detail');
  });

  it('treats a TimeoutError rejection as fatal', () => {
    const { sink, handler, exit } = setup();
    handler(new DOMException('t', 'TimeoutError'));
    expect(exit).toHaveBeenCalledWith(1);
    expect(sink.records()[0]).toMatchObject({ level: 'fatal' });
  });
});
