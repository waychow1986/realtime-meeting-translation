import { chromium } from '/tmp/qa-run-CWDQ/node_modules/playwright/index.mjs';
const url = process.env.AIDH_SERVICE_WEB_URL;
const b = await chromium.launch();
const p = await b.newPage();
await p.goto(url);
await p.waitForTimeout(1500);
const info = await p.evaluate(() => {
  const dlg = [...document.querySelectorAll('dialog,[role=dialog],[aria-modal=true]')].map(d => ({tag:d.tagName, open: d.open ?? null, modal: d.matches(':modal'), id: d.id, cls: d.className, visible: !!(d.offsetWidth||d.offsetHeight)}));
  const radios = [...document.querySelectorAll('input[type=radio]')].map(r => ({name:r.name, value:r.value, id:r.id, label: r.labels?.[0]?.textContent?.trim(), checked:r.checked}));
  const sb = document.getElementById('start-button'); const rc = sb.getBoundingClientRect();
  const top = document.elementFromPoint(rc.x+rc.width/2, rc.y+rc.height/2);
  return { dlg, radios, topAtStart: top && (top.tagName + '#' + top.id + '.' + top.className) };
});
console.log(JSON.stringify(info, null, 1));
const btn = p.getByRole('button', { name: '知道了' });
if (await btn.count()) { await btn.first().click(); await p.waitForTimeout(500); }
const after = await p.evaluate(() => { const sb = document.getElementById('start-button'); const rc = sb.getBoundingClientRect(); const top = document.elementFromPoint(rc.x+rc.width/2, rc.y+rc.height/2); return top && (top.tagName + '#' + top.id); });
console.log('after dismiss top at start:', after);
await b.close();
