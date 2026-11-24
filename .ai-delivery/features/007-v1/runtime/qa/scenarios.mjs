// 各次运行（R-A～R-K）的操作与判定，预期结果逐条对应测试计划 tasks-qa.md 第 4 节。
import {
  Session, sleep, STATE, MSG_INTERRUPTED, MSG_SHARE_ENDED, isStallNotice, windowCheck, firstLeaveRunning,
} from './lib.mjs';

const ck = (step, passed, observation) => ({ step, passed: !!passed, observation });
const sec = (ms) => (ms == null ? '—' : `${(ms / 1000).toFixed(1)} 秒`);

async function newSession(env, name, opts = {}) {
  const s = new Session(env.browser, env.url, env.ev, name);
  await s.open(opts);
  return s;
}

// 等待状态离开“正在听”（以页面内时间线为准），最多 limitMs。
async function waitLeaveRunning(s, from, limitMs) {
  const deadline = from + limitMs;
  while (Date.now() < deadline) {
    const q = await s.qa();
    const leave = firstLeaveRunning(q, from);
    if (leave) return leave;
    await sleep(250);
  }
  return null;
}

// 观察窗口内提示区的所有取值（包括窗口开始时正在显示的那条）。
function noticesIn(q, from, to) {
  const out = [];
  let cur = null;
  for (const n of q.notices) { if (n.at <= from) cur = n; else if (n.at <= to) out.push(n); }
  return [cur, ...out].filter(Boolean).map((n) => n.text);
}

function captionSnapshot(list) { return new Map(list.map((f) => [f.id, f.text])); }
function captionsKept(before, after) {
  const now = captionSnapshot(after);
  let missing = 0; let changed = 0;
  for (const [id, text] of before) { if (!now.has(id)) missing++; else if (now.get(id) !== text) changed++; }
  return { ok: missing === 0 && changed === 0 && after.length >= before.size, missing, changed, before: before.size, after: after.length };
}

// TS-06：在停滞后的同一页面重新开始（检查点 A/B 共用）。
async function restartCheck(s, label) {
  const cps = [];
  const btn = await s.buttons();
  if (!btn.startEnabled) return { cps: [ck(`检查点 ${label}：点击“开始”`, false, '停滞后“开始”不可用')], report: true };
  if (!s.player || s.player.isClosed()) await s.reopenPlayer();
  await s.play('speech');
  await sleep(1000);
  const r = await s.start('系统声音', 90_000);
  const q0 = await s.qa();
  const after = q0.states.filter((x) => x.at >= r.clickAt);
  const errNotice = q0.notices.some((n) => n.at >= r.clickAt + 1500 && n.text && n.kind === 'error');
  if (!r.ok) {
    if (r.reason.startsWith('state') || errNotice) {
      return { cps: [ck(`检查点 ${label}：回到“正在听”并出现新字幕`, false, `重新开始后状态变化：${after.map((x) => x.text).join(' → ')}；提示：${await s.noticeText() || '（无）'}`)], report: true };
    }
    return { cps: [], report: false, why: `检查点 ${label} 在 90 秒等待上限内未出现“正在听”与新的中文定稿字幕（${r.reason}）` };
  }
  const notice1 = await s.noticeText();
  cps.push(ck(`检查点 ${label}-1：回到“正在听”，停滞中断提示消失`, after.some((x) => x.text === STATE.running) && !isStallNotice(notice1),
    `点击后状态：${after.map((x) => x.text).join(' → ')}；当前提示：${notice1 || '（无）'}`));
  cps.push(ck(`检查点 ${label}-2：出现新的中文定稿字幕`, true, `点击“开始”后 ${sec(Date.now() - r.clickAt)} 内出现新的定稿字幕`));
  const runAt = (after.find((x) => x.text === STATE.running) || {}).at || r.clickAt;
  const until = runAt + 60_000;
  while (Date.now() < until + 500) await sleep(1000);
  const q = await s.qa();
  const w = windowCheck(q, runAt, until);
  const ns = noticesIn(q, runAt + 1, until).filter((t) => t);
  cps.push(ck(`检查点 ${label}-3：重新开始后 60 秒内保持“正在听”、无停滞中断提示`,
    !w.stallSeen && w.changes.length === 0 && w.startState === STATE.running && ns.length === 0,
    `60 秒内状态变化：${w.changes.join(' → ') || '无'}；出现的提示：${ns.join(' / ') || '无'}`));
  return { cps, report: true };
}

