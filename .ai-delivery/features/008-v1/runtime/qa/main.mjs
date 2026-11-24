// Runs the scenario groups and writes the script result (contract version 2) to QA_RESULT_PATH.
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { launch, closeBrowser, log, Skip, EVIDENCE_DIR, BASE_URL, notes } from './lib.mjs';
import { synthesize } from './tts.mjs';
import { ts01, ts03, ts05, ts09, ts14 } from './scenarios-static.mjs';
import { groupLayout, groupLive, ts10, groupPip, ts15 } from './scenarios-live.mjs';

const RESULT_PATH = process.env.QA_RESULT_PATH || './qa-result.json';
const timeoutSec = Number(process.env.QA_TIMEOUT_SECONDS || 3000);
const deadline = Date.now() + (timeoutSec - 90) * 1000;
mkdirSync(EVIDENCE_DIR, { recursive: true });

// Optional filter for trial runs: QA_ONLY="TS-01,TS-03"
const only = (process.env.QA_ONLY || '').split(',').map((x) => x.trim()).filter(Boolean);

const results = new Map();

function writeResult() {
  const scenarios = [...results.values()].map((s) => s.toJSON());
  const passed = scenarios.filter((s) => s.passed).length;
  const summary = `字幕行距可调：报告 ${scenarios.length} 个场景，通过 ${passed} 个，未通过 ${scenarios.length - passed} 个` +
    (notes.length ? `；未报告：${notes.join('；')}` : '');
  const out = {
    schemaVersion: 2,
    testedCommitSha: process.env.QA_CANDIDATE_SHA || '',
    summary: summary.slice(0, 900),
    scenarios,
    externalServices: ['speech', 'chat-model'],
  };
  writeFileSync(RESULT_PATH, JSON.stringify(out, null, 2));
}

// Each group: [scenario ids it can report, estimated worst-case seconds, function returning Scenario | Scenario[]]
const groups = [
  [['TS-01'], 60, ts01],
  [['TS-03'], 90, ts03],
  [['TS-05'], 60, ts05],
  [['TS-09'], 120, ts09],
  [['TS-14'], 120, ts14],
  [['TS-04', 'TS-02'], 360, groupLayout],
  [['TS-07', 'TS-06', 'TS-08'], 600, groupLive],
  [['TS-10'], 300, ts10],
  [['TS-11', 'TS-12', 'TS-13'], 600, groupPip],
  [['TS-15'], 300, ts15],
];

async function main() {
  if (!BASE_URL) throw new Error('AIDH_SERVICE_WEB_URL is not set');
  const audio = await synthesize(resolve('speech.wav'));
  log('speech audio ready');
  await launch(audio);
  for (const [ids, est, fn] of groups) {
    if (only.length && !ids.some((i) => only.includes(i))) continue;
    if (Date.now() + est * 1000 > deadline) { notes.push(`${ids.join('、')} 剩余时限不足，未执行`); log('skip (time)', ids.join(',')); continue; }
    log('=== group', ids.join(','));
    try {
      const r = await fn({ only });
      for (const s of [].concat(r)) if (s && s.checkpoints.length) results.set(s.id, s);
    } catch (e) {
      // A group may return partial results through e.partial (scenarios already decided before the stop).
      for (const s of [].concat(e.partial || [])) if (s && s.checkpoints.length) results.set(s.id, s);
      const pending = ids.filter((i) => !results.has(i));
      if (e instanceof Skip) notes.push(`${pending.join('、')}：${e.message}`);
      else notes.push(`${pending.join('、')}：执行出错 ${e.message}`);
      log('group stopped', ids.join(','), e.stack || e.message);
    }
    writeResult();
  }
  await closeBrowser();
  writeResult();
}

main().catch(async (e) => {
  log('fatal', e.stack || e.message);
  notes.push(`执行中断：${e.message}`);
  await closeBrowser();
  writeResult();
  process.exit(0);
});
