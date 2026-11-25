// Smoke (backfilled old main path): start listening to English speech, Chinese captions appear, stop keeps captions.
import { resolve } from 'node:path';
import { synthesize } from './tts.mjs';
import { launch, closeBrowser, newContext, openPage, statusText, finals, waitFor, writeResult, log, sleep, CAPTION_WAIT_MS } from './common.mjs';

const cps = [];
const check = (step, passed, observation) => { cps.push({ step, passed: !!passed, observation }); log(passed ? 'PASS' : 'FAIL', step, observation); };
const CJK = /[\u4e00-\u9fff]/;

try {
  const audio = await synthesize(resolve('speech.wav'));
  await launch(audio);
  const ctx = await newContext({ width: 1366, height: 900 });
  const page = await openPage(ctx);
  await page.getByRole('button', { name: '开始', exact: true }).click();
  const listening = await waitFor(async () => ((await statusText(page)) === '正在听' ? true : null), 30_000, 500);
  const got = await waitFor(async () => { const f = await finals(page); return f.some((i) => CJK.test(i.text)) ? f : null; }, CAPTION_WAIT_MS);
  if (!got) {
    writeResult('冒烟：实时字幕主路径——测试等待上限内没有出现中文字幕，未报告', []);
  } else {
    check('开始后状态为“正在听”，出现中文字幕', listening === true && got.length >= 1,
      `状态曾为“正在听”=${!!listening}；已确定字幕 ${got.length} 条；首条长度 ${got[0].text.length} 字`);
    await page.getByRole('button', { name: '停止', exact: true }).click();
    const stopped = await waitFor(async () => ((await statusText(page)) === '已停止' ? true : null), 15_000, 500);
    await sleep(500);
    const after = await finals(page);
    check('停止后状态为“已停止”，已有字幕保留', !!stopped && after.length >= got.length, `状态=${await statusText(page)}；停止后字幕 ${after.length} 条`);
    check('没有未捕获的页面脚本错误', page.__errors.length === 0, `页面脚本错误=${JSON.stringify(page.__errors)}`);
    writeResult('冒烟（补的老主路径）：开始收听英文语音后出现中文字幕，停止后字幕保留', [{ id: 'SMOKE-LIVE-CAPTIONS', passed: cps.every((c) => c.passed), checkpoints: cps, evidence: ['run.log'] }]);
  }
  await ctx.close();
} catch (e) {
  log('error', e.message);
  check('操作', false, `无法完成操作：${e.message.split('\n')[0]}`);
  writeResult('冒烟：实时字幕主路径——操作出错', [{ id: 'SMOKE-LIVE-CAPTIONS', passed: false, checkpoints: cps, evidence: ['run.log'] }]);
} finally {
  await closeBrowser();
}
