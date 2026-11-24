import {
  AudioConfig,
  AutoDetectSourceLanguageConfig,
  CancellationReason,
  OutputFormat,
  PropertyId,
  ResultReason,
  SpeechConfig,
  SpeechRecognizer,
  type SpeechRecognitionResult,
} from 'microsoft-cognitiveservices-speech-sdk';
import type { SpeechTokenResponse } from '../shared/contracts.js';
import { SDK_TIMER_WORKER_URL, installSdkTimers } from './sdkTimers.js';

export class MicrophoneError extends Error {
  constructor(readonly kind: 'denied' | 'not-found' | 'unavailable' | 'unsupported') {
    super(kind);
    this.name = 'MicrophoneError';
  }
}

export class SpeechTokenError extends Error {
  constructor() {
    super('speech token unavailable');
    this.name = 'SpeechTokenError';
  }
}

export async function openMicrophone(): Promise<MediaStream> {
  if (!navigator.mediaDevices?.getUserMedia) throw new MicrophoneError('unsupported');
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false,
    });
  } catch (error) {
    const name = error instanceof DOMException ? error.name : '';
    if (name === 'NotAllowedError' || name === 'SecurityError') throw new MicrophoneError('denied');
    if (name === 'NotFoundError' || name === 'OverconstrainedError') throw new MicrophoneError('not-found');
    throw new MicrophoneError('unavailable');
  }
}

function isSpeechTokenResponse(value: unknown): value is SpeechTokenResponse {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.token === 'string' &&
    typeof v.sttEndpoint === 'string' &&
    Array.isArray(v.candidateLanguages) &&
    v.candidateLanguages.every((l) => typeof l === 'string') &&
    typeof v.segmentationSilenceMs === 'number' &&
    typeof v.refreshAfterSeconds === 'number'
  );
}

export async function fetchSpeechToken(signal?: AbortSignal): Promise<SpeechTokenResponse> {
  let response: Response;
  try {
    response = await fetch('/api/speech-token', {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      ...(signal ? { signal } : {}),
    });
  } catch {
    throw new SpeechTokenError();
  }
  if (!response.ok) throw new SpeechTokenError();
  const body: unknown = await response.json().catch(() => undefined);
  if (!isSpeechTokenResponse(body)) throw new SpeechTokenError();
  return body;
}

export interface RecognitionHandlers {
  onRecognizing(text: string, language: string | undefined): void;
  onRecognized(text: string, language: string | undefined): void;
  /** Recognition can no longer continue (connection lost, invalid token, quota...): an error cancellation. */
  onFailure(errorCode: string): void;
  /** The recognition session ended without an error (TD-704); the caller decides what that means for the run. */
  onSessionEnded(cause: 'session_stopped' | 'end_of_stream'): void;
}

export interface RecognitionSession {
  start(): Promise<void>;
  updateToken(token: string): void;
  /** Stops recognition and releases the SDK; errors are ignored. */
  dispose(): Promise<void>;
}

/**
 * Language detected by the service. AutoDetectSourceLanguageResult.fromResult throws for interim
 * results (they carry no confidence), so read the same `language` field it would wrap directly.
 */
function detectedLanguage(result: SpeechRecognitionResult): string | undefined {
  return result.language || undefined;
}

/** Continuous recognition with automatic (continuous) language identification over a browser MediaStream. */
export function createRecognitionSession(
  stream: MediaStream,
  token: SpeechTokenResponse,
  handlers: RecognitionHandlers,
): RecognitionSession {
  const config = SpeechConfig.fromEndpoint(new URL(token.sttEndpoint));
  config.authorizationToken = token.token;
  config.setProperty(PropertyId.SpeechServiceConnection_LanguageIdMode, 'Continuous');
  config.setProperty(PropertyId.Speech_SegmentationSilenceTimeoutMs, String(token.segmentationSilenceMs));
  config.outputFormat = OutputFormat.Simple;
  const lid = AutoDetectSourceLanguageConfig.fromLanguages(token.candidateLanguages);
  const audio = AudioConfig.fromStreamInput(stream);
  installSdkTimers(() => new Worker(SDK_TIMER_WORKER_URL));
  const recognizer = SpeechRecognizer.FromConfig(config, lid, audio);
  let disposed = false;

  recognizer.recognizing = (_sender, event) => {
    if (disposed) return;
    handlers.onRecognizing(event.result.text ?? '', detectedLanguage(event.result));
  };
  recognizer.recognized = (_sender, event) => {
    if (disposed) return;
    const text = event.result.reason === ResultReason.RecognizedSpeech ? (event.result.text ?? '') : '';
    handlers.onRecognized(text, detectedLanguage(event.result));
  };
  recognizer.canceled = (_sender, event) => {
    if (disposed) return;
    if (event.reason === CancellationReason.Error) handlers.onFailure(String(event.errorCode));
    else if (event.reason === CancellationReason.EndOfStream) handlers.onSessionEnded('end_of_stream');
  };
  recognizer.sessionStopped = () => {
    if (disposed) return;
    handlers.onSessionEnded('session_stopped');
  };

  return {
    start: () =>
      new Promise<void>((resolve, reject) => {
        recognizer.startContinuousRecognitionAsync(resolve, (error) => reject(new Error(String(error))));
      }),
    updateToken: (value) => {
      if (!disposed) recognizer.authorizationToken = value;
    },
    dispose: async () => {
      if (disposed) return;
      disposed = true;
      await new Promise<void>((resolve) => {
        try {
          recognizer.stopContinuousRecognitionAsync(resolve, () => resolve());
        } catch {
          resolve();
        }
      });
      try {
        recognizer.close();
      } catch {
        // already closed
      }
    },
  };
}