// ---------------- R-A：TS-01、TS-02，随后 TS-06 检查点 A ----------------
export async function runA(env) {
  const { R } = env;
  const s = await newSession(env, 'R-A');
  await s.play('speech');
  const r = await s.start('系统声音');
  if (!r.ok) { const ev = await s.saveEvidence('start'); for (const id of ['TS-01', 'TS-02', 'TS-06']) R.skip(id, `第一条字幕未在等待上限内出现（${r.reason}；证据 ${ev.join(', ')}）`); return; }
  const pipOk = await s.openPip();
  await s.play('voiced');
  await sleep(3000);
  const before = captionSnapshot(await s.finalIds());
  const blockAt = await s.blockRecognizer();
  s.note(`blocked recognizer; finals before=${before.size}; pip=${pipOk}`);
  const leave = await waitLeaveRunning(s, blockAt, 50_000);
  const leaveMs = leave ? leave.at - blockAt : null;

  // TS-02
  R.set('TS-02', !!leave && leave.text === STATE.error && leaveMs <= 30_000,
    [ck('自触发起不超过 30 秒离开“正在听”变为“出错”', !!leave && leave.text === STATE.error && leaveMs <= 30_000,
      leave ? `触发后 ${sec(leaveMs)} 状态变为“${leave.text}”` : '触发后 50 秒内状态没有离开“正在听”')], []);

  if (!leave) {
    const ev = await s.saveEvidence('TS-01');
    R.set('TS-01', false, [ck('50 秒内离开“正在听”', false, '触发后 50 秒内状态没有离开“正在听”')], ev);
    R.ctx.ts06 = { A: { report: false, cps: [], why: '检查点 A 前置条件（TS-01 已显示停滞中断提示）未满足' } };
    await s.close();
    return;
  }
  await sleep(1500);
  const cps = [];
  const st = await s.statusText();
  cps.push(ck('1 状态从“正在听”变为“出错”', leave.text === STATE.error && st === STATE.error, `状态变为“${leave.text}”（触发后 ${sec(leaveMs)}），当前“${st}”`));
  const notice = await s.noticeText();
  R.ctx.stallNoticeText = notice;
  cps.push(ck('2 显示停滞中断提示（非“翻译已中断，请稍后重新开始。”）', isStallNotice(notice) && notice !== MSG_INTERRUPTED, `提示：${notice || '（无）'}`));
  const errAt = leave.at;
  const capIdsAtErr = new Set(Object.keys((await s.qa()).captions));
  const btn = await s.buttons();
  cps.push(ck('4 “开始”可用、“停止”不可用、输入方式可重新选择', btn.startEnabled && !btn.stopEnabled && btn.micEnabled && btn.sysEnabled,
    `开始=${btn.startEnabled ? '可用' : '不可用'}，停止=${btn.stopEnabled ? '可用' : '不可用'}，麦克风=${btn.micEnabled ? '可选' : '不可选'}，系统声音=${btn.sysEnabled ? '可选' : '不可选'}`));
  const live = await s.liveCaptureTracks();
  cps.push(ck('5 页面不再持有活动的共享采集', live === 0, `活动的共享采集轨道数：${live}`));
  const pip = pipOk ? await s.pipStatus() : null;
  cps.push(ck('6 字幕小窗状态显示“出错”', pip === STATE.error, pipOk ? `小窗状态：${pip ?? '（未找到 #pip-status）'}` : '字幕小窗未能打开'));

  // 7：关闭播放器标签页并观察 35 秒
  const closeAt = Date.now();
  await s.player.close();
  await sleep(35_500);
  const q = await s.qa();
  const ns = noticesIn(q, errAt, Date.now());
  const w = windowCheck(q, closeAt, Date.now());
  const st7 = await s.statusText();
  const n7 = await s.noticeText();
  cps.push(ck('7 关闭播放器标签页后 35 秒内仍为“出错”与停滞中断提示，未被替换',
    st7 === STATE.error && w.changes.length === 0 && ns.every((t) => t === notice) && isStallNotice(n7) && !n7.startsWith('共享已结束'),
    `关闭后状态变化：${w.changes.join(' → ') || '无'}，当前“${st7}”；出错后提示取值：${[...new Set(ns)].join(' / ')}`));
  const kept = captionsKept(before, await s.finalIds());
  const newCaps = Object.keys(q.captions).filter((id) => !capIdsAtErr.has(id) && !q.captions[id].notice);
  const newFinals = q.finals.filter((f) => f.at > errAt && !before.has(f.id));
  cps.splice(2, 0, ck('3 触发前定稿字幕保留且之后没有新字幕', kept.ok && newCaps.length === 0 && newFinals.length === 0,
    `触发前定稿 ${kept.before} 条，现在 ${kept.after} 条；缺失 ${kept.missing}、文本变化 ${kept.changed}；出错后新增字幕条目 ${newCaps.length}、出错后新定稿 ${newFinals.length}`));
  const passed = cps.every((c) => c.passed);
  R.set('TS-01', passed, cps, passed ? [] : await s.saveEvidence('TS-01'));

  // TS-06 检查点 A
  const res = await restartCheck(s, 'A');
  R.ctx.ts06 = { A: res };
  s.note(`TS-06 A: ${res.report ? res.cps.map((c) => `${c.passed ? 'ok' : 'NG'} ${c.step}: ${c.observation}`).join(' | ') : `not reported: ${res.why}`}`);
  if (!res.report || res.cps.some((c) => !c.passed)) res.evidence = await s.saveEvidence('TS-06A');
  finalizeTs06(R);
  await s.close();
}

