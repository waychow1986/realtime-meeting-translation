// TS-08, TS-09 + TS-16 (+TS-13(b)), TS-10, TS-12 + TS-17, TS-18, TS-13
import * as c from './common.mjs';
import { recorder, shared } from './shared.mjs';
import { compareRows, nonDecreasing, timeChecks } from './scenarios2.mjs';

const J = (v) => JSON.stringify(v);
const srcTexts = (s) => (s.spoken || []).map((id) => s.audio[id].text);

async function pendingItem(page) {
  const its = await c.items(page);
  return [...its].reverse().find((i) => i.status === 'interim' || i.status === 'finalizing') || null;
}
async function itemById(page, id) { return (await c.items(page)).find((i) => i.id === id) || null; }

// Produces the untranslated notice for sentence `id` (first final translation and retranslation return Hangul).
async function makeNotice(s, id) {
  const page = s.page;
  await c.addRule(page, s.audio[id].key, 'hangul');
  const n0 = (await c.items(page)).filter((i) => i.kind === 'notice').length;
  await c.say(s, id);
  const ok = await c.waitFor(async () => (await c.items(page)).filter((i) => i.kind === 'notice' && i.status === 'final').length > n0 && (await c.pendingCount(page)) === 0, c.SENTENCE_WAIT_MS, 500);
  if (!ok) throw new c.NotReached(`句子 ${id} 在等待上限内没有出现“（此句未能翻译成中文）”提示`);
  await c.sleep(1000);
}

// Produces an interrupted caption for sentence `id`: final translation delayed 20 s; stop then start while finalizing.
async function makeInterrupted(s, id) {
  const page = s.page;
  await c.addRule(page, s.audio[id].key, 'delay', 20_000);
  await c.say(s, id);
  await c.waitFinalRequest(s, id);
  const it = await pendingItem(page);
  if (!it || it.status !== 'finalizing') throw new c.NotReached(`句子 ${id} 未处于“正在定稿”（${J(it)}）`);
  await c.stop(page);
  await c.start(page);
  const ok = await c.waitFor(async () => ((await itemById(page, it.id))?.status === 'interrupted' ? true : null), 5000, 200);
  if (!ok) throw new c.NotReached(`再点击“开始”后该条没有变为被中断字幕（${J(await itemById(page, it.id))}）`);
  return itemById(page, it.id);
}

// ---------- TS-08 ----------
export async function groupS08(audio, report) {
  const s = await c.newSession('TS08', audio);
  try {
    const page = s.page;
    await c.start(page);
    await c.sayAndFinal(s, 's1');
    await makeNotice(s, 's2');
    await c.sayAndFinal(s, 's3');
    const intr = await makeInterrupted(s, 's4');
    await c.sayAndFinal(s, 's5');
    await c.addRule(page, audio.s6.key, 'delay', 20_000);
    await c.say(s, 's6');
    const pend = await c.waitFor(async () => pendingItem(page), c.SENTENCE_WAIT_MS, 300);
    if (!pend) throw new c.NotReached('句子 s6 没有出现临时或“正在定稿”字幕');
    const its = await c.items(page);
    const pageList = await c.finals(page);
    const status = await c.statusText(page);
    if (status !== '正在听') throw new c.NotReached(`导出前状态不是“正在听”（${status}）`);
    if (pageList.length !== 3) throw new c.NotReached(`页面定稿条数=${pageList.length}，造数不符合 A、B、C 三条`);
    const pendNow = await pendingItem(page);
    const f = await c.exportOnce(s);
    const pendAfter = await itemById(page, pendNow?.id);
    const r = recorder();
    compareRows(r.check, '1. 字幕行恰为 A、B、C', f, pageList);
    const text = f.text || '';
    const excluded = [
      ...its.filter((i) => i.kind === 'notice').map((i) => ['提示', i.text]),
      ['被中断字幕', intr.text],
      ['点击时的临时/正在定稿字幕', pendNow?.text || ''],
      ...c.sourceFragments(srcTexts(s)).map((x) => ['原文片段', x]),
    ].filter(([, t]) => t && t.trim());
    const hits = excluded.filter(([, t]) => text.includes(t.trim()));
    r.check('2. 文件中不出现提示、被中断字幕、临时/正在定稿字幕的文字与外语原文片段', !text.includes(c.NOTICE_UNTRANSLATED) && hits.length === 0, `命中=${J(hits.slice(0, 10))}；检查的提示=${J(its.filter((i) => i.kind === 'notice').map((i) => i.text))}；被中断=${J(intr.text)}；点击时未定稿=${J(pendNow)}（导出后：${J(pendAfter)}）；原文片段 ${excluded.filter(([k]) => k === '原文片段').length} 个`);
    const blank = f.lines.slice(2).filter((l) => l.trim() === '' || !/^\d{2}:\d{2}:\d{2} ./.test(l));
    r.check('3. 字幕行之间没有空行或占位行', blank.length === 0 && f.lines.length === 2 + pageList.length, `第 3 行起=${J(f.lines.slice(2))}`);
    report({ id: 'TS-08', passed: r.passed(), checkpoints: r.cps, evidence: await c.saveSessionEvidence(s, { itemsAtExport: its }) });
  } finally { await c.closeSession(s); }
}

