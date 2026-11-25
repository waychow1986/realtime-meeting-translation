// Scenarios that do not need a running translation: TS-01, TS-03, TS-05, TS-09, TS-14.
import {
  Scenario, Recorder, newContext, openPage, reopen, openDisplay, chooseSpacing, chooseSize, checkedIn,
  panelAttr, panelBg, BG_EXPECTED, SPACING_LABEL, spacingGroup, screenshot, sleep,
} from './lib.mjs';

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export async function ts01() {
  const s = new Scenario('TS-01');
  const rec = new Recorder('TS-01');
  const ctx = await newContext();
  try {
    const page = await openPage(ctx, rec);
    await openDisplay(page);
    const group = spacingGroup(page);
    const visible = await group.isVisible();
    const radios = group.getByRole('radio');
    const n = await radios.count();
    const names = [];
    for (let i = 0; i < n; i++) names.push(await radios.nth(i).evaluate((el) => (el.labels?.[0]?.textContent || '').trim()));
    s.check('1 打开“字幕显示”，有“行距”分组且含“紧凑”“标准”“宽松”', visible && ['紧凑', '标准', '宽松'].every((x) => names.includes(x)),
      `分组“行距”可见=${visible}；其中单选项=${JSON.stringify(names)}`);
    let ok = true; const obs = [];
    for (const key of ['compact', 'loose', 'normal', 'loose']) {
      await chooseSpacing(page, key);
      const c = await checkedIn(page, '行距');
      const good = same(c, [SPACING_LABEL[key]]);
      ok &&= good; obs.push(`选${SPACING_LABEL[key]}→选中${JSON.stringify(c)}`);
    }
    s.check('2 依次选紧凑、宽松、标准、宽松，每次恰有一档选中且为刚选的', ok, obs.join('；'));
    await chooseSize(page, 'l');
    const sp = await checkedIn(page, '行距');
    s.check('3 选字号“大”后行距仍为“宽松”', same(sp, ['宽松']), `行距选中=${JSON.stringify(sp)}`);
    await chooseSpacing(page, 'compact');
    const sz = await checkedIn(page, '字号');
    s.check('4 选行距“紧凑”后字号仍为“大”', same(sz, ['大']), `字号选中=${JSON.stringify(sz)}；行距选中=${JSON.stringify(await checkedIn(page, '行距'))}`);
    s.check('5 未开始翻译，在主页面完成以上操作', rec.pageErrors.length === 0, `页面脚本错误=${JSON.stringify(rec.pageErrors)}`);
    if (!s.passed) s.ev(await screenshot(page, 'TS-01-final'));
  } finally { s.ev(rec.flush()); await ctx.close(); }
  return s;
}

export async function ts03() {
  const s = new Scenario('TS-03');
  const rec = new Recorder('TS-03');
  {
    const ctx = await newContext();
    try {
      const page = await openPage(ctx, rec, 'fresh');
      const sp = await checkedIn(page, '行距'); const sz = await checkedIn(page, '字号'); const attr = await panelAttr(page);
      s.check('1 首次打开：行距“标准”选中、字号“中”、字幕区档位标记 normal', same(sp, ['标准']) && same(sz, ['中']) && attr === 'normal',
        `行距选中=${JSON.stringify(sp)}；字号选中=${JSON.stringify(sz)}；data-caption-spacing=${attr}`);
      const bg = await panelBg(page);
      s.check('2 字幕区背景为 rgb(13, 17, 23)、不透明', bg === BG_EXPECTED, `字幕区背景=${bg}`);
      if (!s.passed) s.ev(await screenshot(page, 'TS-03-fresh'));
    } finally { await ctx.close(); }
  }
  for (const v of ['tight', 'Loose', '']) {
    const ctx = await newContext({ initScript: `try { localStorage.setItem('rtmt.captionSpacing', ${JSON.stringify(v)}); } catch (e) {}` });
    const before = rec.pageErrors.length;
    try {
      const page = await openPage(ctx, rec, `preset-${v || 'empty'}`);
      await sleep(500);
      const sp = await checkedIn(page, '行距'); const attr = await panelAttr(page);
      const errs = rec.pageErrors.slice(before);
      s.check(`3 预置无法识别的保存值 ${JSON.stringify(v)}：页面正常、无脚本错误、“标准”选中、标记 normal`,
        same(sp, ['标准']) && attr === 'normal' && errs.length === 0,
        `行距选中=${JSON.stringify(sp)}；data-caption-spacing=${attr}；页面脚本错误=${JSON.stringify(errs)}`);
    } catch (e) {
      s.check(`3 预置无法识别的保存值 ${JSON.stringify(v)}`, false, `页面无法正常打开或操作：${e.message}`);
    } finally { await ctx.close(); }
  }
  {
    const ctx = await newContext({ initScript: `try { localStorage.setItem('rtmt.captionSpacing', 'loose'); } catch (e) {}` });
    try {
      const page = await openPage(ctx, rec, 'preset-loose');
      const sp = await checkedIn(page, '行距');
      s.check('4 对照：预置 loose 时“宽松”选中', same(sp, ['宽松']), `行距选中=${JSON.stringify(sp)}`);
    } finally { await ctx.close(); }
  }
  s.ev(rec.flush());
  return s;
}

