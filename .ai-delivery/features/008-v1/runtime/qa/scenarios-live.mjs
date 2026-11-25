// Scenarios that need a running translation (status “正在听”): TS-02, TS-04, TS-06..TS-08, TS-10..TS-13, TS-15.
import {
  Scenario, Recorder, Skip, newContext, openPage, reopen, chooseSpacing, chooseSize, checkedIn, closeDisplay,
  panelAttr, panelBg, statusText, startTranslation, stopTranslation, measure, finals, intra, gapBetween, finalPairs,
  waitFor, waitForCaptions, screenshot, writeJson, sleep, log, fmt, notes,
  BG_EXPECTED, SPACING_LABEL, SIZE_LABEL, STANDARD_PX, STRICT, SAME, CAPTION_WAIT_MS, APPLY_WAIT_MS,
} from './lib.mjs';
import { STORAGE_DENIED } from './scenarios-static.mjs';

const NARROW = { width: 480, height: 800 };
const LISTENING = '正在听';
const TIERS = ['compact', 'normal', 'loose'];
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const near = (a, b) => a != null && b != null && Math.abs(a - b) <= SAME;
const gt = (a, b) => a != null && b != null && a > b + STRICT;
const lt = (a, b) => a != null && b != null && a < b - STRICT;

function skip(s, reason) { s.skipped = true; notes.push(`${s.id}：${reason}`); log(`${s.id} NOT REPORTED: ${reason}`); }
function reported(...list) { return list.filter((s) => s && !s.skipped && s.checkpoints.length); }
async function failEvidence(list, page, rec, tag, data) {
  const failed = list.filter((s) => s && !s.skipped && !s.passed);
  if (!failed.length) return;
  const shot = page ? await screenshot(page, `${tag}-screen`) : null;
  const json = data ? writeJson(`${tag}-measurements`, data) : null;
  const net = rec.flush();
  for (const s of failed) { s.ev(shot); s.ev(json); s.ev(net); }
}
function onError(s, e) {
  if (e instanceof Skip) { skip(s, e.message); return; }
  s.check('操作', false, `场景操作无法完成：${e.message.split('\n')[0]}`);
}

// Picks an adjacent final pair and a multi-line final caption from a measurement.
function pick(m, { preferPair } = {}) {
  const pairs = finalPairs(m);
  const pair = (preferPair && pairs.find((p) => same(p, preferPair))) || pairs[0] || null;
  const multi = finals(m).find((i) => i.lines >= 2) || null;
  return { pair, multiId: multi?.id ?? null };
}
function sample(m, pair, multiId) {
  const item = m.items.find((i) => i.id === multiId);
  return { intra: intra(item), gap: pair ? gapBetween(m, pair[0], pair[1]) : null };
}
async function finalsSnapshot(page) {
  const m = await measure(page);
  return new Map(finals(m).map((i) => [i.id, i.text]));
}
// Waits for two new adjacent final captions (ids not in oldIds).
async function waitNewPair(page, oldIds, where = 'main') {
  return waitFor(async () => {
    const m = await measure(page, where);
    if (!m) return null;
    const p = finalPairs(m).find(([a, b]) => !oldIds.has(a) && !oldIds.has(b));
    return p ? { m, pair: p } : null;
  }, CAPTION_WAIT_MS, 1500);
}

