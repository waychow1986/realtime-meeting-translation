// TS-03 (+TS-13(a), TS-14), TS-05, TS-06
import * as c from './common.mjs';
import { recorder, shared } from './shared.mjs';

const J = (v) => JSON.stringify(v);
export function nonDecreasing(rows) { for (let i = 1; i < rows.length; i++) if (c.secOf(rows[i]) < c.secOf(rows[i - 1])) return false; return true; }
export const hms = (p) => [p.h, p.mi, p.s].map((x) => String(x).padStart(2, '0')).join(':');
const diffSec = (a, b) => { let d = Math.abs(a - b); if (d > 43200) d = 86400 - d; return d; };

export function compareRows(check, label, f, pageList) {
  const exp = pageList.map(c.norm);
  const got = (f.rows || []).map((r) => r.text);
  const allFmt = (f.rows || []).every((r) => r.ok);
  check(`${label}：字幕行数 = 页面定稿字幕条数`, f.rows && f.rows.length === exp.length, `文件字幕行 ${f.rows?.length}，页面定稿 ${exp.length}`);
  const diffs = exp.map((t, i) => (got[i] === t ? null : { 行: i + 1, 页面: t, 文件: got[i] ?? null })).filter(Boolean);
  check(`${label}：第 i 行文字与页面第 i 条逐字相同、同序`, allFmt && diffs.length === 0 && got.length === exp.length, diffs.length || !allFmt || got.length !== exp.length ? `不一致：${J(diffs)}；全部行为“HH:MM:SS 文字”=${allFmt}；文件行=${J(got)}` : `逐字一致：${J(got)}`);
}

// Reads all browser storage (localStorage, sessionStorage, every IndexedDB database/store) as one string.
export async function dumpStorage(page) {
  return page.evaluate(async () => {
    const out = { local: {}, session: {}, idb: {} };
    for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); out.local[k] = localStorage.getItem(k); }
    for (let i = 0; i < sessionStorage.length; i++) { const k = sessionStorage.key(i); out.session[k] = sessionStorage.getItem(k); }
    const dbs = indexedDB.databases ? await indexedDB.databases() : [];
    for (const info of dbs) {
      out.idb[info.name] = await new Promise((res) => {
        const req = indexedDB.open(info.name);
        req.onerror = () => res({ error: 'open failed' });
        req.onsuccess = () => {
          const db = req.result; const stores = [...db.objectStoreNames]; const data = {};
          if (!stores.length) { db.close(); return res(data); }
          const tx = db.transaction(stores, 'readonly'); let left = stores.length;
          for (const st of stores) { const g = tx.objectStore(st).getAll(); g.onsuccess = () => { data[st] = g.result; if (--left === 0) { db.close(); res(data); } }; g.onerror = () => { data[st] = 'getAll failed'; if (--left === 0) { db.close(); res(data); } }; }
        };
      });
    }
    return out;
  });
}
function leaks(dump, zh, frags) {
  const s = JSON.stringify(dump);
  const hits = [...zh.filter((t) => t && s.includes(t)).map((t) => `中文：${t}`), ...frags.filter((f) => s.includes(f) || s.includes(JSON.stringify(f).slice(1, -1))).map((f) => `原文片段：${f}`)];
  return hits;
}
const srcTexts = (s) => (s.spoken || []).map((id) => s.audio[id].text);

