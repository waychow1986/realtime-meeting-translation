import { describe, expect, it, vi } from 'vitest';
import type { AudioChainMonitor } from '../../src/web/audioSource.js';
import { StallWatchdog, type StallCause } from '../../src/web/stallWatchdog.js';

/** Deterministic clock and interval: `tick(ms)` advances time and runs one check (TD-702: injected now/setInterval). */
function harness(options: { voiced?: boolean } = {}) {
  let time = 0;
  let callback: (() => void) | undefined;
  let changeListener: (() => void) | undefined;
  const state = { voiced: options.voiced ?? true, health: 'ok' as 'ok' | 'broken' };
  const unsubscribe = vi.fn(() => {
    changeListener = undefined;
  });
  const monitor: AudioChainMonitor = {
    health: () => state.health,
    isVoiced: () => state.voiced,
    onChange: (listener) => {
      changeListener = listener;
      return unsubscribe;
    },
  };
  const causes: StallCause[] = [];
  const clear = vi.fn(() => {
    callback = undefined;
  });
  const watchdog = new StallWatchdog({
    monitor,
    onStall: (cause) => causes.push(cause),
    now: () => time,
    setInterval: ((fn: () => void) => {
      callback = fn;
      return 1;
    }) as unknown as typeof setInterval,
    clearInterval: clear as unknown as typeof clearInterval,
  });
  return {
    watchdog,
    state,
    causes,
    unsubscribe,
    clear,
    advance(ms: number) {
      time += ms;
    },
    /** Advances `ms` and runs one interval check. */
    tick(ms = 1_000) {
      time += ms;
      callback?.();
    },
    /** Runs `n` one-second checks. */
    ticks(n: number) {
      for (let i = 0; i < n; i += 1) this.tick();
    },
    change() {
      changeListener?.();
    },
    get time() {
      return time;
    },
  };
}

describe('StallWatchdog（TD-702）', () => {
  it('有声音且没有识别结果：第 29 次检查不触发，第 30 次检查（累计 30 秒）以 no-results 触发', () => {
    const h = harness();
    h.watchdog.start();
    h.ticks(29);
    expect(h.causes).toEqual([]);
    h.tick();
    expect(h.causes).toEqual(['no-results']);
  });

  it('识别结果只清零有声计时：检查后 400 ms 收到结果，再有声 (29, 30] 秒内触发', () => {
    const h = harness();
    h.watchdog.start();
    h.ticks(5);
    h.advance(400);
    h.watchdog.noteResult();
    const resultAt = h.time;
    h.tick(600);
    let firedAt: number | undefined;
    for (let i = 0; i < 40 && h.causes.length === 0; i += 1) {
      h.tick();
      if (h.causes.length) firedAt = h.time;
    }
    expect(h.causes).toEqual(['no-results']);
    expect(firedAt! - resultAt).toBeGreaterThan(29_000);
    expect(firedAt! - resultAt).toBeLessThanOrEqual(30_000);
  });

  it('每 10 秒有一次识别结果：120 秒内不触发', () => {
    const h = harness();
    h.watchdog.start();
    for (let second = 1; second <= 120; second += 1) {
      h.tick();
      if (second % 10 === 0) h.watchdog.noteResult();
    }
    expect(h.causes).toEqual([]);
  });

  it('静音暂停计时、不清零：有声 20 秒 + 静音 60 秒 + 有声 10 秒触发', () => {
    const h = harness();
    h.watchdog.start();
    h.ticks(20);
    h.state.voiced = false;
    h.ticks(60);
    expect(h.causes).toEqual([]);
    h.state.voiced = true;
    h.ticks(9);
    expect(h.causes).toEqual([]);
    h.tick();
    expect(h.causes).toEqual(['no-results']);
  });

  it('持续静音 10 分钟不触发', () => {
    const h = harness({ voiced: false });
    h.watchdog.start();
    h.ticks(600);
    expect(h.causes).toEqual([]);
  });

  it('音频链路异常：即使静音，下一次检查以 audio-chain 触发', () => {
    const h = harness({ voiced: false });
    h.watchdog.start();
    h.ticks(3);
    h.state.health = 'broken';
    h.tick();
    expect(h.causes).toEqual(['audio-chain']);
  });

  it('音频链路异常：statechange 回调立即检查，不等下一次定时检查', () => {
    const h = harness({ voiced: false });
    h.watchdog.start();
    h.state.health = 'broken';
    h.change();
    expect(h.causes).toEqual(['audio-chain']);
  });

  it('识别会话结束：即使静音也立即以 session-ended 触发', () => {
    const h = harness({ voiced: false });
    h.watchdog.start();
    h.watchdog.noteSessionEnded();
    expect(h.causes).toEqual(['session-ended']);
  });

  it('只回调一次：触发后停止定时检查并取消订阅，之后的事件都忽略', () => {
    const h = harness();
    h.watchdog.start();
    h.watchdog.noteSessionEnded();
    h.state.health = 'broken';
    h.change();
    h.ticks(60);
    h.watchdog.noteSessionEnded();
    expect(h.causes).toEqual(['session-ended']);
    expect(h.clear).toHaveBeenCalledTimes(1);
    expect(h.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('检查被推迟（后台节流）时每次最多计入 2 秒', () => {
    const h = harness();
    h.watchdog.start();
    h.tick(10_000);
    h.ticks(27);
    expect(h.causes).toEqual([]);
    h.tick();
    expect(h.causes).toEqual(['no-results']);
  });

  it('stop() 后不再触发，可重复调用', () => {
    const h = harness();
    h.watchdog.start();
    h.ticks(10);
    h.watchdog.stop();
    h.watchdog.stop();
    h.ticks(60);
    h.watchdog.noteSessionEnded();
    h.state.health = 'broken';
    h.change();
    expect(h.causes).toEqual([]);
    expect(h.clear).toHaveBeenCalledTimes(1);
    expect(h.unsubscribe).toHaveBeenCalledTimes(1);
  });
});
