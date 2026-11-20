import { describe, expect, it } from 'vitest';
import { TokenBucketLimiter } from '../../src/server/http/rateLimit.js';

describe('TokenBucketLimiter', () => {
  it('allows a burst up to capacity then rejects with Retry-After', () => {
    let now = 0;
    const limiter = new TokenBucketLimiter({ perMinute: 3, now: () => now });
    expect(limiter.take('a').ok).toBe(true);
    expect(limiter.take('a').ok).toBe(true);
    expect(limiter.take('a').ok).toBe(true);
    const denied = limiter.take('a');
    expect(denied.ok).toBe(false);
    expect(denied.ok === false && denied.retryAfterSeconds).toBe(20);
    now += 20_000;
    expect(limiter.take('a').ok).toBe(true);
  });

  it('keeps separate buckets per key', () => {
    const limiter = new TokenBucketLimiter({ perMinute: 1, now: () => 0 });
    expect(limiter.take('a').ok).toBe(true);
    expect(limiter.take('b').ok).toBe(true);
    expect(limiter.take('a').ok).toBe(false);
  });

  it('evicts idle buckets and does not keep raw keys', () => {
    let now = 0;
    const limiter = new TokenBucketLimiter({ perMinute: 1, now: () => now, idleMs: 600_000 });
    limiter.take('203.0.113.7');
    expect(limiter.size()).toBe(1);
    expect(limiter.keys().some((k) => k.includes('203.0.113.7'))).toBe(false);
    now += 600_001;
    limiter.take('198.51.100.1');
    expect(limiter.size()).toBe(1);
  });
});