// ---------------- R-B：TS-03 ----------------
export async function runB(env) {
  const { R } = env;
  const s = await newSession(env, 'R-B');
  await s.play('speech');
  const r = await s.start('系统声音');
  if (!r.ok) { R.skip('TS-03', `第一条字幕未在等待上限内出现（${r.reason}）`); await s.saveEvidence('start'); return; }
  await s.play('voiced');
  const upd = await s.waitForCaptionUpdate(15_000);
  const blockAt = await s.blockRecognizer();
  s.note(`caption update seen=${upd}`);
  while (Date.now() < blockAt + 15_000) await sleep(100);
  const pauseAt = await s.pausePlayer();
  const firstVoicedMs = pauseAt - blockAt;
  while (Date.now() < pauseAt + 45_000) await sleep(200);
  const resumeAt = await s.resumePlayer();
  const q1 = await s.qa();
  const w1 = windowCheck(q1, blockAt, resumeAt);
  const cps = [];
  const leftEarly = firstLeaveRunning(q1, blockAt);
  cps.push(ck('1 静音段结束时仍为“正在听”、无停滞中断提示', !leftEarly && !w1.stallSeen,
    `触发后第一段有声 ${sec(firstVoicedMs)}、静音 ${sec(resumeAt - pauseAt)}；静音结束时状态变化：${w1.changes.join(' → ') || '无'}${leftEarly ? `（触发后 ${sec(leftEarly.at - blockAt)} 变为“${leftEarly.text}”）` : ''}；停滞提示：${w1.stallSeen ? '出现' : '未出现'}`));
  let leave = leftEarly;
  if (!leave) leave = await waitLeaveRunning(s, resumeAt, 45_000);
  await sleep(1000);
  const notice = await s.noticeText();
  cps.push(ck('2 声音恢复后变为“出错”并显示停滞中断提示', !!leave && leave.text === STATE.error && isStallNotice(notice),
    leave ? `状态变为“${leave.text}”（恢复后 ${sec(leave.at - resumeAt)}）；提示：${notice || '（无）'}` : '声音恢复后 45 秒内状态没有离开“正在听”'));
  const limitAt = resumeAt + 30_000 - firstVoicedMs;
  cps.push(ck('3 变为“出错”不晚于恢复后再累计 (30 − 第一段有声时长) 秒', !!leave && !leftEarly && leave.text === STATE.error && leave.at <= limitAt,
    leave ? `最迟时刻为恢复后 ${sec(limitAt - resumeAt)}，实际为恢复后 ${sec(leave.at - resumeAt)}` : '未变为“出错”'));
  const passed = cps.every((c) => c.passed);
  R.set('TS-03', passed, cps, passed ? [] : await s.saveEvidence('TS-03'));
  await s.close();
}

// ---------------- R-C～R-F：TS-05 检查点 A～D；R-C 之后 TS-06 检查点 B ----------------
const TS05 = [
  { key: 'A', run: 'R-C', action: 'suspend', silent: false, pip: true, desc: '有声音时挂起混音音频上下文' },
  { key: 'B', run: 'R-D', action: 'suspend', silent: true, pip: false, desc: '静音时挂起混音音频上下文' },
  { key: 'C', run: 'R-E', action: 'close', silent: false, pip: false, desc: '关闭混音音频上下文' },
  { key: 'D', run: 'R-F', action: 'stopTrack', silent: false, pip: false, desc: '停止混音输出轨道' },
];

