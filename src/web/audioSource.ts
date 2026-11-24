/** Structural subset of `MediaStreamTrack` (kept DOM-free so the logic is unit-testable under Node). */
export interface TrackLike {
  stop(): void;
  addEventListener(type: 'ended', listener: () => void): void;
  readonly readyState?: string;
}

/** Health and level of the system-audio mixing chain, read by the stall watchdog (TD-702, TD-703). */
export interface AudioChainMonitor {
  /** 'ok': the mixing AudioContext is running and its output track is live; otherwise 'broken'. */
  health(): 'ok' | 'broken';
  /** The shared audio's RMS over the last ~0.7 s is at least −50 dBFS. */
  isVoiced(): boolean;
  /** Called on the mixing AudioContext's 'statechange'; returns an unsubscribe function. */
  onChange(listener: () => void): () => void;
}

/** Structural subset of `MediaStream`. */
export interface StreamLike {
  getTracks(): TrackLike[];
  getAudioTracks(): TrackLike[];
}

/**
 * One acquired audio input of a run (TD-101). `stream` is what the recognizer consumes; `release()` stops every
 * underlying capture track (for a share also its video track) and frees audio resources. Calling it twice is a no-op.
 */
export interface AcquiredAudio<S extends StreamLike = StreamLike> {
  stream: S;
  release(): void;
  /** Only system audio provides one. */
  monitor?: AudioChainMonitor;
}

/** Wraps the microphone stream of version 1 unchanged: the recognizer reads it directly. */
export async function acquireMicrophone<S extends StreamLike>(open: () => Promise<S>): Promise<AcquiredAudio<S>> {
  const stream = await open();
  let released = false;
  return {
    stream,
    release: () => {
      if (released) return;
      released = true;
      stream.getTracks().forEach((track) => track.stop());
    },
  };
}
