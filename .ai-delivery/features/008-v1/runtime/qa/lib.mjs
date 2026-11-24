// Driver layer: browser setup, UI operations (by accessible role and visible name), measurement and evidence.
import { chromium } from 'playwright-core';
import { writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';

export const BASE_URL = (process.env.AIDH_SERVICE_WEB_URL || '').replace(/\/$/, '');
export const EVIDENCE_DIR = process.env.QA_EVIDENCE_DIR || './evidence';
export const BG_EXPECTED = 'rgb(13, 17, 23)';
export const SPACING_LABEL = { compact: '紧凑', normal: '标准', loose: '宽松' };
export const SIZE_LABEL = { s: '小', m: '中', l: '大', xl: '特大' };
// Pre-delivery ("standard") values per caption size: [line spacing inside a caption, spacing between captions] in px.
export const STANDARD_PX = { s: [36, 50], m: [48, 62], l: [60, 74], xl: [78, 92] };
export const STRICT = 0.5; // test tolerance for "strictly greater" (pixel rounding), not a product requirement
export const SAME = 1; // test tolerance for "the same" (measurement rounding), not a product requirement
export const CAPTION_WAIT_MS = 180_000; // test wait limit, not a product requirement
export const APPLY_WAIT_MS = 10_000; // test wait limit, not a product requirement

export class Skip extends Error {}
// Reasons for scenarios that are not reported (test wait limit reached etc.), shown in the result summary.
export const notes = [];

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function log(...a) {
  const line = `[${new Date().toISOString()}] ${a.join(' ')}`;
  console.log(line);
  try { appendFileSync(join(EVIDENCE_DIR, 'run.log'), line + '\n'); } catch {}
}

// Redacts query values and anything token-like before it is written as evidence.
export function redact(s) {
  return String(s)
    .replace(/([?&][^=&#\s]+)=([^&#\s"]*)/g, '$1=***')
    .replace(/eyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]*/g, '***')
    .replace(/(authorization|ocp-apim-subscription-key|token)(["':\s=]+)[^\s"',}]+/gi, '$1$2***');
}

let browser;
export async function launch(audioPath) {
  browser = await chromium.launch({
    headless: false,
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      `--use-file-for-fake-audio-capture=${audioPath}`,
      '--autoplay-policy=no-user-gesture-required',
    ],
  });
  return browser;
}
export async function closeBrowser() { try { await browser?.close(); } catch {} }

// A recorder collects client logs and network traffic for one group of scenarios.
export class Recorder {
  constructor(name) { this.name = name; this.lines = []; this.pageErrors = []; this.file = `${name}-client-network.log`; }
  add(kind, text) { this.lines.push(`${new Date().toISOString()} ${kind} ${redact(text)}`); }
  attach(page, label = 'page') {
    page.on('console', (m) => this.add(`${label}.console.${m.type()}`, m.text()));
    page.on('pageerror', (e) => { this.pageErrors.push(`${label}: ${e.message}`); this.add(`${label}.pageerror`, e.stack || e.message); });
    page.on('request', (r) => this.add(`${label}.request`, `${r.method()} ${r.url()}`));
    page.on('response', (r) => this.add(`${label}.response`, `${r.status()} ${r.url()}`));
    page.on('requestfailed', (r) => this.add(`${label}.requestfailed`, `${r.url()} ${r.failure()?.errorText}`));
    page.on('websocket', (ws) => {
      this.add(`${label}.websocket.open`, ws.url());
      ws.on('framesent', (f) => this.add(`${label}.ws.sent`, typeof f.payload === 'string' ? f.payload.slice(0, 300) : `<binary ${f.payload.length} bytes>`));
      ws.on('framereceived', (f) => this.add(`${label}.ws.recv`, typeof f.payload === 'string' ? f.payload.slice(0, 600) : `<binary ${f.payload.length} bytes>`));
      ws.on('close', () => this.add(`${label}.websocket.close`, ws.url()));
      ws.on('socketerror', (e) => this.add(`${label}.websocket.error`, String(e)));
    });
  }
  flush() { writeFileSync(join(EVIDENCE_DIR, this.file), this.lines.join('\n') + '\n'); return this.file; }
}

export async function newContext({ viewport = { width: 1366, height: 900 }, initScript } = {}) {
  const ctx = await browser.newContext({ viewport, permissions: ['microphone'], locale: 'zh-CN' });
  if (initScript) await ctx.addInitScript(initScript);
  return ctx;
}

export async function openPage(ctx, rec, label = 'page') {
  const page = await ctx.newPage();
  rec?.attach(page, label);
  await page.goto(BASE_URL + '/', { waitUntil: 'load' });
  await page.getByRole('button', { name: '字幕显示' }).waitFor({ state: 'visible', timeout: 15000 });
  await sleep(500);
  await closeGuide(page);
  return page;
}

// "Close the page and open it again in the same browser": open a new page in the same context, then close the old one.
export async function reopen(ctx, page, rec, label = 'page') {
  const next = await openPage(ctx, rec, label);
  await page.close();
  return next;
}

export async function closeGuide(page) {
  const guide = page.getByRole('dialog', { name: '使用引导' });
  if (await guide.isVisible().catch(() => false)) {
    await guide.getByRole('button', { name: '知道了' }).click();
    await guide.waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {});
  }
}

export async function openDisplay(page) {
  const btn = page.getByRole('button', { name: '字幕显示' });
  if (!(await page.getByRole('group', { name: '行距' }).isVisible())) {
    await btn.click();
  }
  await page.getByRole('group', { name: '行距' }).waitFor({ state: 'visible', timeout: 5000 });
}

export async function closeDisplay(page) {
  if (await page.getByRole('group', { name: '行距' }).isVisible().catch(() => false)) {
    await page.keyboard.press('Escape');
    await sleep(200);
  }
}

export function spacingGroup(page) { return page.getByRole('group', { name: '行距' }); }
export function sizeGroup(page) { return page.getByRole('group', { name: '字号' }); }

export async function chooseSpacing(page, key) {
  await openDisplay(page);
  await spacingGroup(page).getByRole('radio', { name: SPACING_LABEL[key], exact: true }).click();
}
export async function chooseSize(page, key) {
  await openDisplay(page);
  await sizeGroup(page).getByRole('radio', { name: SIZE_LABEL[key], exact: true }).click();
}

// Returns the visible names of the checked radios in a group (opens the display panel first).
export async function checkedIn(page, groupName) {
  await openDisplay(page);
  const radios = page.getByRole('group', { name: groupName }).getByRole('radio');
  const n = await radios.count();
  const out = [];
  for (let i = 0; i < n; i++) {
    const r = radios.nth(i);
    if (await r.isChecked()) out.push((await r.evaluate((el) => (el.labels?.[0]?.textContent || el.getAttribute('aria-label') || '').trim())));
  }
  return out;
}

export async function panelAttr(page) {
  return page.evaluate(() => document.getElementById('caption-panel')?.dataset.captionSpacing ?? null);
}
export async function panelBg(page) {
  return page.evaluate(() => getComputedStyle(document.getElementById('caption-panel')).backgroundColor);
}
export async function statusText(page) {
  return (await page.getByRole('status').first().textContent())?.trim();
}

export async function startTranslation(page) {
  await page.getByRole('button', { name: '开始', exact: true }).click();
}
export async function stopTranslation(page) {
  await page.getByRole('button', { name: '停止', exact: true }).click();
}

// Measures every caption entry in the main page ("main") or the caption window ("pip").
export async function measure(page, where = 'main') {
  return page.evaluate((where) => {
    const doc = where === 'pip' ? window.documentPictureInPicture?.window?.document : document;
    if (!doc) return null;
    const list = doc.getElementById(where === 'pip' ? 'pip-captions' : 'captions');
    if (!list) return null;
    const items = [...list.children].map((li) => {
      const range = doc.createRange();
      range.selectNodeContents(li);
      const tops = [];
      for (const r of range.getClientRects()) {
        if (r.width < 1 || r.height < 1) continue;
        if (!tops.some((t) => Math.abs(t - r.top) < 2)) tops.push(r.top);
      }
      tops.sort((a, b) => a - b);
      const cs = getComputedStyle(li);
      return {
        id: li.dataset.segmentId ?? null,
        status: li.dataset.status ?? null,
        cls: li.className,
        text: li.textContent,
        tops,
        lines: tops.length,
        lineHeight: parseFloat(cs.lineHeight),
        fontSize: parseFloat(cs.fontSize),
        color: cs.color,
        fontFamily: cs.fontFamily,
      };
    });
    return { items, spacingAttr: (where === 'pip' ? doc.body : doc.getElementById('caption-panel'))?.dataset.captionSpacing ?? null };
  }, where);
}

export const finals = (m) => (m?.items || []).filter((i) => i.status === 'final' && i.text.trim() && i.lines > 0);

// Line spacing inside a multi-line caption: differences of consecutive line tops (all should be equal).
export function intra(item) {
  if (!item || item.tops.length < 2) return null;
  return item.tops[1] - item.tops[0];
}

// Spacing between two adjacent captions: last line top of the first to first line top of the second.
export function gapBetween(m, idA, idB) {
  const a = m.items.find((i) => i.id === idA);
  const b = m.items.find((i) => i.id === idB);
  if (!a || !b || !a.tops.length || !b.tops.length) return null;
  const ia = m.items.indexOf(a), ib = m.items.indexOf(b);
  if (ib !== ia + 1) return null;
  return b.tops[0] - a.tops[a.tops.length - 1];
}

// Adjacent pairs of non-empty final captions with the same font size.
export function finalPairs(m) {
  const out = [];
  for (let k = 0; k + 1 < m.items.length; k++) {
    const a = m.items[k], b = m.items[k + 1];
    if (a.status === 'final' && b.status === 'final' && a.text.trim() && b.text.trim() && a.fontSize === b.fontSize && a.tops.length && b.tops.length) out.push([a.id, b.id]);
  }
  return out;
}

export async function waitFor(fn, timeoutMs, intervalMs = 1000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) return null;
    await sleep(intervalMs);
  }
}

// Waits until the caption area has at least `minFinals` final captions in an adjacent pair, optionally one multi-line.
export async function waitForCaptions(page, { minFinals = 2, multiLine = false, where = 'main', timeoutMs = CAPTION_WAIT_MS } = {}) {
  const m = await waitFor(async () => {
    const m = await measure(page, where);
    if (!m) return null;
    const f = finals(m);
    if (f.length < minFinals || finalPairs(m).length < 1) return null;
    if (multiLine && !f.some((i) => i.lines >= 2)) return null;
    return m;
  }, timeoutMs, 1500);
  if (!m) throw new Skip(`test wait limit reached: captions (>=${minFinals} final${multiLine ? ', one multi-line' : ''}) did not appear`);
  return m;
}

export async function screenshot(page, name) {
  const file = `${name}.png`;
  try { await page.screenshot({ path: join(EVIDENCE_DIR, file), fullPage: false }); return file; } catch { return null; }
}

export function writeJson(name, data) {
  const file = `${name}.json`;
  writeFileSync(join(EVIDENCE_DIR, file), JSON.stringify(data, null, 2));
  return file;
}

// Scenario result builder.
export class Scenario {
  constructor(id) { this.id = id; this.checkpoints = []; this.evidence = new Set(); }
  check(step, passed, observation) {
    this.checkpoints.push({ step, passed: !!passed, observation: String(observation).slice(0, 1500) });
    log(`${this.id} ${passed ? 'PASS' : 'FAIL'} ${step} :: ${observation}`);
    return !!passed;
  }
  ev(f) { if (f) this.evidence.add(f); }
  get passed() { return this.checkpoints.length > 0 && this.checkpoints.every((c) => c.passed); }
  toJSON() { return { id: this.id, passed: this.passed, checkpoints: this.checkpoints, evidence: [...this.evidence] }; }
}

export const fmt = (v) => (v == null ? 'n/a' : Number(v).toFixed(1));