// ---------- TS-04 then TS-02 (one translation, measured after stopping) ----------
export async function groupLayout() {
  const s4 = new Scenario('TS-04'), s2 = new Scenario('TS-02');
  const rec = new Recorder('TS-02-04');
  const ctx = await newContext({ viewport: NARROW });
  const data = {};
  let page;
  try {
    page = await openPage(ctx, rec);
    await startTranslation(page);
    let m = await waitForCaptions(page, { minFinals: 2, multiLine: true });
    // Give the short sentences of the speech a chance to appear as well (single-line neighbours), within the same wait limit.
    await waitFor(async () => finals(await measure(page)).length >= 5, 60_000, 2000);
    m = await measure(page);
    const ids = finals(m).map((i) => i.id);
    await stopTranslation(page);
    await sleep(2500);
    const after = await measure(page);
    let stopped = true;
    if (!ids.every((id) => finals(after).some((i) => i.id === id))) {
      // Captions were cleared by stopping: measure while listening instead (as allowed by the plan).
      log('captions not kept after stop; measuring while listening');
      stopped = false;
      await startTranslation(page);
      await waitForCaptions(page, { minFinals: 2, multiLine: true });
    }
    data.stopped = stopped;

    // TS-04: spacing control untouched; standard per caption size equals the pre-delivery values.
    try {
      const obs = []; let ok = true; let bgOk = true; const bgObs = [];
      for (const size of ['s', 'm', 'l', 'xl']) {
        await chooseSize(page, size); await sleep(400);
        const mm = await measure(page); data[`ts04-${size}`] = mm;
        const bg = await panelBg(page); bgOk &&= bg === BG_EXPECTED; bgObs.push(`${SIZE_LABEL[size]}:${bg}`);
        const [eIntra, eGap] = STANDARD_PX[size];
        const multi = finals(mm).filter((i) => i.lines >= 2);
        const intras = multi.map((i) => intra(i));
        const gaps = finalPairs(mm).map(([a, b]) => gapBetween(mm, a, b));
        const iOk = intras.every((v) => near(v, eIntra));
        const gOk = gaps.length > 0 && gaps.every((v) => near(v, eGap));
        ok &&= iOk && gOk;
        obs.push(`${SIZE_LABEL[size]}：字幕内行距 ${intras.length ? intras.map(fmt).join('/') : '无换行字幕（只检查字幕间距）'}（应为 ${eIntra}）；字幕间距 ${gaps.map(fmt).join('/')}（应为 ${eGap}）`);
      }
      s4.check('1 首次打开（未动行距）各字号下字幕内行距/字幕间距与交付前相同（±1 px）', ok, obs.join('；'));
      const spNow = await checkedIn(page, '行距');
      await chooseSize(page, 'm');
      await chooseSpacing(page, 'loose'); await sleep(400);
      await chooseSpacing(page, 'normal'); await sleep(400);
      const mm = await measure(page); data['ts04-m-back'] = mm;
      const ref = data['ts04-m'];
      const p = pick(ref);
      const a = sample(ref, p.pair, p.multiId), b = sample(mm, p.pair, p.multiId);
      s4.check('2 选宽松再选回标准，中号测量值回到检查点 1 的值（±1 px）',
        near(a.gap, b.gap) && (a.intra == null || near(a.intra, b.intra)),
        `测量前行距选中=${JSON.stringify(spNow)}；检查点1 中号 字幕内行距 ${fmt(a.intra)} 字幕间距 ${fmt(a.gap)}；选回标准后 ${fmt(b.intra)} / ${fmt(b.gap)}`);
      const bg = await panelBg(page); bgOk &&= bg === BG_EXPECTED;
      s4.check('3 测量期间字幕区背景始终为 rgb(13, 17, 23)', bgOk, `${bgObs.join('；')}；选回标准后:${bg}`);
    } catch (e) { onError(s4, e); }

    // TS-02: every caption size × three spacing tiers on the same set of captions.
    try {
      const c1 = [], c2 = [], c3 = [], c4 = [], c5 = [];
      let ok1 = true, ok2 = true, ok3 = true, ok4 = true, ok5 = true, singlePairSeen = false;
      for (const size of ['s', 'm', 'l', 'xl']) {
        await chooseSize(page, size);
        const per = {};
        for (const t of TIERS) {
          await chooseSpacing(page, t); await sleep(400);
          per[t] = { m: await measure(page), bg: await panelBg(page), size: await checkedIn(page, '字号') };
        }
        data[`ts02-${size}`] = per;
        const base = per.normal.m;
        // 1 line spacing inside a multi-line caption
        const multi = finals(base).filter((i) => i.lines >= 2);
        if (multi.length) {
          const vals = TIERS.map((t) => intra(per[t].m.items.find((i) => i.id === multi[0].id)));
          const good = lt(vals[0], vals[1]) && lt(vals[1], vals[2]);
          ok1 &&= good; c1.push(`${SIZE_LABEL[size]}：${vals.map(fmt).join(' < ')}`);
        } else c1.push(`${SIZE_LABEL[size]}：无换行字幕，只检查字幕间距`);
        // 2 spacing between adjacent captions (every adjacent final pair)
        for (const [a, b] of finalPairs(base)) {
          const vals = TIERS.map((t) => gapBetween(per[t].m, a, b));
          const good = lt(vals[0], vals[1]) && lt(vals[1], vals[2]);
          const ia = base.items.find((i) => i.id === a), ib = base.items.find((i) => i.id === b);
          const single = ia.lines === 1 && ib.lines === 1;
          singlePairSeen ||= single;
          ok2 &&= good;
          if (!good || single) c2.push(`${SIZE_LABEL[size]} #${a}-#${b}${single ? '（两条单行）' : ''}：${vals.map(fmt).join(' < ')}`);
        }
        // 3 every caption entry's line height follows the tier
        const n = base.items.length;
        const sameList = TIERS.every((t) => per[t].m.items.length === n);
        for (let k = 0; k < n; k++) {
          const vals = TIERS.map((t) => per[t].m.items[k]?.lineHeight);
          if (!(lt(vals[0], vals[1]) && lt(vals[1], vals[2]))) { ok3 = false; c3.push(`${SIZE_LABEL[size]} 条目${k}(${base.items[k].status})：${vals.map(fmt).join('/')}`); }
        }
        ok3 &&= sameList;
        // 4 font size and size choice unchanged
        for (let k = 0; k < n; k++) {
          const fs = TIERS.map((t) => per[t].m.items[k]?.fontSize);
          if (!(fs[0] === fs[1] && fs[1] === fs[2])) { ok4 = false; c4.push(`${SIZE_LABEL[size]} 条目${k} 字号 ${fs.join('/')}`); }
        }
        const sizes = TIERS.map((t) => per[t].size[0]);
        if (!sizes.every((x) => x === SIZE_LABEL[size])) { ok4 = false; c4.push(`${SIZE_LABEL[size]}：字号选中 ${sizes.join('/')}`); }
        // 5 colour, font family and background unchanged
        for (let k = 0; k < n; k++) {
          const cs = TIERS.map((t) => `${per[t].m.items[k]?.color}|${per[t].m.items[k]?.fontFamily}`);
          if (!(cs[0] === cs[1] && cs[1] === cs[2])) { ok5 = false; c5.push(`${SIZE_LABEL[size]} 条目${k}：${cs.join(' / ')}`); }
        }
        const bgs = TIERS.map((t) => per[t].bg);
        if (!bgs.every((b) => b === bgs[0])) { ok5 = false; c5.push(`${SIZE_LABEL[size]} 背景 ${bgs.join('/')}`); }
      }
      const pairCount = finalPairs(data['ts02-m'].normal.m).length;
      s2.check('1 各字号下字幕内行距 紧凑<标准<宽松', ok1, c1.join('；'));
      s2.check('2 各字号下相邻字幕的字幕间距 紧凑<标准<宽松（含两条单行的相邻字幕）', ok2 && pairCount > 0,
        `相邻已确定字幕对 ${pairCount} 组${singlePairSeen ? '' : '（本次没有两条都只有一行的相邻字幕）'}；${c2.length ? c2.join('；') : '全部满足'}`);
      s2.check('3 字幕区每一条字幕条目的行高随档位 紧凑<标准<宽松', ok3, c3.length ? c3.slice(0, 20).join('；') : `全部条目满足（每字号 ${data['ts02-m'].normal.m.items.length} 条）`);
      s2.check('4 切换三档时字幕字号与字号选中值不变', ok4, c4.length ? c4.join('；') : '不变');
      s2.check('5 切换三档时字幕颜色、字体与字幕区背景不变', ok5, c5.length ? c5.join('；') : '不变');
      if (!stopped) s2.check('附 测量方式', true, '停止后字幕区被清空，按测试计划在“正在听”状态下测量');
    } catch (e) { onError(s2, e); }
  } catch (e) {
    if (e instanceof Skip) { skip(s4, e.message); skip(s2, e.message); }
    else { onError(s4, e); onError(s2, e); }
  } finally {
    await failEvidence([s4, s2], page, rec, 'TS-02-04', data);
    await ctx.close();
  }
  return reported(s4, s2);
}

