// TS-10, TS-12 + TS-17, TS-18
import * as c from './common.mjs';
import { recorder } from './shared.mjs';
import { compareRows, nonDecreasing } from './scenarios2.mjs';

const J = (v) => JSON.stringify(v);
async function pendingItem(page) {
  const its = await c.items(page);
  return [...its].reverse().find((i) => i.status === 'interim' || i.status === 'finalizing') || null;
}
async function disabledChecks(r, s, label) {
  const page = s.page;
  const dis = await c.exportButton(page).isDisabled();
  r.check(`${label}按钮不可用`, dis, `不可用=${dis}；条目=${J(await c.items(page))}`);
  const hv = await c.hintVisible(page);
  r.check(`${label}说明文字“${c.HINT}”可见`, hv, `可见=${hv}`);
  const nd = await c.forceClickNoDownload(s);
  r.check(`${label}强制点击后 5 秒内没有下载`, nd, `下载数=${s.downloads.length}`);
}

// ---------- TS-10 ----------
export async function groupS10(audio, report) {
  const s = await c.newSession('TS10', audio);
  try {
    const page = s.page;
    await c.start(page);
    await c.sayAndFinal(s, 's1');
    await c.sayAndFinal(s, 's2');
    await page.evaluate(() => { window.__qa.failAllFinal = true; });
    const t0 = Date.now();
    for (const id of ['s3', 's4', 's5']) {
      if ((await c.statusText(page)) === '出错') break;
      await c.say(s, id);
      await c.sleep(2500);
    }
    const err = await c.waitFor(async () => ((await c.statusText(page)) === '出错' ? true : null), Math.max(1000, c.ERROR_WAIT_MS - (Date.now() - t0)), 500);
    if (!err) throw new c.NotReached(`120 秒内未进入“出错”（状态=${await c.statusText(page)}）`);
    await c.sleep(1000);
    const before = await c.items(page);
    const pageList = await c.finals(page);
    const enabled = await c.exportButton(page).isEnabled();
    const f = await c.exportOnce(s);
    const r = recorder();
    r.check('1. “出错”状态下按钮可用', enabled, `状态=出错；可用=${enabled}`);
    const l = f.lines;
    r.check('2a. 开头为导出日期行与空行', /^导出日期：\d{4}-\d{2}-\d{2}$/.test(l[0] || '') && l[1] === '', `第 1、2 行=${J(l.slice(0, 2))}`);
    compareRows(r.check, '2b. 字幕行恰为页面中文定稿字幕（至少含前 2 条）', f, pageList);
    r.check('2c. 至少含前 2 条，每行“HH:MM:SS 文字”，时刻不倒序', pageList.length >= 2 && (f.rows || []).every((x) => x.ok) && nonDecreasing(f.rows || []), J((f.rows || []).map((x) => x.raw)));
    const notices = before.filter((i) => i.kind === 'notice').map((i) => i.text.trim()).filter(Boolean);
    const frags = c.sourceFragments(['s3', 's4', 's5'].map((id) => audio[id].text));
    const hits = [...notices.filter((t) => f.text.includes(t)), ...frags.filter((x) => f.text.includes(x))];
    r.check('2d. 不含失败句的提示或原文', hits.length === 0, `页面提示=${J(notices)}；命中=${J(hits.slice(0, 5))}`);
    const st = await c.statusText(page);
    const after = await c.items(page);
    r.check('3. 导出后状态仍为“出错”，页面字幕不变', st === '出错' && J(after) === J(before), `状态=${st}；字幕不变=${J(after) === J(before)}`);
    report({ id: 'TS-10', passed: r.passed(), checkpoints: r.cps, evidence: await c.saveSessionEvidence(s) });
  } finally { await c.closeSession(s); }
}

