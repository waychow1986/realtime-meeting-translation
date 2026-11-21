import {
  ERROR,
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

test.use({ audioSet: 'single', grantMicrophone: false });

test('IQA-010 麦克风权限被拒绝时给出中文提示，授权后再次开始即可恢复', async ({ harness }) => {
  const { page, context } = harness;
  await page.goto('/');
  await startButton(page).click();

  const notice = page.getByRole('alert');
  await expect(notice).toBeVisible({ timeout: 5_000 });
  await expect(notice).toContainText('麦克风');
  await expect(notice).toHaveText(/权限|拒绝|允许|无法|不可用/);
  const noticeText = await notice.innerText();
  expect(noticeText).not.toMatch(/azure|microsoft|https?:|[A-Za-z0-9]{32,}/i);
  await page.waitForTimeout(5_000);
  // FR-128 / TD-110: a start that cannot produce captions now ends in “出错” (v1 returned to “未开始”).
  await expect(statusText(page)).toHaveText(ERROR);
  expect(await trackStates(page)).toMatchObject({ states: [] });
  await expect(startButton(page)).toBeEnabled();
  expect((await captionTexts(page)).filter((text) => text.trim())).toEqual([]);

  await context.grantPermissions(['microphone']);
  await startButton(page).click();
  await expect(statusText(page)).toHaveText(RUNNING, { timeout: 10_000 });
  await expect(notice).toBeHidden();
  await waitForFinalCaptions(page, 1, 40_000);
  await stopButton(page).click();
  await expect(statusText(page)).toHaveText(NOT_RUNNING, { timeout: 3_000 });
});