// ---------- TS-07, TS-06, TS-08 (one translation, while listening) ----------
export async function groupLive() {
  const s7 = new Scenario('TS-07'), s6 = new Scenario('TS-06'), s8 = new Scenario('TS-08');
  const rec = new Recorder('TS-06-08');
  const ctx = await newContext({ viewport: NARROW });
  const data = {};
  let page;
  try {
    page = await openPage(ctx, rec);
    await page.evaluate(() => { window.__qaMarker = 'qa-marker'; });
    await startTranslation(page);
    const m0 = await waitForCaptions(page, { minFinals: 2, multiLine: true });
    const { pair, multiId } = pick(m0);
    const marker = () => page.evaluate(() => window.__qaMarker === 'qa-marker');
    let std;
    // TS-07: captions already shown follow the new tier.
    try {
      std = sample(await measure(page), pair, multiId); data.std = std;
      await chooseSpacing(page, 'loose');
      const lo = await waitFor(async () => { const v = sample(await measure(page), pair, multiId); return gt(v.intra, std.intra) && gt(v.gap, std.gap) ? v : null; }, APPLY_WAIT_MS, 250);
      if (!lo) throw new Skip('选“宽松”后 10 秒（测试等待上限）内已显示字幕未按新档位显示');
      s7.check('1 选宽松后同一组已显示字幕的字幕内行距与字幕间距都严格大于标准', true,
        `字幕 #${multiId} 字幕内行距 ${fmt(std.intra)}→${fmt(lo.intra)}；#${pair.join('-#')} 字幕间距 ${fmt(std.gap)}→${fmt(lo.gap)}`);
      await chooseSpacing(page, 'compact');
      const co = await waitFor(async () => { const v = sample(await measure(page), pair, multiId); return lt(v.intra, std.intra) && lt(v.gap, std.gap) ? v : null; }, APPLY_WAIT_MS, 250);
      if (!co) throw new Skip('选“紧凑”后 10 秒（测试等待上限）内已显示字幕未按新档位显示');
      s7.check('2 选紧凑后同一组已显示字幕的字幕内行距与字幕间距都严格小于标准', true,
        `字幕内行距 ${fmt(std.intra)}→${fmt(co.intra)}；字幕间距 ${fmt(std.gap)}→${fmt(co.gap)}`);
      const st = await statusText(page), mk = await marker();
      s7.check('3 变化时没有刷新页面、没有停止或重新开始翻译', mk && st === LISTENING, `页面标记仍在=${mk}；状态=${st}`);
    } catch (e) { onError(s7, e); }

    // TS-06: no reload, still listening, captions kept, last choice wins.
    try {
      const obs = []; let ok1 = true, ok2 = true, ok3 = true;
      const verify = async (label, before) => {
        const mk = await marker(); const st = await statusText(page); const now = await finalsSnapshot(page);
        const kept = now.size >= before.size && [...before].every(([id, t]) => now.get(id) === t);
        ok1 &&= mk; ok2 &&= st === LISTENING; ok3 &&= kept;
        obs.push(`${label}：标记=${mk} 状态=${st} 已确定字幕 ${before.size}→${now.size}${kept ? '' : '（有字幕减少或文字改变）'}`);
      };
      for (const t of ['loose', 'compact', 'normal']) {
        const before = await finalsSnapshot(page);
        await chooseSpacing(page, t); await sleep(150);
        await verify(`选${SPACING_LABEL[t]}`, before);
      }
      const before = await finalsSnapshot(page);
      const g = page.getByRole('group', { name: '行距' });
      for (const t of ['loose', 'compact', 'loose']) await g.getByRole('radio', { name: SPACING_LABEL[t], exact: true }).click();
      await sleep(150);
      await verify('快速连续选宽松、紧凑、宽松', before);
      s6.check('1 每次选择后页面没有重新载入（测试标记仍在）', ok1, obs.join('；'));
      s6.check('2 每次选择后状态仍为“正在听”', ok2, obs.join('；'));
      s6.check('3 已确定字幕条数不减少、已有字幕文字不变', ok3, obs.join('；'));
      const sp = await checkedIn(page, '行距'); const attr = await panelAttr(page);
      s6.check('4 快速连续选择后为最后一次的“宽松”', same(sp, ['宽松']) && attr === 'loose', `行距选中=${JSON.stringify(sp)}；data-caption-spacing=${attr}`);
    } catch (e) { onError(s6, e); }

    // TS-08: captions that appear after switching use the new tier; translation continues.
    try {
      if (!std) throw new Skip('没有取得“标准”档的参照测量');
      await chooseSpacing(page, 'loose'); await sleep(400);
      const refM = await measure(page);
      const looseRef = sample(refM, pair, multiId); data.looseRef = looseRef;
      const statuses = new Set();
      const watch = setInterval(() => { statusText(page).then((s) => statuses.add(s)).catch(() => {}); }, 2000);
      let got;
      try { got = await waitNewPair(page, new Set(finals(refM).map((i) => i.id))); } finally { clearInterval(watch); }
      if (!got) throw new Skip('切换到“宽松”后 3 分钟（测试等待上限）内没有新出现两条已确定字幕');
      statuses.add(await statusText(page));
      const nv = sample(got.m, got.pair, finals(got.m).find((i) => got.pair.includes(i.id) && i.lines >= 2)?.id);
      data.newLoose = { pair: got.pair, nv };
      s8.check('1 切换后有新的已确定字幕出现，状态始终为“正在听”', statuses.size === 1 && statuses.has(LISTENING),
        `新字幕 #${got.pair.join('、#')}；期间状态=${JSON.stringify([...statuses])}`);
      const intraOk = nv.intra == null || (near(nv.intra, looseRef.intra) && gt(nv.intra, std.intra));
      s8.check('2 宽松后新字幕的字幕间距（及字幕内行距）与宽松档已有字幕相同，并严格大于标准',
        near(nv.gap, looseRef.gap) && gt(nv.gap, std.gap) && intraOk,
        `新字幕间距 ${fmt(nv.gap)}（宽松已有 ${fmt(looseRef.gap)}，标准 ${fmt(std.gap)}）；新字幕内行距 ${nv.intra == null ? '新字幕未换行' : fmt(nv.intra)}（宽松已有 ${fmt(looseRef.intra)}，标准 ${fmt(std.intra)}）`);
      await chooseSpacing(page, 'compact'); await sleep(400);
      const m2 = await measure(page);
      const got2 = await waitNewPair(page, new Set(finals(m2).map((i) => i.id)));
      if (!got2) throw new Skip('切换到“紧凑”后 3 分钟（测试等待上限）内没有新出现两条已确定字幕');
      const cv = sample(got2.m, got2.pair, null);
      data.newCompact = { pair: got2.pair, cv };
      s8.check('3 紧凑后新字幕的字幕间距严格小于标准', lt(cv.gap, std.gap), `新字幕 #${got2.pair.join('-#')} 间距 ${fmt(cv.gap)}（标准 ${fmt(std.gap)}）；状态=${await statusText(page)}`);
    } catch (e) { onError(s8, e); }
    await stopTranslation(page).catch(() => {});
  } catch (e) {
    for (const s of [s7, s6, s8]) if (!s.checkpoints.length && !s.skipped) (e instanceof Skip ? skip(s, e.message) : onError(s, e));
  } finally {
    await failEvidence([s7, s6, s8], page, rec, 'TS-06-08', data);
    await ctx.close();
  }
  return reported(s7, s6, s8);
}

