// 独立测试脚本主体：按测试计划 tasks-qa.md 第 3.4 节的编排串行执行 R-A～R-K，
// 只报告 kind=script 的场景是否符合测试计划的预期结果。
import fs from 'node:fs';
import path from 'node:path';
import { buildMaterials } from './audio.mjs';
import {
  launchBrowser, startPlayerServer, Session, sleep, STATE, MSG_INTERRUPTED, MSG_SHARE_ENDED,
  isStallNotice, windowCheck, firstLeaveRunning,
} from './lib.mjs';
import { runA, runB, runTS05, runG, runH, runI, runJ, runK } from './scenarios.mjs';

const T0 = Date.now();
const TIMEOUT_S = Number(process.env.QA_TIMEOUT_SECONDS || 3600);
const RESULT = process.env.QA_RESULT_PATH || path.join(process.cwd(), 'qa-result.json');
const EV = process.env.QA_EVIDENCE_DIR || path.join(process.cwd(), 'evidence');
const ONLY = (process.env.QA_ONLY_RUNS || '').split(',').filter(Boolean);
fs.mkdirSync(EV, { recursive: true });

const scenarios = new Map();
const notes = [];
const R = {
  set(id, passed, checkpoints, evidence = []) {
    scenarios.set(id, { id, passed: !!passed, checkpoints, evidence });
    console.log(`== ${id}: ${passed ? 'PASS' : 'FAIL'}`);
    for (const c of checkpoints) console.log(`   - ${c.passed ? 'ok ' : 'NG '} ${c.step}: ${c.observation}`);
    write();
  },
  skip(id, why) { notes.push(`${id} 未报告：${why}`); console.log(`== ${id}: not reported (${why})`); write(); },
  ctx: { stallNoticeText: null },
};

function write() {
  const list = Array.from(scenarios.values()).sort((a, b) => a.id.localeCompare(b.id));
  const passed = list.filter((s) => s.passed).length;
  const out = {
    schemaVersion: 2,
    testedCommitSha: process.env.QA_CANDIDATE_SHA || '',
    summary: `执行 ${list.length} 个脚本场景，通过 ${passed} 个、未通过 ${list.length - passed} 个${notes.length ? `；未报告：${notes.map((n) => n.split('：')[0]).join('、')}` : ''}。`,
    scenarios: list.map((s) => ({ id: s.id, passed: s.passed, checkpoints: s.checkpoints.map((c) => ({ step: c.step, passed: !!c.passed, observation: String(c.observation).slice(0, 600) })), evidence: s.evidence })),
    externalServices: ['speech', 'chat-model'],
  };
  let json = JSON.stringify(out, null, 1);
  if (Buffer.byteLength(json) > 250_000) json = JSON.stringify(out);
  fs.writeFileSync(RESULT, json);
}

const remainingMs = () => TIMEOUT_S * 1000 - (Date.now() - T0);

const RUNS = [
  { id: 'R-A', worstMs: 330_000, ids: ['TS-01', 'TS-02', 'TS-06'], fn: runA },
  { id: 'R-B', worstMs: 210_000, ids: ['TS-03'], fn: runB },
  { id: 'R-CF', worstMs: 700_000, ids: ['TS-05', 'TS-06'], fn: runTS05 },
  { id: 'R-G', worstMs: 330_000, ids: ['TS-07', 'TS-08'], fn: runG },
  { id: 'R-H', worstMs: 460_000, ids: ['TS-09', 'TS-10', 'TS-12'], fn: runH },
  { id: 'R-I', worstMs: 160_000, ids: ['TS-11'], fn: runI },
  { id: 'R-J', worstMs: 470_000, ids: ['TS-13', 'TS-14', 'TS-15'], fn: runJ },
  { id: 'R-K', worstMs: 140_000, ids: ['TS-16'], fn: runK },
];

async function main() {
  write();
  let materials;
  try {
    materials = await buildMaterials(path.join(process.cwd(), 'materials'), (m) => console.log(m));
  } catch (e) {
    notes.push(`素材合成失败：${e.message}`);
    console.log('materials failed', e.message);
    write();
    return;
  }
  const { server, url } = await startPlayerServer(materials);
  const env = { url, ev: EV, materials, R, sleep };
  for (const run of RUNS) {
    if (ONLY.length && !ONLY.includes(run.id)) continue;
    if (remainingMs() < run.worstMs + 60_000) {
      for (const id of run.ids) if (!scenarios.has(id)) R.skip(id, `剩余执行时间不足以开始运行 ${run.id}`);
      continue;
    }
    console.log(`##### ${run.id} start (remaining ${Math.round(remainingMs() / 1000)} s)`);
    let browser;
    try {
      browser = await launchBrowser(run.id === 'R-K' ? ['--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${materials.speechPath}`] : []);
      await run.fn({ ...env, browser });
    } catch (e) {
      console.log(`${run.id} error: ${e.stack || e}`);
      fs.writeFileSync(path.join(EV, `${run.id}-exception.txt`), String(e.stack || e));
      for (const id of run.ids) if (!scenarios.has(id)) R.skip(id, `${run.id} 执行异常：${String(e.message || e).slice(0, 120)}`);
    } finally {
      try { await browser?.close(); } catch { /* ignore */ }
    }
  }
  server.close();
  write();
}

export { STATE, MSG_INTERRUPTED, MSG_SHARE_ENDED, isStallNotice, windowCheck, firstLeaveRunning, Session };

main().then(() => process.exit(0), (e) => { console.log('fatal', e); write(); process.exit(0); });
