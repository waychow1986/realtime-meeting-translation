// Driver layer: browser sessions, page operations, export reading and time budget.
import { chromium } from 'playwright-core';
import { writeFileSync, readFileSync, mkdirSync, appendFileSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const BASE_URL = (process.env.AIDH_SERVICE_WEB_URL || '').replace(/\/$/, '');
export const EVIDENCE_DIR = process.env.QA_EVIDENCE_DIR || './evidence';
export const RESULT_PATH = process.env.QA_RESULT_PATH || './qa-result.json';
export const TZ = 'Asia/Shanghai'; // non-UTC browser time zone (test choice)
// Test wait limits (test plan §2.1), not product requirements.
export const SENTENCE_WAIT_MS = 90_000;
export const DOWNLOAD_WAIT_MS = 30_000;
export const ERROR_WAIT_MS = 120_000;
export const OBSERVE_MS = 5_000;
export const HINT = '还没有可导出的字幕。出现中文定稿字幕后即可导出。';
export const NOTICE_UNTRANSLATED = '（此句未能翻译成中文）';
const INIT = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'init.js'), 'utf8');
mkdirSync(EVIDENCE_DIR, { recursive: true });

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export function log(...a) {
  const line = `[${new Date().toISOString()}] ${a.join(' ')}`;
  console.log(line);
  try { appendFileSync(join(EVIDENCE_DIR, 'run.log'), line + '\n'); } catch {}
}

// ---------- time budget (test plan §2.2) ----------
const T0 = Date.now();
const TOTAL_MS = (Number(process.env.QA_TIMEOUT_SECONDS) || 3600) * 1000;
export const RESERVE_MS = 180_000;
export const deadline = T0 + TOTAL_MS - RESERVE_MS;
export class Aborted extends Error {}
export class NotReached extends Error {} // precondition not reached within a wait limit -> scenario not reported
export function guard() { if (Date.now() > deadline) throw new Aborted('执行时限预留点已到，中止当前场景'); }
export const remainingMs = () => deadline - Date.now();

export async function waitFor(fn, ms, every = 500) {
  const end = Date.now() + ms;
  for (;;) {
    guard();
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) return null;
    await sleep(every);
  }
}

// Never keep credentials (e.g. speech tokens in query strings) in evidence.
export const redact = (u) => String(u).replace(/([?&][^=&]*(auth|token|key)[^=&]*=)[^&]*/gi, '$1***');

// ---------- browser ----------
let browser;
export async function launch() {
  browser = await chromium.launch({
    headless: false,
    args: ['--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
  });
  return browser;
}
export async function closeBrowser() { try { await browser?.close(); } catch {} }

// A session = new browser context + main page with network, download and console recording.
export async function newSession(name, audio) {
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 }, permissions: ['microphone'], locale: 'zh-CN', timezoneId: TZ, acceptDownloads: true });
  await ctx.addInitScript({ content: INIT });
  const s = { name, ctx, audio, requests: [], wsFrames: [], downloads: [], console: [], errors: [], files: [] };
  ctx.on('request', (r) => {
    let body = null;
    try { body = r.postData(); } catch {}
    s.requests.push({ at: Date.now(), method: r.method(), url: redact(r.url()), type: r.resourceType(), body: body && body.length > 4000 ? body.slice(0, 4000) : body });
  });
  s.page = await openPage(s, ctx);
  return s;
}

export function attachPage(s, page) {
  page.on('download', (d) => s.downloads.push({ at: Date.now(), d }));
  page.on('console', (m) => s.console.push(`[${m.type()}] ${m.text()}`.slice(0, 500)));
  page.on('pageerror', (e) => s.errors.push(e.message));
  page.on('websocket', (ws) => {
    s.wsFrames.push({ at: Date.now(), url: redact(ws.url()), dir: 'open', text: '' });
    ws.on('framesent', (f) => { if (typeof f.payload === 'string') s.wsFrames.push({ at: Date.now(), url: redact(ws.url()), dir: 'sent', text: f.payload.slice(0, 4000) }); });
  });
}

export async function openPage(s, ctx) {
  const page = await ctx.newPage();
  attachPage(s, page);
  await page.goto(BASE_URL + '/', { waitUntil: 'load' });
  await page.getByRole('button', { name: '开始', exact: true }).waitFor({ state: 'visible', timeout: 20000 });
  await closeGuide(page);
  return page;
}

export async function closeGuide(page) {
  await sleep(600);
  const guide = page.getByRole('dialog', { name: '使用引导' });
  if (await guide.isVisible().catch(() => false)) {
    await guide.getByRole('button', { name: '知道了' }).click();
    await guide.waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {});
  }
}