// ---------- TS-10 restore shows the saved tier; no caption text in local storage ----------
export async function ts10() {
  const s = new Scenario('TS-10');
  const rec = new Recorder('TS-10');
  const ctx = await newContext({ viewport: NARROW });
  const data = {};
  let page;
  try {
    page = await openPage(ctx, rec, 'first');
    await chooseSpacing(page, 'loose');
    page = await reopen(ctx, page, rec, 'reopened');
    await closeDisplay(page);
    await startTranslation(page);
    const m0 = await waitForCaptions(page, { minFinals: 2, multiLine: true });
    const { pair, multiId } = pick(m0);
    const R = sample(m0, pair, multiId);
    const restored = await checkedIn(page, '行距');
    await chooseSpacing(page, 'normal'); await sleep(500);
    const std = sample(await measure(page), pair, multiId);
    await chooseSpacing(page, 'loose'); await sleep(500);
    const back = sample(await measure(page), pair, multiId);
    data.R = R; data.std = std; data.back = back;
    s.check('1 恢复后（未触碰行距）测量值 R 严格大于标准，选回宽松后与 R 相同（±1 px）',
      gt(R.intra, std.intra) && gt(R.gap, std.gap) && near(back.intra, R.intra) && near(back.gap, R.gap),
      `恢复后行距选中=${JSON.stringify(restored)}；字幕 #${multiId} 字幕内行距 R=${fmt(R.intra)} 标准=${fmt(std.intra)} 选回宽松=${fmt(back.intra)}；#${pair.join('-#')} 字幕间距 R=${fmt(R.gap)} 标准=${fmt(std.gap)} 选回宽松=${fmt(back.gap)}`);
    const texts = finals(await measure(page)).map((i) => i.text.trim());
    await stopTranslation(page);
    await sleep(1500);
    const store = await page.evaluate(() => { const o = {}; for (let k = 0; k < localStorage.length; k++) { const key = localStorage.key(k); o[key] = localStorage.getItem(key); } return o; });
    // Fragments of 4 characters (after removing spaces) of every final caption.
    const frags = new Set();
    for (const t of texts) { const c = t.replace(/\s+/g, ''); for (let k = 0; k + 4 <= c.length; k++) frags.add(c.slice(k, k + 4)); }
    const hits = [];
    for (const [k, v] of Object.entries(store)) { const c = String(v).replace(/\s+/g, ''); for (const f of frags) if (c.includes(f)) { hits.push(`${k} 含片段“${f}”`); break; } }
    const spacingVal = store['rtmt.captionSpacing'];
    const valOk = ['compact', 'normal', 'loose'].includes(spacingVal);
    s.check('2 本地保存内容不含任何字幕文字片段（4 字），行距保存值为三档之一',
      hits.length === 0 && valOk && texts.length > 0,
      `本地保存的键=${JSON.stringify(Object.keys(store))}；rtmt.captionSpacing=${JSON.stringify(spacingVal)}；比对字幕 ${texts.length} 条、片段 ${frags.size} 个；命中=${hits.length ? hits.join('；') : '无'}`);
  } catch (e) { onError(s, e); }
  finally {
    await failEvidence([s], page, rec, 'TS-10', data);
    await ctx.close();
  }
  return reported(s);
}

