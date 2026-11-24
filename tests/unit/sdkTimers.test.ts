import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWorkerTimers, type TimerRequest, type TimerWorker } from '../../src/web/sdkTimers.js';

class FakeWorker implements TimerWorker {
  readonly posted: TimerRequest[] = [];
  terminated = false;
  private readonly listeners: { message: ((event: { data: unknown }) => void)[]; error: (() => void)[] } = {
    message: [],
    error: [],
  };
  postMessage(message: TimerRequest) {
    this.posted.push(message);
  }
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  addEventListener(type: 'error', listener: () => void): void;
  addEventListener(type: 'message' | 'error', listener: (event: { data: unknown }) => void): void {
    if (type === 'message') this.listeners.message.push(listener);
    else this.listeners.error.push(() => listener({ data: undefined }));
  }
  terminate() {
    this.terminated = true;
  }
  /** The worker reports that timer `id` elapsed. */
  elapse(id: number) {
    for (const listener of this.listeners.message) listener({ data: { id } });
  }
  /** The worker script could not be loaded or run (e.g. blocked by CSP, 404). */
  fail() {
    for (const listener of this.listeners.error) listener();
  }
}

describe('createWorkerTimers: SDK audio-send timers off the main thread', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('schedules through the worker, not main-thread timers, and runs the callback once when the worker reports it', () => {
    const worker = new FakeWorker();
    const timers = createWorkerTimers(() => worker);
    const fired = vi.fn();
    const id = timers.setTimeout(fired, 250);

    expect(worker.posted).toEqual([{ method: 'set', id, delay: 250 }]);
    vi.advanceTimersByTime(10_000);
    expect(fired).not.toHaveBeenCalled();

    worker.elapse(id);
    worker.elapse(id);
    expect(fired).toHaveBeenCalledTimes(1);
  });

  it('creates one worker for all timers and clears a timer in the worker', () => {
    const create = vi.fn(() => new FakeWorker());
    const timers = createWorkerTimers(create);
    const fired = vi.fn();
    const a = timers.setTimeout(fired, 10);
    timers.setTimeout(() => undefined, 20);
    timers.clearTimeout(a);

    expect(create).toHaveBeenCalledTimes(1);
    const worker = create.mock.results[0]!.value as FakeWorker;
    expect(worker.posted.at(-1)).toEqual({ method: 'clear', id: a });
    worker.elapse(a);
    expect(fired).not.toHaveBeenCalled();
  });

  it('falls back to main-thread timers when the worker fails, keeping already scheduled timers on time', () => {
    let clock = 0;
    const worker = new FakeWorker();
    const timers = createWorkerTimers(() => worker, () => clock);
    const early = vi.fn();
    const late = vi.fn();
    timers.setTimeout(early, 100);
    clock = 60;
    vi.advanceTimersByTime(60);
    worker.fail();
    expect(worker.terminated).toBe(true);

    timers.setTimeout(late, 100);
    expect(worker.posted).toHaveLength(1);
    vi.advanceTimersByTime(40);
    expect(early).toHaveBeenCalledTimes(1);
    expect(late).not.toHaveBeenCalled();
    vi.advanceTimersByTime(60);
    expect(late).toHaveBeenCalledTimes(1);
  });

  it('falls back to main-thread timers when no worker can be created', () => {
    const timers = createWorkerTimers(() => {
      throw new Error('SecurityError');
    });
    const fired = vi.fn();
    const cancelled = vi.fn();
    timers.setTimeout(fired, 50);
    timers.clearTimeout(timers.setTimeout(cancelled, 50));
    vi.advanceTimersByTime(50);
    expect(fired).toHaveBeenCalledTimes(1);
    expect(cancelled).not.toHaveBeenCalled();
  });
});