async function ts05Point(env, p) {
  const { R } = env;
  const s = await newSession(env, `${p.run}`);
  try {
    await s.play('speech');
    const r = await s.start('系统声音');
    if (!r.ok) return { skip: `检查点 ${p.key} 第一条字幕未在等待上限内出现（${r.reason}）`, s };
    const pipOk = p.pip ? await s.openPip() : false;
    if (p.silent) {
      const pauseAt = await s.pausePlayer();
      while (Date.now() < pauseAt + 5000) await sleep(100);
    } else {
      await s.play('voiced');
      await sleep(3000);
    }
    const before = captionSnapshot(await s.finalIds());
    const act = await s.mixAction(p.action);
    if (!act.ok) return { cps: [ck(`检查点 ${p.key}：${p.desc}`, false, `受控触发未能执行：${act.reason}`)], s };
    const leave = await waitLeaveRunning(s, act.at, 40_000);
    await sleep(1500);
    const notice = await s.noticeText();
    const btn = await s.buttons();
    const kept = captionsKept(before, await s.finalIds());
    const ref = R.ctx.stallNoticeText;
    const cps = [
      ck(`检查点 ${p.key}-1（${p.desc}）：不超过 30 秒变为“出错”`, !!leave && leave.text === STATE.error && leave.at - act.at <= 30_000,
        leave ? `触发后 ${sec(leave.at - act.at)} 状态变为“${leave.text}”` : '触发后 40 秒内状态没有离开“正在听”'),
      ck(`检查点 ${p.key}-2：停滞中断提示，且与 TS-01 的提示文本相同`, isStallNotice(notice) && (ref ? notice === ref : true),
        `提示：${notice || '（无）'}；${ref ? (notice === ref ? '与 TS-01 相同' : `与 TS-01（${ref}）不同`) : 'TS-01 本次未取得提示文本，只按 3.1 判定'}`),
      ck(`检查点 ${p.key}-3：“开始”可用、“停止”不可用，定稿字幕保留`, btn.startEnabled && !btn.stopEnabled && kept.ok,
        `开始=${btn.startEnabled ? '可用' : '不可用'}，停止=${btn.stopEnabled ? '可用' : '不可用'}；触发前定稿 ${kept.before} 条，现在 ${kept.after} 条，缺失 ${kept.missing}、文本变化 ${kept.changed}`),
    ];
    if (p.pip) {
      const pip = pipOk ? await s.pipStatus() : null;
      cps.push(ck(`检查点 ${p.key}-4：字幕小窗状态显示“出错”`, pip === STATE.error, pipOk ? `小窗状态：${pip ?? '（未找到 #pip-status）'}` : '字幕小窗未能打开'));
    }
    return { cps, s };
  } catch (e) {
    return { skip: `检查点 ${p.key} 执行异常：${String(e.message || e).slice(0, 120)}`, s };
  }
}

export async function runTS05(env) {
  const { R } = env;
  const all = [];
  const evidence = [];
  let skipped = null;
  for (const p of TS05) {
    const res = await ts05Point(env, p);
    if (res.skip) { skipped = skipped || res.skip; evidence.push(...await res.s.saveEvidence(`TS-05${p.key}`)); }
    else {
      all.push(...res.cps);
      if (res.cps.some((c) => !c.passed)) evidence.push(...await res.s.saveEvidence(`TS-05${p.key}`));
    }
    if (p.key === 'A') {
      // TS-06 检查点 B：只在检查点 A 已显示停滞中断提示时进行。
      const stalled = !res.skip && isStallNotice(await res.s.noticeText().catch(() => ''));
      if (stalled) {
        try {
          const b = await restartCheck(res.s, 'B');
          if (!b.report || b.cps.some((c) => !c.passed)) b.evidence = await res.s.saveEvidence('TS-06B');
          res.s.note(`TS-06 B: ${b.report ? b.cps.map((c) => `${c.passed ? 'ok' : 'NG'} ${c.step}`).join(' | ') : `not reported: ${b.why}`}`);
          R.ctx.ts06 = { ...(R.ctx.ts06 || {}), B: b };
        } catch (e) { R.ctx.ts06 = { ...(R.ctx.ts06 || {}), B: { report: false, cps: [], why: `检查点 B 执行异常：${e.message}` } }; }
      } else {
        R.ctx.ts06 = { ...(R.ctx.ts06 || {}), B: { report: false, cps: [], why: '前置条件（TS-05 检查点 A 已显示停滞中断提示）未满足' } };
      }
    }
    await res.s.close();
  }
  const anyFail = all.some((c) => !c.passed);
  if (skipped && !anyFail) R.skip('TS-05', skipped);
  else R.set('TS-05', !anyFail, all, evidence);
  finalizeTs06(R);
}