// ---------- PiP helpers ----------
async function openPip(page) {
  await closeDisplay(page);
  await page.getByRole('button', { name: '弹出字幕小窗' }).click();
  const ok = await waitFor(() => page.evaluate(() => !!window.documentPictureInPicture?.window?.document?.getElementById('pip-captions')), 10_000, 250);
  if (!ok) throw new Error('点击“弹出字幕小窗”后没有出现字幕小窗');
  await page.evaluate(() => { window.documentPictureInPicture.window.__qaPip = 'qa-pip'; });
}
async function closePip(page) {
  await page.evaluate(() => window.documentPictureInPicture?.window?.close());
  await waitFor(() => page.evaluate(() => !window.documentPictureInPicture?.window), 5000, 200);
}
const pipAttr = (page) => page.evaluate(() => window.documentPictureInPicture?.window?.document.body.dataset.captionSpacing ?? null);
const pipSame = (page) => page.evaluate(() => window.documentPictureInPicture?.window?.__qaPip === 'qa-pip');
// Gap of the first adjacent final pair in the caption window, and of the main-page pair with the same texts.
function pipVsMain(pm, mm, pipPair) {
  const pairs = finalPairs(pm);
  const p = (pipPair && pairs.find((x) => same(x, pipPair))) || pairs[pairs.length - 1];
  if (!p) return { pair: null, pip: null, main: null };
  const ta = pm.items.find((i) => i.id === p[0]), tb = pm.items.find((i) => i.id === p[1]);
  const ma = mm.items.findIndex((i) => i.text.trim() === ta.text.trim());
  const mb = mm.items[ma + 1];
  const main = ma >= 0 && mb && mb.text.trim() === tb.text.trim() ? gapBetween(mm, mm.items[ma].id, mb.id) : null;
  return { pair: p, pip: gapBetween(pm, p[0], p[1]), main, pipFont: ta.fontSize, mainFont: mm.items[ma]?.fontSize };
}

