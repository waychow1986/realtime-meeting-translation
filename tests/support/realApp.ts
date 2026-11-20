import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { chatAuth, speechAuth } from '../../src/server/auth/azureAuth.js';
import { loadConfig, type AppConfig } from '../../src/server/config.js';
import { buildApp } from '../../src/server/http/app.js';
import { createLogger } from '../../src/server/logger.js';
import { createSpeechTokenService } from '../../src/server/speech/tokenService.js';
import { createTranslator } from '../../src/server/translation/translator.js';
import { MemoryLogSink } from './memoryLogSink.js';

export interface RealApp {
  app: FastifyInstance;
  config: AppConfig;
  sink: MemoryLogSink;
  sameOriginHeaders: Record<string, string>;
}

/** Builds the real application wired to the injected dev dependency instances (no mocks). */
export async function buildRealApp(envOverrides: Record<string, string> = {}): Promise<RealApp> {
  const config = loadConfig({ ...process.env, ...envOverrides });
  const sink = new MemoryLogSink();
  const logger = createLogger({ level: 'info', destination: sink });
  const webRoot = await mkdtemp(path.join(os.tmpdir(), 'rtmt-web-'));
  await writeFile(path.join(webRoot, 'index.html'), '<!doctype html><title>t</title>');
  const app = await buildApp({
    config,
    logger,
    webRoot,
    tokenService: createSpeechTokenService({ stsBaseUrl: config.speech.stsBaseUrl, auth: speechAuth(config.speech.auth) }),
    translator: createTranslator({
      baseUrl: config.chat.baseUrl,
      deployment: config.chat.deployment,
      auth: chatAuth(config.chat.auth),
    }),
  });
  await app.ready();
  return {
    app,
    config,
    sink,
    sameOriginHeaders: { origin: 'http://app.test', host: 'app.test', 'sec-fetch-site': 'same-origin' },
  };
}
