import { describe, expect, it } from 'vitest';
import type { AppState } from '../../src/web/messages.js';
import { controlsFor, isNearBottom } from '../../src/web/uiState.js';

describe('controlsFor', () => {
  const cases: [AppState, { start: boolean; stop: boolean; source: boolean }][] = [
    ['idle', { start: true, stop: false, source: true }],
    ['starting', { start: false, stop: true, source: false }],
    ['running', { start: false, stop: true, source: false }],
    ['stopped', { start: true, stop: false, source: true }],
    ['error', { start: true, stop: false, source: true }],
  ];

  it.each(cases)('%s → start/stop/input-source availability', (state, expected) => {
    const controls = controlsFor(state);
    expect({ start: controls.startEnabled, stop: controls.stopEnabled, source: controls.sourceEnabled }).toEqual(
      expected,
    );
  });
});

describe('isNearBottom', () => {
  it('is true when the remaining distance to the bottom is at most 48 px', () => {
    expect(isNearBottom({ scrollTop: 600, clientHeight: 400, scrollHeight: 1000 })).toBe(true);
    expect(isNearBottom({ scrollTop: 552, clientHeight: 400, scrollHeight: 1000 })).toBe(true);
    expect(isNearBottom({ scrollTop: 551, clientHeight: 400, scrollHeight: 1000 })).toBe(false);
    expect(isNearBottom({ scrollTop: 0, clientHeight: 400, scrollHeight: 1000 })).toBe(false);
  });

  it('is true when the content does not overflow', () => {
    expect(isNearBottom({ scrollTop: 0, clientHeight: 400, scrollHeight: 300 })).toBe(true);
  });

  it('tolerates fractional scroll positions', () => {
    expect(isNearBottom({ scrollTop: 599.5, clientHeight: 400.4, scrollHeight: 1000 })).toBe(true);
  });
});