// ---------- TS-03 + TS-13(a) + TS-14 ----------
export async function groupS03(audio, report) {
  const s = await c.newSession('TS03', audio);
  try {
    const page = s.page;
    await c.start(page);
    for (const id of ['s1', 's2', 's3']) await c.sayAndFinal(s, id);
    await c.stop(page);
    await c.start(page);
    for (const id of ['s4', 's5']) await c.sayAndFinal(s, id);
    await c.stop(page);
    const before = await c.items(page);
    const pageList = await c.finals(page);
    if (pageList.length < 5) throw new c.NotReached(`页面定稿只有 ${pageList.length} 条`);
    const st0 = await dumpStorage(page);
    const f = await c.exportOnce(s);
    const after = await c.items(page);
    const st1 = await dumpStorage(page);
    // TS-03
    const r = recorder();
    r.check('1. 文件按 UTF-8 严格解码成功', f.utf8, `UTF-8 严格解码=${f.utf8}；文件名=${f.name}`);
    compareRows(r.check, '2/3. 两轮共 5 条', f, pageList);
    const status = await c.statusText(page);
    r.check('4. 导出后页面字幕条数、顺序、文字不变，状态仍为“已停止”', J(after) === J(before) && status === '已停止', `导出前 ${before.length} 条，导出后 ${after.length} 条，内容相同=${J(after) === J(before)}；状态=${status}`);
    report({ id: 'TS-03', passed: r.passed(), checkpoints: r.cps, evidence: await c.saveSessionEvidence(s, { storageBefore: st0, storageAfter: st1 }) });
    // TS-13(a)
    shared.ts13a = { rows: f.rows.map((x) => x.text), requestsDuring: f.requestsDuring, requests: s.requests, wsFrames: s.wsFrames };
    // TS-14
    const r14 = recorder();
    const frags = c.sourceFragments(srcTexts(s));
    const h0 = leaks(st0, pageList, frags), h1 = leaks(st1, pageList, frags);
    r14.check('导出前浏览器存储（localStorage、sessionStorage、IndexedDB）中没有中文定稿字幕文字与原文片段', h0.length === 0, h0.length ? `命中：${J(h0.slice(0, 10))}` : `存储键：local=${J(Object.keys(st0.local))} session=${J(Object.keys(st0.session))} idb=${J(Object.keys(st0.idb))}；未命中`);
    r14.check('导出后浏览器存储中没有中文定稿字幕文字与原文片段', h1.length === 0, h1.length ? `命中：${J(h1.slice(0, 10))}` : `存储键：local=${J(Object.keys(st1.local))} session=${J(Object.keys(st1.session))} idb=${J(Object.keys(st1.idb))}；未命中`);
    report({ id: 'TS-14', passed: r14.passed(), checkpoints: r14.cps, evidence: [`${s.name}-extra.json`] });
  } finally { await c.closeSession(s); }
}

// time checks shared by TS-05/06/10
export async function timeChecks(check, page, f, label) {
  const { own, exp } = await c.expectedTimes(page);
  const ownP = await c.localParts(page, own.map((x) => x ?? 0));
  const expP = await c.localParts(page, exp.map((x) => (x === Infinity ? 0 : x)));
  const rows = f.rows || [];
  const bad = rows.map((r, i) => (r.ok && expP[i] && diffSec(c.secOf(r), expP[i].sec) <= 1 ? null : { 行: i + 1, 文件: r.time ?? r.raw, 期望: expP[i] ? hms(expP[i]) : null })).filter(Boolean);
  check(`${label}每行时刻等于期望的定稿本地时刻（±1 秒）`, rows.length === own.length && bad.length === 0, bad.length || rows.length !== own.length ? `不符：${J(bad)}；各条自己的定稿时刻=${J(ownP.map(hms))}` : `文件=${J(rows.map((x) => x.time))}；期望=${J(expP.map(hms))}；各条自己的定稿时刻=${J(ownP.map(hms))}`);
  return { own, exp, ownP, expP };
}

// ---------- TS-05 ----------
export async function groupS05(audio, report) {
  const s = await c.newSession('TS05', audio);
  try {
    const page = s.page;
    await c.start(page);
    for (const id of ['s6', 's7', 's8', 's9']) { await c.sayAndFinal(s, id); await c.sleep(2500); }
    await c.stop(page);
    await c.sleep(5500);
    const pageList = await c.finals(page);
    const { own } = await c.expectedTimes(page);
    const overtaken = own.some((t, i) => own.slice(i + 1).some((u) => u < t));
    const dBefore = await page.evaluate(() => { const d = new Date(); return [d.getFullYear(), d.getMonth() + 1, d.getDate()]; });
    const f = await c.exportOnce(s);
    const dAfter = await page.evaluate(() => { const d = new Date(); return [d.getFullYear(), d.getMonth() + 1, d.getDate()]; });
    const ds = (a) => `${a[0]}-${String(a[1]).padStart(2, '0')}-${String(a[2]).padStart(2, '0')}`;
    const r = recorder();
    const l = f.lines;
    const okDate = [ds(dBefore), ds(dAfter)].map((x) => `导出日期：${x}`);
    const dateCount = (f.text || '').split('导出日期').length - 1;
    r.check('1. 第 1 行为“导出日期：YYYY-MM-DD”且等于点击时本地日期，第 2 行为空行，导出日期只出现一次', okDate.includes(l[0]) && l[1] === '' && dateCount === 1, `第 1 行=${J(l[0])}；期望=${J(okDate[0])}；第 2 行=${J(l[1])}；“导出日期”出现次数=${dateCount}`);
    const allRowsFmt = f.rows.length > 0 && f.rows.every((x) => x.ok && x.h < 24 && x.m < 60 && x.s < 60);
    r.check('2. 每条字幕行为“HH:MM:SS 文字”（24 小时制、两位数、1 个空格）', allRowsFmt && f.rows.length === pageList.length, `字幕行=${J(f.rows.map((x) => x.raw))}`);
    await timeChecks(r.check, page, f, overtaken ? '3.（记录显示有句子被越过定稿，按 TS-06 规则计算期望）' : '3.（没有句子被越过定稿）');
    r.check('4. 时刻不倒序', allRowsFmt && nonDecreasing(f.rows), J(f.rows.map((x) => x.time)));
    const [clickP] = await c.localParts(page, [f.clickAt]);
    const late = f.rows.filter((x) => { if (!x.ok) return true; const d = (clickP.sec - c.secOf(x) + 86400) % 86400; return !(d >= 4 && d < 43200); });
    r.check('5. 各行时刻都早于点击导出时刻至少 4 秒', allRowsFmt && late.length === 0, `点击时刻=${hms(clickP)}；不满足的行=${J(late.map((x) => x.raw))}`);
    report({ id: 'TS-05', passed: r.passed(), checkpoints: r.cps, evidence: await c.saveSessionEvidence(s) });
  } finally { await c.closeSession(s); }
}