export function finalizeTs06(R) {
  const t = R.ctx.ts06 || {};
  if (t.A && !t.B) {
    // 检查点 B 尚未（或无法）执行：只有检查点 A 已判未通过时才先报告。
    if ((t.A.cps || []).some((c) => !c.passed)) R.set('TS-06', false, t.A.cps, t.A.evidence || []);
    return;
  }
  if (!t.A || !t.B) return;
  const cps = [...(t.A.cps || []), ...(t.B.cps || [])];
  const anyFail = cps.some((c) => !c.passed);
  const ev = [...(t.A.evidence || []), ...(t.B.evidence || [])];
  if (anyFail) R.set('TS-06', false, cps, ev);
  else if (t.A.report && t.B.report) R.set('TS-06', true, cps, ev);
  else R.skip('TS-06', [t.A.why, t.B.why].filter(Boolean).join('；'));
}

// ---------------- R-G：TS-07、TS-08 ----------------
export async function runG(env) {
  const { R } = env;
  const s = await newSession(env, 'R-G');
  await s.play('speech');
  const r = await s.start('系统声音');
  if (!r.ok) { for (const id of ['TS-07', 'TS-08']) R.skip(id, `第一条字幕未在等待上限内出现（${r.reason}）`); await s.saveEvidence('start'); return; }
  const obsFrom = Date.now();
  const p1 = await s.pausePlayer();
  while (Date.now() < p1 + 20_000) await sleep(200);
  const r1 = await s.resumePlayer();
  while (Date.now() < r1 + 30_000) await sleep(200);
  const p2 = await s.pausePlayer();
  while (Date.now() < p2 + 60_000) await sleep(200);
  const resumeAt = await s.resumePlayer();
  const finalsAtResume = new Set((await s.finalIds()).map((f) => f.id));
  while (Date.now() < resumeAt + 10_500) await sleep(200);
  const q = await s.qa();
  const w = windowCheck(q, obsFrom, resumeAt + 10_000);
  const ok7 = w.startState === STATE.running && w.changes.length === 0 && !w.stallSeen;
  R.set('TS-07', ok7, [ck('两个静音段（20 秒、60 秒）期间及结束后 10 秒内始终“正在听”、无停滞中断提示', ok7,
    `观察 ${sec(resumeAt + 10_000 - obsFrom)}；状态变化：${w.changes.join(' → ') || '无'}；停滞提示：${w.stallSeen ? '出现' : '未出现'}`)],
  ok7 ? [] : await s.saveEvidence('TS-07'));

  const deadline = resumeAt + 90_000;
  let got = null;
  while (Date.now() < deadline) {
    const f = (await s.qa()).finals.find((x) => x.at > resumeAt && !finalsAtResume.has(x.id));
    if (f) { got = f; break; }
    if (isStallNotice(await s.noticeText())) break;
    await sleep(500);
  }
  const q2 = await s.qa();
  const w2 = windowCheck(q2, resumeAt, Date.now());
  const st = await s.statusText();
  if (!got && !w2.stallSeen) { R.skip('TS-08', '声音恢复后 90 秒等待上限内没有出现新的中文定稿字幕'); await s.saveEvidence('TS-08'); }
  else {
    const ok8 = !!got && !w2.stallSeen && st === STATE.running;
    R.set('TS-08', ok8, [ck('声音恢复后出现新的中文定稿字幕，仍为“正在听”、无停滞中断提示', ok8,
      `${got ? `恢复后 ${sec(got.at - resumeAt)} 出现新定稿字幕` : '未出现新定稿字幕'}；当前状态“${st}”；停滞提示：${w2.stallSeen ? '出现' : '未出现'}`)],
    ok8 ? [] : await s.saveEvidence('TS-08'));
  }
  await s.close();
}

