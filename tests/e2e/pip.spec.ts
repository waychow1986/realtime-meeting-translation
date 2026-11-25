import type { Page } from '@playwright/test';
import { playMaterial } from '../support/player.js';
import { SecretScanner } from '../support/secretScan.js';
import {
  NOT_RUNNING,
  RUNNING,
  captionTimeline,
  chooseCaptionDisplay,
  expect,
  selectSource,
  startButton,
  statusText,
  stopButton,
  test,
  waitForFinalCaptions,
} from './fixtures.js';

/**
 * IQA-122 (AC-12): the floating caption window is a Document Picture-in-Picture window fed by the same caption
 * pipeline as the main page. Whether it stays visible above full-screen video / other applications cannot be
 * shown under Xvfb (no window manager) and is deliberately not asserted here (DD-101).
 */

type Row = [string, string, string];

interface PipSample {
  at: number;
  main: Row[];
  pip: Row[];
}

interface PipView {
  open: boolean;
  separate: boolean;
  bodyClass: string;
  captionSize: string;
  state: string;
  status: string;
  rows: Row[];
  media: number;
  stylesheet: boolean;
  captionFontSize: number | null;
  html: string;
}

const pipButton = (page: Page) => page.locator('#pip-button');

function pipView(page: Page): Promise<PipView> {
  return page.evaluate<PipView>(`(() => {
    const win = documentPictureInPicture.window;
    if (!win) return { open: false, separate: false, bodyClass: '', captionSize: '', state: '', status: '', rows: [], media: 0, stylesheet: false, captionFontSize: null, html: '' };
    const doc = win.document;
    const caption = [...doc.querySelectorAll('#pip-captions > li.caption')].filter((li) => li.textContent.trim()).pop();
    return {
      open: true,
      separate: win !== window,
      bodyClass: doc.body.className,
      captionSize: doc.body.dataset.captionSize || '',
      state: doc.body.dataset.state || '',
      status: doc.getElementById('pip-status')?.textContent || '',
      rows: [...doc.querySelectorAll('#pip-captions > li.caption[data-status][data-segment-id]')].map((li) => [li.dataset.segmentId, li.dataset.status, li.textContent]),
      media: doc.querySelectorAll('video, audio, canvas').length,
      stylesheet: [...doc.styleSheets].some((sheet) => (sheet.href || '').endsWith('/styles.css') && sheet.cssRules.length > 0),
      captionFontSize: caption ? parseFloat(win.getComputedStyle(caption).fontSize) : null,
      html: doc.documentElement.outerHTML,
    };
  })()`);
}

function mainRows(page: Page): Promise<Row[]> {
  return page.evaluate<Row[]>(
    `[...document.querySelectorAll('#captions > li.caption')].map((li) => [li.dataset.segmentId, li.dataset.status, li.textContent])`,
  );
}

function pipSamples(page: Page): Promise<PipSample[]> {
  return page.evaluate<PipSample[]>('window.__rtmt.pip.samples.slice()');
}

function mainCaptionFontSize(page: Page): Promise<number> {
  return page.evaluate<number>(
    `parseFloat(getComputedStyle([...document.querySelectorAll('#captions > li.caption')].filter((li) => li.textContent.trim()).pop()).fontSize)`,
  );
}

const nonEmpty = (rows: Row[]) => rows.filter((row) => row[2].trim());

async function openPip(page: Page): Promise<void> {
  await expect(pipButton(page)).toBeEnabled();
  await expect(pipButton(page)).toHaveText('弹出字幕小窗');
  await pipButton(page).click();
  await expect.poll(async () => (await pipView(page)).open).toBe(true);
  await expect(pipButton(page)).toHaveText('关闭字幕小窗');
}

/** Every sample taken while the window was open shows the same captions in the same order in both places. */
async function expectMirrored(page: Page, since: number, minChanges: number): Promise<void> {
  const samples = (await pipSamples(page)).filter((sample) => sample.at >= since);
  for (const sample of samples) expect(sample.pip).toEqual(sample.main);
  const distinct = new Set(samples.map((sample) => JSON.stringify(sample.pip)));
  expect(distinct.size).toBeGreaterThanOrEqual(minChanges);
}