// ---------- TS-06 ----------
export async function groupS06(audio, report) {
  const s = await c.newSession('TS06', audio);
  try {
    const page = s.page;
    await c.addRule(page, audio.s10.key, 'delay', 8000);
    await c.start(page);
    await c.say(s, 's10'); await c.sleep(1200);
    await c.say(s, 's11'); await c.sleep(1200);
    await c.say(s, 's12');
    const ok = await c.waitFor(async () => (await c.finals(page)).length >= 3 && (await c.pendingCount(page)) === 0, c.SENTENCE_WAIT_MS + 8000, 500);
    if (!ok) throw new c.NotReached('3 句在等待上限内没有都成为定稿');
    await c.sleep(1500);
    await c.stop(page);
    const { own } = await c.expectedTimes(page);
    if (own.length !== 3 || !(own[0] > own[1])) throw new c.NotReached(`造数未成功：定稿条数=${own.length}，各条定稿时间戳=${J(own)}（需第 2 句先于第 1 句定稿）`);
    const lastFinal = Math.max(...own);
    const waitMore = lastFinal + 5500 - (await page.evaluate(() => Date.now()));
    if (waitMore > 0) await c.sleep(waitMore);
    const pageList = await c.finals(page);
    const f = await c.exportOnce(s);
    const r = recorder();
    compareRows(r.check, '1. 3 条字幕顺序与文字与页面一致', f, pageList);
    const ownP = await c.localParts(page, own);
    const rows = f.rows || [];
    const fmtOk = rows.length === 3 && rows.every((x) => x.ok);
    const minLater = Math.min(own[1], own[2]);
    const [minP] = await c.localParts(page, [minLater]);
    r.check('2a. 第 1 行时刻等于第 2、3 条中最早的定稿时刻（±1 秒），且不晚于第 1 条自己的定稿时刻', fmtOk && diffSec(c.secOf(rows[0]), minP.sec) <= 1 && c.secOf(rows[0]) <= ownP[0].sec, fmtOk ? `第 1 行=${rows[0].time}；第 2、3 条最早定稿=${hms(minP)}；第 1 条自己的定稿=${hms(ownP[0])}` : `行=${J(rows.map((x) => x.raw))}`);
    r.check('2b. 第 2、3 行时刻各自等于自己的定稿时刻（±1 秒）', fmtOk && diffSec(c.secOf(rows[1]), ownP[1].sec) <= 1 && diffSec(c.secOf(rows[2]), ownP[2].sec) <= 1, fmtOk ? `第 2 行=${rows[1].time}（定稿 ${hms(ownP[1])}）；第 3 行=${rows[2].time}（定稿 ${hms(ownP[2])}）` : '行格式不符');
    r.check('3. 整列时刻不倒序', fmtOk && nonDecreasing(rows), J(rows.map((x) => x.time)));
    report({ id: 'TS-06', passed: r.passed(), checkpoints: r.cps, evidence: await c.saveSessionEvidence(s) });
  } finally { await c.closeSession(s); }
}
