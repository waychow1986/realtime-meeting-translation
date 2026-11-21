import type { Page } from '@playwright/test';
import { playMaterial } from '../support/player.js';
import { ERROR, RUNNING, expect, selectSource, startButton, statusText, stopButton, test } from './fixtures.js';

/**
 * G4 UI defects (AC-11): the system-audio instructions must fold away while listening so the captions are the main
 * area, and the control bar must use one consistent control style (no native radio dots) that fits in at most two
 * rows at about 480 px wide. Accessible names stay unchanged.
 */

const TOPBAR_ITEMS = ['h1', '#input-source', '#start-button', '#stop-button', '.status-box', '#caption-size', '#pip-button', '#guide-open'];
/** Controls whose height, corner radius and look must match (the "pill" items of the control bar). */
const UNIFORM_CONTROLS = [
  '#input-source label',
  '#start-button',
  '#stop-button',
  '.status-box',
  '#caption-size label',
  '#pip-button',
  '#guide-open',
];

interface TopbarProbe {
  rows: number;
  topbarHeight: number;
  heights: { selector: string; height: number }[];
  /** Native radio circles still painted (visible, non-zero opacity, default appearance). */
  nativeRadios: number;
  /** Segmented groups: the selected option looks different from the unselected ones. */
  selectedDistinct: boolean;
}

// Browser-side source text: the test tsconfig has no DOM lib.
const TOPBAR_PROBE = `(() => {
  const items = ${JSON.stringify(TOPBAR_ITEMS)}.map((s) => document.querySelector(s)).filter((el) => el && el.getClientRects().length);
  const tops = [];
  for (const el of items) {
    const r = el.getBoundingClientRect();
    const mid = r.top + r.height / 2;
    if (!tops.some((t) => Math.abs(t - mid) < 12)) tops.push(mid);
  }
  const heights = [];
  for (const selector of ${JSON.stringify(UNIFORM_CONTROLS)}) {
    for (const el of document.querySelectorAll(selector)) {
      heights.push({ selector, height: Math.round(el.getBoundingClientRect().height) });
    }
  }
  const radios = [...document.querySelectorAll('input[type="radio"]')];
  const nativeRadios = radios.filter((r) => {
    const cs = getComputedStyle(r);
    const box = r.getBoundingClientRect();
    return cs.display !== 'none' && cs.visibility !== 'hidden' && +cs.opacity > 0 && box.width > 1 && box.height > 1 && cs.appearance !== 'none';
  }).length;
  const look = (label) => { const cs = getComputedStyle(label); return [cs.backgroundColor, cs.color, cs.fontWeight].join('|'); };
  const selectedDistinct = ['input-source', 'caption-size'].every((name) => {
    const labels = [...document.querySelectorAll('#' + name + ' label')];
    const on = labels.filter((l) => l.querySelector('input').checked).map(look);
    const off = labels.filter((l) => !l.querySelector('input').checked).map(look);
    return on.length === 1 && off.length > 0 && off.every((o) => o !== on[0]);
  });
  return { rows: tops.length, topbarHeight: document.querySelector('.topbar').getBoundingClientRect().height, heights, nativeRadios, selectedDistinct };
})()`;

function probeTopbar(page: Page): Promise<TopbarProbe> {
  return page.evaluate<TopbarProbe>(TOPBAR_PROBE);
}

async function expectUnchangedNames(page: Page): Promise<void> {
  for (const name of ['麦克风', '系统声音', '小', '中', '大', '特大']) {
    await expect(page.getByRole('radio', { name, exact: true })).toHaveCount(1);
  }
  for (const name of ['开始', '停止', '弹出字幕小窗', '使用引导']) {
    await expect(page.getByRole('button', { name, exact: true })).toBeVisible();
  }
}