test.describe('字幕小窗：麦克风模式', () => {
  test.use({ audioSet: 'meeting' });

  test('IQA-122 运行中弹出小窗：独立窗口、与主页面同一份字幕逐次一致、字号与状态同步；关闭后主页面继续，再弹出内容一致', async ({
    harness,
  }, testInfo) => {
    test.setTimeout(240_000);
    const { page } = harness;
    await page.goto('/');
    await expect(page.locator('#pip-unsupported')).toBeHidden();
    await startButton(page).click();
    await expect(statusText(page)).toHaveText(RUNNING, { timeout: 10_000 });
    await waitForFinalCaptions(page, 1);

    const openedAt = Date.now();
    await openPip(page);
    let view = await pipView(page);
    expect(view.separate).toBe(true);
    expect(view.bodyClass).toBe('pip');
    expect(view.status).toBe('正在听');
    expect(view.state).toBe('running');
    expect(view.media).toBe(0);
    // Opened with the captions already shown on the main page.
    expect(nonEmpty(view.rows).length).toBeGreaterThanOrEqual(1);
    await expect.poll(async () => (await pipView(page)).stylesheet).toBe(true);

    // Captions keep streaming into both views; every change is identical in both.
    const finalsAtOpen = nonEmpty(view.rows).filter((row) => row[1] === 'final').length;
    await waitForFinalCaptions(page, finalsAtOpen + 2);
    await expectMirrored(page, openedAt, 3);
    expect((await pipView(page)).rows).toEqual(await mainRows(page));

    // Caption size switches apply to the window at once (IQA-119), without interrupting capture.
    for (const [label, size] of [['特大', 'xl'], ['小', 's'], ['中', 'm']] as const) {
      await chooseCaptionDisplay(page, label);
      view = await pipView(page);
      expect(view.captionSize).toBe(size);
      expect(view.captionFontSize).toBe(await mainCaptionFontSize(page));
    }
    await expect(statusText(page)).toHaveText(RUNNING);
    await page.screenshot({ path: testInfo.outputPath('main-with-pip.png') });

    // The window carries no credential either (IQA-115).
    const scanner = new SecretScanner();
    scanner.scan('pip-dom', (await pipView(page)).html);
    expect(scanner.hits).toEqual([]);

    // Closing the window: button restores, main page keeps updating, capture continues.
    await pipButton(page).click();
    await expect.poll(async () => (await pipView(page)).open).toBe(false);
    await expect(pipButton(page)).toHaveText('弹出字幕小窗');
    const closedEvents = (await captionTimeline(page)).length;
    await expect.poll(async () => (await captionTimeline(page)).length, { timeout: 60_000 }).toBeGreaterThan(closedEvents);
    await expect(statusText(page)).toHaveText(RUNNING);

    // Opening again shows the current captions and keeps mirroring.
    const reopenedAt = Date.now();
    await openPip(page);
    expect((await pipView(page)).rows).toEqual(await mainRows(page));
    const finalsAtReopen = (await mainRows(page)).filter((row) => row[1] === 'final' && row[2].trim()).length;
    await waitForFinalCaptions(page, finalsAtReopen + 1);
    await expectMirrored(page, reopenedAt, 2);

    // Stopping is reflected in the window; captions stay in both places.
    await stopButton(page).click();
    await expect(statusText(page)).toHaveText(NOT_RUNNING, { timeout: 3_000 });
    await expect.poll(async () => (await pipView(page)).status).toBe('已停止');
    expect((await pipView(page)).rows).toEqual(await mainRows(page));

    // Closing the window itself (its own close button) also restores the main page button.
    await page.evaluate('documentPictureInPicture.window.close()');
    await expect.poll(async () => (await pipView(page)).open).toBe(false);
    await expect(pipButton(page)).toHaveText('弹出字幕小窗');
  });
});

test.describe('字幕小窗：系统声音模式', () => {
  test.use({ audioSet: 'multi' });

  test('IQA-122 系统声音模式下弹出小窗：与主页面同步更新，小窗中无媒体元素', async ({ harness }) => {
    test.setTimeout(240_000);
    const { page } = harness;
    await page.goto('/');
    const player = await harness.openPlayer('multi', 6_000);
    await playMaterial(player);
    await selectSource(page, '系统声音');
    await startButton(page).click();
    await expect(statusText(page)).toHaveText(RUNNING, { timeout: 15_000 });

    const openedAt = Date.now();
    await openPip(page);
    const view = await pipView(page);
    expect(view.separate).toBe(true);
    expect(view.status).toBe('正在听');
    expect(view.media).toBe(0);

    await waitForFinalCaptions(page, 2, 90_000);
    await expectMirrored(page, openedAt, 3);
    expect((await pipView(page)).rows).toEqual(await mainRows(page));
    await stopButton(page).click();
    await expect(statusText(page)).toHaveText(NOT_RUNNING, { timeout: 3_000 });
    await expect.poll(async () => (await pipView(page)).status).toBe('已停止');
  });
});
