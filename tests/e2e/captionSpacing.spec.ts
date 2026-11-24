import type { Page } from '@playwright/test';
import {
  RUNNING,
  chooseCaptionDisplay,
  closeCaptionDisplay,
  expect,
  openCaptionDisplay,
  startButton,
  statusText,
  stopButton,
  test,
  waitForFinalCaptions,
} from './fixtures.js';
import { captionDistance, lineDistance, probeSpacing, type CaptionMetrics, type SpacingProbe } from './ui.js';

/**
 * Feature 008: caption line spacing 紧凑 / 标准 / 宽松 (AC-1, AC-3～AC-7; background opacity is out of scope, Q1 = C).
 * The spacing applies to the line distance inside one caption and to the distance between consecutive captions (R2).
 */

const SPACINGS = [
  ['紧凑', 'compact', 1.4, 2, 0],
  ['标准', 'normal', 1.5, 4, 6],
  ['宽松', 'loose', 1.8, 4, 14],
] as const;
const SIZES = [
  ['小', 's', 24],
  ['中', 'm', 32],
  ['大', 'l', 40],
  ['特大', 'xl', 52],
] as const;
const CAPTION_BG = 'rgb(13, 17, 23)';

const panel = (page: Page) => page.locator('#caption-panel');

/** Computed style of two temporary, single-line captions in the main list (nothing is translated yet). */
function probeIdleCaptionStyle(page: Page): Promise<{ lineHeight: number; fontSize: number; paddingTop: number; paddingBottom: number; marginTop: number }> {
  return page.evaluate(`(() => {
    const list = document.getElementById('captions');
    const a = document.createElement('li');
    const b = document.createElement('li');
    a.className = b.className = 'caption';
    a.textContent = b.textContent = '字幕';
    list.append(a, b);
    const cs = getComputedStyle(b);
    const result = { lineHeight: parseFloat(cs.lineHeight), fontSize: parseFloat(cs.fontSize), paddingTop: parseFloat(cs.paddingTop), paddingBottom: parseFloat(cs.paddingBottom), marginTop: parseFloat(cs.marginTop) };
    a.remove();
    b.remove();
    return result;
  })()`);
}

async function expectChecked(page: Page, spacing: string, size: string): Promise<void> {
  await openCaptionDisplay(page);
  const group = page.getByRole('group', { name: '行距' });
  await expect(group.getByRole('radio', { name: spacing, exact: true })).toBeChecked();
  await expect(page.getByRole('group', { name: '字号' }).getByRole('radio', { name: size, exact: true })).toBeChecked();
  await closeCaptionDisplay(page);
}

function expectStyle(caption: CaptionMetrics, spacing: (typeof SPACINGS)[number], where: string): void {
  const [, , ratio, pad] = spacing;
  expect(caption.lineHeight, `${where}: line height`).toBeCloseTo(caption.fontSize * ratio, 1);
  expect(caption.paddingTop, `${where}: padding top`).toBe(pad);
  expect(caption.paddingBottom, `${where}: padding bottom`).toBe(pad);
  expect(caption.lineHeight, `${where}: line height ≥ 1.4 × font size`).toBeGreaterThanOrEqual(caption.fontSize * 1.4 - 0.01);
}

async function failOnPageErrors(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  return errors;
}

