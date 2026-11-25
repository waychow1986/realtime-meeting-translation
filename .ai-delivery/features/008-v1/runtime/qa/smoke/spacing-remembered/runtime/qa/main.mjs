// Smoke: the chosen caption line spacing is remembered when the page is opened again in the same browser.
import { launch, closeBrowser, newContext, openPage, chooseSpacing, checkedSpacing, writeResult, log } from './common.mjs';

const cps = [];
const check = (step, passed, observation) => { cps.push({ step, passed: !!passed, observation }); log(passed ? 'PASS' : 'FAIL', step, observation); };
const attr = (page) => page.evaluate(() => document.getElementById('caption-panel')?.dataset.captionSpacing ?? null);

try {
  // No translation in this case, so the fake microphone needs no audio file.
  await launch('/dev/null');
  const ctx = await newContext({ width: 1366, height: 900 });
  let page = await openPage(ctx);
  const first = await checkedSpacing(page);
  check('全新打开时行距为“标准”', JSON.stringify(first) === '["标准"]', `行距选中=${JSON.stringify(first)}`);
  await chooseSpacing(page, '宽松');
  const next = await openPage(ctx);
  await page.close();
  page = next;
  const sp = await checkedSpacing(page), a = await attr(page);
  check('选“宽松”后关闭并在同一浏览器再次打开，仍为“宽松”且字幕区按宽松显示', JSON.stringify(sp) === '["宽松"]' && a === 'loose', `行距选中=${JSON.stringify(sp)}；字幕区档位标记=${a}`);
  // Clean up: back to the default.
  await chooseSpacing(page, '标准');
  await ctx.close();
  writeResult('冒烟：字幕行距的选择在同一浏览器中再次打开时恢复', [{ id: 'SMOKE-SPACING-REMEMBERED', passed: cps.every((c) => c.passed), checkpoints: cps, evidence: ['run.log'] }], []);
} catch (e) {
  log('error', e.message);
  check('操作', false, `无法完成操作：${e.message.split('\n')[0]}`);
  writeResult('冒烟：行距恢复——操作出错', [{ id: 'SMOKE-SPACING-REMEMBERED', passed: false, checkpoints: cps, evidence: ['run.log'] }], []);
} finally {
  await closeBrowser();
}
