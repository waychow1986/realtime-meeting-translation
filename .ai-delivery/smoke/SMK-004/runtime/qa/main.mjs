// Smoke candidate (from 009-v1 TS-03): 已停止时点击“导出字幕”，下载 1 个 .txt，内容与页面中文定稿字幕一致。
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import * as c from './common.mjs';
import { synthesizeAll } from './tts.mjs';
import { recorder } from './shared.mjs';

const results = [];
let note = '';
function writeResult() {
  mkdirSync(dirname(c.RESULT_PATH), { recursive: true });
  const ok = results.length && results.every((x) => x.passed);
  writeFileSync(c.RESULT_PATH, JSON.stringify({ schemaVersion: 2, testedCommitSha: process.env.QA_CANDIDATE_SHA || '', summary: (results.length ? (ok ? '冒烟通过：已停止时导出字幕。' : '冒烟未通过：已停止时导出字幕。') : '冒烟场景未产出。') + note, scenarios: results, externalServices: ['speech', 'chat-model'] }, null, 2));
}
const watchdog = setTimeout(() => { note += ' 到达时限，写出部分结果。'; writeResult(); process.exit(0); }, Math.max(10_000, c.deadline + 60_000 - Date.now()));
watchdog.unref();

async function main() {
  const audio = await synthesizeAll('./audio', ['s1', 's2']);
  await c.launch();
  const s = await c.newSession('smoke-export', audio);
  try {
    const page = s.page;
    const r = recorder();
    r.check('刚打开页面时“导出字幕”不可用', await c.exportButton(page).isDisabled(), `状态=${await c.statusText(page)}`);
    await c.start(page);
    await c.sayAndFinal(s, 's1');
    await c.sayAndFinal(s, 's2');
    await c.stop(page);
    const pageList = await c.finals(page);
    r.check('“已停止”时“导出字幕”可用', pageList.length >= 2 && (await c.exportButton(page).isEnabled()), `页面定稿 ${pageList.length} 条`);
    const f = await c.exportOnce(s);
    r.check('点击一次下载 1 个 .txt 文件，UTF-8 可解码', /\.txt$/.test(f.name) && f.utf8 && f.extraDownloads === 0, `文件名=${f.name}；额外下载=${f.extraDownloads}`);
    r.check('第 1 行为导出日期，第 2 行为空行', /^导出日期：\d{4}-\d{2}-\d{2}$/.test(f.lines[0] || '') && f.lines[1] === '', JSON.stringify(f.lines.slice(0, 2)));
    const exp = pageList.map(c.norm);
    const got = (f.rows || []).map((x) => (x.ok ? x.text : null));
    r.check('字幕行与页面中文定稿字幕逐条、逐字、同序一致', JSON.stringify(got) === JSON.stringify(exp), `文件=${JSON.stringify((f.rows || []).map((x) => x.raw))}；页面=${JSON.stringify(exp)}`);
    r.check('导出后状态仍为“已停止”，字幕仍在', (await c.statusText(page)) === '已停止' && JSON.stringify(await c.finals(page)) === JSON.stringify(pageList), `状态=${await c.statusText(page)}`);
    results.push({ id: 'SMOKE-EXPORT', passed: r.passed(), checkpoints: r.cps, evidence: await c.saveSessionEvidence(s) });
  } finally { await c.closeSession(s); }
  await c.closeBrowser();
}
try { await main(); } catch (e) { note += ` 未产出：${String(e.message || e).split('\n')[0].slice(0, 200)}`; c.log('ERROR', e.stack || e); }
writeResult();
clearTimeout(watchdog);
process.exit(0);
