import { build } from 'esbuild';
import { copyFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');

await rm(dist, { recursive: true, force: true });

await build({
  entryPoints: [path.join(root, 'src/server/main.ts')],
  outfile: path.join(dist, 'server/main.js'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  packages: 'external',
  sourcemap: false,
  logLevel: 'warning',
});

await build({
  entryPoints: [path.join(root, 'src/web/main.ts')],
  outfile: path.join(dist, 'web/app.js'),
  bundle: true,
  platform: 'browser',
  target: ['chrome120', 'edge120'],
  format: 'iife',
  minify: true,
  sourcemap: false,
  legalComments: 'none',
  logLevel: 'warning',
});

await build({
  entryPoints: [path.join(root, 'src/web/sdkTimerWorker.ts')],
  outfile: path.join(dist, 'web/sdk-timer-worker.js'),
  bundle: true,
  platform: 'browser',
  target: ['chrome120', 'edge120'],
  format: 'iife',
  minify: true,
  sourcemap: false,
  legalComments: 'none',
  logLevel: 'warning',
});

await mkdir(path.join(dist, 'web'), { recursive: true });
for (const file of ['index.html', 'styles.css']) {
  await copyFile(path.join(root, 'src/web', file), path.join(dist, 'web', file));
}

console.log('build ok: dist/server/main.js, dist/web/{index.html,app.js,sdk-timer-worker.js,styles.css}');
