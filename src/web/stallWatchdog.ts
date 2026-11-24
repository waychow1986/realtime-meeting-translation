import type { AudioChainMonitor } from './audioSource.js';

/**
 * Detects that speech recognition silently stopped in 系统声音 mode (IR-003, TD-702):
 * - 'no-results': the shared audio was voiced for 30 s in total since the last recognition result. Silence pauses
 *   the count without resetting it; any result resets it.
 * - 'audio-chain': the mixing chain broke (context not running or its output track not live), checked every second
 *   and on every context state change.
 * - 'session-ended': the recognizer reported its session ended while the run was still meant to be listening.
 * Reports at most once per run.
 */
export type StallCause = 'session-ended' | 'audio-chain' | 'no-results';

export const STALL_THRESHOLD_MS = 30_000;
export const CHECK_INTERVAL_MS = 1_000;
/** A check delayed by background throttling credits at most this much voiced time. */
export const MAX_CREDIT_PER_CHECK_MS = 2_000;

export interface StallWatchdogDeps {
  monitor: AudioChainMonitor;
  onStall(cause: StallCause): void;
  now?(): number;
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
}

export class StallWatchdog {
  private readonly now: () => number;
  private readonly setTimer: typeof setInterval;
  private readonly clearTimer: typeof clearInterval;
  private timer: ReturnType<typeof setInterval> | undefined;
  private unsubscribe: (() => void) | undefined;
  private voicedMs = 0;
  private lastCheck = 0;
  private active = false;
  private fired = false;

  constructor(private readonly deps: StallWatchdogDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.setTimer = deps.setInterval ?? ((...args: Parameters<typeof setInterval>) => setInterval(...args));
    this.clearTimer = deps.clearInterval ?? ((id) => clearInterval(id));
  }

  start(): void {
    if (this.active || this.fired) return;
    this.active = true;
    this.voicedMs = 0;
    this.lastCheck = this.now();
    this.timer = this.setTimer(() => this.check(), CHECK_INTERVAL_MS);
    this.unsubscribe = this.deps.monitor.onChange(() => this.check());
  }

  /** A non-empty recognition result arrived. */
  noteResult(): void {
    if (this.active) this.voicedMs = 0;
  }

  noteSessionEnded(): void {
    this.fire('session-ended');
  }

  stop(): void {
    if (!this.active) return;
    this.active = false;
    if (this.timer !== undefined) this.clearTimer(this.timer);
    this.timer = undefined;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  private check(): void {
    if (!this.active) return;
    if (this.deps.monitor.health() === 'broken') {
      this.fire('audio-chain');
      return;
    }
    const now = this.now();
    const credit = Math.min(Math.max(now - this.lastCheck, 0), MAX_CREDIT_PER_CHECK_MS);
    this.lastCheck = now;
    if (this.deps.monitor.isVoiced()) this.voicedMs += credit;
    if (this.voicedMs >= STALL_THRESHOLD_MS) this.fire('no-results');
  }

  private fire(cause: StallCause): void {
    if (!this.active || this.fired) return;
    this.fired = true;
    this.stop();
    this.deps.onStall(cause);
  }
}
