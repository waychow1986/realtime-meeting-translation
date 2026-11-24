import type { AcquiredAudio, AudioChainMonitor, StreamLike, TrackLike } from './audioSource.js';

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

export interface AnalyserNodeLike extends AudioNodeLike {
  fftSize: number;
  getFloatTimeDomainData(array: Float32Array<ArrayBuffer>): void;
}

/** Structural subset of `AudioContext` used for the downmix (TD-106) and the stall monitor (TD-703). */
export interface AudioContextLike<S> {
  readonly state: string;
  resume(): Promise<void>;
  close(): Promise<void>;
  createMediaStreamSource(stream: S): AudioNodeLike;
  createGain(): GainNodeLike;
  createMediaStreamDestination(): DestinationNodeLike<S>;
  createAnalyser(): AnalyserNodeLike;
  addEventListener(type: 'statechange', listener: () => void): void;
  removeEventListener(type: 'statechange', listener: () => void): void;
}

/** −50 dBFS: at or above this RMS the shared audio counts as "有声音" for the stall watchdog (TD-703). */
export const VOICE_RMS_THRESHOLD = 0.00316;
/** ~0.68 s at 48 kHz. */
export const ANALYSER_FFT_SIZE = 32768;

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
      // Bypass tap for the stall monitor (TD-703): reads the mixed level, feeds no output.
      const analyser = ctx.createAnalyser();
      analyser.fftSize = ANALYSER_FFT_SIZE;
      gain.connect(analyser);
      const samples = new Float32Array(analyser.fftSize);
      const outputTracks = destination.stream.getAudioTracks();
      const stateListeners = new Set<() => void>();

      const monitor: AudioChainMonitor = {
        health: () =>
          ctx.state === 'running' && outputTracks.length > 0 && outputTracks.every((track) => track.readyState === 'live')
            ? 'ok'
            : 'broken',
        isVoiced: () => {
          analyser.getFloatTimeDomainData(samples);
          let sum = 0;
          for (const sample of samples) sum += sample * sample;
          return Math.sqrt(sum / samples.length) >= VOICE_RMS_THRESHOLD;
        },
        onChange: (listener) => {
          if (released) return () => undefined;
          const wrapped = () => listener();
          stateListeners.add(wrapped);
          ctx.addEventListener('statechange', wrapped);
          return () => {
            if (!stateListeners.delete(wrapped)) return;
            ctx.removeEventListener('statechange', wrapped);
          };
        },
      };

      return {
        stream: destination.stream,
        monitor,
        release: () => {
          if (released) return;
          released = true;
          stateListeners.forEach((listener) => ctx.removeEventListener('statechange', listener));
          stateListeners.clear();
          stopAll(shared);
          source.disconnect();
          gain.disconnect();
          analyser.disconnect();
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
