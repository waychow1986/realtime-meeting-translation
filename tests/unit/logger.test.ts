import { describe, expect, it } from 'vitest';
import { createLogger } from '../../src/server/logger.js';
import { MemoryLogSink } from '../support/memoryLogSink.js';

describe('whitelist logger', () => {
  it('writes JSON lines with string levels and allowed fields only', () => {
    const sink = new MemoryLogSink();
    const log = createLogger({ level: 'info', destination: sink });
    log.info('translation_completed', 'translation completed', {
      kind: 'final',
      textLength: 12,
      sourceLanguage: 'en-US',
      reasoningTokens: 0,
      model: 'gpt-5.1-2025-11-13',
      // values below must never reach the output
      ...({ text: 'Good morning everyone', translation: '大家早上好', headers: { 'api-key': 'x' } } as object),
    });
    const [line] = sink.records();
    expect(line).toMatchObject({
      level: 'info',
      event: 'translation_completed',
      msg: 'translation completed',
      kind: 'final',
      textLength: 12,
      sourceLanguage: 'en-US',
      reasoningTokens: 0,
      model: 'gpt-5.1-2025-11-13',
    });
    expect(typeof line?.time).toBe('string');
    expect(sink.raw()).not.toContain('Good morning');
    expect(sink.raw()).not.toContain('大家早上好');
    expect(sink.raw()).not.toContain('api-key');
  });

  it('drops sourceLanguage and model values that do not look like codes', () => {
    const sink = new MemoryLogSink();
    const log = createLogger({ level: 'info', destination: sink });
    log.info('translation_completed', 'translation completed', {
      sourceLanguage: 'hello world, this is content',
      model: 'some text with spaces',
      errorCode: 'not an enum value!' as never,
    });
    const [line] = sink.records();
    expect(line).not.toHaveProperty('sourceLanguage');
    expect(line).not.toHaveProperty('model');
    expect(line).not.toHaveProperty('errorCode');
  });

  it('drops non-primitive values even for allowed keys', () => {
    const sink = new MemoryLogSink();
    const log = createLogger({ level: 'info', destination: sink });
    log.warn('upstream_error', 'upstream error', {
      upstream: 'chat-model',
      upstreamStatus: 429,
      errorCode: 'upstream_throttled',
      ...({ route: { text: 'secret content' } } as object),
    });
    const [line] = sink.records();
    expect(line).toMatchObject({ level: 'warn', upstream: 'chat-model', upstreamStatus: 429 });
    expect(line).not.toHaveProperty('route');
  });

  it('respects the configured level', () => {
    const sink = new MemoryLogSink();
    const log = createLogger({ level: 'warn', destination: sink });
    log.info('server_started', 'server started', {});
    log.error('unhandled_error', 'unhandled error', {});
    expect(sink.records().map((r) => r.event)).toEqual(['unhandled_error']);
  });
});
