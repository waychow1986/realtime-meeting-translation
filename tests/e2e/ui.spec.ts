import type { Page } from '@playwright/test';
import {
  ERROR,
  NOT_RUNNING,
  RUNNING,
  expect,
  hanCount,
  startButton,
  statusText,
  stopButton,
  test,
  trackStates,
  waitForFinalCaptions,
} from './fixtures.js';
import {
  FR127_CONTROLS,
  contrastRatio,
  insideViewport,
  overlapArea,
  probeCaptionStyle,
  probeLayout,
} from './ui.js';

const STATE_NAMES = { idle: '未开始', starting: '正在启动…', running: '正在听', stopped: '已停止', error: '出错' } as const;
type State = keyof typeof STATE_NAMES;

interface StateLook {
  text: string;
  icon: string;
  color: string;
}

async function stateLook(page: Page): Promise<StateLook> {
  return page.evaluate<StateLook>(`(() => ({
    text: document.getElementById('status').textContent,
    icon: document.getElementById('status-indicator').textContent,
    color: getComputedStyle(document.getElementById('status-indicator')).color,
  }))()`);
}

/** Visible interface text outside the caption list (header, notice, hint, dialogs when open). */
async function interfaceText(page: Page): Promise<string> {
  return page.evaluate<string>(`(() => {
    const parts = [document.querySelector('.topbar').innerText, document.getElementById('notice').innerText];
    const hint = document.querySelector('.hint');
    if (hint) parts.push(hint.innerText);
    const guide = document.getElementById('guide');
    if (guide.open) parts.push(guide.innerText);
    return parts.join('\\n');
  })()`);
}

function expectChinese(text: string): void {
  expect(text.match(/[A-Za-z]{2,}/g) ?? []).toEqual([]);
  expect(hanCount(text)).toBeGreaterThan(10);
}

async function expectControlsForState(page: Page, state: State): Promise<void> {
  const layout = await probeLayout(page);
  for (const control of layout.controls.filter((c) => FR127_CONTROLS.includes(c.selector))) {
    expect(insideViewport(control, layout.viewport), `${control.selector} visible without scrolling`).toBe(true);
  }
  await expect(page.locator('#input-source')).toBeVisible();
  await expect(statusText(page)).toBeVisible();
  const active = state === 'starting' || state === 'running';
  await (active ? expect(startButton(page)).toBeDisabled() : expect(startButton(page)).toBeEnabled());
  await (active ? expect(stopButton(page)).toBeEnabled() : expect(stopButton(page)).toBeDisabled());
  await (active
    ? expect(page.locator('#source-microphone')).toBeDisabled()
    : expect(page.locator('#source-microphone')).toBeEnabled());
  await expect(page.locator('body')).toHaveAttribute('data-state', state);
}

test.describe('首次使用引导', () => {
  test.use({ guideSeen: false, audioSet: 'single' });

  test('IQA-120 首次打开自动显示中文引导，一步关闭后可直接开始，再次打开不自动出现，入口可重新打开', async ({
    harness,
  }, testInfo) => {
    const { page } = harness;
    await page.goto('/');
    const guide = page.locator('dialog#guide');
    await expect(guide).toBeVisible();
    await expect(guide).toHaveAttribute('open', '');
    const text = await guide.innerText();
    expectChinese(text);
    for (const point of [/输入方式/, /开始/, /共享/, /音频/, /字号/, /小窗/, /不支持/]) expect(text).toMatch(point);
    await page.screenshot({ path: testInfo.outputPath('guide-first-visit.png') });

    await page.locator('#guide-close').click();
    await expect(guide).toBeHidden();
    await expect.poll(() => page.evaluate<string | null>(`localStorage.getItem('rtmt.guideSeen')`)).toBe('1');
    await startButton(page).click();
    await expect(statusText(page)).toHaveText(RUNNING, { timeout: 10_000 });
    await stopButton(page).click();
    await expect(statusText(page)).toHaveText(NOT_RUNNING);

    await page.reload();
    await expect(statusText(page)).toHaveText(STATE_NAMES.idle);
    await page.waitForTimeout(1_000);
    await expect(guide).toBeHidden();

    await page.getByRole('button', { name: '使用引导' }).click();
    await expect(guide).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('guide-reopened.png') });
    await page.keyboard.press('Escape');
    await expect(guide).toBeHidden();
    await expect(startButton(page)).toBeEnabled();
  });
});

