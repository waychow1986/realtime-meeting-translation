import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hostToHttpsBase, requireEnv } from './env.js';

export type SentenceSetName = 'single' | 'multi' | 'long';

interface Fixture {
  voice: string;
  sets: Record<SentenceSetName, { description: string; sentences: string[] }>;
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

function escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function buildSsml(voice: string, sentences: string[]): string {
  const body = sentences.map(escapeXml).join(`<break time="${SENTENCE_GAP_MS}ms"/>`);
  return (
    `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="http://www.w3.org/2001/mstts" xml:lang="en-US">` +
    `<voice name="${voice}"><mstts:silence type="Leading-exact" value="${LEADING_SILENCE_MS}ms"/>` +
    `<mstts:silence type="Tailing-exact" value="0ms"/>` +
    `<mstts:silence type="comma-exact" value="200ms"/>${body}</voice></speak>`
  );
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

async function synthesize(ssml: string): Promise<Buffer> {
  const url = `${hostToHttpsBase(requireEnv('AIDH_DEP_SPEECH_TTS_HOST'))}/cognitiveservices/v1`;
  for (let attempt = 0; ; attempt += 1) {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Ocp-Apim-Subscription-Key': requireEnv('AIDH_DEP_SPEECH_KEY'),
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

/**
 * Synthesizes the given sentence set with the real Speech TTS service and returns a cached WAV path
 * (16 kHz mono PCM, 1 s leading silence, 2 s between sentences, trailing silence padded explicitly).
 */
export async function ensureSpeechWav(set: SentenceSetName): Promise<string> {
  const fixture = loadFixture();
  const ssml = buildSsml(fixture.voice, fixture.sets[set].sentences);
  const digest = createHash('sha256').update(ssml).update(String(TRAILING_SILENCE_MS)).digest('hex').slice(0, 16);
  const dir = path.join(os.tmpdir(), 'rtmt-tts-cache');
  const file = path.join(dir, `${set}-${digest}.wav`);
  if (existsSync(file)) return file;
  await mkdir(dir, { recursive: true });
  const pcm = pcmOf(await synthesize(ssml));
  const trailing = Buffer.alloc(Math.round((TRAILING_SILENCE_MS / 1000) * SAMPLE_RATE) * 2);
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, wavFromPcm(Buffer.concat([pcm, trailing])));
  await rename(tmp, file);
  return file;
}

export async function readWav(file: string): Promise<Buffer> {
  return readFile(file);
}