test.describe('字幕行距', () => {
  test.use({ audioSet: 'meeting' });

  test('三档与默认：只有紧凑/标准/宽松，首次打开为标准，各字号下标准与交付前相同，背景不变', async ({ harness }) => {
    const { page } = harness;
    await page.goto('/');
    await expect(panel(page)).toHaveAttribute('data-caption-spacing', 'normal');
    await openCaptionDisplay(page);
    const group = page.getByRole('group', { name: '行距' });
    await expect(group.getByRole('radio')).toHaveCount(3);
    for (const [label] of SPACINGS) await expect(group.getByRole('radio', { name: label, exact: true })).toHaveCount(1);
    await expect(group.getByRole('radio', { name: '标准', exact: true })).toBeChecked();
    await expect(page.getByRole('radio', { name: '中', exact: true })).toBeChecked();
    // No background opacity setting in this delivery (Q1 = C).
    await expect(page.getByText(/透明/)).toHaveCount(0);
    await closeCaptionDisplay(page);
    await expect(panel(page)).toHaveCSS('background-color', CAPTION_BG);

    for (const [label, value, px] of SIZES) {
      await chooseCaptionDisplay(page, label);
      await expect(panel(page)).toHaveAttribute('data-caption-size', value);
      const style = await probeIdleCaptionStyle(page);
      expect(style.fontSize).toBe(px);
      expect(style.lineHeight).toBeCloseTo(px * 1.5, 1);
      expect([style.paddingTop, style.paddingBottom, style.marginTop]).toEqual([4, 4, 6]);
    }
  });

  test('行距实测：同一条字幕内行距与相邻字幕间距都满足 紧凑 < 标准 < 宽松，标准与交付前相同；字号与行距互不影响', async ({
    harness,
  }, testInfo) => {
    test.setTimeout(240_000);
    const { page } = harness;
    await page.setViewportSize({ width: 480, height: 800 });
    await page.goto('/');
    await chooseCaptionDisplay(page, '特大');
    await startButton(page).click();
    await expect(statusText(page)).toHaveText(RUNNING, { timeout: 15_000 });

    // Two final captions, at least one of them wrapped onto several lines.
    let pair: [string, string] | null = null;
    let multi = '';
    await expect
      .poll(
        async () => {
          const finals = (await probeSpacing(page)).captions.filter((c) => c.status === 'final' && !c.kind);
          const wrapped = finals.find((c) => c.lineTops.length >= 2);
          if (finals.length >= 2 && wrapped) {
            pair = [finals[0]!.segmentId, finals[1]!.segmentId];
            multi = wrapped.segmentId;
            return true;
          }
          return false;
        },
        { timeout: 150_000, intervals: [500] },
      )
      .toBe(true);
    await stopButton(page).click();

    const byId = (probe: SpacingProbe, id: string) => probe.captions.find((c) => c.segmentId === id)!;
    const records: Record<string, { line: number; between: number }> = {};
    for (const spacing of SPACINGS) {
      const [label, value] = spacing;
      await chooseCaptionDisplay(page, label);
      await expect(panel(page)).toHaveAttribute('data-caption-spacing', value);
      const probe = await probeSpacing(page);
      expect(probe.spacing).toBe(value);
      const wrapped = byId(probe, multi);
      const [first, second] = pair!.map((id) => byId(probe, id)) as [CaptionMetrics, CaptionMetrics];
      expectStyle(wrapped, spacing, label);
      expect(second.marginTop, `${label}: gap`).toBe(spacing[4]);
      expect(wrapped.fontSize).toBe(52);
      records[value] = { line: lineDistance(wrapped)!, between: captionDistance(first, second) };
      await page.screenshot({ path: testInfo.outputPath(`spacing-${value}.png`) });
    }
    testInfo.attach('spacing-measurements.json', { body: JSON.stringify(records, null, 2), contentType: 'application/json' });
    const { compact, normal, loose } = records as Record<'compact' | 'normal' | 'loose', { line: number; between: number }>;
    expect(compact.line).toBeLessThan(normal.line);
    expect(normal.line).toBeLessThan(loose.line);
    expect(compact.between).toBeLessThan(normal.between);
    expect(normal.between).toBeLessThan(loose.between);
    // “标准” equals the spacing before this delivery: 1.5 × 52 = 78 px inside, 78 + 4 + 4 + 6 = 92 px between.
    expect(normal.line).toBeCloseTo(78, 0);
    expect(normal.between).toBeCloseTo(92, 0);

    // Size and spacing are independent settings.
    await expectChecked(page, '宽松', '特大');
    await chooseCaptionDisplay(page, '小');
    await expect(panel(page)).toHaveAttribute('data-caption-spacing', 'loose');
    await expectChecked(page, '宽松', '小');
    expect(byId(await probeSpacing(page), multi).lineHeight).toBeCloseTo(24 * 1.8, 1);
  });

  test('正在听时切换行距：页面不刷新、翻译不中断，已有字幕与之后的新字幕都立即按新行距显示', async ({ harness }) => {
    test.setTimeout(240_000);
    const { page } = harness;
    await page.goto('/');
    await startButton(page).click();
    await expect(statusText(page)).toHaveText(RUNNING, { timeout: 15_000 });
    await waitForFinalCaptions(page, 1);
    await page.evaluate(`window.__spacingMarker = 'kept'`);

    for (const spacing of [SPACINGS[2], SPACINGS[0]]) {
      const [label, value] = spacing;
      const finalsBefore = (await probeSpacing(page)).captions.filter((c) => c.status === 'final');
      await chooseCaptionDisplay(page, label);
      const probe = await probeSpacing(page);
      expect(probe.spacing).toBe(value);
      for (const caption of probe.captions.filter((c) => !c.kind)) expectStyle(caption, spacing, `${label} existing`);
      expect(probe.captions.filter((c) => c.status === 'final').length).toBeGreaterThanOrEqual(finalsBefore.length);
      await expect(statusText(page)).toHaveText(RUNNING);
      expect(await page.evaluate(`window.__spacingMarker`)).toBe('kept');
    }

    // Captions appearing after the switch use the new spacing too.
    const known = new Set((await probeSpacing(page)).captions.filter((c) => c.status === 'final').map((c) => c.segmentId));
    let fresh: CaptionMetrics | undefined;
    await expect
      .poll(
        async () => {
          fresh = (await probeSpacing(page)).captions.find((c) => c.status === 'final' && !c.kind && !known.has(c.segmentId));
          return fresh !== undefined;
        },
        { timeout: 120_000, intervals: [500] },
      )
      .toBe(true);
    expectStyle(fresh!, SPACINGS[0], 'new caption');
    await expect(statusText(page)).toHaveText(RUNNING);
    expect(await page.evaluate(`window.__spacingMarker`)).toBe('kept');
    await stopButton(page).click();
  });

  test('保存与恢复：关闭页面后在同一浏览器再打开，行距与字号都恢复为上次的选择，只保存界面偏好', async ({ harness }) => {
    const { page, context } = harness;
    await page.goto('/');
    await chooseCaptionDisplay(page, '宽松');
    await chooseCaptionDisplay(page, '大');
    await page.close();

    const reopened = await context.newPage();
    await reopened.goto('/');
    await expect(panel(reopened)).toHaveAttribute('data-caption-spacing', 'loose');
    await expect(panel(reopened)).toHaveAttribute('data-caption-size', 'l');
    await expectChecked(reopened, '宽松', '大');
    const style = await probeIdleCaptionStyle(reopened);
    expect(style.lineHeight).toBeCloseTo(40 * 1.8, 1);
    expect(style.marginTop).toBe(14);
    const stored = await reopened.evaluate(() => ({ ...localStorage }));
    expect(stored).toEqual({ 'rtmt.guideSeen': '1', 'rtmt.captionSize': 'l', 'rtmt.captionSpacing': 'loose' });
  });

  test('无法识别的保存值按标准显示；交付前已保存的字号照常恢复', async ({ harness }) => {
    const { page } = harness;
    await page.goto('/');
    for (const value of ['tight', '', 'Loose']) {
      await page.evaluate((v) => localStorage.setItem('rtmt.captionSpacing', v), value);
      await page.reload();
      await expect(panel(page)).toHaveAttribute('data-caption-spacing', 'normal');
      await expectChecked(page, '标准', '中');
    }
    await page.evaluate(() => {
      localStorage.removeItem('rtmt.captionSpacing');
      localStorage.setItem('rtmt.captionSize', 'l');
    });
    await page.reload();
    await expectChecked(page, '标准', '大');
    await expect(panel(page)).toHaveAttribute('data-caption-spacing', 'normal');
  });

  test('浏览器不允许本地保存时：页面照常打开与翻译，行距为标准，本次打开期间仍可调整并立即生效', async ({ harness }) => {
    test.setTimeout(180_000);
    const { page, context } = harness;
    await context.addInitScript({
      content: `Object.defineProperty(window, 'localStorage', { configurable: true, get() { throw new DOMException('The operation is insecure.', 'SecurityError'); } });`,
    });
    const errors = await failOnPageErrors(page);
    await page.goto('/');
    // The guide cannot be remembered as seen, so it is shown on every visit.
    const close = page.getByRole('button', { name: '知道了' });
    if (await close.isVisible()) await close.click();
    await expect(panel(page)).toHaveAttribute('data-caption-spacing', 'normal');
    await expectChecked(page, '标准', '中');

    await chooseCaptionDisplay(page, '宽松');
    await expect(panel(page)).toHaveAttribute('data-caption-spacing', 'loose');
    expect((await probeIdleCaptionStyle(page)).lineHeight).toBeCloseTo(32 * 1.8, 1);

    await startButton(page).click();
    await expect(statusText(page)).toHaveText(RUNNING, { timeout: 15_000 });
    await waitForFinalCaptions(page, 1);
    const caption = (await probeSpacing(page)).captions.find((c) => c.status === 'final' && !c.kind)!;
    expectStyle(caption, SPACINGS[2], 'no storage');
    await chooseCaptionDisplay(page, '紧凑');
    expectStyle((await probeSpacing(page)).captions.find((c) => c.segmentId === caption.segmentId)!, SPACINGS[0], 'no storage');
    await stopButton(page).click();
    expect(errors).toEqual([]);
  });

  test('浏览器能读不能写时：选择照常生效，刷新后回到标准', async ({ harness }) => {
    const { page, context } = harness;
    await context.addInitScript({
      content: `Storage.prototype.setItem = function () { throw new DOMException('quota', 'QuotaExceededError'); };`,
    });
    const errors = await failOnPageErrors(page);
    await page.goto('/');
    const close = page.getByRole('button', { name: '知道了' });
    if (await close.isVisible()) await close.click();
    await chooseCaptionDisplay(page, '紧凑');
    await expect(panel(page)).toHaveAttribute('data-caption-spacing', 'compact');
    expect((await probeIdleCaptionStyle(page)).marginTop).toBe(0);
    await page.reload();
    if (await close.isVisible()) await close.click();
    await expect(panel(page)).toHaveAttribute('data-caption-spacing', 'normal');
    expect(errors).toEqual([]);
  });

  test('字幕小窗：打开时沿用当前行距，主页面切换行距后小窗立即一致，新字幕也一致；小窗内没有行距控件', async ({ harness }) => {
    test.setTimeout(240_000);
    const { page } = harness;
    await page.goto('/');
    await chooseCaptionDisplay(page, '紧凑');
    await startButton(page).click();
    await expect(statusText(page)).toHaveText(RUNNING, { timeout: 15_000 });
    await waitForFinalCaptions(page, 1);

    const pipButton = page.locator('#pip-button');
    await expect(pipButton).toBeEnabled();
    await pipButton.click();
    await expect
      .poll(() =>
        page.evaluate<boolean>(
          `(() => { const w = documentPictureInPicture.window; return !!w && [...w.document.styleSheets].some((s) => (s.href || '').endsWith('/styles.css') && s.cssRules.length > 0); })()`,
        ),
      )
      .toBe(true);

    const pipProbe = () => probeSpacing(page, 'pip');
    let probe = await pipProbe();
    expect(probe.spacing).toBe('compact');
    expect(probe.captions.length).toBeGreaterThanOrEqual(1);
    for (const caption of probe.captions.filter((c) => !c.kind)) expectStyle(caption, SPACINGS[0], 'pip compact');
    expect(
      await page.evaluate<number>(`documentPictureInPicture.window.document.querySelectorAll('input, select, [role="radio"]').length`),
    ).toBe(0);

    await chooseCaptionDisplay(page, '宽松');
    await expect.poll(async () => (await pipProbe()).spacing).toBe('loose');
    probe = await pipProbe();
    for (const caption of probe.captions.filter((c) => !c.kind)) expectStyle(caption, SPACINGS[2], 'pip loose');
    const main = await probeSpacing(page);
    expect(main.spacing).toBe('loose');

    const known = new Set(probe.captions.filter((c) => c.status === 'final').map((c) => c.segmentId));
    let fresh: CaptionMetrics | undefined;
    let next: SpacingProbe | undefined;
    await expect
      .poll(
        async () => {
          next = await pipProbe();
          fresh = next.captions.find((c) => c.status === 'final' && !c.kind && !known.has(c.segmentId));
          return fresh !== undefined;
        },
        { timeout: 120_000, intervals: [500] },
      )
      .toBe(true);
    expectStyle(fresh!, SPACINGS[2], 'pip new caption');
    const index = next!.captions.indexOf(fresh!);
    if (index > 0) expect(fresh!.marginTop).toBe(14);
    await expect(statusText(page)).toHaveText(RUNNING);
    await page.evaluate('documentPictureInPicture.window.close()');
    await stopButton(page).click();
  });
});
