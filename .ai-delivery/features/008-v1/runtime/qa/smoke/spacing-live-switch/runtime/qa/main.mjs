// Smoke: while listening, switching caption line spacing changes the shown captions at once and translation continues.
import { resolve } from 'node:path';
import { synthesize } from './tts.mjs';
import { launch, closeBrowser, newContext, openPage, chooseSpacing, statusText, finals, waitFor, writeResult, log, sleep, CAPTION_WAIT_MS } from './common.mjs';

const cps = [];
const check = (step, passed, observation) => { cps.push({ step, passed: !!passed, observation }); log(passed ? 'PASS' : 'FAIL', step, observation); };
const gapOf = (list, a, b) => { const x = list.find((i) => i.id === a), y = list.find((i) => i.id === b); return x && y ? y.tops[0] - x.tops[x.tops.length - 1] : null; };

try {
  const audio = await synthesize(resolve('speech.wav'));
  await launch(audio);
  const ctx = await newContext();
  const page = await openPage(ctx);
  await page.evaluate(() => { window.__qaMarker = 1; });
  await page.getByRole('button', { name: '开始', exact: true }).click();
  const pair = await waitFor(async () => {
    const f = await finals(page);
    const all = await page.evaluate(() => [...document.querySelectorAll('#captions > li')].map((li) => li.dataset.segmentId));
    for (let k = 0; k + 1 < f.length; k++) if (all.indexOf(f[k + 1].id) === all.indexOf(f[k].id) + 1) return [f[k].id, f[k + 1].id];
    return null;
  }, CAPTION_WAIT_MS);
  if (!pair) {
    writeResult('冒烟：行距实时切换——测试等待上限内没有出现两条相邻的已确定字幕，未报告', []);
  } else {
    const std = gapOf(await finals(page), ...pair);
    await chooseSpacing(page, '宽松');
    const loose = await waitFor(async () => { const g = gapOf(await finals(page), ...pair); return g > std + 0.5 ? g : null; }, 10_000, 250);
    await chooseSpacing(page, '紧凑');
    const compact = await waitFor(async () => { const g = gapOf(await finals(page), ...pair); return g < std - 0.5 ? g : null; }, 10_000, 250);
    const st = await statusText(page);
    const marker = await page.evaluate(() => window.__qaMarker === 1);
    check('正在听时选宽松、紧凑，同两条字幕的字幕间距立即变大、变小，页面不刷新、仍为“正在听”',
      loose != null && compact != null && st === '正在听' && marker,
      `标准 ${std?.toFixed(1)}，宽松 ${loose?.toFixed(1) ?? '未变大'}，紧凑 ${compact?.toFixed(1) ?? '未变小'}；状态=${st}；页面未刷新=${marker}`);
    await page.getByRole('button', { name: '停止', exact: true }).click();
    await sleep(500);
    writeResult('冒烟：正在听时切换字幕行距立即生效、翻译不中断', [{ id: 'SMOKE-SPACING-LIVE', passed: cps.every((c) => c.passed), checkpoints: cps, evidence: ['run.log'] }]);
  }
  await ctx.close();
} catch (e) {
  log('error', e.message);
  check('操作', false, `无法完成操作：${e.message.split('\n')[0]}`);
  writeResult('冒烟：行距实时切换——操作出错', [{ id: 'SMOKE-SPACING-LIVE', passed: false, checkpoints: cps, evidence: ['run.log'] }]);
} finally {
  await closeBrowser();
}
