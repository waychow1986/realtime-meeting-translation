import { Timeout } from 'microsoft-cognitiveservices-speech-sdk/distrib/lib/src/common/Timeout.js';

/**
 * Timers for the Speech SDK's audio send loop that keep running at full rate while the page is hidden.
 *
 * The SDK paces audio upload with timers from a worker it loads from a `data:` URL, which the page CSP
 * (`script-src 'self'`) blocks: the worker never answers, so the first paced wait never ends and audio silently
 * stops being sent. Main-thread timers are no substitute, since browsers throttle them on hidden pages (the
 * translation page is usually in the background while the shared tab is watched). So the SDK's timers are routed
 * through a same-origin worker instead, falling back to main-thread timers only if that worker cannot run.
 */

export const SDK_TIMER_WORKER_URL = '/sdk-timer-worker.js';

/** The part of a dedicated Worker the timers use. */
export interface TimerWorker {
  postMessage(message: TimerRequest): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  addEventListener(type: 'error', listener: () => void): void;
  terminate(): void;
}

export type TimerRequest = { method: 'set'; id: number; delay: number } | { method: 'clear'; id: number };

export interface Timers {
  setTimeout(callback: () => void, delay: number): number;
  clearTimeout(id: number): void;
}

interface Pending {
  callback: () => void;
  due: number;
  mainHandle?: ReturnType<typeof setTimeout>;
}

export function createWorkerTimers(createWorker: () => TimerWorker, now: () => number = () => Date.now()): Timers {
  const pending = new Map<number, Pending>();
  let nextId = 0;
  let worker: TimerWorker | null = null;
  let workerFailed = false;

  const fire = (id: number) => {
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    entry.callback();
  };

  const onMainThread = (id: number, entry: Pending) => {
    entry.mainHandle = setTimeout(() => fire(id), Math.max(0, entry.due - now()));
  };

  const failOver = () => {
    if (workerFailed) return;
    workerFailed = true;
    worker?.terminate();
    worker = null;
    for (const [id, entry] of pending) if (entry.mainHandle === undefined) onMainThread(id, entry);
  };

  const ensureWorker = (): TimerWorker | null => {
    if (worker || workerFailed) return worker;
    try {
      const created = createWorker();
      created.addEventListener('message', (event) => {
        const id = (event.data as { id?: unknown } | null)?.id;
        if (typeof id === 'number') fire(id);
      });
      created.addEventListener('error', failOver);
      worker = created;
    } catch {
      failOver();
    }
    return worker;
  };

  return {
    setTimeout(callback, delay) {
      nextId += 1;
      const id = nextId;
      const ms = Math.max(0, Number(delay) || 0);
      const entry: Pending = { callback, due: now() + ms };
      pending.set(id, entry);
      const target = ensureWorker();
      if (target) target.postMessage({ method: 'set', id, delay: ms });
      else onMainThread(id, entry);
      return id;
    },
    clearTimeout(id) {
      const entry = pending.get(id);
      if (!entry) return;
      pending.delete(id);
      if (entry.mainHandle !== undefined) clearTimeout(entry.mainHandle);
      else worker?.postMessage({ method: 'clear', id });
    },
  };
}

let installed = false;

/** Makes recognizers created from now on pace audio upload with {@link createWorkerTimers}. Idempotent. */
export function installSdkTimers(createWorker: () => TimerWorker): void {
  if (installed) return;
  installed = true;
  const timers = createWorkerTimers(createWorker);
  Timeout.setTimeout = (callback: () => void, delay: number) => timers.setTimeout(callback, delay);
  Timeout.clearTimeout = (id: number) => timers.clearTimeout(id);
}
