import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { speechAuth } from '../../src/server/auth/azureAuth.js';
import { loadConfig } from '../../src/server/config.js';
import { createSpeechTokenService, type SpeechTokenService } from '../../src/server/speech/tokenService.js';
import { hostToHttpsBase, requireEnv } from './env.js';

export type SentenceSetName = 'single' | 'multi' | 'meeting' | 'long' | 'interference';

/** Reference translation and meaning checks for one sentence (regex sources; every key point must match). */
export interface SentenceAnnotation {
  reference: string;
  keyPoints: string[];
  anchor: string;
}

interface SentenceSet {
  description: string;
  sentences: string[];
  annotations?: SentenceAnnotation[];
}

interface Fixture {
  voice: string;
  sets: Record<SentenceSetName, SentenceSet>;
}

/** Position of one spoken sentence inside the synthesized WAV. */
export interface SentenceTiming {
  startMs: number;
  endMs: number;
}

export interface SpeechAudio {
  wav: string;
  timings: SentenceTiming[];
  durationMs: number;
}

const FIXTURE_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/sentences.en.json');

export const LEADING_SILENCE_MS = 1000;
export const SENTENCE_GAP_MS = 2000;
export const TRAILING_SILENCE_MS = 4000;
const SAMPLE_RATE = 16000;

export function loadFixture(): Fixture {
  return JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as Fixture;
}

export function sentencesOf(set: SentenceSetName): string[] {
  return loadFixture().sets[set].sentences;
}

export function annotationsOf(set: SentenceSetName): SentenceAnnotation[] {
  const { sentences, annotations } = loadFixture().sets[set];
  if (!annotations || annotations.length !== sentences.length) throw new Error(`set ${set} has no annotation per sentence`);
  return annotations;
}

function escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

/** One sentence without leading/trailing silence, so its position in the concatenated WAV is exact. */
function buildSentenceSsml(voice: string, sentence: string): string {
  return (
    `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="http://www.w3.org/2001/mstts" xml:lang="en-US">` +
    `<voice name="${voice}"><mstts:silence type="Leading-exact" value="0ms"/>` +
    `<mstts:silence type="Tailing-exact" value="0ms"/>` +
    `<mstts:silence type="comma-exact" value="200ms"/>${escapeXml(sentence)}</voice></speak>`
  );
}

function silence(ms: number): Buffer {
  return Buffer.alloc(Math.round((ms / 1000) * SAMPLE_RATE) * 2);
}

function pcmMs(pcm: Buffer): number {
  return (pcm.length / (SAMPLE_RATE * 2)) * 1000;
}

/** Extracts the PCM payload of a RIFF/WAVE file. */
export function pcmOf(wav: Buffer): Buffer {
  if (wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') throw new Error('not a wav file');
  let offset = 12;
  while (offset + 8 <= wav.length) {
    const id = wav.toString('ascii', offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    if (id === 'data') return wav.subarray(offset + 8, Math.min(wav.length, offset + 8 + size));
    offset += 8 + size + (size % 2);
  }
  throw new Error('wav has no data chunk');
}

export function wavFromPcm(pcm: Buffer): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

export function wavDurationMs(wav: Buffer): number {
  return (pcmOf(wav).length / (SAMPLE_RATE * 2)) * 1000;
}

let tokenService: SpeechTokenService | undefined;

/**
 * Authenticates like the application (AIDH_DEP_SPEECH_AUTH_MODE: key or managed identity) and calls TTS with
 * a short-lived STS token, which the TTS REST API accepts in both modes.
 */
async function ttsAuthHeaders(): Promise<Record<string, string>> {
  if (!tokenService) {
    const config = loadConfig(process.env);
    tokenService = createSpeechTokenService({ stsBaseUrl: config.speech.stsBaseUrl, auth: speechAuth(config.speech.auth) });
  }
  return { Authorization: `Bearer ${await tokenService.getToken()}` };
}

async function synthesize(ssml: string): Promise<Buffer> {
  const url = `${hostToHttpsBase(requireEnv('AIDH_DEP_SPEECH_TTS_HOST'))}/cognitiveservices/v1`;
  for (let attempt = 0; ; attempt += 1) {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        ...(await ttsAuthHeaders()),
        'Content-Type': 'application/ssml+xml',
        'X-Microsoft-OutputFormat': 'riff-16khz-16bit-mono-pcm',
        'User-Agent': 'realtime-meeting-translation-tests',
      },
      body: ssml,
      signal: AbortSignal.timeout(60_000),
    });
    if (response.ok) return Buffer.from(await response.arrayBuffer());
    await response.body?.cancel();
    if (attempt >= 2 || (response.status !== 429 && response.status < 500)) {
      throw new Error(`text-to-speech failed with HTTP ${response.status}`);
    }
    await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
  }
}

async function writeAtomic(file: string, data: Buffer | string): Promise<void> {
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, data);
  await rename(tmp, file);
}

/**
 * Synthesizes each sentence of the set with the real Speech TTS service and concatenates them
 * (16 kHz mono PCM: 1 s leading silence, 2 s between sentences, 4 s trailing silence). The WAV and the
 * per-sentence start/end times are cached in the system temp directory.
 */
export async function ensureSpeechAudio(set: SentenceSetName): Promise<SpeechAudio> {
  const fixture = loadFixture();
  const ssmls = fixture.sets[set].sentences.map((sentence) => buildSentenceSsml(fixture.voice, sentence));
  const digest = createHash('sha256')
    .update(JSON.stringify([ssmls, LEADING_SILENCE_MS, SENTENCE_GAP_MS, TRAILING_SILENCE_MS]))
    .digest('hex')
    .slice(0, 16);
  const dir = path.join(os.tmpdir(), 'rtmt-tts-cache');
  const file = path.join(dir, `${set}-${digest}.wav`);
  const timingsFile = `${file}.json`;
  if (existsSync(file) && existsSync(timingsFile)) {
    return JSON.parse(await readFile(timingsFile, 'utf8')) as SpeechAudio;
  }
  await mkdir(dir, { recursive: true });
  const parts: Buffer[] = [silence(LEADING_SILENCE_MS)];
  const timings: SentenceTiming[] = [];
  let cursorMs = LEADING_SILENCE_MS;
  for (const [index, ssml] of ssmls.entries()) {
    if (index > 0) {
      parts.push(silence(SENTENCE_GAP_MS));
      cursorMs += SENTENCE_GAP_MS;
    }
    const pcm = pcmOf(await synthesize(ssml));
    parts.push(pcm);
    timings.push({ startMs: Math.round(cursorMs), endMs: Math.round(cursorMs + pcmMs(pcm)) });
    cursorMs += pcmMs(pcm);
  }
  parts.push(silence(TRAILING_SILENCE_MS));
  const audio: SpeechAudio = { wav: file, timings, durationMs: Math.round(cursorMs + TRAILING_SILENCE_MS) };
  await writeAtomic(file, wavFromPcm(Buffer.concat(parts)));
  await writeAtomic(timingsFile, JSON.stringify(audio));
  return audio;
}

export async function ensureSpeechWav(set: SentenceSetName): Promise<string> {
  return (await ensureSpeechAudio(set)).wav;
}

export async function readWav(file: string): Promise<Buffer> {
  return readFile(file);
}
