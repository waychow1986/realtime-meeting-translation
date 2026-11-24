/**
 * Same-origin timer worker for the Speech SDK's audio send loop (see sdkTimers.ts). Worker timers are not
 * throttled like the timers of a hidden page. Built to `/sdk-timer-worker.js`.
 */
import type { TimerRequest } from './sdkTimers.js';

const handles = new Map<number, ReturnType<typeof setTimeout>>();

self.addEventListener('message', (event: MessageEvent<TimerRequest>) => {
  const request = event.data;
  if (request.method === 'set') {
    handles.set(
      request.id,
      setTimeout(() => {
        handles.delete(request.id);
        self.postMessage({ id: request.id });
      }, request.delay),
    );
  } else if (request.method === 'clear') {
    clearTimeout(handles.get(request.id));
    handles.delete(request.id);
  }
});