// ---------------- R-H：TS-09、TS-10，随后 TS-12 ----------------
export async function runH(env) {
  const { R } = env;
  const s = await newSession(env, 'R-H');
  const playAt = await s.play('speech');
  const r = await s.start('系统声音');
  if (!r.ok) { for (const id of ['TS-09', 'TS-10', 'TS-12']) R.skip(id, `第一条字幕未在等待上限内出现（${r.reason}）`); await s.saveEvidence('start'); return; }
  const q0 = await s.qa();
  const runAt = (q0.states.find((x) => x.at >= r.clickAt && x.text === STATE.running) || {}).at || r.clickAt;
  const endAt = Math.max(playAt, r.clickAt) + 330_000;
  while (Date.now() < endAt) await sleep(1000);
  const q = await s.qa();
  const w = windowCheck(q, runAt, endAt);
  const ok9 = w.startState === STATE.running && w.changes.length === 0 && !w.stallSeen;
  const ev = [];
  if (!ok9) ev.push(...await s.saveEvidence('TS-09'));
  R.set('TS-09', ok9, [ck('连续播放约 5.5 分钟期间始终“正在听”、无停滞中断提示', ok9,
    `观察 ${sec(endAt - runAt)}；状态变化：${w.changes.join(' → ') || '无'}；停滞提示：${w.stallSeen ? '出现' : '未出现'}`)], ev);

  const finals = q.finals.filter((f) => f.at >= r.clickAt && f.at <= endAt).map((f) => f.at).sort((a, b) => a - b);
  const gaps = [];
  for (let i = 1; i < finals.length; i++) gaps.push(finals[i] - finals[i - 1]);
  if (finals.length) gaps.push(endAt - finals[finals.length - 1]);
  const maxGap = gaps.length ? Math.max(...gaps) : null;
  const ok10 = finals.length > 0 && maxGap <= 60_000;
  R.set('TS-10', ok10, [ck('从第一条定稿字幕到播放结束，任意相邻间隔（含最后一条到结束）不超过 60 秒', ok10,
    `定稿字幕 ${finals.length} 条；最大间隔 ${sec(maxGap)}`)], ok10 ? [] : await s.saveEvidence('TS-10'));

  // TS-12
  const btn0 = await s.buttons();
  const stopAt = Date.now();
  await s.page.getByRole('button', { name: '停止', exact: true }).click();
  await sleep(35_500);
  const q2 = await s.qa();
  const w2 = windowCheck(q2, stopAt, Date.now());
  const btn = await s.buttons();
  const st = await s.statusText();
  const ok12 = btn0.stopEnabled && st === STATE.stopped && btn.startEnabled && !w2.stallSeen && !w2.changes.includes(STATE.error);
  R.set('TS-12', ok12, [ck('点击“停止”后变为“已停止”、“开始”可用；35 秒内无停滞中断提示、未变为“出错”', ok12,
    `点击后状态变化：${w2.changes.join(' → ') || '无'}，当前“${st}”；开始=${btn.startEnabled ? '可用' : '不可用'}；停滞提示：${w2.stallSeen ? '出现' : '未出现'}`)],
  ok12 ? [] : await s.saveEvidence('TS-12'));
  await s.close();
}

// ---------------- R-I：TS-11 ----------------
export async function runI(env) {
  const { R } = env;
  const s = await newSession(env, 'R-I');
  await s.play('speech');
  const r = await s.start('系统声音');
  if (!r.ok) { R.skip('TS-11', `第一条字幕未在等待上限内出现（${r.reason}）`); await s.saveEvidence('start'); return; }
  const closeAt = Date.now();
  await s.player.close();
  let stoppedAt = null;
  while (Date.now() < closeAt + 30_000) {
    const q = await s.qa();
    const x = q.states.find((y) => y.at >= closeAt && y.text === STATE.stopped);
    if (x) { stoppedAt = x.at; break; }
    if (q.states.some((y) => y.at >= closeAt && y.text === STATE.error) || isStallNotice(await s.noticeText())) break;
    await sleep(250);
  }
  const q1 = await s.qa();
  if (!stoppedAt && !windowCheck(q1, closeAt, Date.now()).stallSeen && !q1.states.some((y) => y.at >= closeAt && y.text === STATE.error)) {
    R.skip('TS-11', '关闭标签页后 30 秒等待上限内未出现“已停止”');
    await s.saveEvidence('TS-11');
    await s.close();
    return;
  }
  await sleep(1000);
  const notice1 = await s.noticeText();
  const cps = [ck('1 状态变为“已停止”，提示为原有“共享已结束……”提示', !!stoppedAt && notice1 === MSG_SHARE_ENDED,
    `${stoppedAt ? `关闭后 ${sec(stoppedAt - closeAt)} 变为“已停止”` : `未变为“已停止”（状态：${await s.statusText()}）`}；提示：${notice1 || '（无）'}`)];
  const obsFrom = stoppedAt || Date.now();
  while (Date.now() < obsFrom + 35_500) await sleep(500);
  const q = await s.qa();
  const w = windowCheck(q, closeAt, Date.now());
  const ns = [...new Set(noticesIn(q, obsFrom + 1500, Date.now()))];
  cps.push(ck('2 观察 35 秒内未出现停滞中断提示，状态未变为“出错”，提示未被替换',
    !w.stallSeen && !w.changes.includes(STATE.error) && ns.every((t) => t === notice1),
    `关闭后状态变化：${w.changes.join(' → ') || '无'}；观察期提示取值：${ns.join(' / ') || '（无）'}`));
  const passed = cps.every((c) => c.passed);
  R.set('TS-11', passed, cps, passed ? [] : await s.saveEvidence('TS-11'));
  await s.close();
}

