import {
  NOT_RUNNING,
  RUNNING,
  captionTexts,
  expect,
  startButton,
  statusText,
  stopButton,
  test,
  trackStates,
  waitForFinalCaptions,
} from './fixtures.js';

test.use({ audioSet: 'multi' });

const QUIET_PERIOD_MS = 31_000;

test('IQA-006 停止后立即释放麦克风、不再发送音频、字幕不再变化；再次开始在原字幕之后追加', async ({ harness }) => {
  test.setTimeout(240_000);
  const { page, frames } = harness;
  await page.goto('/');
  await startButton(page).click();
  await expect(statusText(page)).toHaveText(RUNNING, { timeout: 10_000 });

  // Stop while the second sentence is being spoken (the first one already has a final caption).
  await waitForFinalCaptions(page, 1);
  await page.waitForTimeout(1_500);
  const beforeStop = await captionTexts(page, 'final');
  await stopButton(page).click();
  const stoppedAt = Date.now();

  await expect.poll(async () => (await trackStates(page)).states, { timeout: 2_000 }).not.toContain('live');
  const { gumCalls, states } = await trackStates(page);
  expect(states.length).toBeGreaterThan(0);
  expect(states.every((state) => state === 'ended')).toBe(true);
  await expect(statusText(page)).toHaveText(NOT_RUNNING);

  await page.waitForTimeout(1_000);
  const snapshot = await captionTexts(page);
  for (const text of beforeStop) expect(snapshot).toContain(text);
  await page.waitForTimeout(QUIET_PERIOD_MS);
  expect(await captionTexts(page)).toEqual(snapshot);
  const lateFrames = frames.filter((frame) => frame.direction === 'sent' && frame.at > stoppedAt + 2_000 && frame.bytes > 1024);
  expect(lateFrames).toHaveLength(0);
  expect((await trackStates(page)).gumCalls).toBe(gumCalls);

  // Restart: new captions are appended after the preserved ones.
  await startButton(page).click();
  await expect(statusText(page)).toHaveText(RUNNING, { timeout: 10_000 });
  const preserved = snapshot.filter((text) => text.trim());
  await expect
    .poll(async () => (await captionTexts(page, 'final')).filter((text) => text.trim()).length, { timeout: 60_000 })
    .toBeGreaterThan(preserved.length);
  const after = (await captionTexts(page)).filter((text) => text.trim());
  expect(after.slice(0, preserved.length)).toEqual(preserved);
  await stopButton(page).click();
  await expect(statusText(page)).toHaveText(NOT_RUNNING, { timeout: 3_000 });
});
