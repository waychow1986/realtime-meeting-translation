// Minimal helpers for a smoke case (self-contained copy per case).
import { chromium } from 'playwright-core';
import { writeFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';

export const BASE_URL = (process.env.AIDH_SERVICE_WEB_URL || '').replace(/\/$/, '');
export const EVIDENCE_DIR = process.env.QA_EVIDENCE_DIR || './evidence';
export const RESULT_PATH = process.env.QA_RESULT_PATH || './qa-result.json';
export const CAPTION_WAIT_MS = 180_000; // test wait limit, not a product requirement
mkdirSync(EVIDENCE_DIR, { recursive: true });
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export function log(...a) {
  const line = `[${new Date().toISOString()}] ${a.join(' ')}`;
  console.log(line);
  try { appendFileSync(join(EVIDENCE_DIR, 'run.log'), line + '\n'); } catch {}
}

let browser;
export async function launch(audioPath) {
  browser = await chromium.launch({
    headless: false,
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${audioPath}`, '--autoplay-policy=no-user-gesture-required'],
  });
  return browser;
}
export async function closeBrowser() { try { await browser?.close(); } catch {} }

export async function openPage(ctx) {
  const page = await ctx.newPage();
  page.__errors = [];
  page.on('pageerror', (e) => page.__errors.push(e.message));
  await page.goto(BASE_URL + '/', { waitUntil: 'load' });
  await page.getByRole('button', { name: '字幕显示' }).waitFor({ state: 'visible', timeout: 15000 });
  await sleep(500);
  const guide = page.getByRole('dialog', { name: '使用引导' });
  if (await guide.isVisible().catch(() => false)) await guide.getByRole('button', { name: '知道了' }).click();
  return page;
}
export async function newContext(viewport = { width: 480, height: 800 }) {
  return browser.newContext({ viewport, permissions: ['microphone'], locale: 'zh-CN' });
}
export async function openDisplay(page) {
  if (!(await page.getByRole('group', { name: '行距' }).isVisible())) await page.getByRole('button', { name: '字幕显示' }).click();
  await page.getByRole('group', { name: '行距' }).waitFor({ state: 'visible', timeout: 5000 });
}
export async function chooseSpacing(page, label) {
  await openDisplay(page);
  await page.getByRole('group', { name: '行距' }).getByRole('radio', { name: label, exact: true }).click();
}
export async function checkedSpacing(page) {
  await openDisplay(page);
  const radios = page.getByRole('group', { name: '行距' }).getByRole('radio');
  const out = [];
  for (let i = 0; i < (await radios.count()); i++) if (await radios.nth(i).isChecked()) out.push(await radios.nth(i).evaluate((el) => (el.labels?.[0]?.textContent || '').trim()));
  return out;
}
export const statusText = async (page) => (await page.getByRole('status').first().textContent())?.trim();

// Final captions in the main caption area with the top of each rendered text line.
export async function finals(page) {
  return page.evaluate(() => [...document.querySelectorAll('#captions > li')].map((li) => {
    const r = document.createRange(); r.selectNodeContents(li);
    const tops = [];
    for (const x of r.getClientRects()) if (x.width >= 1 && x.height >= 1 && !tops.some((t) => Math.abs(t - x.top) < 2)) tops.push(x.top);
    tops.sort((a, b) => a - b);
    return { id: li.dataset.segmentId, status: li.dataset.status, text: li.textContent.trim(), tops };
  }).filter((i) => i.status === 'final' && i.text && i.tops.length));
}
export async function waitFor(fn, ms, every = 1500) {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) return null; await sleep(every); }
}

export function writeResult(summary, scenarios, externalServices = ['speech', 'chat-model']) {
  writeFileSync(RESULT_PATH, JSON.stringify({ schemaVersion: 2, testedCommitSha: process.env.QA_CANDIDATE_SHA || '', summary, scenarios, externalServices }, null, 2));
}
