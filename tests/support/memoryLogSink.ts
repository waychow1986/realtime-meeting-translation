import { Writable } from 'node:stream';

/** Collects pino JSON lines in memory so tests can inspect exactly what would reach stdout. */
export class MemoryLogSink extends Writable {
  private chunks: string[] = [];

  override _write(chunk: Buffer | string, _enc: BufferEncoding, cb: (err?: Error | null) => void): void {
    this.chunks.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
    cb();
  }

  raw(): string {
    return this.chunks.join('');
  }

  records(): Array<Record<string, unknown>> {
    return this.raw()
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  }
}
