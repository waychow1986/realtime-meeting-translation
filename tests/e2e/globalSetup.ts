import { existsSync } from 'node:fs';
import { copyFile, mkdir } from 'node:fs/promises';
import { ensureSpeechWav, type SentenceSetName } from '../support/tts.js';
import { AUDIO_DIR, audioPath } from './audio.js';

export default async function globalSetup(): Promise<void> {
  if (!existsSync('dist/server/main.js') || !existsSync('dist/web/app.js')) {
    throw new Error('dist/ is missing: run `npm run build` first (npm run test:e2e does this)');
  }
  await mkdir(AUDIO_DIR, { recursive: true });
  const sets: SentenceSetName[] = ['single', 'multi', 'meeting', 'long', 'interference', 'ko-drama', 'ja-drama'];
  for (const set of sets) await copyFile(await ensureSpeechWav(set), audioPath(set));
}
