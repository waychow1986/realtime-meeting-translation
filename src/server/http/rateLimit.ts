import { createHash, randomBytes } from 'node:crypto';

export type TakeResult = { ok: true } | { ok: false; retryAfterSeconds: number };

interface Bucket {
  tokens: number;
  updatedAt: number;
}

export interface TokenBucketOptions {
  perMinute: number;
  now?: () => number;
  idleMs?: number;
}

/**
 * Per-key token bucket (capacity = refill per minute). Keys are hashed with a
 * per-process salt so raw client addresses are never retained in memory.
 */
export class TokenBucketLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly capacity: number;
  private readonly refillPerMs: number;
  private readonly now: () => number;
  private readonly idleMs: number;
  private readonly salt = randomBytes(16);
  private lastSweep = 0;

  constructor(options: TokenBucketOptions) {
    this.capacity = options.perMinute;
    this.refillPerMs = options.perMinute / 60_000;
    this.now = options.now ?? Date.now;
    this.idleMs = options.idleMs ?? 600_000;
  }

  take(rawKey: string): TakeResult {
    const now = this.now();
    this.sweep(now);
    const key = createHash('sha256').update(this.salt).update(rawKey).digest('base64url');
    const bucket = this.buckets.get(key) ?? { tokens: this.capacity, updatedAt: now };
    bucket.tokens = Math.min(this.capacity, bucket.tokens + (now - bucket.updatedAt) * this.refillPerMs);
    bucket.updatedAt = now;
    this.buckets.set(key, bucket);
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return { ok: true };
    }
    const retryAfterSeconds = Math.max(1, Math.ceil((1 - bucket.tokens) / this.refillPerMs / 1000));
    return { ok: false, retryAfterSeconds };
  }

  size(): number {
    return this.buckets.size;
  }

  keys(): string[] {
    return [...this.buckets.keys()];
  }

  private sweep(now: number): void {
    if (now - this.lastSweep < Math.min(this.idleMs, 60_000) && this.lastSweep !== 0) return;
    this.lastSweep = now;
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.updatedAt > this.idleMs) this.buckets.delete(key);
    }
  }
}
