import type { AppState } from './messages.js';

export interface ControlAvailability {
  startEnabled: boolean;
  stopEnabled: boolean;
  /** Input source can only be changed while not capturing (FR-103). */
  sourceEnabled: boolean;
}

/** Icons shown next to the status text; together with the colour they differ for every state (FR-128). */
export const STATE_ICONS: Record<AppState, string> = {
  idle: '○',
  starting: '◔',
  running: '●',
  stopped: '■',
  error: '⚠',
};

export function controlsFor(state: AppState): ControlAvailability {
  const active = state === 'starting' || state === 'running';
  return { startEnabled: !active, stopEnabled: active, sourceEnabled: !active };
}

export const NEAR_BOTTOM_PX = 48;

export interface ScrollMetrics {
  scrollTop: number;
  clientHeight: number;
  scrollHeight: number;
}

/** Auto-scroll only follows new captions when the reader is already at (or near) the bottom (FR-130). */
export function isNearBottom(metrics: ScrollMetrics, threshold = NEAR_BOTTOM_PX): boolean {
  return metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight <= threshold;
}
