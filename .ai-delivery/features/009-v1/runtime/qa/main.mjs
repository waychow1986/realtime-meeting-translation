// Entry of the 009-v1 test script (导出本次字幕). Runs the script scenarios of tasks-qa.md and writes the result.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import * as c from './common.mjs';
import { synthesizeAll } from './tts.mjs';
import { groupA } from './scenarios.mjs';
import { groupS03, groupS05, groupS06 } from './scenarios2.mjs';
import { groupS08, groupS09, reportTS13 } from './scenarios3.mjs';
import { groupS10, groupS12, groupS18 } from './scenarios4.mjs';

const ALL = ['TS-01', 'TS-02', 'TS-03', 'TS-04', 'TS-05', 'TS-06', 'TS-08', 'TS-09', 'TS-10', 'TS-11', 'TS-12', 'TS-13', 'TS-14', 'TS-15', 'TS-16', 'TS-17', 'TS-18'];
// Order and estimates (minutes) follow tasks-qa.md §2.2.
const GROUPS = [
  { name: 'TS03', ids: ['TS-03', 'TS-14'], min: 8.7, run: groupS03 },
  { name: 'TS09', ids: ['TS-09', 'TS-16'], min: 6.7, run: groupS09 },
  { name: 'TS08', ids: ['TS-08'], min: 10.2, run: groupS08 },
  { name: 'TS10', ids: ['TS-10'], min: 5.5, run: groupS10 },
  { name: 'TS05', ids: ['TS-05'], min: 6.6, run: groupS05 },
  { name: 'TS06', ids: ['TS-06'], min: 5.2, run: groupS06 },
  { name: 'A', ids: ['TS-11', 'TS-01', 'TS-02', 'TS-04', 'TS-15'], min: 3.6 + 4 + 0.2 + 0.3, run: groupA },
  { name: 'TS12', ids: ['TS-12', 'TS-17'], min: 3.8, run: groupS12 },
  { name: 'TS18', ids: ['TS-18'], min: 2, run: groupS18 },
];
const only = (process.env.QA_ONLY || '').split(',').map((x) => x.trim()).filter(Boolean);

const results = new Map();
const notes = [];
let written = false;
function report(sc) { results.set(sc.id, sc); }
function writeResult(extra = '') {
  const scenarios = ALL.filter((id) => results.has(id)).map((id) => results.get(id));
  const missing = ALL.filter((id) => !results.has(id));
  const failed = scenarios.filter((x) => !x.passed).map((x) => x.id);
  const summary = [
    `报告 ${scenarios.length} 个脚本场景：通过 ${scenarios.length - failed.length}，未通过 ${failed.length}${failed.length ? `（${failed.join('、')}）` : ''}。`,
    missing.length ? `未报告（未产出、到等待上限、造数未成功或执行时限不足）：${missing.join('、')}。` : '',
    ...notes, extra,
  ].filter(Boolean).join(' ');
  const out = { schemaVersion: 2, testedCommitSha: process.env.QA_CANDIDATE_SHA || '', summary: summary.slice(0, 4000), scenarios, externalServices: ['speech', 'chat-model'] };
  mkdirSync(dirname(c.RESULT_PATH), { recursive: true });
  writeFileSync(c.RESULT_PATH, JSON.stringify(out, null, 2));
  written = true;
}

// Watchdog: writes what is known before the platform limit is reached.
const watchdog = setTimeout(() => { c.log('watchdog: writing partial result'); writeResult('执行时限预留点已到，已写出部分结果。'); process.exit(0); }, Math.max(10_000, c.deadline + 60_000 - Date.now()));
watchdog.unref();

async function main() {
  mkdirSync(c.EVIDENCE_DIR, { recursive: true });
  const audio = await synthesizeAll('./audio');
  await c.launch();
  for (const g of GROUPS) {
    if (only.length && !g.ids.some((id) => only.includes(id))) continue;
    if (c.remainingMs() < (g.min + 1) * 60_000) { notes.push(`${g.ids.join('、')} 因剩余执行时间不足未执行。`); continue; }
    c.log('=== group', g.name, 'remaining min', Math.round(c.remainingMs() / 60000));
    const t = Date.now();
    try { await g.run(audio, report); } catch (e) {
      if (e instanceof c.NotReached) { notes.push(`${g.name} 组：${e.message}`); c.log('NotReached', g.name, e.message); }
      else if (e instanceof c.Aborted) { notes.push(`${g.name} 组：${e.message}`); c.log('Aborted', g.name); }
      else { notes.push(`${g.name} 组运行异常：${String(e.message || e).split('\n')[0].slice(0, 200)}`); c.log('ERROR', g.name, e.stack || e); }
    }
    c.log('=== group', g.name, 'done in', Math.round((Date.now() - t) / 1000), 's');
    writeResult();
  }
  if (!only.length || only.includes('TS-13')) reportTS13(report);
  await c.closeBrowser();
}

try { await main(); } catch (e) { notes.push(`脚本异常：${String(e.message || e).split('\n')[0].slice(0, 200)}`); c.log('FATAL', e.stack || e); }
writeResult();
clearTimeout(watchdog);
process.exit(0);
