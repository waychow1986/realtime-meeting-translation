import {
  AudioConfig,
  AudioInputStream,
  AutoDetectSourceLanguageConfig,
  OutputFormat,
  PropertyId,
  ResultReason,
  SpeechConfig,
  SpeechRecognizer,
  type SpeechRecognitionResult,
} from 'microsoft-cognitiveservices-speech-sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SpeechTokenResponse } from '../../src/shared/contracts.js';
import { buildRealApp, type RealApp } from '../support/realApp.js';
import { ensureSpeechWav, pcmOf, readWav, sentencesOf, wavDurationMs, type SentenceSetName } from '../support/tts.js';

interface RecognitionTrace {
  recognizing: { offsetMs: number; language?: string }[];
  recognized: { text: string; language?: string }[];
  canceled?: string;
}

let real: RealApp;

beforeAll(async () => {
  real = await buildRealApp();
});

afterAll(async () => {
  await real.app.close();
});

async function issueToken(): Promise<SpeechTokenResponse> {
  const response = await real.app.inject({ method: 'POST', url: '/api/speech-token', headers: real.sameOriginHeaders });
  expect(response.statusCode).toBe(200);
  return response.json<SpeechTokenResponse>();
}

/** Runs the same recognizer configuration the browser uses (design 开始 step 4) over a synthesized WAV. */
async function recognize(set: SentenceSetName): Promise<RecognitionTrace> {
  const token = await issueToken();
  const pcm = pcmOf(await readWav(await ensureSpeechWav(set)));
  const config = SpeechConfig.fromEndpoint(new URL(token.sttEndpoint));
  config.authorizationToken = token.token;
  config.setProperty(PropertyId.SpeechServiceConnection_LanguageIdMode, 'Continuous');
  config.setProperty(PropertyId.Speech_SegmentationSilenceTimeoutMs, String(token.segmentationSilenceMs));
  config.outputFormat = OutputFormat.Simple;
  const push = AudioInputStream.createPushStream();
  const recognizer = SpeechRecognizer.FromConfig(
    config,
    AutoDetectSourceLanguageConfig.fromLanguages(token.candidateLanguages),
    AudioConfig.fromStreamInput(push),
  );
  const trace: RecognitionTrace = { recognizing: [], recognized: [] };
  const started = Date.now();
  // fromResult throws for interim results (no confidence) and the SDK swallows handler errors.
  const lang = (result: SpeechRecognitionResult) => result.language || undefined;

  const done = new Promise<void>((resolve) => {
    recognizer.recognizing = (_s, e) => trace.recognizing.push({ offsetMs: Date.now() - started, language: lang(e.result) });
    recognizer.recognized = (_s, e) => {
      if (e.result.reason === ResultReason.RecognizedSpeech && e.result.text.trim()) {
        trace.recognized.push({ text: e.result.text, language: lang(e.result) });
      }
    };
    recognizer.canceled = (_s, e) => {
      if (e.errorCode) trace.canceled = String(e.errorCode);
      resolve();
    };
    recognizer.sessionStopped = () => resolve();
  });

  await new Promise<void>((resolve, reject) => recognizer.startContinuousRecognitionAsync(resolve, reject));
  // Feed audio at roughly 4x real time in 100 ms frames so the service produces streaming interim results.
  const frame = 3200;
  for (let i = 0; i < pcm.length; i += frame) {
    const chunk = pcm.subarray(i, i + frame);
    push.write(chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.length) as ArrayBuffer);
    await new Promise((r) => setTimeout(r, 25));
  }
  push.close();
  await done;
  await new Promise<void>((resolve) => recognizer.stopContinuousRecognitionAsync(resolve, () => resolve()));
  recognizer.close();
  return trace;
}

describe('Azure Speech streaming recognition with automatic language identification (AC-07)', () => {
  it('the token API exposes the configured endpoint, candidate languages and segmentation threshold', async () => {
    const token = await issueToken();
    expect(token.token.length).toBeGreaterThan(100);
    expect(token.sttEndpoint).toBe(real.config.speech.sttEndpoint);
    expect(token.sttEndpoint).toMatch(/^wss:\/\/.+\/speech\/universal\/v2$/);
    expect(token.candidateLanguages).toEqual(real.config.candidateLanguages);
    expect(token.segmentationSilenceMs).toBe(real.config.segmentationSilenceMs);
  });

  it('returns interim results and exactly one en-US final result per spoken sentence', async () => {
    const expected = sentencesOf('multi');
    const trace = await recognize('multi');
    expect(trace.canceled).toBeUndefined();
    expect(trace.recognizing.length).toBeGreaterThanOrEqual(expected.length);
    expect(trace.recognized).toHaveLength(expected.length);
    for (const result of trace.recognized) expect(result.language).toBe('en-US');
    expect(trace.recognized[0]?.text.toLowerCase()).toContain('good morning');
    expect(trace.recognized[2]?.text.toLowerCase()).toContain('revenue');
  });

  it('keeps a 10–20 second sentence with short comma pauses as a single final result', async () => {
    const wav = await readWav(await ensureSpeechWav('long'));
    const speechMs = wavDurationMs(wav) - 1000 - 4000;
    expect(speechMs).toBeGreaterThan(10_000);
    expect(speechMs).toBeLessThan(20_000);
    const trace = await recognize('long');
    expect(trace.canceled).toBeUndefined();
    expect(trace.recognizing.length).toBeGreaterThan(1);
    expect(trace.recognized).toHaveLength(1);
    expect(trace.recognized[0]?.language).toBe('en-US');
  });
});
