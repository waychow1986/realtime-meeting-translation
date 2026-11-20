import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chatAuth, speechAuth } from './auth/azureAuth.js';
import { ConfigError, loadConfig, type AppConfig } from './config.js';
import { buildApp } from './http/app.js';
import { createLogger } from './logger.js';
import { createSpeechTokenService } from './speech/tokenService.js';
import { createTranslator } from './translation/translator.js';

const SHUTDOWN_GRACE_MS = 10_000;

function resolveWebRoot(): string {
  if (process.env.WEB_ROOT) return path.resolve(process.env.WEB_ROOT);
  // dist/server/main.js -> dist/web
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../web');
}

async function main(): Promise<void> {
  let config: AppConfig;
  try {
    config = loadConfig(process.env);
  } catch (err) {
    const logger = createLogger({ level: 'info' });
    logger.fatal('config_invalid', 'configuration invalid', {
      configKeys: err instanceof ConfigError ? err.problems.join(',') : undefined,
      errorClass: err instanceof Error ? err.name : undefined,
    });
    process.exit(1);
  }

  const logger = createLogger({ level: config.logLevel });

  const fatal = (kind: string) => (err: unknown) => {
    logger.fatal('unhandled_error', kind, { errorClass: err instanceof Error ? err.name : 'UnknownError' });
    logger.flush();
    process.exit(1);
  };
  process.on('uncaughtException', fatal('uncaught exception'));
  process.on('unhandledRejection', fatal('unhandled rejection'));

  const app = await buildApp({
    config,
    logger,
    webRoot: resolveWebRoot(),
    tokenService: createSpeechTokenService({ stsBaseUrl: config.speech.stsBaseUrl, auth: speechAuth(config.speech.auth) }),
    translator: createTranslator({
      baseUrl: config.chat.baseUrl,
      deployment: config.chat.deployment,
      auth: chatAuth(config.chat.auth),
    }),
  });

  await app.listen({ host: '0.0.0.0', port: config.port });
  logger.info('server_started', 'server started', { authMode: config.chat.auth.mode });

  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    logger.info('server_stopping', 'server stopping');
    const force = setTimeout(() => {
      logger.flush();
      process.exit(0);
    }, SHUTDOWN_GRACE_MS);
    force.unref();
    app
      .close()
      .catch(() => undefined)
      .finally(() => {
        clearTimeout(force);
        logger.flush();
        process.exit(0);
      });
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err: unknown) => {
  createLogger({ level: 'info' }).fatal('unhandled_error', 'startup failed', {
    errorClass: err instanceof Error ? err.name : 'UnknownError',
  });
  process.exit(1);
});
