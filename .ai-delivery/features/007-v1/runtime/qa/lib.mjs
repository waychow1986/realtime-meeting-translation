// 驱动层：浏览器、播放器标签页、页面操作与观察。
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

// playwright 安装在工作目录（脚本所在位置只读），按工作目录解析。
const { chromium } = createRequire(path.join(process.cwd(), 'noop.js'))('playwright');

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const INIT_SCRIPT = fs.readFileSync(path.join(HERE, 'page-init.js'), 'utf8');
export const PLAYER_TITLE = 'RTMT-player';
export const WEB_URL = (process.env.AIDH_SERVICE_WEB_URL || '').replace(/\/$/, '');
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const STATE = { idle: '未开始', starting: '正在启动…', running: '正在听', stopped: '已停止', error: '出错' };
export const MSG_INTERRUPTED = '翻译已中断，请稍后重新开始。';
export const MSG_SHARE_ENDED_PREFIX = '共享已结束，翻译已停止';
export const MSG_SHARE_ENDED = '共享已结束，翻译已停止。如需继续，请点击“开始”并重新选择共享内容。';

// 3.1：停滞中断提示 = 表达“翻译已中断” + “点击开始并重新选择共享内容重新开始”，且不同于既有两条提示。
export function isStallNotice(text) {
  if (!text) return false;
  const t = text.trim();
  if (t === MSG_INTERRUPTED || t.startsWith(MSG_SHARE_ENDED_PREFIX)) return false;
  const interrupted = /中断|已停止输出|停止输出/.test(t);
  const restart = /开始/.test(t) && /(重新)/.test(t) && /共享/.test(t);
  return interrupted && restart;
}

// ---- 播放器（本地 HTTP 服务，页面标题 RTMT-player） ----
export function startPlayerServer(materials) {
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${PLAYER_TITLE}</title></head><body>
<audio id="a" preload="auto"></audio>
<script>
const a = document.getElementById('a');
window.__p = { log: [] };
a.addEventListener('ended', () => { if (a.loop) { a.currentTime = 0; a.play(); window.__p.log.push({ at: Date.now(), ev: 'replay' }); } });
window.playSeg = async (name, loop) => { a.loop = !!loop; if (!a.src.endsWith('/' + name + '.wav')) a.src = '/' + name + '.wav'; a.currentTime = 0; await a.play(); window.__p.log.push({ at: Date.now(), ev: 'play', name }); return Date.now(); };
window.silence = () => { a.pause(); window.__p.log.push({ at: Date.now(), ev: 'pause' }); return Date.now(); };
window.resumeSeg = async () => { await a.play(); window.__p.log.push({ at: Date.now(), ev: 'resume' }); return Date.now(); };
</script></body></html>`;
  const server = http.createServer((req, res) => {
    const u = req.url.split('?')[0];
    if (u === '/' || u === '/player.html') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(html); }
    const m = /^\/(speech|voiced)\.wav$/.exec(u);
    if (m) {
      // 支持 Range 请求：没有它，Chromium 无法回到开头，循环播放只放一遍。
      const buf = fs.readFileSync(materials[m[1] + 'Path']);
      const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
      if (range) {
        const start = range[1] ? Number(range[1]) : 0;
        const end = range[2] ? Math.min(Number(range[2]), buf.length - 1) : buf.length - 1;
        res.writeHead(206, { 'content-type': 'audio/wav', 'accept-ranges': 'bytes', 'content-range': `bytes ${start}-${end}/${buf.length}`, 'content-length': end - start + 1 });
        return res.end(buf.subarray(start, end + 1));
      }
      res.writeHead(200, { 'content-type': 'audio/wav', 'accept-ranges': 'bytes', 'content-length': buf.length });
      return res.end(buf);
    }
    res.writeHead(404); res.end();
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}/player.html` })));
}

export async function launchBrowser(extraArgs = []) {
  return chromium.launch({
    headless: false,
    args: [
      `--auto-select-tab-capture-source-by-title=${PLAYER_TITLE}`,
      '--autoplay-policy=no-user-gesture-required',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
      ...extraArgs,
    ],
  });
}

// 一次“运行”：新的浏览器上下文 + 主页面（+ 可选播放器标签页）。
export class Session {
  constructor(browser, playerUrl, ev, name) {
    this.browser = browser; this.playerUrl = playerUrl; this.ev = ev; this.name = name; this.log = [];
  }
  note(msg) { const line = `${new Date().toISOString()} [${this.name}] ${msg}`; this.log.push(line); console.log(line); }