export async function ts05() {
  const s = new Scenario('TS-05');
  const rec = new Recorder('TS-05');
  const ctx = await newContext();
  try {
    const page = await openPage(ctx, rec);
    await openDisplay(page);
    const found = await page.evaluate(() => {
      const roots = [document.querySelector('header'), document.getElementById('display-panel')].filter(Boolean);
      const hits = [];
      for (const root of roots) {
        for (const el of root.querySelectorAll('*')) {
          const own = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join('');
          const attrs = ['aria-label', 'title', 'placeholder', 'name', 'id', 'value'].map((a) => el.getAttribute(a) || '').join(' ');
          if (/透明|opacity|transparen/i.test(own + ' ' + attrs)) hits.push(el.outerHTML.slice(0, 160));
        }
        for (const el of root.querySelectorAll('input[type=range]')) hits.push(el.outerHTML.slice(0, 160));
      }
      return hits;
    });
    s.check('1 顶栏与“字幕显示”浮层中没有背景透明度设置', found.length === 0, found.length ? `发现：${JSON.stringify(found)}` : '没有名称或标签含“透明”的控件，也没有滑块');
    const obs = []; let ok = true;
    for (const key of ['compact', 'normal', 'loose']) {
      await chooseSpacing(page, key);
      const bg = await panelBg(page);
      ok &&= bg === BG_EXPECTED; obs.push(`${SPACING_LABEL[key]}：${bg}`);
    }
    s.check('2 三档行距下字幕区背景始终为 rgb(13, 17, 23)、不透明', ok, obs.join('；'));
    if (!s.passed) s.ev(await screenshot(page, 'TS-05'));
  } finally { s.ev(rec.flush()); await ctx.close(); }
  return s;
}

export async function ts09() {
  const s = new Scenario('TS-09');
  const rec = new Recorder('TS-09');
  const ctx = await newContext();
  try {
    let page = await openPage(ctx, rec, 'p1');
    await chooseSpacing(page, 'loose'); await chooseSize(page, 'l');
    page = await reopen(ctx, page, rec, 'p2');
    let sp = await checkedIn(page, '行距'), sz = await checkedIn(page, '字号'), attr = await panelAttr(page);
    s.check('1 选宽松、大，关闭后再打开：宽松、大选中，标记 loose', same(sp, ['宽松']) && same(sz, ['大']) && attr === 'loose',
      `行距=${JSON.stringify(sp)}；字号=${JSON.stringify(sz)}；data-caption-spacing=${attr}`);
    await chooseSpacing(page, 'compact');
    page = await reopen(ctx, page, rec, 'p3');
    sp = await checkedIn(page, '行距'); sz = await checkedIn(page, '字号');
    s.check('2 选紧凑，关闭后再打开：紧凑选中，字号仍为大', same(sp, ['紧凑']) && same(sz, ['大']), `行距=${JSON.stringify(sp)}；字号=${JSON.stringify(sz)}`);
    await chooseSpacing(page, 'normal');
    page = await reopen(ctx, page, rec, 'p4');
    sp = await checkedIn(page, '行距');
    s.check('3 选标准，关闭后再打开：标准选中', same(sp, ['标准']), `行距=${JSON.stringify(sp)}`);
    await chooseSpacing(page, 'loose');
    await page.reload({ waitUntil: 'load' });
    await page.getByRole('button', { name: '字幕显示' }).waitFor({ state: 'visible' });
    sp = await checkedIn(page, '行距');
    s.check('4 选宽松后刷新：宽松选中', same(sp, ['宽松']), `行距=${JSON.stringify(sp)}`);
    await chooseSize(page, 's');
    page = await reopen(ctx, page, rec, 'p5');
    sp = await checkedIn(page, '行距'); sz = await checkedIn(page, '字号');
    s.check('5 只改字号为小，关闭后再打开：字号小、行距宽松', same(sp, ['宽松']) && same(sz, ['小']), `行距=${JSON.stringify(sp)}；字号=${JSON.stringify(sz)}`);
    if (!s.passed) s.ev(await screenshot(page, 'TS-09-ctx1'));
  } finally { await ctx.close(); }
  {
    const ctx2 = await newContext();
    try {
      const page = await openPage(ctx2, rec, 'other-context');
      const sp = await checkedIn(page, '行距'), sz = await checkedIn(page, '字号');
      s.check('6 另一个全新浏览器上下文：标准、中选中，不带入', same(sp, ['标准']) && same(sz, ['中']), `行距=${JSON.stringify(sp)}；字号=${JSON.stringify(sz)}`);
    } finally { await ctx2.close(); }
  }
  {
    const ctx3 = await newContext({ initScript: `try { localStorage.setItem('rtmt.captionSize', 'l'); } catch (e) {}` });
    try {
      const page = await openPage(ctx3, rec, 'legacy-size');
      const sp = await checkedIn(page, '行距'), sz = await checkedIn(page, '字号');
      s.check('7 按交付前方式预置字号 l：字号大、行距标准选中', same(sp, ['标准']) && same(sz, ['大']), `行距=${JSON.stringify(sp)}；字号=${JSON.stringify(sz)}`);
    } finally { await ctx3.close(); }
  }
  s.ev(rec.flush());
  return s;
}