test.describe('控制区与状态', () => {
  test.use({ audioSet: 'single' });

  test('IQA-118 五种状态文字、颜色与图标两两不同，控制区四项不滚动可见，按钮可用性与状态相符，界面文字为中文', async ({
    harness,
  }, testInfo) => {
    const { page } = harness;
    const looks = new Map<State, StateLook>();
    const capture = async (state: State) => {
      await expect(statusText(page)).toHaveText(STATE_NAMES[state]);
      await expectControlsForState(page, state);
      looks.set(state, await stateLook(page));
      expectChinese(await interfaceText(page));
      await page.screenshot({ path: testInfo.outputPath(`state-${state}.png`) });
    };

    // Hold the speech token so the transient “正在启动…” can be observed.
    let releaseToken: () => void = () => undefined;
    const tokenHeld = new Promise<void>((resolve) => (releaseToken = resolve));
    await page.route('**/api/speech-token', async (route) => {
      await tokenHeld;
      await route.continue();
    });

    await page.goto('/');
    await capture('idle');
    await startButton(page).click();
    await capture('starting');
    releaseToken();
    await expect(statusText(page)).toHaveText(RUNNING, { timeout: 10_000 });
    await capture('running');
    await stopButton(page).click();
    await capture('stopped');
    expect((await trackStates(page)).states.every((s) => s === 'ended')).toBe(true);

    // Error: the speech token cannot be obtained, so no captions can be produced (TD-110).
    await page.unroute('**/api/speech-token');
    await page.route('**/api/speech-token', (route) => route.abort());
    await startButton(page).click();
    await expect(statusText(page)).toHaveText(ERROR, { timeout: 10_000 });
    await expect(page.getByRole('alert')).toBeVisible();
    await capture('error');
    expect((await trackStates(page)).states.every((s) => s === 'ended')).toBe(true);

    const all = [...looks.entries()];
    expect(all).toHaveLength(5);
    for (const [i, [stateA, a]] of all.entries()) {
      expect(a.text).toBe(STATE_NAMES[stateA]);
      for (const [stateB, b] of all.slice(i + 1)) {
        expect(a.icon === b.icon && a.color === b.color, `${stateA} vs ${stateB} look the same`).toBe(false);
        expect(a.icon, `${stateA} vs ${stateB} icon`).not.toBe(b.icon);
        expect(a.color, `${stateA} vs ${stateB} colour`).not.toBe(b.color);
      }
    }
  });
});

const SIZE_LABELS = ['小', '中', '大', '特大'] as const;

async function timelineLength(page: Page): Promise<number> {
  return page.evaluate<number>('window.__rtmt.timeline.length');
}

test.describe('字幕区样式与字号', () => {
  test.use({ audioSet: 'meeting' });

  test('IQA-119 字幕区最大、字号最大、对比度与行距达标、临时与定稿样式不同；运行中切换 4 档字号不中断，最新字幕始终可见', async ({
    harness,
  }, testInfo) => {
    test.setTimeout(240_000);
    const { page } = harness;
    await page.goto('/');
    const sizeRadios = page.locator('#caption-size input[type="radio"][name="caption-size"]');
    await expect(sizeRadios).toHaveCount(4);
    expect((await page.locator('#caption-size label').allInnerTexts()).map((t) => t.trim())).toEqual([...SIZE_LABELS]);
    await expect(page.getByRole('radio', { name: '中', exact: true })).toBeChecked();
    await expect(page.locator('#caption-panel')).toHaveAttribute('data-caption-size', 'm');

    await startButton(page).click();
    await expect(statusText(page)).toHaveText(RUNNING, { timeout: 10_000 });
    await waitForFinalCaptions(page, 1);
    // Measure at a moment where a final and an interim caption are both on screen.
    let probe = await probeCaptionStyle(page);
    await expect
      .poll(async () => {
        probe = await probeCaptionStyle(page);
        return probe.final !== null && probe.interim !== null;
      }, { timeout: 90_000, intervals: [100] })
      .toBe(true);
    await page.screenshot({ path: testInfo.outputPath('captions-default.png') });
    const final = probe.final!;
    const interim = probe.interim!;
    testInfo.attach('style-measurements.json', { body: JSON.stringify(probe, null, 2), contentType: 'application/json' });

    expect(final.fontSize).toBeGreaterThanOrEqual(28);
    expect(final.fontSize).toBeGreaterThan(probe.maxOtherFontSize);
    for (const other of probe.otherAreas) expect(probe.panelArea, other.selector).toBeGreaterThan(other.area);
    expect(contrastRatio(final.color, probe.panelBackground)).toBeGreaterThanOrEqual(7);
    expect(contrastRatio(interim.color, probe.panelBackground)).toBeGreaterThanOrEqual(4.5);
    for (const style of [final, interim]) expect(style.lineHeight).toBeGreaterThanOrEqual(style.fontSize * 1.4);
    expect(
      [final.color !== interim.color, final.borderLeftStyle !== interim.borderLeftStyle, final.after !== interim.after],
    ).toContain(true);

    // Switch every size while captions keep streaming.
    const before = await timelineLength(page);
    const sizes: number[] = [];
    for (const label of SIZE_LABELS) {
      await page.getByRole('radio', { name: label, exact: true }).check();
      const measured = await probeCaptionStyle(page);
      expect(measured.final).not.toBeNull();
      const size = measured.final!.fontSize;
      sizes.push(size);
      expect(measured.final!.lineHeight).toBeGreaterThanOrEqual(size * 1.4);
      expect(size).toBeGreaterThan(measured.maxOtherFontSize);
      if (measured.interim) expect(measured.interim.fontSize).toBe(size);
      await expect.poll(async () => (await probeCaptionStyle(page)).latestVisible).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`captions-size-${label}.png`) });
    }
    testInfo.attach('size-measurements.json', { body: JSON.stringify(sizes), contentType: 'application/json' });
    for (let i = 1; i < sizes.length; i += 1) expect(sizes[i]!).toBeGreaterThan(sizes[i - 1]!);
    expect(sizes[1]).toBeGreaterThanOrEqual(28);
    expect(sizes[3]).toBeGreaterThanOrEqual(48);
    await expect(statusText(page)).toHaveText(RUNNING);
    await expect.poll(() => timelineLength(page), { timeout: 60_000 }).toBeGreaterThan(before);
    expect((await trackStates(page)).states).toContain('live');

    // FR-130: reading earlier captions is not interrupted; “回到最新” brings the latest caption back.
    await page.setViewportSize({ width: 900, height: 600 });
    await expect
      .poll(() => page.evaluate<number>(`(() => { const s = document.getElementById('caption-scroll'); return s.scrollHeight - s.clientHeight; })()`), {
        timeout: 90_000,
      })
      .toBeGreaterThan(150);
    await page.evaluate(`document.getElementById('caption-scroll').scrollTop = 0`);
    const scrolledAt = await timelineLength(page);
    await expect.poll(() => timelineLength(page), { timeout: 60_000 }).toBeGreaterThan(scrolledAt);
    expect(await page.evaluate<number>(`document.getElementById('caption-scroll').scrollTop`)).toBeLessThan(10);
    const jump = page.getByRole('button', { name: /回到最新/ });
    await expect(jump).toBeVisible();
    await jump.click();
    await expect(jump).toBeHidden();
    await expect.poll(async () => (await probeCaptionStyle(page)).latestVisible).toBe(true);

    await stopButton(page).click();
    await expect(statusText(page)).toHaveText(STATE_NAMES.stopped);
  });
});

