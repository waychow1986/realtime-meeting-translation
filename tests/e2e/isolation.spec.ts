import { NOT_RUNNING, RUNNING, captionTexts, expect, startButton, statusText, test, trackStates, waitForFinalCaptions } from './fixtures.js';

test.use({ audioSet: 'single' });

const NO_ENTRY = /历史|导出|下载|录音|保存/;

test('IQA-011 字幕只在当前页面可见，刷新后清空且不保留，页面没有历史/导出入口', async ({ harness }) => {
  const { page } = harness;
  await page.goto('/');
  await startButton(page).click();
  await expect(statusText(page)).toHaveText(RUNNING, { timeout: 10_000 });
  const captionsA = await waitForFinalCaptions(page, 1, 40_000);

  const pageB = await harness.newPage();
  await pageB.goto('/');
  await pageB.waitForTimeout(8_000);
  const textB = await pageB.locator('body').innerText();
  for (const caption of captionsA) expect(textB).not.toContain(caption);
  expect((await captionTexts(pageB)).filter((text) => text.trim())).toEqual([]);
  await expect(statusText(pageB)).toHaveText(NOT_RUNNING);

  await page.reload();
  await expect(statusText(page)).toHaveText(NOT_RUNNING);
  await page.waitForTimeout(8_000);
  expect((await captionTexts(page)).filter((text) => text.trim())).toEqual([]);
  expect((await trackStates(page)).gumCalls).toBe(0);
  const storage = await page.evaluate(() => localStorage.length + sessionStorage.length);
  expect(storage).toBe(0);

  for (const target of [page, pageB]) {
    const entries = await target.locator('button, a, [role="button"], [role="link"]').allInnerTexts();
    for (const entry of entries) expect(entry).not.toMatch(NO_ENTRY);
  }
});