// ---------------- R-J：TS-13、TS-14，随后 TS-15 ----------------
export async function runJ(env) {
  const { R } = env;
  const s = await newSession(env, 'R-J');
  await s.play('speech');
  const r = await s.start('系统声音');
  if (!r.ok) { for (const id of ['TS-13', 'TS-14', 'TS-15']) R.skip(id, `第一条字幕未在等待上限内出现（${r.reason}）`); await s.saveEvidence('start'); return; }
  const trigAt = Date.now();
  await s.setTranslateMode('rejectNextFinal');
  let hit = null;
  while (Date.now() < trigAt + 60_000) {
    const q = await s.qa();
    if (q.translateHits.length) { hit = q.translateHits[0]; break; }
    await sleep(250);
  }
  if (!hit) {
    await s.setTranslateMode('normal');
    for (const id of ['TS-13', 'TS-14']) R.skip(id, '60 秒等待上限内未出现被拒绝的翻译请求');
  } else {
    const dropAt = hit.at;
    const finalsAtDrop = new Set((await s.finalIds()).map((f) => f.id));
    await sleep(3000);
    const stA = await s.statusText();
    const nA = await s.noticeText();
    const segs = hit.finalizing;
    const capsA = (await s.qa()).captions;
    const translated = segs.filter((id) => capsA[id] && capsA[id].status === 'final');
    // TS-14：等待之后的新定稿字幕（最多 90 秒），与 TS-13 的 35 秒观察同时进行。
    let next = null;
    while (Date.now() < dropAt + 35_500 || (!next && Date.now() < dropAt + 90_000)) {
      if (!next) {
        const q = await s.qa();
        next = q.finals.find((f) => f.at > dropAt && !finalsAtDrop.has(f.id) && !segs.includes(f.id)) || null;
      }
      if (next && Date.now() >= dropAt + 35_500) break;
      await sleep(500);
    }
    const q = await s.qa();
    const w35 = windowCheck(q, dropAt, dropAt + 35_000);
    const ns = noticesIn(q, dropAt, dropAt + 35_000);
    const interruptedSeen = ns.includes(MSG_INTERRUPTED);
    const domSt = await s.page.evaluate((ids) => ids.map((id) => {
      const li = Array.from(document.querySelectorAll('#captions li.caption')).find((x) => x.getAttribute('data-segment-id') === id);
      return li ? li.getAttribute('data-status') : null;
    }), segs);
    const capsB = Object.fromEntries(segs.map((id, i) => [id, domSt[i] ? { status: domSt[i] } : null]));
    const translatedLater = segs.filter((id) => capsB[id] && capsB[id].status === 'final');
    const cps = [
      ck('1 被拒绝的那一句没有中文译文，且未出现停滞中断提示或“翻译已中断，请稍后重新开始。”',
        segs.length > 0 && translated.length === 0 && translatedLater.length === 0 && !w35.stallSeen && !interruptedSeen,
        `被拒绝请求发出时处于定稿中的条目 ${segs.length} 条，其中显示为中文定稿的 ${translatedLater.length} 条（状态：${segs.map((id) => (capsB[id] ? capsB[id].status : '已移除')).join('、') || '—'}）；35 秒内提示取值：${[...new Set(ns)].map((t) => t || '（无）').join(' / ')}`),
      ck('2 丢弃时与之后 35 秒时状态为“正在听”且无停滞中断提示，期间始终“正在听”',
        stA === STATE.running && !isStallNotice(nA) && w35.startState === STATE.running && w35.changes.length === 0 && !w35.stallSeen,
        `丢弃后 3 秒状态“${stA}”，35 秒内状态变化：${w35.changes.join(' → ') || '无'}；停滞提示：${w35.stallSeen ? '出现' : '未出现'}`),
    ];
    const p13 = cps.every((c) => c.passed);
    R.set('TS-13', p13, cps, p13 ? [] : await s.saveEvidence('TS-13'));
    const st = await s.statusText();
    const wAll = windowCheck(q, dropAt, Date.now());
    const anyErr = q.notices.some((n) => n.at > dropAt && n.text);
    if (!next && !anyErr && !wAll.stallSeen) R.skip('TS-14', '90 秒等待上限内没有出现新的中文定稿字幕');
    else {
      const p14 = !!next && st === STATE.running && !isStallNotice(await s.noticeText()) && !wAll.stallSeen;
      R.set('TS-14', p14, [ck('被拒绝那一句之后出现新的中文定稿字幕，仍为“正在听”、无停滞中断提示', p14,
        `${next ? `丢弃后 ${sec(next.at - dropAt)} 出现新的定稿字幕` : '未出现新的定稿字幕'}；当前状态“${st}”；停滞提示：${wAll.stallSeen ? '出现' : '未出现'}`)],
      p14 ? [] : await s.saveEvidence('TS-14'));
    }
  }

  // TS-15
  if ((await s.statusText()) !== STATE.running) { R.skip('TS-15', '前置条件（系统声音运行中）未满足'); await s.close(); return; }
  const failAt = Date.now();
  await s.setTranslateMode('failFinals');
  let end = null;
  while (Date.now() < failAt + 120_000) {
    const q = await s.qa();
    end = firstLeaveRunning(q, failAt);
    if (end || windowCheck(q, failAt, Date.now()).stallSeen) break;
    await sleep(250);
  }
  const q0 = await s.qa();
  if (!end && !windowCheck(q0, failAt, Date.now()).stallSeen) {
    R.skip('TS-15', '开始让翻译失败后 2 分钟等待上限内页面未停止');
    await s.saveEvidence('TS-15');
    await s.close();
    return;
  }
  await sleep(1000);
  const n1 = await s.noticeText();
  const st1 = await s.statusText();
  const cps = [ck('1 状态变为“出错”，提示为“翻译已中断，请稍后重新开始。”（非停滞中断提示）', !!end && end.text === STATE.error && n1 === MSG_INTERRUPTED,
    `${end ? `开始失败后 ${sec(end.at - failAt)} 状态变为“${end.text}”` : '状态未离开“正在听”'}；当前“${st1}”；提示：${n1 || '（无）'}`)];
  const obsFrom = Date.now();
  while (Date.now() < obsFrom + 35_000) await sleep(500);
  const q = await s.qa();
  const w = windowCheck(q, failAt, Date.now());
  const ns = [...new Set(noticesIn(q, obsFrom, Date.now()))];
  const st2 = await s.statusText();
  cps.push(ck('2 之后 35 秒内提示与状态不变，从未出现停滞中断提示', !w.stallSeen && st2 === st1 && ns.length === 1 && ns[0] === n1,
    `35 秒后状态“${st2}”；观察期提示取值：${ns.join(' / ') || '（无）'}；停滞提示：${w.stallSeen ? '出现' : '未出现'}`));
  const passed = cps.every((c) => c.passed);
  R.set('TS-15', passed, cps, passed ? [] : await s.saveEvidence('TS-15'));
  await s.close();
}

// ---------------- R-K：TS-16（麦克风） ----------------
export async function runK(env) {
  const { R } = env;
  const s = await newSession(env, 'R-K', { withPlayer: false, permissions: ['microphone'] });
  const r = await s.start('麦克风');
  if (!r.ok) { R.skip('TS-16', `第一条字幕未在等待上限内出现（${r.reason}）`); await s.saveEvidence('start'); await s.close(); return; }
  const blockAt = await s.blockRecognizer();
  while (Date.now() < blockAt + 45_000) await sleep(500);
  const q = await s.qa();
  const w = windowCheck(q, blockAt, blockAt + 45_000);
  const st = await s.statusText();
  const ok = !w.stallSeen && !w.changes.includes(STATE.error) && w.changes.length === 0 && st === STATE.running;
  R.set('TS-16', ok, [ck('麦克风模式下识别器停止输出后 45 秒内无停滞中断提示，状态保持“正在听”', ok,
    `45 秒内状态变化：${w.changes.join(' → ') || '无'}，当前“${st}”；停滞提示：${w.stallSeen ? '出现' : '未出现'}；被拦截的识别消息 ${q.wsInDropped} 条`)],
  ok ? [] : await s.saveEvidence('TS-16'));
  await s.close();
}