// ---------- TS-12 (a)(b) + TS-17 ----------
export async function groupS12(audio, report) {
  const r = recorder();
  let r17 = null;
  const evidence = [];
  // (a)
  const s = await c.newSession('TS12a', audio);
  try {
    const page = s.page;
    await c.addRule(page, audio.s1.key, 'delay', 15_000);
    await c.start(page);
    await c.say(s, 's1');
    await c.waitFinalRequest(s, 's1');
    const pend = await pendingItem(page);
    if (!pend) throw new c.NotReached('(a) 第 1 句没有出现临时或“正在定稿”字幕');
    if ((await c.finals(page)).length) throw new c.NotReached('(a) 检查前已有定稿字幕');
    await disabledChecks(r, s, '(a) 只有临时/正在定稿字幕时：');
    if ((await c.finals(page)).length) throw new c.NotReached('(a) 检查期间第 1 句已定稿，未能在“只有临时字幕”时完成检查');
    // TS-17
    try {
      const ok = await c.waitFor(async () => ((await c.finals(page)).length >= 1 && (await c.pendingCount(page)) === 0 ? true : null), c.SENTENCE_WAIT_MS, 300);
      if (!ok) throw new c.NotReached('第 1 句在等待上限内没有定稿');
      const rr = recorder();
      const en = await c.waitFor(async () => ((await c.exportButton(page).isEnabled()) ? true : null), 3000, 200);
      const hv = await c.hintVisible(page);
      rr.check('第 1 条定稿出现后按钮自动变为可用，说明文字不再显示', !!en && !hv, `可用=${!!en}；说明可见=${hv}`);
      const pageList = await c.finals(page);
      const f = await c.exportOnce(s);
      rr.check('点击即下载 1 个文件', f.extraDownloads === 0, `文件=${f.name}；额外下载=${f.extraDownloads}`);
      compareRows(rr.check, '字幕行恰为这 1 条', f, pageList);
      r17 = rr;
    } catch (e) { if (!(e instanceof c.NotReached)) throw e; c.log('TS-17 not reported:', e.message); }
    evidence.push(...(await c.saveSessionEvidence(s)));
  } finally { await c.closeSession(s); }
  if (r17) report({ id: 'TS-17', passed: r17.passed(), checkpoints: r17.cps, evidence: [...evidence] });
  // (b)
  const s2 = await c.newSession('TS12b', audio);
  try {
    const page = s2.page;
    await c.addRule(page, audio.s2.key, 'hangul');
    await c.start(page);
    await c.say(s2, 's2');
    const ok = await c.waitFor(async () => { const its = await c.items(page); return its.some((i) => i.kind === 'notice' && i.status === 'final') && (await c.pendingCount(page)) === 0 ? true : null; }, c.SENTENCE_WAIT_MS, 300);
    if (!ok) throw new c.NotReached('(b) 没有出现“（此句未能翻译成中文）”提示');
    await c.sleep(1000);
    if ((await c.finals(page)).length) throw new c.NotReached('(b) 页面出现了中文定稿字幕，不是“只有提示”');
    await disabledChecks(r, s2, '(b) 只有“（此句未能翻译成中文）”提示时：');
    evidence.push(...(await c.saveSessionEvidence(s2)));
  } finally { await c.closeSession(s2); }
  report({ id: 'TS-12', passed: r.passed(), checkpoints: r.cps, evidence });
}

// ---------- TS-18 ----------
export async function groupS18(audio, report) {
  const s = await c.newSession('TS18', audio);
  try {
    const page = s.page;
    await c.addRule(page, audio.s3.key, 'delay', 20_000);
    await c.start(page);
    await c.say(s, 's3');
    await c.waitFinalRequest(s, 's3');
    const it = await pendingItem(page);
    if (!it || it.status !== 'finalizing') throw new c.NotReached(`第 1 句未处于“正在定稿”（${J(it)}）`);
    await c.stop(page);
    await c.start(page);
    const ok = await c.waitFor(async () => ((await c.items(page)).find((i) => i.id === it.id)?.status === 'interrupted' ? true : null), 5000, 200);
    if (!ok) throw new c.NotReached('再点击“开始”后该条没有变为被中断字幕');
    if ((await c.finals(page)).length) throw new c.NotReached('检查前页面已出现中文定稿字幕');
    const r = recorder();
    await disabledChecks(r, s, '只有被中断字幕时：');
    report({ id: 'TS-18', passed: r.passed(), checkpoints: r.cps, evidence: await c.saveSessionEvidence(s) });
  } finally { await c.closeSession(s); }
}
