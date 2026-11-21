/** Structural subset of `MediaStreamTrack` (kept DOM-free so the logic is unit-testable under Node). */
export interface TrackLike {
  stop(): void;
  addEventListener(type: 'ended', listener: () => void): void;
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
