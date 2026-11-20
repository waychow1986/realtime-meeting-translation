import { defineConfig, devices } from '@playwright/test';

/**
 * Developer-level functional tests (IQA-001/003/006/007/008/009/010/011). Each worker starts the built
 * server (`dist/`) on localhost against the real dev Speech and model instances; audio comes from a
 * synthesized English WAV fed to Chromium as a fake microphone.
 */
export default defineConfig({
  testDir: 'tests/e2e',
  testMatch: '**/*.spec.ts',
  globalSetup: './tests/e2e/globalSetup.ts',
  timeout: 150_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 2,
  retries: 0,
  reporter: [['list']],
  use: {
    ...devices['Desktop Chrome'],
    locale: 'zh-CN',
    trace: 'off',
    video: 'off',
  },
});