// ---------- TS-11, TS-12, TS-13 (one translation with the caption window) ----------
export async function groupPip() {
  const s11 = new Scenario('TS-11'), s12 = new Scenario('TS-12'), s13 = new Scenario('TS-13');
  const rec = new Recorder('TS-11-13');
  const ctx = await newContext({ viewport: NARROW });
  const data = {};
  let page;
  try {
    page = await openPage(ctx, rec);
    await chooseSpacing(page, 'compact');
    await closeDisplay(page);
    await startTranslation(page);
    await waitForCaptions(page, { minFinals: 2 });
    let stdGap = null;
    // TS-11
    try {
      await openPip(page);
      await waitForCaptions(page, { minFinals: 2, where: 'pip', timeoutMs: 30_000 });
      const pm = await measure(page, 'pip'), mm = await measure(page);
      const v = pipVsMain(pm, mm); data.ts11c = v;
      const attr = await pipAttr(page);
      await chooseSpacing(page, 'normal'); await sleep(500);
      const mStd = await measure(page);
      stdGap = finalPairs(mStd).map(([a, b]) => gapBetween(mStd, a, b))[0];
      await chooseSpacing(page, 'compact'); await sleep(500);
      s11.check('1 打开小窗：小窗标记 compact，小窗字幕间距与主页面相同（±1 px）且严格小于主页面标准值',
        attr === 'compact' && near(v.pip, v.main) && lt(v.pip, stdGap),
        `小窗 data-caption-spacing=${attr}；小窗字幕间距 ${fmt(v.pip)}（字号 ${v.pipFont}px），主页面同两条 ${fmt(v.main)}（字号 ${v.mainFont}px），主页面标准 ${fmt(stdGap)}`);
      const pipCtl = await page.evaluate(() => {
        const d = window.documentPictureInPicture.window.document;
        const radios = d.querySelectorAll('input[type=radio], [role=radio]').length;
        const txt = d.body.innerText;
        const labels = [...d.querySelectorAll('label, button, [role=radio], [role=group]')].map((e) => (e.textContent || e.getAttribute('aria-label') || '').trim()).filter((t) => ['紧凑', '标准', '宽松', '行距'].includes(t));
        return { radios, labels, hasGroup: !!d.querySelector('[aria-label="行距"]'), text: txt.length };
      });
      s11.check('2 小窗中没有行距设置（无紧凑/标准/宽松可选项、无单选按钮）', pipCtl.radios === 0 && pipCtl.labels.length === 0 && !pipCtl.hasGroup,
        `小窗单选按钮 ${pipCtl.radios} 个；行距相关控件=${JSON.stringify(pipCtl.labels)}；行距分组=${pipCtl.hasGroup}`);
      await closePip(page);
      await chooseSpacing(page, 'loose'); await sleep(300);
      await openPip(page);
      await waitForCaptions(page, { minFinals: 2, where: 'pip', timeoutMs: 30_000 });
      const v2 = pipVsMain(await measure(page, 'pip'), await measure(page)); data.ts11l = v2;
      const attr2 = await pipAttr(page);
      s11.check('3 关闭小窗、主页面选宽松、再打开：小窗标记 loose，字幕间距与主页面相同（±1 px）',
        attr2 === 'loose' && near(v2.pip, v2.main), `小窗 data-caption-spacing=${attr2}；小窗字幕间距 ${fmt(v2.pip)}，主页面 ${fmt(v2.main)}`);
    } catch (e) { onError(s11, e); }

    // TS-12: start from 标准 with the window open.
    let pipLooseRef = null, pipStd = null;
    try {
      if (!(await pipSame(page).catch(() => false))) await openPip(page);
      await chooseSpacing(page, 'normal'); await sleep(600);
      const pm0 = await measure(page, 'pip');
      const p0 = finalPairs(pm0); if (!p0.length) throw new Skip('小窗中没有两条相邻的已确定字幕');
      const pair = p0[p0.length - 1];
      pipStd = gapBetween(pm0, pair[0], pair[1]); data.pipStd = pipStd;
      await chooseSpacing(page, 'loose');
      const lo = await waitFor(async () => { const g = gapBetween(await measure(page, 'pip'), pair[0], pair[1]); return gt(g, pipStd) ? g : null; }, APPLY_WAIT_MS, 250);
      if (!lo) throw new Skip('选“宽松”后 10 秒（测试等待上限）内小窗未按新档位显示');
      await sleep(300);
      const v = pipVsMain(await measure(page, 'pip'), await measure(page), pair);
      const a1 = await pipAttr(page);
      pipLooseRef = v.pip;
      s12.check('1 选宽松后小窗同一组字幕间距严格大于切换前，小窗标记 loose，与主页面相同（±1 px）',
        gt(v.pip, pipStd) && a1 === 'loose' && near(v.pip, v.main), `小窗 #${pair.join('-#')} 字幕间距 ${fmt(pipStd)}→${fmt(v.pip)}；主页面 ${fmt(v.main)}；小窗标记=${a1}`);
      await chooseSpacing(page, 'compact');
      const co = await waitFor(async () => { const g = gapBetween(await measure(page, 'pip'), pair[0], pair[1]); return lt(g, pipStd) ? g : null; }, APPLY_WAIT_MS, 250);
      if (!co) throw new Skip('选“紧凑”后 10 秒（测试等待上限）内小窗未按新档位显示');
      const a2 = await pipAttr(page);
      s12.check('2 选紧凑后小窗同一组字幕间距严格小于标准，小窗标记 compact', a2 === 'compact', `小窗字幕间距 ${fmt(co)}（标准 ${fmt(pipStd)}）；小窗标记=${a2}`);
      const sameWin = await pipSame(page);
      s12.check('3 整个过程小窗没有被关闭或重新打开', sameWin, `小窗中测试标记仍在=${sameWin}`);
    } catch (e) { onError(s12, e); }

    // TS-13: new captions in the window after switching to 宽松.
    try {
      if (pipStd == null) throw new Skip('没有取得小窗“标准”档的参照测量');
      await chooseSpacing(page, 'loose'); await sleep(500);
      const pm = await measure(page, 'pip');
      const ref = finalPairs(pm).map(([a, b]) => gapBetween(pm, a, b));
      const looseRef = ref[ref.length - 1]; data.pipLooseRef = looseRef;
      const got = await waitNewPair(page, new Set(finals(pm).map((i) => i.id)), 'pip');
      if (!got) throw new Skip('切换到“宽松”后 3 分钟（测试等待上限）内小窗没有新出现两条已确定字幕');
      const g = gapBetween(got.m, got.pair[0], got.pair[1]);
      data.pipNew = { pair: got.pair, g };
      s13.check('1 小窗新出现的相邻字幕间距与小窗宽松已有字幕相同（±1 px）且严格大于标准',
        near(g, looseRef) && gt(g, pipStd), `已确定字幕条数（切换时）${finals(pm).length}；新字幕 #${got.pair.join('-#')} 间距 ${fmt(g)}；宽松已有 ${fmt(looseRef)}；标准 ${fmt(pipStd)}`);
    } catch (e) { onError(s13, e); }
    await closePip(page).catch(() => {});
    await stopTranslation(page).catch(() => {});
  } catch (e) {
    for (const s of [s11, s12, s13]) if (!s.checkpoints.length && !s.skipped) (e instanceof Skip ? skip(s, e.message) : onError(s, e));
  } finally {
    await failEvidence([s11, s12, s13], page, rec, 'TS-11-13', data);
    await ctx.close();
  }
  return reported(s11, s12, s13);
}