// ---------- TS-09 + TS-16 + TS-13(b) ----------
export async function groupS09(audio, report) {
  const s = await c.newSession('TS09', audio);
  try {
    const page = s.page;
    await c.start(page);
    await c.sayAndFinal(s, 's7');
    await c.sayAndFinal(s, 's8');
    await c.addRule(page, audio.s9.key, 'delay', 10_000);
    await c.say(s, 's9');
    const pend = await c.waitFor(async () => pendingItem(page), c.SENTENCE_WAIT_MS, 300);
    if (!pend) throw new c.NotReached('第 3 句没有出现未定稿字幕');
    const before = (await c.items(page)).filter((i) => i.status === 'final');
    const pageList = await c.finals(page);
    if (pageList.length !== 2) throw new c.NotReached(`点击前页面定稿=${pageList.length} 条`);
    const enabled = await c.exportButton(page).isEnabled();
    const statusBefore = await c.statusText(page);
    const tClick = Date.now();
    const f = await c.exportOnce(s);
    const statusAfter = await c.statusText(page);
    const r = recorder();
    r.check('1. 点击前（状态“正在听”）按钮可用', enabled && statusBefore === '正在听', `可用=${enabled}；状态=${statusBefore}`);
    compareRows(r.check, '2. 字幕行恰为点击时的 2 条定稿字幕（不含第 3 句）', f, pageList);
    r.check('3. 导出后状态仍为“正在听”', statusAfter === '正在听', `导出后状态=${statusAfter}`);
    const nowItems = await c.items(page);
    const kept = before.every((b) => nowItems.some((n) => n.id === b.id && n.text === b.text && n.status === 'final'));
    r.check('4. 导出前已有的 2 条字幕仍在，文字不变', kept, `导出前=${J(before.map((x) => x.text))}；现在=${J(nowItems.filter((x) => x.status === 'final').map((x) => x.text))}`);
    report({ id: 'TS-09', passed: r.passed(), checkpoints: r.cps, evidence: await c.saveSessionEvidence(s) });
    shared.ts13b = { rows: (f.rows || []).map((x) => x.text), tClick, requests: s.requests };

    // TS-16
    try {
      const statuses = new Set();
      const watch = setInterval(async () => { try { statuses.add(await c.statusText(page)); } catch {} }, 300);
      let ok3, ok4;
      try {
        ok3 = await c.waitFor(async () => ((await itemById(page, pend.id))?.status === 'final' ? true : null), c.SENTENCE_WAIT_MS, 300);
        if (!ok3) throw new c.NotReached('第 3 句在等待上限内没有定稿');
        await c.sleep(1000);
        await c.sayAndFinal(s, 's10');
        ok4 = true;
      } finally { clearInterval(watch); }
      statuses.add(await c.statusText(page));
      const fin = await c.items(page);
      const r16 = recorder();
      const third = fin.find((i) => i.id === pend.id);
      r16.check('第 3、4 句都成为中文定稿字幕显示在页面上', third?.status === 'final' && third.kind !== 'notice' && (await c.finals(page)).length >= 4 && ok4, `定稿=${J(await c.finals(page))}`);
      r16.check('期间状态始终为“正在听”', statuses.size === 1 && statuses.has('正在听'), `观察到的状态=${J([...statuses])}`);
      report({ id: 'TS-16', passed: r16.passed(), checkpoints: r16.cps, evidence: await c.saveSessionEvidence(s) });
    } catch (e) { if (!(e instanceof c.NotReached)) throw e; c.log('TS-16 not reported:', e.message); }
  } finally { await c.closeSession(s); }
}

// ---------- TS-13: combines (a) from TS-03 and (b) from TS-09 ----------
export function reportTS13(report) {
  const { ts13a: a, ts13b: b } = shared;
  if (!a || !b) { c.log('TS-13 not reported: (a) or (b) missing'); return false; }
  const r = recorder();
  r.check('1. (a) “已停止”时从点击到下载完成，页面发出的网络请求数为 0', a.requestsDuring.length === 0, `请求数=${a.requestsDuring.length} ${J(a.requestsDuring.map((x) => x.method + ' ' + x.url))}`);
  const allowed = (u) => { try { const x = new URL(u); return (x.origin === new URL(c.BASE_URL).origin && (x.pathname === '/api/translations' || x.pathname === '/api/speech-token')) || /\.stt\.speech\.microsoft\.com$/.test(x.hostname) || /\.cognitiveservices\.azure\.com$/.test(x.hostname); } catch { return false; } };
  const near = b.requests.filter((x) => x.at >= b.tClick - 10_000 && x.at <= b.tClick + 15_000);
  const others = near.filter((x) => !allowed(x.url));
  r.check('2. (b) “正在听”时点击前后的请求只属于翻译请求、语音令牌请求与语音识别连接', others.length === 0, `点击前 10 秒至点击后 15 秒的请求 ${near.length} 个，地址=${J([...new Set(near.map((x) => x.method + ' ' + x.url.split('?')[0]))])}；其他=${J(others.map((x) => x.url))}`);
  const rows = [...a.rows, ...b.rows].filter(Boolean);
  const origin = new URL(c.BASE_URL).origin;
  const toApp = [...a.requests, ...b.requests].filter((x) => x.url.startsWith(origin));
  const leak = [];
  for (const q of toApp) for (const t of rows) { let u = q.url; try { u = decodeURIComponent(q.url); } catch {} if (u.includes(t) || (q.body && (q.body.includes(t) || q.body.includes(JSON.stringify(t).slice(1, -1))))) leak.push({ url: q.url.split('?')[0], 行: t }); }
  r.check('3. 发往本应用服务器的请求地址与请求体都不含导出文件任何一行的完整中文文字', leak.length === 0, `检查请求 ${toApp.length} 个、字幕行 ${rows.length} 行；命中=${J(leak.slice(0, 5))}`);
  report({ id: 'TS-13', passed: r.passed(), checkpoints: r.cps, evidence: ['TS03-network.json', 'TS03-ws-text-frames.json', 'TS09-network.json', 'TS09-ws-text-frames.json'] });
  return true;
}
