import os from 'node:os';
import path from 'node:path';
import type { SentenceSetName } from '../support/tts.js';

export const AUDIO_DIR = path.join(os.tmpdir(), 'rtmt-e2e-audio');

export function audioPath(set: SentenceSetName): string {
  return path.join(AUDIO_DIR, `${set}.wav`);
}

/** Chromium flags that replace the microphone with a looping WAV file (permission is granted per context). */
export function fakeMicrophoneArgs(set: SentenceSetName): string[] {
  return ['--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${audioPath(set)}`];
}