// ---------- TS-15 storage read denied: translation works and switching applies at once ----------
export async function ts15() {
  const s = new Scenario('TS-15');
  const rec = new Recorder('TS-15');
  const ctx = await newContext({ viewport: NARROW, initScript: STORAGE_DENIED });
  const data = {};
  let page;
  try {
    page = await openPage(ctx, rec);
    await closeDisplay(page);
    await startTranslation(page);
    const m0 = await waitForCaptions(page, { minFinals: 2 });
    const st0 = await statusText(page);
    s.check('1 翻译能开始，状态为“正在听”，有已确定字幕出现', st0 === LISTENING && finals(m0).length >= 2, `状态=${st0}；已确定字幕 ${finals(m0).length} 条`);
    const pair = finalPairs(m0)[0];
    const std = gapBetween(await measure(page), pair[0], pair[1]);
    const n0 = finals(await measure(page)).length;
    await chooseSpacing(page, 'loose');
    const lo = await waitFor(async () => { const g = gapBetween(await measure(page), pair[0], pair[1]); return gt(g, std) ? g : null; }, APPLY_WAIT_MS, 250);
    if (!lo) throw new Skip('选“宽松”后 10 秒（测试等待上限）内未按新档位显示');
    const st1 = await statusText(page), n1 = finals(await measure(page)).length;
    s.check('2 选宽松后同一组字幕间距严格大于标准，状态仍为“正在听”，已确定字幕条数不减少',
      st1 === LISTENING && n1 >= n0, `#${pair.join('-#')} 字幕间距 ${fmt(std)}→${fmt(lo)}；状态=${st1}；已确定字幕 ${n0}→${n1}`);
    await openPip(page);
    await waitForCaptions(page, { minFinals: 2, where: 'pip', timeoutMs: 30_000 });
    const v = pipVsMain(await measure(page, 'pip'), await measure(page)); data.pip = v;
    const attr = await pipAttr(page);
    s.check('3 打开小窗：小窗标记 loose，字幕间距与主页面相同（±1 px）', attr === 'loose' && near(v.pip, v.main),
      `小窗标记=${attr}；小窗字幕间距 ${fmt(v.pip)}，主页面 ${fmt(v.main)}`);
    await closePip(page).catch(() => {});
    await stopTranslation(page).catch(() => {});
    s.check('4 整个过程没有未捕获的页面脚本错误', rec.pageErrors.length === 0, `页面脚本错误=${JSON.stringify(rec.pageErrors)}`);
  } catch (e) { onError(s, e); }
  finally {
    await failEvidence([s], page, rec, 'TS-15', data);
    await ctx.close();
  }
  return reported(s);
}