export const STORAGE_DENIED = `(() => {
  Object.defineProperty(window, 'localStorage', { configurable: true, get() { throw new DOMException('The operation is insecure.', 'SecurityError'); } });
})();`;
export const STORAGE_NO_WRITE = `(() => {
  Storage.prototype.setItem = function () { throw new DOMException('The quota has been exceeded.', 'QuotaExceededError'); };
})();`;

export async function ts14() {
  const s = new Scenario('TS-14');
  const rec = new Recorder('TS-14');
  for (const [tag, script] of [['A 读取被拒', STORAGE_DENIED], ['B 能读不能写', STORAGE_NO_WRITE]]) {
    const ctx = await newContext({ initScript: script });
    const before = rec.pageErrors.length;
    try {
      let page = await openPage(ctx, rec, tag[0]);
      await sleep(800);
      const startOk = await page.getByRole('button', { name: '开始', exact: true }).isEnabled();
      await openDisplay(page);
      const panelOk = await spacingGroup(page).isVisible();
      let sp = await checkedIn(page, '行距');
      s.check(`${tag}：1 页面正常打开、控件可用、标准选中、无脚本错误`,
        startOk && panelOk && same(sp, ['标准']) && rec.pageErrors.length === before,
        `“开始”可用=${startOk}；“字幕显示”浮层可打开=${panelOk}；行距=${JSON.stringify(sp)}；页面脚本错误=${JSON.stringify(rec.pageErrors.slice(before))}`);
      await chooseSpacing(page, 'loose');
      sp = await checkedIn(page, '行距'); let attr = await panelAttr(page);
      s.check(`${tag}：2 选宽松：宽松选中、标记 loose、无脚本错误`, same(sp, ['宽松']) && attr === 'loose' && rec.pageErrors.length === before,
        `行距=${JSON.stringify(sp)}；data-caption-spacing=${attr}；页面脚本错误=${JSON.stringify(rec.pageErrors.slice(before))}`);
      await chooseSpacing(page, 'compact');
      sp = await checkedIn(page, '行距'); attr = await panelAttr(page);
      s.check(`${tag}：3 选紧凑：紧凑选中、标记 compact`, same(sp, ['紧凑']) && attr === 'compact', `行距=${JSON.stringify(sp)}；data-caption-spacing=${attr}`);
      page = await reopen(ctx, page, rec, `${tag[0]}-reopen`);
      sp = await checkedIn(page, '行距');
      s.check(`${tag}：4 关闭后再打开：标准选中`, same(sp, ['标准']), `行距=${JSON.stringify(sp)}`);
      if (!s.passed) s.ev(await screenshot(page, `TS-14-${tag[0]}`));
    } catch (e) {
      s.check(`${tag}：页面操作`, false, `无法完成操作：${e.message}`);
    } finally { await ctx.close(); }
  }
  s.ev(rec.flush());
  return s;
}