export const exportButton = (page) => page.getByRole('button', { name: '导出字幕', exact: true });
export const statusText = async (page) => ((await page.getByRole('status').first().textContent()) || '').trim();

export async function waitStatus(page, text, ms = 30_000) {
  return waitFor(async () => ((await statusText(page)) === text ? true : null), ms, 300);
}
export async function start(page) {
  await page.getByRole('button', { name: '开始', exact: true }).click();
  if (!(await waitStatus(page, '正在听', 30_000))) throw new NotReached(`点击“开始”后 30 秒内没有进入“正在听”（状态=${await statusText(page)}）`);
}
export async function stop(page) {
  await page.getByRole('button', { name: '停止', exact: true }).click();
  if (!(await waitStatus(page, '已停止', 15_000))) throw new NotReached(`点击“停止”后没有进入“已停止”（状态=${await statusText(page)}）`);
}

// All caption items in page order.
export async function items(page) {
  return page.evaluate(() => [...document.querySelectorAll('#captions > li')].map((li) => ({
    id: li.getAttribute('data-segment-id') || '', status: li.getAttribute('data-status') || '', kind: li.getAttribute('data-kind') || '', text: li.textContent,
  })));
}
// Chinese final captions on the main page (可测性约定: li.caption[data-status=final]:not([data-kind=notice])), page order.
export async function finals(page) {
  return page.evaluate(() => [...document.querySelectorAll('#captions li.caption[data-status="final"]:not([data-kind="notice"])')].map((li) => li.textContent));
}
export const pendingCount = async (page) => (await items(page)).filter((i) => i.status === 'interim' || i.status === 'finalizing').length;
export const timeline = (page) => page.evaluate(() => { window.__qa.scan(); return window.__qa.order.map((id) => window.__qa.seen[id]); });
export const finalReqs = (page) => page.evaluate(() => window.__qa.finalReqs);
export async function addRule(page, key, action, delayMs = 0) { await page.evaluate(([k, a, d]) => window.__qa.rules.push({ key: k, action: a, delayMs: d }), [key, action, delayMs]); }

// Plays one sentence into the fake microphone and waits until it has been played.
export async function say(s, id) {
  guard();
  const a = s.audio[id];
  log(s.name, 'say', id, a.text);
  const dur = await s.page.evaluate((b64) => window.__qa.play(b64), a.b64);
  await sleep(dur * 1000 + 300);
  s.spoken = [...(s.spoken || []), id];
  return dur;
}

// Plays a sentence, then waits until at least one more final caption exists and nothing is pending.
export async function sayAndFinal(s, id, extraMs = 0) {
  const before = (await finals(s.page)).length;
  await say(s, id);
  const ok = await waitFor(async () => (await finals(s.page)).length > before && (await pendingCount(s.page)) === 0, SENTENCE_WAIT_MS + extraMs, 500);
  if (!ok) throw new NotReached(`句子 ${id} 在等待上限内没有成为中文定稿字幕`);
  await sleep(1200);
  if ((await pendingCount(s.page)) > 0) await waitFor(async () => (await pendingCount(s.page)) === 0, 20_000, 500);
  return finals(s.page);
}

// Waits until the final translation request for sentence `id` has been issued (caption is "正在定稿").
export async function waitFinalRequest(s, id, ms = SENTENCE_WAIT_MS) {
  const key = s.audio[id].key;
  const ok = await waitFor(async () => (await finalReqs(s.page)).some((r) => r.text.toLowerCase().includes(key)), ms, 300);
  if (!ok) throw new NotReached(`句子 ${id} 在等待上限内没有进入“正在定稿”`);
}

// Clicks the (enabled) export button once; returns the download and file content (null if no download within the limit).
export async function exportOnce(s, page = s.page) {
  const n0 = s.downloads.length;
  const reqBefore = s.requests.length;
  const clickAt = await page.evaluate(() => Date.now());
  await exportButton(page).click();
  const got = await waitFor(async () => s.downloads.length > n0, DOWNLOAD_WAIT_MS, 100);
  if (!got) throw new NotReached('点击“导出字幕”后 30 秒内没有开始下载');
  const dl = s.downloads[n0].d;
  const path = await dl.path();
  const doneAt = Date.now();
  const reqDuring = s.requests.slice(reqBefore).filter((r) => r.at <= doneAt);
  await sleep(OBSERVE_MS);
  const extra = s.downloads.length - n0 - 1;
  const bytes = readFileSync(path);
  const idx = s.files.length + 1;
  const evName = `${s.name}-export${idx}.txt`;
  copyFileSync(path, join(EVIDENCE_DIR, evName));
  const f = { name: dl.suggestedFilename(), path, bytes, evName, clickAt, extraDownloads: extra, requestsDuring: reqDuring, ...parseExport(bytes) };
  s.files.push(f);
  log(s.name, 'exported', f.name, `${f.rows?.length ?? '?'} rows`, `extra downloads=${extra}`, `requests during=${reqDuring.length}`);
  return f;
}