async function expectProductTopbar(page: Page, maxRows: number, where: string): Promise<void> {
  const probe = await probeTopbar(page);
  expect(probe.rows, `${where}: control bar rows`).toBeLessThanOrEqual(maxRows);
  expect(probe.nativeRadios, `${where}: native radio dots shown`).toBe(0);
  expect(probe.selectedDistinct, `${where}: selected option distinct`).toBe(true);
  const heights = probe.heights.map((h) => h.height);
  expect(Math.max(...heights) - Math.min(...heights), `${where}: uneven control heights ${JSON.stringify(probe.heights)}`).toBeLessThanOrEqual(2);
  await expectUnchangedNames(page);
}

test.describe('顶栏统一样式', () => {
  test.use({ audioSet: 'single' });

  test('分段按钮无原生圆点、控件等高；约 480 像素宽时顶栏最多 2 行，宽屏 1 行；无障碍名称不变', async ({ harness }) => {
    const { page } = harness;
    await page.setViewportSize({ width: 1366, height: 768 });
    await page.goto('/');
    await expectProductTopbar(page, 1, '1366 microphone');
    await selectSource(page, '系统声音');
    await expectProductTopbar(page, 1, '1366 system');

    await page.setViewportSize({ width: 480, height: 800 });
    await expectProductTopbar(page, 2, '480 system');
    await selectSource(page, '麦克风');
    await page.getByRole('radio', { name: '特大', exact: true }).check();
    await expect(page.locator('#caption-panel')).toHaveAttribute('data-caption-size', 'xl');
    await expectProductTopbar(page, 2, '480 microphone');

    // The segmented options still work by clicking their visible text.
    await page.locator('#input-source label', { hasText: '系统声音' }).click();
    await expect(page.locator('#source-system')).toBeChecked();
    await page.locator('#caption-size label', { hasText: /^中$/ }).click();
    await expect(page.locator('#caption-panel')).toHaveAttribute('data-caption-size', 'm');
    await page.getByRole('button', { name: '使用引导' }).click();
    await expect(page.locator('dialog#guide')).toHaveAttribute('open', '');
  });
});

test.describe('系统声音说明栏', () => {
  test.use({ audioSet: 'single' });

  test('开始后自动收起、可随时展开，字幕区占满宽度；停止和出错时展开', async ({ harness }) => {
    test.setTimeout(120_000);
    const { page } = harness;
    const details = page.locator('#system-details');
    await page.setViewportSize({ width: 1366, height: 768 });
    await page.goto('/');
    const player = await harness.openPlayer('single', 4_000);
    await playMaterial(player);
    await selectSource(page, '系统声音');
    await expect(details).toHaveAttribute('open', '');

    await startButton(page).click();
    await expect(statusText(page)).toHaveText(RUNNING, { timeout: 15_000 });
    await expect(details).not.toHaveAttribute('open', '');
    const workspace = await page.locator('.workspace').boundingBox();
    const captions = await page.locator('#caption-panel').boundingBox();
    expect(captions!.width / workspace!.width, 'captions take the full width while listening').toBeGreaterThan(0.9);
    const panel = await page.locator('#system-panel').boundingBox();
    expect(panel!.height, 'folded instructions are a single compact bar').toBeLessThan(64);

    // Can be expanded at any time and folded again.
    await page.locator('#system-title').click();
    await expect(details).toHaveAttribute('open', '');
    await expect(page.locator('#support-matrix')).toBeVisible();
    await page.locator('#system-title').click();
    await expect(details).not.toHaveAttribute('open', '');

    await stopButton(page).click();
    await expect(details).toHaveAttribute('open', '');

    // Collapsed by hand, then a failed start (error state) opens it again.
    await page.locator('#system-title').click();
    await expect(details).not.toHaveAttribute('open', '');
    await page.route('**/api/speech-token', (route) => route.abort());
    await startButton(page).click();
    await expect(statusText(page)).toHaveText(ERROR, { timeout: 15_000 });
    await expect(details).toHaveAttribute('open', '');
  });
});
