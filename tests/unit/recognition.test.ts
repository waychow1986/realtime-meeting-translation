import { beforeEach, describe, expect, it, vi } from 'vitest';

type RecognitionModule = {
  createRecognitionSession(
    stream: unknown,
    token: typeof TOKEN,
    handlers: Record<'onRecognizing' | 'onRecognized' | 'onFailure' | 'onSessionEnded', (...args: never[]) => void>,
  ): { dispose(): Promise<void> };
};

type Handler = (sender: unknown, event: unknown) => void;

interface FakeRecognizer {
  recognizing?: Handler;
  recognized?: Handler;
  canceled?: Handler;
  sessionStopped?: Handler;
  authorizationToken?: string;
  startContinuousRecognitionAsync(ok: () => void): void;
  stopContinuousRecognitionAsync(ok: () => void): void;
  close(): void;
}

const created: FakeRecognizer[] = [];
const configProperties = new Map<unknown, string>();

vi.mock('microsoft-cognitiveservices-speech-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('microsoft-cognitiveservices-speech-sdk')>();
  return {
    ...actual,
    SpeechConfig: {
      fromEndpoint: () => ({
        setProperty: (name: unknown, value: string) => {
          configProperties.set(name, value);
        },
      }),
    },
    AutoDetectSourceLanguageConfig: { fromLanguages: () => ({}) },
    AudioConfig: { fromStreamInput: () => ({}) },
    SpeechRecognizer: {
      FromConfig: () => {
        const recognizer: FakeRecognizer = {
          startContinuousRecognitionAsync: (ok) => ok(),
          stopContinuousRecognitionAsync: (ok) => ok(),
          close: () => undefined,
        };
        created.push(recognizer);
        return recognizer;
      },
    },
  };
});

const { CancellationReason, PropertyId, ResultReason } = await import('microsoft-cognitiveservices-speech-sdk');
// recognition.ts is browser code (DOM types); the unit-test program is type-checked without DOM, so the module is
// loaded through a non-literal specifier and typed structurally.
const RECOGNITION_MODULE = '../../src/web/recognition.js';
const { createRecognitionSession } = (await import(/* @vite-ignore */ RECOGNITION_MODULE)) as RecognitionModule;

const TOKEN = {
  token: 't',
  sttEndpoint: 'wss://stt.example.test/speech/universal/v2',
  candidateLanguages: ['en-US'],
  segmentationSilenceMs: 500,
  refreshAfterSeconds: 540,
};

function session() {
  const handlers = {
    onRecognizing: vi.fn(),
    onRecognized: vi.fn(),
    onFailure: vi.fn(),
    onSessionEnded: vi.fn(),
  };
  const s = createRecognitionSession({}, TOKEN, handlers);
  return { s, handlers, recognizer: created[created.length - 1]! };
}

describe('createRecognitionSession: how the SDK reports the end of recognition (TD-704)', () => {
  beforeEach(() => {
    created.length = 0;
  });

  it('an error cancellation is a failure with its code', () => {
    const { handlers, recognizer } = session();
    recognizer.canceled?.(null, { reason: CancellationReason.Error, errorCode: 4 });
    expect(handlers.onFailure).toHaveBeenCalledWith('4');
    expect(handlers.onSessionEnded).not.toHaveBeenCalled();
  });

  it('an end-of-stream cancellation ends the session without being a failure', () => {
    const { handlers, recognizer } = session();
    recognizer.canceled?.(null, { reason: CancellationReason.EndOfStream, errorCode: 0 });
    expect(handlers.onSessionEnded).toHaveBeenCalledWith('end_of_stream');
    expect(handlers.onFailure).not.toHaveBeenCalled();
  });

  it('a stopped session is reported as session_stopped, not as a failure', () => {
    const { handlers, recognizer } = session();
    recognizer.sessionStopped?.(null, {});
    expect(handlers.onSessionEnded).toHaveBeenCalledWith('session_stopped');
    expect(handlers.onFailure).not.toHaveBeenCalled();
  });

  it('reports nothing after dispose', async () => {
    const { s, handlers, recognizer } = session();
    await s.dispose();
    recognizer.recognizing?.(null, { result: { text: 'a' } });
    recognizer.recognized?.(null, { result: { text: 'a', reason: ResultReason.RecognizedSpeech } });
    recognizer.canceled?.(null, { reason: CancellationReason.Error, errorCode: 4 });
    recognizer.canceled?.(null, { reason: CancellationReason.EndOfStream, errorCode: 0 });
    recognizer.sessionStopped?.(null, {});
    expect(Object.values(handlers).every((fn) => fn.mock.calls.length === 0)).toBe(true);
  });
});

describe('createRecognitionSession: SDK timers under the page CSP', () => {
  it("turns off the SDK's data: URL timer worker, which `script-src 'self'` blocks", () => {
    configProperties.clear();
    session();
    expect(configProperties.get(PropertyId.WebWorkerLoadType)).toBe('off');
  });
});
