import type { AcquiredAudio, StreamLike, TrackLike } from './audioSource.js';

/**
 * getDisplayMedia options (TD-102). Video is requested only because browsers require it; it is never read,
 * shown, sent or saved (TD-103). `suppressLocalAudioPlayback: false` keeps the shared tab audible (A-03).
 */
export const DISPLAY_OPTIONS = {
  video: { frameRate: { max: 1 }, width: { max: 640 }, height: { max: 360 } },
  audio: {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
    suppressLocalAudioPlayback: false,
  },
  systemAudio: 'include',
  selfBrowserSurface: 'exclude',
  surfaceSwitching: 'include',
  monitorTypeSurfaces: 'include',
  preferCurrentTab: false,
} as const;

export type DisplayOptions = typeof DISPLAY_OPTIONS;

/** A NotAllowedError faster than this never showed a dialog: blocked by policy or OS permission (TD-111). */
export const BLOCKED_THRESHOLD_MS = 400;

export type ShareFailure = 'share-cancelled' | 'share-blocked' | 'share-no-audio' | 'share-failed';

export class ShareError extends Error {
  constructor(readonly kind: ShareFailure) {
    super(kind);
    this.name = 'ShareError';
  }
}

export function classifyShareError(error: unknown, elapsedMs: number): ShareFailure {
  const name = typeof error === 'object' && error !== null && 'name' in error ? String(error.name) : '';
  if (name !== 'NotAllowedError') return 'share-failed';
  return elapsedMs < BLOCKED_THRESHOLD_MS ? 'share-blocked' : 'share-cancelled';
}

export interface AudioNodeLike {
  connect(destination: AudioNodeLike): unknown;
  disconnect(): void;
}

export interface GainNodeLike extends AudioNodeLike {
  channelCount: number;
  channelCountMode: string;
  channelInterpretation: string;
}

export interface DestinationNodeLike<S> extends AudioNodeLike {
  channelCount: number;
  readonly stream: S;
}

/** Structural subset of `AudioContext` used for the downmix (TD-106). */
export interface AudioContextLike<S> {
  resume(): Promise<void>;
  close(): Promise<void>;
  createMediaStreamSource(stream: S): AudioNodeLike;
  createGain(): GainNodeLike;
  createMediaStreamDestination(): DestinationNodeLike<S>;
}

export interface DisplayAudioDeps<S extends StreamLike> {
  getDisplayMedia(options: DisplayOptions): Promise<S>;
  createAudioContext(): AudioContextLike<S>;
  /** Builds a stream that holds only the given (audio) tracks. */
  audioOnlyStream(tracks: TrackLike[]): S;
  now(): number;
}

function stopAll(stream: StreamLike): void {
  stream.getTracks().forEach((track) => track.stop());
}

function closeQuietly<S>(ctx: AudioContextLike<S>): void {
  ctx.close().catch(() => undefined);
}

/**
 * Starts a system-audio share. Must be called synchronously from the click handler, before any `await`: the
 * AudioContext and the share dialog both need the user activation (TD-102, TD-106).
 * Resolves with a mono stream for the recognizer, or rejects with a ShareError. `onEnded` fires when any shared
 * track ends (browser "stop sharing", shared tab/window closed) (TD-107); `release()` does not trigger it.
 */
export function requestDisplayAudio<S extends StreamLike>(
  deps: DisplayAudioDeps<S>,
  onEnded: () => void,
): Promise<AcquiredAudio<S>> {
  const ctx = deps.createAudioContext();
  ctx.resume().catch(() => undefined);
  const startedAt = deps.now();
  let request: Promise<S>;
  try {
    request = deps.getDisplayMedia(DISPLAY_OPTIONS);
  } catch (error) {
    request = Promise.reject(error);
  }

  return request.then(
    (shared) => {
      const audioTracks = shared.getAudioTracks();
      if (audioTracks.length === 0) {
        stopAll(shared);
        closeQuietly(ctx);
        throw new ShareError('share-no-audio');
      }

      let released = false;
      const ended = () => {
        if (!released) onEnded();
      };
      shared.getTracks().forEach((track) => track.addEventListener('ended', ended));

      // Downmix with the "speakers" rules to one channel; never connected to ctx.destination (no second playback).
      const source = ctx.createMediaStreamSource(deps.audioOnlyStream(audioTracks));
      const gain = ctx.createGain();
      gain.channelCount = 1;
      gain.channelCountMode = 'explicit';
      gain.channelInterpretation = 'speakers';
      const destination = ctx.createMediaStreamDestination();
      destination.channelCount = 1;
      source.connect(gain);
      gain.connect(destination);

      return {
        stream: destination.stream,
        release: () => {
          if (released) return;
          released = true;
          stopAll(shared);
          source.disconnect();
          gain.disconnect();
          closeQuietly(ctx);
        },
      };
    },
    (error: unknown) => {
      closeQuietly(ctx);
      throw new ShareError(classifyShareError(error, deps.now() - startedAt));
    },
  );
}
