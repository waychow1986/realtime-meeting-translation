import { readFile } from "node:fs/promises";
import type { Download, Page, Request } from "@playwright/test";
import {
  ERROR,
  NOT_RUNNING,
  RUNNING,
  UNTRANSLATED_NOTICE,
  captionEntries,
  captionTimeline,
  expect,
  startButton,
  statusText,
  stopButton,
  test,
  waitForFinalCaptions,
  type CaptionEvent,
} from "./fixtures.js";
import {
  TRANSLATION_FAILURE_SCRIPT,
  failFinalTranslations,
  overrideTranslations,
  translationCalls,
} from "./translationOverride.js";

const HINT = "还没有可导出的字幕。出现中文定稿字幕后即可导出。";
const FINAL_CAPTIONS =
  '#captions li.caption[data-status="final"]:not([data-kind="notice"])';
const LINE = /^(\d{2}):(\d{2}):(\d{2}) (.+)$/;

function exportButton(page: Page) {
  return page.getByRole("button", { name: "导出字幕", exact: true });
}

interface ExportFile {
  fileName: string;
  date: string;
  lines: { time: string; text: string }[];
  raw: string;
}

async function exportCaptions(page: Page): Promise<ExportFile> {
  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: 30_000 }),
    exportButton(page).click(),
  ]);
  return readExport(download);
}

async function readExport(download: Download): Promise<ExportFile> {
  expect(await download.failure()).toBeNull();
  const raw = await readFile(await download.path(), "utf8");
  const rows = raw.split(/\r?\n/);
  if (rows.at(-1) === "") rows.pop();
  const header = /^导出日期：(\d{4}-\d{2}-\d{2})$/.exec(rows[0] ?? "");
  expect(header, `first line: ${rows[0]}`).not.toBeNull();
  expect(rows[1]).toBe("");
  const lines = rows.slice(2).map((row) => {
    const match = LINE.exec(row);
    expect(match, `caption line: ${row}`).not.toBeNull();
    return { time: `${match![1]}:${match![2]}:${match![3]}`, text: match![4]! };
  });
  return {
    fileName: download.suggestedFilename(),
    date: header![1]!,
    lines,
    raw,
  };
}

/** Page-order Chinese final captions as shown on the page (line breaks written as one space). */
async function pageFinals(page: Page): Promise<string[]> {
  const texts = await page.locator(FINAL_CAPTIONS).allTextContents();
  return texts.map((text) => text.replace(/\r\n|[\r\n\u2028\u2029]/g, " "));
}

/** First moment each Chinese final caption appeared on the page, in page order. */
function finalTimes(timeline: CaptionEvent[]): number[] {
  return captionEntries(timeline)
    .map((events) =>
      events.find((event) => event.status === "final" && event.kind === ""),
    )
    .filter((event): event is CaptionEvent => event !== undefined)
    .map((event) => event.at);
}

/** D-1 (TD-911): from the last line backwards, each line shows min(own final time, time shown on the next line). */
function expectedShown(times: number[]): number[] {
  const shown = [...times];
  for (let i = shown.length - 2; i >= 0; i -= 1)
    shown[i] = Math.min(shown[i]!, shown[i + 1]!);
  return shown;
}

/** Converts epoch ms to the page's local wall clock (same time zone the app uses). */
function localClock(
  page: Page,
  values: number[],
): Promise<{ date: string; time: string }[]> {
  return page.evaluate((list) => {
    const two = (n: number) => String(n).padStart(2, "0");
    return list.map((ms) => {
      const d = new Date(ms);
      return {
        date: `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`,
        time: `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`,
      };
    });
  }, values);
}

function seconds(time: string): number {
  const [h, m, s] = time.split(":").map(Number);
  return h! * 3600 + m! * 60 + s!;
}

async function expectTimesNear(
  page: Page,
  file: ExportFile,
  expected: number[],
): Promise<void> {
  const clock = await localClock(page, expected);
  expect(file.lines.map((line) => line.time)).toHaveLength(clock.length);
  file.lines.forEach((line, i) => {
    expect(
      Math.abs(seconds(line.time) - seconds(clock[i]!.time)),
      `line ${i + 1}: ${line.time} vs ${clock[i]!.time}`,
    ).toBeLessThanOrEqual(1);
  });
  for (let i = 1; i < file.lines.length; i += 1) {
    expect(seconds(file.lines[i]!.time)).toBeGreaterThanOrEqual(
      seconds(file.lines[i - 1]!.time),
    );
  }
}

