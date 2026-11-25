// Scenario groups. Each group returns an array of reported scenarios ({id, passed, checkpoints, evidence}).
// A scenario whose precondition is not reached (NotReached / Aborted) is not reported (test plan §2.1, §2.2).
import * as c from './common.mjs';
import { recorder } from './shared.mjs';
import { compareRows, nonDecreasing } from './scenarios2.mjs';

const J = (v) => JSON.stringify(v);

// ---------- G-A: TS-11, TS-01, TS-02, TS-04, TS-15 (one page) ----------
export async function groupA(audio, report) {
  const s = await c.newSession('A', audio);
  const page = s.page;
  const ctx = {};
  try {
    // TS-11
    {
      const r = recorder();
      const btn = c.exportButton(page);
      r.check('刚打开页面（未开始）时“导出字幕”可见且不可用', (await btn.count()) === 1 && (await btn.isVisible()) && (await btn.isDisabled()), `状态=${await c.statusText(page)}；按钮数=${await btn.count()}；不可用=${await btn.isDisabled().catch(() => null)}`);
      const box = await page.evaluate((hint) => {
        const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === '导出字幕');
        const h = [...document.querySelectorAll('body *')].find((x) => x.children.length === 0 && x.textContent.trim() === hint);
        if (!b || !h) return null;
        const rb = b.getBoundingClientRect(), rh = h.getBoundingClientRect();
        return { sameParent: b.parentElement === h.parentElement, dx: Math.round(rh.left - rb.right), dy: Math.round(Math.abs((rh.top + rh.bottom) / 2 - (rb.top + rb.bottom) / 2)) };
      }, c.HINT);
      const vis = await c.hintVisible(page);
      r.check('按钮旁可见说明文字“还没有可导出的字幕。出现中文定稿字幕后即可导出。”', vis && box && (box.sameParent || (box.dy < 60 && Math.abs(box.dx) < 400)), `说明可见=${vis}；相对按钮位置=${J(box)}`);
      r.check('强制点击后 5 秒内没有任何下载', await c.forceClickNoDownload(s), `下载数=${s.downloads.length}`);
      report({ id: 'TS-11', passed: r.passed(), checkpoints: r.cps, evidence: await c.saveSessionEvidence(s) });
    }
    // TS-01
    await c.start(page);
    await c.sayAndFinal(s, 's1');
    await c.sayAndFinal(s, 's2');
    await c.stop(page);
    let f1;
    {
      const r = recorder();
      const btns = page.getByRole('button', { name: '导出字幕', exact: true });
      const n = await btns.count();
      let visibleN = 0;
      for (let i = 0; i < n; i++) if (await btns.nth(i).isVisible()) visibleN++;
      r.check('主页面上有且只有 1 个可见的“导出字幕”按钮，且可用', visibleN === 1 && (await btns.first().isEnabled()), `可见按钮数=${visibleN}；可用=${await btns.first().isEnabled()}；状态=${await c.statusText(page)}；页面定稿=${(await c.finals(page)).length} 条`);
      const pos = await page.evaluate(() => {
        const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === '导出字幕');
        const list = document.getElementById('captions');
        const region = b && b.closest('section, [role="region"]');
        const scroll = list && (list.closest('.caption-scroll') || list);
        return b && { inHeader: !!b.closest('header, .topbar, [role="banner"]'), regionLabel: region?.getAttribute('aria-label') || null, regionHasList: !!(region && list && region.contains(list)), btnBottom: Math.round(b.getBoundingClientRect().bottom), listTop: Math.round(scroll.getBoundingClientRect().top) };
      });
      r.check('按钮位于字幕区顶部、字幕列表之上，不在顶栏中（D-2）', pos && !pos.inHeader && pos.regionHasList && pos.btnBottom <= pos.listTop + 1, J(pos));
      const f = await c.exportOnce(s);
      f1 = f;
      r.check('点击一次开始 1 个下载，此后 5 秒内没有第 2 个下载', f.extraDownloads === 0, `额外下载=${f.extraDownloads}`);
      r.check('下载的文件名以 .txt 结尾，文件可读取且内容非空', /\.txt$/.test(f.name) && f.bytes.length > 0 && f.utf8, `文件名=${f.name}；字节数=${f.bytes.length}；UTF-8 可解码=${f.utf8}`);
      report({ id: 'TS-01', passed: r.passed(), checkpoints: r.cps, evidence: await c.saveSessionEvidence(s, { fileName: f.name }) });
    }
    // TS-02
    try {
      const pip = page.getByRole('button', { name: '弹出字幕小窗', exact: true });
      if (await pip.isDisabled()) throw new c.NotReached('测试浏览器不支持字幕小窗');
      await pip.click();
      const opened = await c.waitFor(() => page.evaluate(() => !!(window.documentPictureInPicture && window.documentPictureInPicture.window && window.documentPictureInPicture.window.document.body && window.documentPictureInPicture.window.document.body.children.length)), 10_000, 300);
      if (!opened) throw new c.NotReached('点击“弹出字幕小窗”后没有打开小窗');
      await c.sleep(1000);
      const info = await page.evaluate(() => {
        const d = window.documentPictureInPicture.window.document;
        const finals = [...d.querySelectorAll('li[data-status="final"]:not([data-kind="notice"])')].map((li) => li.textContent);
        const named = [...d.querySelectorAll('button, [role="button"], a, input, [role="link"], [role="menuitem"]')].filter((el) => (el.getAttribute('aria-label') || el.textContent || el.value || '').trim() === '导出字幕').length;
        const anyText = [...d.querySelectorAll('body *')].filter((el) => el.children.length === 0 && el.textContent.trim() === '导出字幕').length;
        return { finals, named, anyText };
      });
      const mainFinals = await c.finals(page);
      const r = recorder();
      r.check('小窗中可见的定稿字幕与主页面一致', J(info.finals) === J(mainFinals), `小窗=${J(info.finals)}；主页面=${J(mainFinals)}`);
      r.check('小窗中没有名称为“导出字幕”的按钮或其他操作', info.named === 0 && info.anyText === 0, `小窗中名为“导出字幕”的操作数=${info.named}；文字为“导出字幕”的元素数=${info.anyText}`);
      r.check('主页面上的“导出字幕”仍在且可用', (await c.exportButton(page).isVisible()) && (await c.exportButton(page).isEnabled()), `可用=${await c.exportButton(page).isEnabled()}`);
      await page.evaluate(() => { try { window.documentPictureInPicture.window.close(); } catch {} });
      await c.sleep(500);
      report({ id: 'TS-02', passed: r.passed(), checkpoints: r.cps, evidence: await c.saveSessionEvidence(s, { pip: info }) });
    } catch (e) {
      if (!(e instanceof c.NotReached)) throw e;
      c.log('TS-02 not reported:', e.message);
    }
    // TS-04
    let f2;
    {
      await c.start(page);
      await c.sayAndFinal(s, 's3');
      await c.sayAndFinal(s, 's4');
      await c.stop(page);
      const pageList = await c.finals(page);
      f2 = await c.exportOnce(s);
      const r = recorder();
      r.check('第 1 次导出 F1 的字幕行数等于当时的页面定稿条数（前置）', f1.rows && f1.rows.length >= 1, `F1 字幕行 ${f1.rows?.length}`);
      compareRows(r.check, '再次导出 F2 与此时页面定稿字幕', f2, pageList);
      const n1 = f1.rows.length;
      r.check('F2 的前几行与 F1 的各行完全相同（文字与时刻都不变）', J(f2.rows.slice(0, n1).map((x) => x.raw)) === J(f1.rows.map((x) => x.raw)), `F1=${J(f1.rows.map((x) => x.raw))}；F2 前 ${n1} 行=${J(f2.rows.slice(0, n1).map((x) => x.raw))}`);
      r.check('F2 新增各行的时刻不早于前一行（不倒序）', f2.rows.every((x) => x.ok) && nonDecreasing(f2.rows), J(f2.rows.map((x) => x.time)));
      report({ id: 'TS-04', passed: r.passed(), checkpoints: r.cps, evidence: await c.saveSessionEvidence(s) });
    }
    // TS-15
    {
      const r = recorder();
      const keep = Buffer.from(f2.bytes);
      await page.reload({ waitUntil: 'load' });
      await page.getByRole('button', { name: '开始', exact: true }).waitFor({ state: 'visible', timeout: 20000 });
      await c.closeGuide(page);
      const checkEmpty = async (p, label) => {
        const its = await c.items(p);
        r.check(`${label}：字幕区没有任何字幕条目`, its.length === 0, `条目数=${its.length}`);
        r.check(`${label}：“导出字幕”不可用，说明文字可见`, (await c.exportButton(p).isDisabled()) && (await c.hintVisible(p)), `不可用=${await c.exportButton(p).isDisabled()}；说明可见=${await c.hintVisible(p)}`);
        r.check(`${label}：强制点击后 5 秒内没有下载`, await c.forceClickNoDownload(s, p), `下载总数=${s.downloads.length}`);
      };
      await checkEmpty(page, '(a) 刷新后');
      await page.close();
      const p2 = await c.openPage(s, s.ctx);
      s.page = p2;
      await checkEmpty(p2, '(b) 关闭后在同一浏览器重新打开');
      const { readFileSync } = await import('node:fs');
      let same = false; let obs = '';
      try { const b = readFileSync(f2.path); same = Buffer.compare(b, keep) === 0; obs = `文件仍在，${b.length} 字节`; } catch (e) { obs = `读取失败：${e.message}`; }
      r.check('已下载的文件 F 仍存在，内容与刷新前读取的完全相同', same, obs);
      report({ id: 'TS-15', passed: r.passed(), checkpoints: r.cps, evidence: await c.saveSessionEvidence(s) });
    }
  } finally {
    await c.closeSession(s);
  }
}