const VIEWPORTS = [
  { width: 1366, height: 768 },
  { width: 1440, height: 900 },
  { width: 1600, height: 900 },
  { width: 1920, height: 1080 },
  { width: 480, height: 800 },
];

test.describe('各尺寸布局', () => {
  test.use({ audioSet: 'meeting' });

  test('IQA-121 五种尺寸 × 四种状态：无横向滚动，控件不重叠不截断，字幕完整换行，控制区四项可见', async ({
    harness,
  }, testInfo) => {
    test.setTimeout(240_000);
    const { page } = harness;
    const records: unknown[] = [];

    const checkAllSizes = async (state: State) => {
      for (const viewport of VIEWPORTS) {
        await page.setViewportSize(viewport);
        await expect(page.locator('body')).toHaveAttribute('data-state', state);
        const layout = await probeLayout(page);
        records.push({ state, ...viewport, layout });
        const where = `${state} @ ${viewport.width}×${viewport.height}`;
        expect(layout.doc.scrollWidth, `${where}: horizontal scroll`).toBeLessThanOrEqual(layout.doc.clientWidth);
        for (const control of layout.controls) {
          expect(control.clipped, `${where}: ${control.selector} clipped`).toBe(false);
          if (FR127_CONTROLS.includes(control.selector)) {
            expect(insideViewport(control, layout.viewport), `${where}: ${control.selector} in viewport`).toBe(true);
          }
        }
        for (const [i, a] of layout.controls.entries()) {
          for (const b of layout.controls.slice(i + 1)) {
            expect(overlapArea(a, b), `${where}: ${a.selector} overlaps ${b.selector}`).toBe(0);
          }
          expect(overlapArea(a, layout.panel), `${where}: ${a.selector} overlaps captions`).toBe(0);
        }
        expect(layout.overflowingCaptions, `${where}: caption cut off`).toBe(0);
        expect(layout.scrollerOverflowX, `${where}: caption area scrolls horizontally`).toBe(false);
        expect(layout.panel.w * layout.panel.h, `${where}: caption area largest`).toBeGreaterThan(
          layout.header.w * layout.header.h,
        );
        await expect(startButton(page)).toBeVisible();
        await expect(stopButton(page)).toBeVisible();
        await page.screenshot({ path: testInfo.outputPath(`layout-${state}-${viewport.width}x${viewport.height}.png`) });
      }
    };

    await page.goto('/');
    await checkAllSizes('idle');

    await startButton(page).click();
    await expect(statusText(page)).toHaveText(RUNNING, { timeout: 10_000 });
    await page.getByRole('radio', { name: '特大', exact: true }).check();
    await waitForFinalCaptions(page, 2);
    await checkAllSizes('running');

    await stopButton(page).click();
    await expect(statusText(page)).toHaveText(STATE_NAMES.stopped);
    await checkAllSizes('stopped');

    await page.route('**/api/speech-token', (route) => route.abort());
    await startButton(page).click();
    await expect(statusText(page)).toHaveText(ERROR, { timeout: 10_000 });
    await checkAllSizes('error');

    testInfo.attach('layout-measurements.json', { body: JSON.stringify(records, null, 2), contentType: 'application/json' });
  });
});