async function expectUnavailable(page: Page): Promise<void> {
  const button = exportButton(page);
  await expect(button).toBeVisible();
  await expect(button).toBeDisabled();
  await expect(page.getByText(HINT, { exact: true })).toBeVisible();
  await expect(button).toHaveAccessibleDescription(HINT);
  let downloads = 0;
  const onDownload = () => (downloads += 1);
  page.on("download", onDownload);
  await button.click({ force: true });
  await page.waitForTimeout(2_000);
  page.off("download", onDownload);
  expect(downloads).toBe(0);
}

async function expectAvailable(page: Page): Promise<void> {
  await expect(exportButton(page)).toBeEnabled();
  await expect(page.getByText(HINT, { exact: true })).toBeHidden();
}

async function storageDump(
  page: Page,
): Promise<{ text: string; databases: unknown[] }> {
  return page.evaluate(`(async () => {
    const dump = (storage) =>
      Array.from({ length: storage.length }, (_, i) => {
        const key = storage.key(i) || '';
        return key + '=' + (storage.getItem(key) || '');
      }).join('\\n');
    const databases = indexedDB.databases ? await indexedDB.databases() : [];
    return { text: dump(localStorage) + '\\n' + dump(sessionStorage), databases };
  })()`);
}

test.describe("导出字幕", () => {
  test.use({ audioSet: "multi" });

  test("EXP-1 刚打开页面：导出字幕不可用、点击不下载并显示原因；只在主页面字幕区工具条中", async ({
    harness,
  }) => {
    const { page } = harness;
    await page.goto("/");
    await expectUnavailable(page);
    await expect(
      page
        .locator("#caption-panel .caption-toolbar")
        .getByRole("button", { name: "导出字幕" }),
    ).toHaveCount(1);
    await expect(
      page.locator("header.topbar").getByRole("button", { name: "导出字幕" }),
    ).toHaveCount(0);
    await expect(
      page.locator("#captions").getByRole("button", { name: "导出字幕" }),
    ).toHaveCount(0);
  });

  test("EXP-2 正在听与已停止时导出：内容、顺序、时刻与页面定稿字幕一致；不发请求、不写存储；刷新后清空且不可用", async ({
    harness,
  }) => {
    test.setTimeout(240_000);
    const { page } = harness;
    await page.goto("/");
    await expectUnavailable(page);
    await startButton(page).click();
    await expect(statusText(page)).toHaveText(RUNNING, { timeout: 15_000 });

    // Listening: becomes available as soon as the first final caption appears.
    await waitForFinalCaptions(page, 1);
    await expectAvailable(page);
    const whileRunning = await exportCaptions(page);
    const runningFinals = await pageFinals(page);
    expect(whileRunning.lines.map((line) => line.text)).toEqual(
      runningFinals.slice(0, whileRunning.lines.length),
    );
    expect(whileRunning.lines.length).toBeGreaterThanOrEqual(1);
    await expect(statusText(page)).toHaveText(RUNNING);

    await waitForFinalCaptions(page, 3);
    await stopButton(page).click();
    await expect(statusText(page)).toHaveText(NOT_RUNNING, { timeout: 5_000 });
    await page.waitForTimeout(5_000);

    const requests: Request[] = [];
    const onRequest = (request: Request) => requests.push(request);
    page.context().on("request", onRequest);
    const clickedAt = Date.now();
    const file = await exportCaptions(page);
    page.context().off("request", onRequest);
    expect(requests.map((request) => request.url())).toEqual([]);

    expect(file.fileName).toMatch(/^字幕-\d{8}-\d{6}\.txt$/);
    const [exportClock] = await localClock(page, [clickedAt]);
    expect(file.date).toBe(exportClock!.date);
    expect(file.raw.match(/导出日期/g)).toHaveLength(1);

    const finals = await pageFinals(page);
    expect(finals.length).toBeGreaterThanOrEqual(3);
    expect(file.lines.map((line) => line.text)).toEqual(finals);
    // The earlier export is a prefix of the later one (export does not clear the captions).
    expect(file.lines.slice(0, whileRunning.lines.length)).toEqual(
      whileRunning.lines,
    );

    const times = finalTimes(await captionTimeline(page));
    expect(times).toHaveLength(finals.length);
    await expectTimesNear(page, file, expectedShown(times));
    expect(
      seconds(exportClock!.time) - seconds(file.lines[0]!.time),
    ).toBeGreaterThanOrEqual(4);

    const storage = await storageDump(page);
    expect(storage.databases).toEqual([]);
    for (const text of finals) expect(storage.text).not.toContain(text);

    await page.reload();
    await expect(page.locator("#captions li.caption")).toHaveCount(0);
    await expectUnavailable(page);
  });

  test("EXP-3 第 1 句晚于第 2 句定稿：保持页面顺序，第 1 行写后面各条中最早的定稿时刻（D-1）", async ({
    harness,
  }) => {
    test.setTimeout(240_000);
    const { page, context } = harness;
    await overrideTranslations(context, [
      {
        kind: "final",
        sentence: 1,
        attempt: "first",
        action: "delay",
        delayMs: 8_000,
      },
    ]);
    await page.goto("/");
    await startButton(page).click();
    await expect(statusText(page)).toHaveText(RUNNING, { timeout: 15_000 });
    await waitForFinalCaptions(page, 3, 120_000);
    await stopButton(page).click();
    await expect(statusText(page)).toHaveText(NOT_RUNNING, { timeout: 5_000 });
    await page.waitForTimeout(5_000);

    expect(
      (await translationCalls(page)).some(
        (call) => call.overridden === "delay",
      ),
    ).toBe(true);
    const times = finalTimes(await captionTimeline(page));
    expect(times.length).toBeGreaterThanOrEqual(2);
    test.skip(
      !(times[0]! > times[1]!),
      "the delayed first sentence did not become final after the second one",
    );

    const file = await exportCaptions(page);
    expect(file.lines.map((line) => line.text)).toEqual(await pageFinals(page));
    await expectTimesNear(page, file, expectedShown(times));
    const [own] = await localClock(page, [times[0]!]);
    expect(seconds(file.lines[0]!.time)).toBeLessThanOrEqual(
      seconds(own!.time),
    );
  });

  test("EXP-4 未能翻译的提示、识别原文不导出", async ({ harness }) => {
    test.setTimeout(240_000);
    const { page, context } = harness;
    await overrideTranslations(context, [
      { kind: "final", sentence: 2, attempt: "first", action: "hangul" },
      { kind: "final", sentence: 2, attempt: "retranslate", action: "hangul" },
    ]);
    await page.goto("/");
    await startButton(page).click();
    await expect(statusText(page)).toHaveText(RUNNING, { timeout: 15_000 });
    await expect(
      page.locator('#captions li.caption[data-kind="notice"]'),
    ).toHaveCount(1, { timeout: 120_000 });
    await waitForFinalCaptions(page, 3, 120_000);
    await stopButton(page).click();
    await expect(statusText(page)).toHaveText(NOT_RUNNING, { timeout: 5_000 });

    const file = await exportCaptions(page);
    const finals = await pageFinals(page);
    expect(file.lines.map((line) => line.text)).toEqual(finals);
    expect(file.raw).not.toContain(UNTRANSLATED_NOTICE);
    expect(file.raw).not.toMatch(/\p{Script=Hangul}/u);
    expect(file.raw).not.toMatch(/[A-Za-z]{4,}/);
  });

  test("EXP-5 “出错”状态下已有定稿字幕时仍可导出", async ({ harness }) => {
    test.setTimeout(240_000);
    const { page } = harness;
    await page.addInitScript({ content: TRANSLATION_FAILURE_SCRIPT });
    await page.goto("/");
    await startButton(page).click();
    await expect(statusText(page)).toHaveText(RUNNING, { timeout: 15_000 });
    await waitForFinalCaptions(page, 1);
    await failFinalTranslations(page, "upstream_unavailable", 3);
    await expect(statusText(page)).toHaveText(ERROR, { timeout: 120_000 });

    await expectAvailable(page);
    const file = await exportCaptions(page);
    const finals = await pageFinals(page);
    expect(finals.length).toBeGreaterThanOrEqual(1);
    expect(file.lines.map((line) => line.text)).toEqual(finals);
    await expect(statusText(page)).toHaveText(ERROR);
  });
});