  async open({ withPlayer = true, permissions = [] } = {}) {
    this.context = await this.browser.newContext({ viewport: { width: 1280, height: 800 } });
    if (permissions.length) await this.context.grantPermissions(permissions, { origin: WEB_URL });
    await this.context.addInitScript({ content: INIT_SCRIPT });
    this.net = [];
    this.context.on('request', (r) => { if (/\/api\//.test(r.url())) this.net.push({ at: Date.now(), method: r.method(), url: r.url().replace(WEB_URL, '') }); });
    this.context.on('response', (r) => { if (/\/api\//.test(r.url())) this.net.push({ at: Date.now(), status: r.status(), url: r.url().replace(WEB_URL, '') }); });
    this.context.on('websocket', (ws) => {
      const host = (() => { try { return new URL(ws.url()).host; } catch { return '?'; } })();
      const e = { at: Date.now(), ws: host, inFrames: 0, outFrames: 0 };
      this.net.push(e);
      ws.on('framereceived', () => e.inFrames++);
      ws.on('framesent', () => e.outFrames++);
      ws.on('close', () => { e.closedAt = Date.now(); });
      ws.on('socketerror', (err) => { e.error = String(err).slice(0, 200); });
    });
    if (withPlayer) {
      this.player = await this.context.newPage();
      await this.player.goto(this.playerUrl);
    }
    this.page = await this.context.newPage();
    this.console = [];
    this.page.on('console', (m) => this.console.push(`${new Date().toISOString()} ${m.type()} ${m.text().slice(0, 300)}`));
    this.page.on('pageerror', (e) => this.console.push(`${new Date().toISOString()} pageerror ${String(e).slice(0, 300)}`));
    await this.page.goto(WEB_URL + '/');
    const ok = this.page.getByRole('button', { name: '知道了' });
    try { await ok.click({ timeout: 5000 }); } catch { /* 引导未显示 */ }
  }

  async play(name, loop = true) { return this.player.evaluate(([n, l]) => window.playSeg(n, l), [name, loop]); }
  async pausePlayer() { return this.player.evaluate(() => window.silence()); }
  async resumePlayer() { return this.player.evaluate(() => window.resumeSeg()); }

  status() { return this.page.getByRole('status').first(); }
  async statusText() { return ((await this.page.locator('#status').textContent()) || '').trim(); }
  async noticeText() {
    const alert = this.page.getByRole('alert');
    if (!(await alert.isVisible().catch(() => false))) return '';
    return ((await alert.textContent()) || '').trim();
  }
  async qa() {
    return this.page.evaluate(() => {
      const T = window.__qa;
      return { states: T.states, notices: T.notices, finals: T.finals, blockAt: T.blockAt, wsCount: T.wsCount, wsInDropped: T.wsInDropped, wsInDelivered: T.wsInDelivered, translateHits: T.translateHits, noticeTexts: T.noticeTexts, captions: T.captions, ctxCount: T.ctxCount };
    });
  }
  async finalIds() {
    return this.page.evaluate(() => Array.from(document.querySelectorAll('#captions li.caption[data-status="final"]')).filter((li) => li.getAttribute('data-kind') !== 'notice').map((li) => ({ id: li.getAttribute('data-segment-id'), text: (li.textContent || '').trim() })));
  }
  async buttons() {
    return {
      startEnabled: await this.page.getByRole('button', { name: '开始', exact: true }).isEnabled(),
      stopEnabled: await this.page.getByRole('button', { name: '停止', exact: true }).isEnabled(),
      micEnabled: await this.page.getByRole('radio', { name: '麦克风' }).isEnabled(),
      sysEnabled: await this.page.getByRole('radio', { name: '系统声音' }).isEnabled(),
    };
  }

  // 选择输入方式并点击“开始”；等待“正在听”与第一条（新的）中文定稿字幕。
  async start(source, limitMs = 90_000) {
    await this.page.bringToFront();
    await this.page.getByRole('radio', { name: source }).check();
    const before = new Set((await this.finalIds()).map((f) => f.id));
    const clickAt = Date.now();
    await this.page.getByRole('button', { name: '开始', exact: true }).click();
    const deadline = clickAt + limitMs;
    let running = false;
    while (Date.now() < deadline) {
      const after = (await this.page.evaluate(() => window.__qa.states)).filter((x) => x.at >= clickAt);
      if (after.some((x) => x.text === STATE.running)) running = true;
      const bad = after.find((x) => x.text === STATE.error || x.text === STATE.stopped);
      if (bad) { const s = bad.text; this.note(`start: state=${s} notice=${await this.noticeText()}`); return { ok: false, reason: `state ${s}`, clickAt }; }
      if (running) {
        const f = (await this.finalIds()).filter((x) => !before.has(x.id));
        if (f.length) { this.note(`start: running + first final after ${Date.now() - clickAt} ms`); return { ok: true, clickAt, runningSeen: true }; }
      }
      await sleep(250);
    }
    this.note(`start: timeout (running=${running})`);
    return { ok: false, reason: running ? 'no final caption within limit' : 'not running within limit', clickAt };
  }

  async waitForNewFinal(afterIds, limitMs) {
    const deadline = Date.now() + limitMs;
    while (Date.now() < deadline) {
      const f = (await this.finalIds()).filter((x) => !afterIds.has(x.id));
      if (f.length) return true;
      await sleep(250);
    }
    return false;
  }

  async waitForCaptionUpdate(limitMs) {
    const n0 = await this.page.evaluate(() => Object.values(window.__qa.captions).map((c) => c.status + c.len).join('|'));
    const deadline = Date.now() + limitMs;
    while (Date.now() < deadline) {
      const n = await this.page.evaluate(() => Object.values(window.__qa.captions).map((c) => c.status + c.len).join('|'));
      if (n !== n0) return true;
      await sleep(100);
    }
    return false;
  }

  async blockRecognizer() { return this.page.evaluate(() => window.__qa.block()); }
  async mixAction(action) {
    return this.page.evaluate(async (a) => {
      const T = window.__qa;
      if (!T.mix) return { ok: false, reason: 'no mix AudioContext recorded' };
      const at = Date.now();
      if (a === 'suspend') await T.mix.suspend();
      else if (a === 'close') await T.mix.close();
      else if (a === 'stopTrack') { if (!T.mixDest) return { ok: false, reason: 'no mix destination recorded' }; T.mixDest.stream.getAudioTracks()[0].stop(); }
      return { ok: true, at, state: T.mix.state };
    }, action);
  }
  async setTranslateMode(mode) { return this.page.evaluate((m) => { window.__qa.translateMode = m; }, mode); }
  async liveCaptureTracks() { return this.page.evaluate(() => window.__qa.liveCaptureTracks()); }

  async waitState(text, limitMs) {
    const deadline = Date.now() + limitMs;
    while (Date.now() < deadline) { if ((await this.statusText()) === text) return true; await sleep(200); }
    return false;
  }

  async saveEvidence(tag) {
    const files = [];
    try {
      const data = await this.qa().catch(() => null);
      // 不写字幕文本：只保留时间、状态、长度。
      const f = `${this.name}-${tag}-timeline.json`;
      fs.writeFileSync(path.join(this.ev, f), JSON.stringify({ timeline: data, network: this.net, log: this.log }, null, 1));
      files.push(f);
      const c = `${this.name}-${tag}-console.log`;
      fs.writeFileSync(path.join(this.ev, c), (this.console || []).join('\n'));
      files.push(c);
      const s = `${this.name}-${tag}.png`;
      await this.page.screenshot({ path: path.join(this.ev, s), timeout: 10_000 }).then(() => files.push(s)).catch(() => {});
    } catch (e) { console.log('evidence error', e.message); }
    return files;
  }

  // 画中画字幕小窗：点击“弹出字幕小窗”，读取小窗中的状态文字。
  async openPip() {
    await this.page.bringToFront();
    await this.page.getByRole('button', { name: '弹出字幕小窗' }).click();
    for (let i = 0; i < 20; i++) {
      if (await this.page.evaluate(() => !!(window.documentPictureInPicture && window.documentPictureInPicture.window))) return true;
      await sleep(250);
    }
    return false;
  }
  async pipStatus() {
    return this.page.evaluate(() => {
      const w = window.documentPictureInPicture && window.documentPictureInPicture.window;
      if (!w) return null;
      const el = w.document.getElementById('pip-status');
      return el ? (el.textContent || '').trim() : null;
    });
  }
  async reopenPlayer() {
    this.player = await this.context.newPage();
    await this.player.goto(this.playerUrl);
  }

  async close() { try { await this.context.close(); } catch { /* ignore */ } }
}

// 观察窗口：在 [from, to] 内是否出现过停滞提示、状态是否一直为给定值。
export function windowCheck(qa, from, to) {
  const notices = qa.notices.filter((n) => n.at <= to);
  const stallSeen = notices.some((n, i) => isStallNotice(n.text) && (n.at >= from || (notices[i + 1] ? notices[i + 1].at > from : true)));
  const statesIn = [];
  let cur = null;
  for (const s of qa.states) { if (s.at <= from) cur = s; else if (s.at <= to) statesIn.push(s); }
  return { stallSeen, startState: cur && cur.text, changes: statesIn.map((s) => s.text) };
}

export function firstStateAfter(qa, text, from) {
  const s = qa.states.find((x) => x.at >= from && x.text === text);
  return s ? s.at : null;
}
export function firstLeaveRunning(qa, from) {
  const s = qa.states.find((x) => x.at >= from && x.text !== STATE.running);
  return s || null;
}