// Force-clicks the export button (as a user click) and watches for any download.
export async function forceClickNoDownload(s, page = s.page) {
  const n0 = s.downloads.length;
  await exportButton(page).click({ force: true, timeout: 5000 }).catch((e) => log('force click error', e.message.split('\n')[0]));
  await sleep(OBSERVE_MS);
  return s.downloads.length === n0;
}

export async function hintVisible(page) {
  const h = page.getByText(HINT, { exact: true });
  return (await h.count()) > 0 && (await h.first().isVisible());
}

// Strict UTF-8 parsing of an export file (test plan §2 + 规格 A-3).
export function parseExport(bytes) {
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return { utf8: false, text: null, lines: [], rows: null }; }
  const lines = text.split(/\r?\n/);
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  const rows = lines.slice(2).map((l) => { const m = /^(\d{2}):(\d{2}):(\d{2}) (.+)$/.exec(l); return m ? { raw: l, h: +m[1], m: +m[2], s: +m[3], time: `${m[1]}:${m[2]}:${m[3]}`, text: m[4], ok: true } : { raw: l, ok: false, text: l }; });
  return { utf8: true, text, lines, rows };
}

// 逐字比较的口径: page text line breaks -> one space, nothing else.
export const norm = (t) => String(t).replace(/\r\n|\r|\n|\u2028|\u2029/g, ' ');
export const secOf = (r) => r.h * 3600 + r.m * 60 + r.s;

// Local (page time zone) clock parts for epoch ms values, computed in the page.
export async function localParts(page, list) {
  return page.evaluate((arr) => arr.map((ms) => { const d = new Date(ms); return { y: d.getFullYear(), mo: d.getMonth() + 1, d: d.getDate(), h: d.getHours(), mi: d.getMinutes(), s: d.getSeconds(), sec: d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds() }; }), list);
}

// Expected time per page-final row (TD-911): from the timeline, min of own and all later final times.
export async function expectedTimes(page) {
  const tl = (await timeline(page)).filter((e) => e.finalAt !== null);
  const pageFinalIds = await page.evaluate(() => [...document.querySelectorAll('#captions li.caption[data-status="final"]:not([data-kind="notice"])')].map((li) => li.getAttribute('data-segment-id') || ''));
  const own = pageFinalIds.map((id) => tl.find((e) => e.id === id)?.finalAt ?? null);
  const exp = new Array(own.length);
  let min = Infinity;
  for (let i = own.length - 1; i >= 0; i--) { min = Math.min(min, own[i] ?? Infinity); exp[i] = min; }
  return { own, exp, ids: pageFinalIds };
}

// Source-text fragments (>= 6 chars, test choice) that must not appear in exported text or storage.
export function sourceFragments(texts) {
  const out = new Set();
  for (const t of texts) for (let i = 0; i + 6 <= t.length; i++) { const f = t.slice(i, i + 6); if (/[A-Za-z]{3}/.test(f)) out.add(f); }
  return [...out];
}

export async function saveSessionEvidence(s, extra = {}) {
  const base = s.name;
  const files = [];
  const w = (n, v) => { try { writeFileSync(join(EVIDENCE_DIR, n), typeof v === 'string' ? v : JSON.stringify(v, null, 2)); files.push(n); } catch {} };
  try { w(`${base}-timeline.json`, await timeline(s.page)); } catch {}
  try { w(`${base}-final-requests.json`, await finalReqs(s.page)); } catch {}
  try { await s.page.screenshot({ path: join(EVIDENCE_DIR, `${base}.png`) }); files.push(`${base}.png`); } catch {}
  w(`${base}-network.json`, s.requests);
  w(`${base}-ws-text-frames.json`, s.wsFrames);
  w(`${base}-console.log`, [...s.console, ...s.errors.map((e) => `[pageerror] ${e}`)].join('\n'));
  if (Object.keys(extra).length) w(`${base}-extra.json`, extra);
  return [...files, ...s.files.map((f) => f.evName)];
}

export async function closeSession(s) { try { await s.ctx.close(); } catch {} }
