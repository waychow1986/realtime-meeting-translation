#!/usr/bin/env bash
# 独立测试脚本：003-v1 韩语字幕显示原文与中止请求误报错误
# 测试计划见同 Feature 目录下的 tasks-qa.md。本脚本在空的临时工作目录中运行，不依赖仓库源码；
# 素材全部在运行时合成。写出有效结果后以零状态退出。
set -uo pipefail

WORK="$(pwd)"
export QA_T0_EPOCH="$(date +%s)"
: "${QA_RESULT_PATH:?QA_RESULT_PATH 未设置}"
: "${QA_EVIDENCE_DIR:?QA_EVIDENCE_DIR 未设置}"
mkdir -p "$QA_EVIDENCE_DIR"
SETUP_LOG="$QA_EVIDENCE_DIR/setup.log"

env_fail() {
  local reason="$1"
  jq -n --arg sha "${QA_CANDIDATE_SHA:-}" --arg r "$reason" '{
    passed: false, testedCommitSha: $sha,
    summary: ("执行环境或平台问题，未能完成测试：" + $r),
    defects: [], testGaps: [], evidence: ["setup.log"],
    bugfixResults: [{bugfixId: "IR-001", verdict: "partial", evidence: ("环境问题，未能验证：" + $r)}],
    scenarios: []
  }' > "$QA_RESULT_PATH"
}

echo "[setup] $(date -u +%FT%TZ) workdir=$WORK" >> "$SETUP_LOG"
{
  npm init -y >/dev/null
  npm i --no-audit --no-fund --loglevel=error playwright@1.65.1
} >> "$SETUP_LOG" 2>&1 || { env_fail "npm 安装 playwright 失败"; exit 0; }
node node_modules/playwright/cli.js install chromium >> "$SETUP_LOG" 2>&1 || echo "[setup] playwright install chromium 返回非零" >> "$SETUP_LOG"
{
  python3 -m venv tts-venv && tts-venv/bin/pip install -q edge-tts
} >> "$SETUP_LOG" 2>&1 || echo "[setup] edge-tts 安装失败，将尝试 espeak-ng" >> "$SETUP_LOG"

# ---------------------------------------------------------------------------
# 浏览器初始化脚本：fetch 包装（受控触发，G2 决定 I1/TD-310）、媒体输入替换、字幕与小窗记录
# ---------------------------------------------------------------------------
cat > inpage.js <<'QA_INPAGE_EOF'
(() => {
  if (window.top !== window || window.__qaInstalled) return;
  window.__qaInstalled = true;
  const CFG = window.__QA_CFG || {};
  const now = () => performance.now();
  const RE_HANGUL = /[\u1100-\u11FF\u3130-\u318F\uA960-\uA97F\uAC00-\uD7AF\uD7B0-\uD7FF]/;
  const RE_KANA = /[\u3040-\u309F\u30A0-\u30FA\u30FC-\u30FF\u31F0-\u31FF\uFF66-\uFF9F]/;
  const RE_HAN_G = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/g;
  const isHanCode = (c) => (c >= 0x3400 && c <= 0x4DBF) || (c >= 0x4E00 && c <= 0x9FFF) || (c >= 0xF900 && c <= 0xFAFF);

  // ---------------- fetch 包装 ----------------
  const REQ = (window.__qaReq = []);
  window.__qaArmed = false;
  let seq = 0;
  let interimInjected = 0;
  const origFetch = window.fetch.bind(window);
  const sleep = (ms, signal) => new Promise((res, rej) => {
    const t = setTimeout(res, ms);
    if (signal) signal.addEventListener('abort', () => { clearTimeout(t); rej(new DOMException('aborted', 'AbortError')); }, { once: true });
  });

  function corruptText(s) {
    s = s.replace(RE_HAN_G, '\uD55C');
    return s.replace(/\\u([0-9a-fA-F]{4})/g, (m, h) => (isHanCode(parseInt(h, 16)) ? '\\ud55c' : m));
  }
  function primaryText(obj) {
    if (!obj || typeof obj !== 'object') return typeof obj === 'string' ? obj : '';
    const pref = ['text', 'sourceText', 'source_text', 'source', 'input', 'content', 'utterance', 'transcript', 'q', 'segment', 'sentence'];
    for (const k of pref) if (typeof obj[k] === 'string' && obj[k].trim()) return obj[k];
    let best = '';
    for (const v of Object.values(obj)) if (typeof v === 'string' && v.length > best.length) best = v;
    return best;
  }
  function deepFind(obj, fn, depth = 0) {
    if (!obj || typeof obj !== 'object' || depth > 3) return undefined;
    for (const [k, v] of Object.entries(obj)) {
      const r = fn(k, v);
      if (r !== undefined) return r;
      if (v && typeof v === 'object') { const r2 = deepFind(v, fn, depth + 1); if (r2 !== undefined) return r2; }
    }
    return undefined;
  }
  function classify(obj) {
    const retrans = !!deepFind(obj, (k, v) => (/retrans/i.test(k) && v ? true : undefined));
    const marker = deepFind(obj, (k, v) => {
      if (/retrans/i.test(k)) return undefined;
      if (typeof v === 'boolean' && /final/i.test(k)) return v;
      if (typeof v === 'boolean' && /(interim|partial|temp)/i.test(k)) return !v;
      if (typeof v === 'string' && /(final|stage|phase|kind|mode|type|status)/i.test(k)) {
        if (/^(final|finali[sz]ed?|definitive)$/i.test(v)) return true;
        if (/^(interim|partial|temp|temporary|provisional|draft|recognizing)$/i.test(v)) return false;
      }
      return undefined;
    });
    return { retrans, marker: marker === undefined ? null : marker };
  }
  function sentenceOf(src) {
    const ss = CFG.sentences || [];
    for (let i = 0; i < ss.length; i++) if ((ss[i].kw || []).some((k) => src.includes(k))) return i;
    return -1;
  }
  function audioEnded(i, padMs) {
    const tl = window.__qaTL;
    if (!tl || !tl.s[i]) return false;
    return now() > tl.t0 + tl.s[i].end * 1000 + padMs;
  }
  function decide(rec) {
    const inj = CFG.inject;
    if (!inj || rec.sentence < 0 || !(inj.targets || []).includes(rec.sentence)) return 'pass';
    const finalPhase = rec.marker === true || (rec.marker === null && audioEnded(rec.sentence, 200));
    const interimPhase = rec.marker === false || (rec.marker === null && !audioEnded(rec.sentence, -800));
    switch (inj.mode) {
      case 'final': return !rec.retrans && finalPhase ? 'corrupt' : 'pass';
      case 'final+retrans': return rec.retrans || finalPhase ? 'corrupt' : 'pass';
      case 'final-delay-retrans': return rec.retrans ? 'delay' : finalPhase ? 'corrupt' : 'pass';
      case 'reject': return 'reject';
      case 'interim-once': {
        // 只注入一次被页面完整读取的临时响应；之前注入的请求若被页面中止（被新结果取代），允许再注入
        const injected = REQ.filter((r) => r.action === 'corrupt');
        if (rec.retrans || !interimPhase || injected.some((r) => r.done || !r.tEnd)) return 'pass';
        const prior = REQ.filter((r) => r !== rec && r.sentence === rec.sentence && r.action === 'pass' && r.done && r.status === 200 && /[\u4E00-\u9FFF]/.test(r.respText || ''));
        const tl = window.__qaTL;
        const startedLongEnough = tl && now() > tl.t0 + tl.s[rec.sentence].start * 1000 + 1500;
        if (prior.length >= 1 && startedLongEnough) { interimInjected++; return 'corrupt'; }
        return 'pass';
      }
      default: return 'pass';
    }
  }

  window.fetch = async function (input, init) {
    let url = '';
    try { url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url; } catch (e) { url = ''; }
    if (!/\/api\/translations(?:[/?#]|$)/.test(url)) return origFetch(input, init);
    let bodyStr = init && typeof init.body === 'string' ? init.body : null;
    if (bodyStr === null && typeof Request !== 'undefined' && input instanceof Request) { try { bodyStr = await input.clone().text(); } catch (e) { /* ignore */ } }
    let obj = null;
    try { obj = bodyStr ? JSON.parse(bodyStr) : null; } catch (e) { obj = null; }
    const src = obj ? primaryText(obj) : bodyStr || '';
    const cls = classify(obj);
    const hdrs = {};
    try {
      const h = new Headers((init && init.headers) || (input instanceof Request ? input.headers : undefined));
      h.forEach((v, k) => { if (k === 'content-type' || k === 'accept' || k.startsWith('x-')) hdrs[k] = v; });
    } catch (e) { /* ignore */ }
    const rec = {
      id: ++seq, t: now(), url, method: (init && init.method) || (input instanceof Request ? input.method : 'GET'),
      headers: hdrs, body: bodyStr, src, sentence: sentenceOf(src), retrans: cls.retrans, marker: cls.marker,
      action: 'pass', status: null, tResp: null, tEnd: null, done: false, aborted: false, err: null, respText: '', outText: '',
    };
    rec.action = decide(rec);
    REQ.push(rec);
    const signal = (init && init.signal) || (input instanceof Request ? input.signal : undefined);
    if (rec.action === 'reject') { rec.tEnd = now(); rec.err = 'TypeError(injected)'; throw new TypeError('Failed to fetch'); }
    if (rec.action === 'delay') {
      try { await sleep(CFG.inject.delayMs || 25000, signal); } catch (e) { rec.aborted = true; rec.tEnd = now(); rec.err = 'AbortError'; throw e; }
    }
    let resp;
    try { resp = await origFetch(input, init); } catch (e) {
      rec.err = (e && e.name) || String(e); rec.aborted = rec.err === 'AbortError'; rec.tEnd = now(); throw e;
    }
    rec.status = resp.status; rec.tResp = now();
    if (!resp.body) { rec.tEnd = now(); rec.done = true; return resp; }
    if (rec.action !== 'corrupt') {
      let clone;
      try { clone = resp.clone(); } catch (e) { rec.tEnd = now(); return resp; }
      (async () => {
        const rd = clone.body.getReader(); const dec = new TextDecoder();
        try {
          for (;;) { const { done, value } = await rd.read(); if (done) break; rec.respText += dec.decode(value, { stream: true }); }
          rec.done = true;
        } catch (e) { rec.aborted = true; rec.err = (e && e.name) || 'error'; }
        rec.tEnd = now();
      })();
      return resp;
    }
    const reader = resp.body.getReader();
    const dec = new TextDecoder(); const enc = new TextEncoder();
    let carry = '';
    const stream = new ReadableStream({
      async pull(ctrl) {
        try {
          const { done, value } = await reader.read();
          if (done) {
            const tail = carry + dec.decode();
            if (tail) { rec.respText += tail; const o = corruptText(tail); rec.outText += o; ctrl.enqueue(enc.encode(o)); }
            rec.done = true; rec.tEnd = now(); ctrl.close(); return;
          }
          let s = carry + dec.decode(value, { stream: true });
          const bi = s.lastIndexOf('\\');
          if (bi >= 0 && bi > s.length - 6) { carry = s.slice(bi); s = s.slice(0, bi); } else carry = '';
          rec.respText += s;
          const o = corruptText(s); rec.outText += o;
          if (o) ctrl.enqueue(enc.encode(o));
        } catch (e) { rec.aborted = true; rec.err = (e && e.name) || 'error'; rec.tEnd = now(); ctrl.error(e); }
      },
      cancel(reason) { rec.aborted = true; rec.err = 'cancelled'; rec.tEnd = now(); try { reader.cancel(reason); } catch (e) { /* ignore */ } },
    });
    const h = new Headers(resp.headers); h.delete('content-length'); h.delete('content-encoding');
    return new Response(stream, { status: resp.status, statusText: resp.statusText, headers: h });
  };

  // ---------------- 媒体输入替换（依赖假设 A-4） ----------------
  let audioPromise = null;
  function b64ToBuf(b64) { const bin = atob(b64); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u.buffer; }
  function buildAudio() {
    if (audioPromise) return audioPromise;
    audioPromise = (async () => {
      const ac = new AudioContext();
      try { await ac.resume(); } catch (e) { /* ignore */ }
      const dest = ac.createMediaStreamDestination();
      const bufs = [];
      for (const a of CFG.audio || []) bufs.push(await ac.decodeAudioData(b64ToBuf(a)));
      // 播放在 window.__qaGo() 被调用（页面已进入“正在听”）后才开始，句子时间表精确记录
      window.__qaGo = () => {
        if (window.__qaTL) return window.__qaTL;
        const lead = 0.5; const gap = CFG.gapSec || 1.6;
        const acStart = ac.currentTime + lead; const perfAtNow = now(); const acNow = ac.currentTime;
        let t = acStart; const s = [];
        const limit = CFG.playCount || bufs.length;
        for (let i = 0; i < bufs.length && i < limit; i++) {
          const src = ac.createBufferSource(); src.buffer = bufs[i]; src.connect(dest); src.start(t);
          s.push({ start: t - acStart, end: t - acStart + bufs[i].duration });
          t += bufs[i].duration + gap;
        }
        window.__qaTL = { t0: perfAtNow + (acStart - acNow) * 1000, s, total: t - acStart - gap };
        return window.__qaTL;
      };
      window.__qaAC = ac;
      return dest.stream;
    })();
    return audioPromise;
  }
  function silentStream() {
    const ac = new AudioContext(); const d = ac.createMediaStreamDestination(); return d.stream;
  }
  const md = navigator.mediaDevices;
  if (md) {
    window.__qaMedia = [];
    const origGUM = md.getUserMedia ? md.getUserMedia.bind(md) : null;
    md.getUserMedia = async function (c) {
      window.__qaMedia.push({ api: 'getUserMedia', t: now(), armed: window.__qaArmed });
      if (c && c.audio && !c.video) {
        const st = window.__qaArmed && CFG.input === 'mic' ? await buildAudio() : silentStream();
        return new MediaStream(st.getAudioTracks());
      }
      return origGUM ? origGUM(c) : Promise.reject(new DOMException('NotAllowed', 'NotAllowedError'));
    };
    md.getDisplayMedia = async function () {
      window.__qaMedia.push({ api: 'getDisplayMedia', t: now(), armed: window.__qaArmed });
      const st = window.__qaArmed && CFG.input === 'system' ? await buildAudio() : silentStream();
      const cv = document.createElement('canvas'); cv.width = 320; cv.height = 180;
      const g = cv.getContext('2d'); g.fillStyle = '#123'; g.fillRect(0, 0, 320, 180);
      setInterval(() => { g.fillStyle = '#' + ((Math.random() * 4095) | 0).toString(16).padStart(3, '0'); g.fillRect(0, 0, 4, 4); }, 500);
      const vs = cv.captureStream(2);
      return new MediaStream([...vs.getVideoTracks(), ...st.getAudioTracks()]);
    };
  }

  // ---------------- 字幕与小窗记录 ----------------
  const SNAPS = (window.__qaSnaps = []);
  const ids = new WeakMap(); let idSeq = 0;
  const idOf = (el) => { let v = ids.get(el); if (!v) { v = ++idSeq; ids.set(el, v); } return v; };
  const CAP_SEL = ['[data-testid*="caption" i]', '[data-test*="caption" i]', '[id*="caption" i]', '[class*="caption" i]',
    '[data-testid*="subtitle" i]', '[id*="subtitle" i]', '[class*="subtitle" i]', '[id*="transcript" i]', '[class*="transcript" i]',
    '[role="log"]', '[aria-live]'];
  const txt = (el) => ((el.innerText !== undefined ? el.innerText : el.textContent) || '').replace(/\s+/g, ' ').trim();
  const depth = (el) => { let d = 0; while (el.parentElement) { d++; el = el.parentElement; } return d; };
  const sigOf = (el) => el.tagName + '#' + (el.id || '') + '.' + (typeof el.className === 'string' ? el.className.split(/\s+/).filter((c) => !/(active|interim|final|hint|pending|fail|warn|state|is-|has-)/i.test(c)).sort().join('.') : '') + '@' + depth(el);
  window.__qaBaseline = new Set();
  window.__qaTakeBaseline = () => {
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let n; while ((n = w.nextNode())) { const s = (n.data || '').replace(/\s+/g, ' ').trim(); if (s) window.__qaBaseline.add(s); }
    try { window.__qaBaseline.add(txt(document.body)); } catch (e) { /* ignore */ }
  };
  function genericBlocks(doc, useBaseline) {
    const out = [];
    const all = doc.body ? doc.body.querySelectorAll('div,p,li,span,section,article') : [];
    for (const el of all) {
      if (el.closest('button,select,option,label,h1,h2,h3,h4,h5,h6,header,nav,footer,script,style')) continue;
      const t = txt(el); if (!t) continue;
      if ([...el.children].some((k) => txt(k))) continue;
      if (useBaseline && window.__qaBaseline.has(t)) continue;
      out.push(el);
    }
    return out;
  }
  window.__qaCollect = (doc, isPip) => {
    const data = {};
    const cands = new Set();
    for (const sel of CAP_SEL) { try { doc.querySelectorAll(sel).forEach((e) => cands.add(e)); } catch (e) { /* ignore */ } }
    for (const c of cands) {
      if (c.closest('button,select,option,label')) continue;
      const kids = [...c.children].filter((k) => { const t = txt(k); return t && (isPip || !window.__qaBaseline.has(t)); });
      data[idOf(c)] = { sig: sigOf(c), d: depth(c), kids: kids.map((k) => ({ id: idOf(k), t: txt(k), c: typeof k.className === 'string' ? k.className : '' })) };
    }
    const gen = genericBlocks(doc, !isPip);
    data.generic = { sig: 'generic', d: 0, kids: gen.map((k) => ({ id: idOf(k), t: txt(k), c: typeof k.className === 'string' ? k.className : '' })) };
    let body = '';
    try { body = txt(doc.body); } catch (e) { /* ignore */ }
    return { data, body };
  };
  const last = {};
  function snap(kind, doc) {
    if (!doc || !doc.body) return;
    let r; try { r = window.__qaCollect(doc, kind === 'pip'); } catch (e) { return; }
    const key = JSON.stringify(r.data) + '|' + r.body;
    if (last[kind] === key) return;
    last[kind] = key;
    const bodyFlags = { hangul: RE_HANGUL.test(r.body), kana: RE_KANA.test(r.body), interrupted: r.body.includes('翻译已中断'), listening: r.body.includes('正在听') };
    SNAPS.push({ k: kind, t: now(), d: r.data, f: bodyFlags });
  }
  window.__qaSnap = snap;
  function observe(kind, doc) {
    const mo = new MutationObserver(() => snap(kind, doc));
    mo.observe(doc.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['class', 'style', 'hidden', 'data-state'] });
    snap(kind, doc);
    return mo;
  }
  const startMain = () => { if (window.__qaMainObs) return; window.__qaMainObs = observe('main', document); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', startMain); else startMain();

  window.__qaPip = null;
  function attachPip(w, via) {
    if (!w) return;
    window.__qaPip = w; window.__qaPipVia = via;
    const tryAttach = (n) => {
      try {
        if (w.document && w.document.documentElement) { observe('pip', w.document); w.addEventListener('pagehide', () => SNAPS.push({ k: 'pip', t: now(), closed: true, d: {}, f: {} })); return; }
      } catch (e) { /* ignore */ }
      if (n < 50) setTimeout(() => tryAttach(n + 1), 100);
    };
    tryAttach(0);
  }
  if (window.documentPictureInPicture && window.documentPictureInPicture.requestWindow) {
    const dpp = window.documentPictureInPicture;
    const orig = dpp.requestWindow.bind(dpp);
    dpp.requestWindow = async function (o) { const w = await orig(o); attachPip(w, 'documentPictureInPicture'); return w; };
  }
  const origOpen = window.open.bind(window);
  window.open = function (...a) { const w = origOpen(...a); if (w) setTimeout(() => attachPip(w, 'window.open'), 300); return w; };

  // 样式测量（IQA-305/307）：按容器签名取条目的计算样式
  function parseColor(s) { const m = /rgba?\(([^)]+)\)/.exec(s || ''); if (!m) return null; const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; }
  function effBg(win, el) {
    let e = el; const layers = [];
    while (e) { const c = parseColor(win.getComputedStyle(e).backgroundColor); if (c && c.a > 0) { layers.push(c); if (c.a >= 1) break; } e = e.parentElement; }
    let bg = { r: 255, g: 255, b: 255 };
    for (let i = layers.length - 1; i >= 0; i--) { const c = layers[i]; bg = { r: c.r * c.a + bg.r * (1 - c.a), g: c.g * c.a + bg.g * (1 - c.a), b: c.b * c.a + bg.b * (1 - c.a) }; }
    return bg;
  }
  function deepestText(el) { let e = el; while (e.children.length === 1 && txt(e.children[0]) === txt(e)) e = e.children[0]; return e; }
  window.__qaMeasure = (kind, sig) => {
    const doc = kind === 'pip' ? window.__qaPip && window.__qaPip.document : document;
    const win = kind === 'pip' ? window.__qaPip : window;
    if (!doc) return null;
    let cont = null;
    if (sig === 'generic') return { entries: genericBlocks(doc, kind !== 'pip').map((k) => measureEl(win, k)) };
    const cands = new Set();
    for (const sel of CAP_SEL) { try { doc.querySelectorAll(sel).forEach((e) => cands.add(e)); } catch (e) { /* ignore */ } }
    for (const c of cands) if (sigOf(c) === sig) { cont = c; break; }
    if (!cont) return null;
    return { entries: [...cont.children].filter((k) => txt(k)).map((k) => measureEl(win, k)) };
  };
  function measureEl(win, k) {
    const e = deepestText(k);
    const cs = win.getComputedStyle(e); const ks = win.getComputedStyle(k);
    const before = win.getComputedStyle(k, '::before').content; const after = win.getComputedStyle(k, '::after').content;
    let opacity = 1; let x = e; while (x) { opacity *= Number(win.getComputedStyle(x).opacity || 1); x = x.parentElement; }
    return {
      text: txt(k), cls: typeof k.className === 'string' ? k.className : '',
      color: cs.color, bg: effBg(win, e), opacity, fontStyle: cs.fontStyle, fontWeight: cs.fontWeight, fontSize: parseFloat(cs.fontSize),
      textDecoration: cs.textDecorationLine, animation: [cs.animationName, ks.animationName].join(','), border: [ks.borderLeftStyle, ks.borderLeftWidth, ks.borderLeftColor, ks.borderStyle].join(' '),
      boxBg: ks.backgroundColor, before: before, after: after, fontFamily: cs.fontFamily,
    };
  }
})();
QA_INPAGE_EOF

# ---------------------------------------------------------------------------
# 编排程序：素材合成、浏览器场景、直接请求的中止场景、服务日志分析、结果汇总
# ---------------------------------------------------------------------------
cat > qa.mjs <<'QA_MAIN_EOF'
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const pexec = promisify(execFile);
const EV = process.env.QA_EVIDENCE_DIR;
const RESULT = process.env.QA_RESULT_PATH;
const SHA = process.env.QA_CANDIDATE_SHA || '';
const LOGS_DIR = process.env.QA_SERVICE_LOGS_DIR || '';
const T0 = Number(process.env.QA_T0_EPOCH || 0) * 1000 || Date.now();
const DEADLINE = T0 + 13 * 60 * 1000;
const timeLeft = () => DEADLINE - Date.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString(), ...a);
const writeEv = (name, obj) => { fs.writeFileSync(path.join(EV, name), typeof obj === 'string' ? obj : JSON.stringify(obj, null, 1)); return name; };
const INPAGE = fs.readFileSync('inpage.js', 'utf8');

// ---------------- 文字判定（FR-301） ----------------
const RE_HANGUL = /[\u1100-\u11FF\u3130-\u318F\uA960-\uA97F\uAC00-\uD7AF\uD7B0-\uD7FF]/;
const RE_KANA = /[\u3040-\u309F\u30A0-\u30FA\u30FC-\u30FF\u31F0-\u31FF\uFF66-\uFF9F]/;
const RE_HAN = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/;
const RE_OTHER = /[\u0370-\u03FF\u0400-\u052F\u0590-\u05FF\u0600-\u06FF\u0750-\u077F\u0900-\u097F\u0E00-\u0E7F]/;
const isChinese = (s) => !!s && !RE_HANGUL.test(s) && !RE_KANA.test(s) && !RE_OTHER.test(s) && RE_HAN.test(s);
const HINT = '此句未能翻译成中文';
const isHint = (s) => (s || '').includes(HINT);
const norm = (s) => (s || '').replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase();
const unescapeU = (s) => (s || '').replace(/\\u([0-9a-fA-F]{4})/g, (m, h) => String.fromCharCode(parseInt(h, 16)));
const short = (s, n = 60) => { s = String(s ?? ''); return s.length > n ? s.slice(0, n) + '…' : s; };

// ---------------- 被测地址与依赖 ----------------
async function pickBase() {
  const svc = Object.entries(process.env).filter(([k, v]) => /^AIDH_SERVICE_.+_URL$/.test(k) && v);
  const diag = [];
  const pref = svc.filter(([k]) => /(WEB|APP|FRONT)/.test(k));
  const order = [...pref, ...svc.filter((e) => !pref.includes(e))];
  for (const [k, v] of order) {
    try {
      const r = await fetch(v, { redirect: 'follow', signal: AbortSignal.timeout(15000) });
      const ct = r.headers.get('content-type') || '';
      const body = await r.text();
      diag.push(`${k}: HTTP ${r.status} ${ct}`);
      if (r.ok && (/html/i.test(ct) || /<html|<!doctype/i.test(body))) return { base: v.replace(/\/+$/, ''), diag };
    } catch (e) { diag.push(`${k}: ${e.name} ${(e.cause && e.cause.code) || e.message}`); }
  }
  return { base: null, diag: svc.length ? diag : ['未注入任何 AIDH_SERVICE_*_URL'] };
}
const DEPS = [...new Set(Object.keys(process.env).map((k) => /^AIDH_DEP_(.+)_(KIND|ENDPOINT|RESOURCE_ID|AUTH_MODE)$/.exec(k)).filter(Boolean).map((m) => m[1].toLowerCase().replace(/_/g, '-')))];
const SECRET_VALUES = Object.entries(process.env)
  .filter(([k, v]) => v && v.length >= 6 && (/^AIDH_SECRET_/.test(k) || (/^AIDH_DEP_/.test(k) && /(KEY|SECRET|TOKEN|PASSWORD|CONNECTION|CREDENTIAL)/.test(k))))
  .map(([, v]) => v);

// ---------------- 素材 ----------------
const KO5 = [
  { text: '안녕하세요, 오늘 회의에 참석해 주셔서 감사합니다.', kw: ['회의', '참석'] },
  { text: '이번 분기 매출은 지난해보다 이십 퍼센트 증가했습니다.', kw: ['매출', '분기', '퍼센트'] },
  { text: '다음 주 월요일에 새로운 제품을 출시할 예정입니다.', kw: ['제품', '출시', '월요일'] },
  { text: '고객 만족도를 높이기 위해 서비스 품질을 개선하겠습니다.', kw: ['고객', '만족', '품질'] },
  { text: '질문이 있으시면 언제든지 말씀해 주세요.', kw: ['질문', '언제든지'] },
];
const JA5 = [
  { text: 'こんにちは、本日はお集まりいただきありがとうございます。', kw: ['こんにちは', '集まり', '本日'] },
  { text: '今期の売上は昨年より二十パーセント増えました。', kw: ['売上', 'パーセント', '今期'] },
  { text: '来週の月曜日に新しい製品を発売する予定です。', kw: ['製品', '発売', '月曜'] },
  { text: 'お客様の満足度を高めるために、サービスを改善します。', kw: ['満足', 'お客様', '改善'] },
  { text: 'ご質問があれば、いつでもお聞かせください。', kw: ['質問', 'いつでも'] },
];
const KOLONG = [
  { text: '안녕하세요, 반갑습니다.', kw: ['반갑'] },
  { text: '오늘 오후 세 시에 본사 대회의실에서 내년도 사업 전략과 예산 계획, 그리고 신규 인력 채용 및 해외 시장 진출 방안에 대해 자세히 논의할 예정입니다.', kw: ['오후', '본사', '대회의실', '전략', '예산', '채용', '해외'] },
  { text: '감사합니다.', kw: ['감사합니다'] },
];
const EN4 = [
  { text: 'Good morning everyone, welcome to the meeting.', kw: ['morning', 'welcome', 'Morning', 'Welcome'], zh: ['早上好', '早安', '欢迎', '会议', '大家'] },
  { text: 'Our sales increased by twenty percent this quarter.', kw: ['sales', 'twenty', 'percent', 'Sales', '20'], zh: ['销售', '销量', '20', '二十', '百分'] },
  { text: 'The new product will launch next Monday.', kw: ['product', 'Monday', 'launch'], zh: ['产品', '周一', '星期一', '礼拜一', '发布', '推出'] },
  { text: 'Please let me know if you have any questions.', kw: ['question', 'Question'], zh: ['问题', '疑问', '提问'] },
];
const ABORT_TEXT = [
  '오늘은 우리 회사의 새로운 사업 계획에 대해 자세히 설명드리겠습니다.',
  '먼저 지난 일 년 동안의 성과를 간단히 돌아보겠습니다.',
  '우리는 세 개의 새로운 시장에 진출했고 직원 수도 두 배로 늘었습니다.',
  '다음으로 내년도 목표와 주요 과제를 말씀드리겠습니다.',
  '가장 중요한 목표는 고객 경험을 개선하고 운영 비용을 줄이는 것입니다.',
  '마지막으로 각 부서의 협력 방안에 대해 함께 논의하고 싶습니다.',
].join(' ');
const NORMAL_TEXT = '오늘 날씨가 정말 좋네요.';
const VOICES = { ko: 'ko-KR-SunHiNeural', ja: 'ja-JP-NanamiNeural', en: 'en-US-JennyNeural' };
const ESPEAK = { ko: 'ko', ja: 'ja', en: 'en-us' };

async function tts(lang, text, file) {
  const errs = [];
  try {
    await pexec('tts-venv/bin/edge-tts', ['--voice', VOICES[lang], '--text', text, '--write-media', file], { timeout: 60000 });
    if (fs.statSync(file).size > 1000) return 'edge-tts';
  } catch (e) { errs.push('edge-tts: ' + short(e.message, 200)); }
  try {
    const wav = file.replace(/\.mp3$/, '.wav');
    await pexec('espeak-ng', ['-v', ESPEAK[lang], '-s', '140', '-w', wav, text], { timeout: 60000 });
    fs.renameSync(wav, file);
    return 'espeak-ng';
  } catch (e) { errs.push('espeak-ng: ' + short(e.message, 200)); }
  throw new Error(errs.join(' | '));
}
async function synthAll() {
  fs.mkdirSync('audio', { recursive: true });
  const sets = { KO5: ['ko', KO5], JA5: ['ja', JA5], KOLONG: ['ko', KOLONG], EN4: ['en', EN4] };
  const jobs = [];
  for (const [name, [lang, arr]] of Object.entries(sets)) arr.forEach((s, i) => jobs.push({ name, lang, s, file: `audio/${name}-${i}.mp3` }));
  const engines = new Set();
  for (let i = 0; i < jobs.length; i += 6) {
    await Promise.all(jobs.slice(i, i + 6).map(async (j) => {
      let lastErr;
      for (let a = 0; a < 3; a++) {
        try { engines.add(await tts(j.lang, j.s.text, j.file)); j.b64 = fs.readFileSync(j.file).toString('base64'); return; } catch (e) { lastErr = e; await sleep(1500); }
      }
      throw lastErr;
    }));
  }
  const out = {};
  for (const j of jobs) (out[j.name] ||= []).push(j.b64);
  return { audio: out, engines: [...engines] };
}

// ---------------- 浏览器运行 ----------------
let browser = null;
let BASE = null;
const RUN_WINDOWS = [];
const newBrowser = () => chromium.launch({
  channel: 'chromium', headless: true,
  args: ['--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
});
async function launchBrowser() { browser = await newBrowser(); }
const RE_SYS = /系统声音|系统音频|系统/;
const RE_MIC = /麦克风/;
async function clickByText(page, re) {
  for (const role of ['radio', 'tab', 'menuitemradio', 'option', 'button', 'switch']) {
    const l = page.getByRole(role, { name: re });
    if (await l.count()) { const el = l.first(); if (role === 'radio') await el.check({ timeout: 5000 }).catch(() => el.click({ timeout: 5000 })); else await el.click({ timeout: 5000 }); return role; }
  }
  const sels = page.locator('select');
  for (let i = 0; i < (await sels.count()); i++) {
    const opts = await sels.nth(i).locator('option').allTextContents();
    const hit = opts.find((o) => re.test(o));
    if (hit) { await sels.nth(i).selectOption({ label: hit.trim() }); return 'select'; }
  }
  const lab = page.getByLabel(re);
  if (await lab.count()) { await lab.first().click({ timeout: 5000 }); return 'label'; }
  const t = page.getByText(re);
  if (await t.count()) { await t.first().click({ timeout: 5000 }); return 'text'; }
  return null;
}
async function bodyText(page) { return page.evaluate(() => (document.body ? document.body.innerText : '')).catch(() => ''); }

// opts: { name, scen, mat, sentences, audio, input, pip, inject, playCount, mode312 }
// 单次运行看门狗：任何一步卡住时按测试缺口记录，不拖垮整轮测试
async function runBrowser(opts) {
  const r = { name: opts.name, scen: opts.scen, input: opts.input, pipWanted: !!opts.pip, ok: false, failKind: null, failMsg: '', console: [], wallStart: Date.now(), step: 'start' };
  log('run start', opts.name);
  const H = {};
  const limit = opts.mode312 ? 220000 : 160000;
  let to;
  const timedOut = new Promise((res) => { to = setTimeout(() => res('timeout'), limit); });
  const how = await Promise.race([runBrowserInner(opts, r, H).then(() => 'done', () => 'done'), timedOut]);
  clearTimeout(to);
  let out = r;
  if (how === 'timeout') {
    out = { ...r, ok: false, failKind: 'gap', failMsg: `单次运行超过 ${limit / 1000} 秒未完成（卡在步骤：${r.step}）` };
  }
  out.wallEnd = Date.now();
  RUN_WINDOWS.push([out.wallStart, out.wallEnd]);
  const ev = { ...out, req: (out.req || []).map((q) => ({ ...q, headers: Object.fromEntries(Object.entries(q.headers || {}).filter(([k]) => !/(key|token|auth|secret)/i.test(k))) })) };
  delete ev.preStop;
  try { writeEv(`run-${opts.name}.json`, ev); } catch (e) { /* ignore */ }
  if (H.ctx) await Promise.race([H.ctx.close().catch(() => {}), sleep(15000)]);
  if (H.own) await Promise.race([H.own.close().catch(() => {}), sleep(15000)]);
  log('run end', opts.name, out.ok ? 'ok' : `${out.failKind}: ${out.failMsg}`);
  return out;
}
async function runBrowserInner(opts, r, H) {
  const cfg = { sentences: opts.sentences.map((s) => ({ kw: s.kw })), audio: opts.audio, gapSec: 1.6, playCount: opts.playCount || 0, input: opts.input, inject: opts.inject || null };
  let ctx;
  try {
    // 需要小窗的运行使用独立浏览器进程，避免并发运行的小窗相互干扰
    if (opts.pip) H.own = await newBrowser();
    ctx = await (H.own || browser).newContext({ viewport: { width: 1280, height: 860 }, permissions: ['microphone'] });
    H.ctx = ctx;
    await ctx.addInitScript({ content: `window.__QA_CFG=${JSON.stringify(cfg)};\n${INPAGE}` });
    const page = await ctx.newPage();
    page.on('console', (m) => r.console.push(`[${m.type()}] ${short(m.text(), 400)}`));
    page.on('pageerror', (e) => r.console.push(`[pageerror] ${short(e.message, 400)}`));
    try { await page.goto(BASE, { waitUntil: 'load', timeout: 45000 }); } catch (e) { r.failKind = 'env'; r.failMsg = '页面加载失败：' + short(e.message, 200); return r; }
    await sleep(1500);
    await page.evaluate(() => window.__qaTakeBaseline());
    r.visibleText = short(await bodyText(page), 1500);
    const sel = await clickByText(page, opts.input === 'mic' ? RE_MIC : RE_SYS).catch((e) => null);
    r.inputControl = sel;
    if (!sel) { r.failKind = 'gap'; r.failMsg = `找不到输入选择控件（${opts.input === 'mic' ? '麦克风' : '系统声音'}）`; await page.screenshot({ path: path.join(EV, `${opts.name}-nocontrol.png`) }).catch(() => {}); return r; }
    const startBtn = page.getByRole('button', { name: /开始/ });
    if (!(await startBtn.count())) { r.failKind = 'gap'; r.failMsg = '找不到“开始”按钮'; await page.screenshot({ path: path.join(EV, `${opts.name}-nocontrol.png`) }).catch(() => {}); return r; }
    await page.evaluate(() => { window.__qaArmed = true; });
    await startBtn.first().click({ timeout: 10000 });
    try { await page.waitForFunction(() => document.body.innerText.includes('正在听'), null, { timeout: 25000 }); } catch (e) {
      r.failKind = 'defect'; r.failMsg = '点击“开始”后 25 秒内未出现“正在听”'; r.visibleText = short(await bodyText(page), 1500);
      await page.screenshot({ path: path.join(EV, `${opts.name}-nolisten.png`) }).catch(() => {});
      r.media = await page.evaluate(() => window.__qaMedia).catch(() => null);
      return r;
    }
    r.step = 'pip';
    if (opts.pip) {
      const pb = page.getByRole('button', { name: /小窗|悬浮|画中画/ });
      if (await pb.count()) {
        await pb.first().click({ timeout: 5000 }).catch(() => {});
        await page.waitForFunction(() => !!window.__qaPip, null, { timeout: 5000 }).catch(() => {});
      }
      const pi = await Promise.race([page.evaluate(() => ({ o: !!window.__qaPip, v: window.__qaPipVia || null })).catch(() => null), sleep(10000).then(() => null)]);
      r.pipOpened = !!(pi && pi.o); r.pipVia = pi ? pi.v : '读取小窗状态超时';
    }
    try { await page.waitForFunction(() => typeof window.__qaGo === 'function', null, { timeout: 20000 }); } catch (e) {
      r.failKind = 'gap'; r.failMsg = '页面未按所选输入请求媒体（未调用 getDisplayMedia/getUserMedia），合成音频无法送入';
      r.media = await page.evaluate(() => window.__qaMedia).catch(() => null); return r;
    }
    r.step = 'play';
    const tl = await page.evaluate(() => window.__qaGo());
    r.tl = tl;
    const audioEnd = tl.t0 + tl.total * 1000;
    // 等待定稿：最后一个请求结束满 4 秒（至少 8 秒、至多 30 秒）
    let stopAt = null;
    r.step = 'settle';
    const loopStart = Date.now();
    const loopCap = (Number.isFinite(tl.total) ? tl.total * 1000 : 60000) + (opts.mode312 ? 50000 : 35000);
    for (;;) {
      await sleep(500);
      if (Date.now() - loopStart > loopCap) { stopAt = 'wall-cap'; break; }
      const st = await page.evaluate(() => ({ now: performance.now(), req: window.__qaReq.map((q) => ({ t: q.t, tEnd: q.tEnd, sentence: q.sentence, retrans: q.retrans, action: q.action })) }));
      if (opts.mode312) {
        const pend = st.req.find((q) => q.sentence === opts.mode312.sentence && q.retrans && q.action === 'delay' && q.tEnd == null);
        if (pend) { await sleep(600); stopAt = 'retrans-pending'; break; }
        if (st.now > audioEnd + 45000) { stopAt = 'timeout-no-retrans'; break; }
        continue;
      }
      if (st.now < audioEnd) continue;
      const inflight = st.req.filter((q) => q.tEnd == null).length;
      const lastAct = Math.max(0, ...st.req.map((q) => Math.max(q.t, q.tEnd || 0)));
      const el = st.now - audioEnd;
      if ((el >= 8000 && inflight === 0 && st.now - lastAct >= 4000) || el >= 30000) { stopAt = el >= 30000 ? 'max-30s' : 'settled'; break; }
    }
    r.stopReason = stopAt;
    r.step = 'pre-stop-snapshot';
    await page.evaluate(() => { window.__qaSnap('main', document); if (window.__qaPip) window.__qaSnap('pip', window.__qaPip.document); });
    r.preStop = await page.evaluate(() => ({ snaps: window.__qaSnaps, now: performance.now() }));
    r.step = 'screenshot';
    await page.screenshot({ path: path.join(EV, `${opts.name}-end.png`), fullPage: true, timeout: 10000 }).catch(() => {});
    for (const p of ctx.pages()) if (p !== page) await Promise.race([p.screenshot({ path: path.join(EV, `${opts.name}-pip.png`), timeout: 10000 }).catch(() => {}), sleep(12000)]);
    r.step = 'measure';
    r.measure = await measureRun(page, r.preStop.snaps);
    r.step = 'stop';
    const stopBtn = page.getByRole('button', { name: /停止/ });
    r.tStop = await page.evaluate(() => performance.now());
    if (await stopBtn.count()) await stopBtn.first().click({ timeout: 5000 }).catch((e) => { r.stopErr = e.message; });
    else r.stopErr = '找不到“停止”按钮';
    const obsMs = opts.mode312 ? 30000 : 10000;
    await sleep(obsMs);
    r.step = 'final-snapshot';
    await page.evaluate(() => { window.__qaSnap('main', document); if (window.__qaPip) window.__qaSnap('pip', window.__qaPip.document); });
    const fin = await page.evaluate(() => ({ snaps: window.__qaSnaps, req: window.__qaReq, media: window.__qaMedia, now: performance.now(), body: document.body.innerText }));
    r.snaps = fin.snaps; r.req = fin.req; r.media = fin.media; r.tEndObs = fin.now;
    r.listeningAfterStop = fin.body.includes('正在听');
    r.ok = true;
    return r;
  } catch (e) {
    r.failKind = r.failKind || 'gap'; r.failMsg = r.failMsg || ('脚本执行异常：' + short(e.stack || e.message, 300));
    return r;
  }
}

// ---------------- 字幕记录分析 ----------------
function chooseSig(snaps, kind) {
  const score = {};
  for (const s of snaps || []) {
    if (s.k !== kind || !s.d) continue;
    for (const c of Object.values(s.d)) {
      if (!c || !c.kids || c.sig === 'generic') continue;
      const sc = (score[c.sig] ||= { max: 0, d: c.d });
      sc.max = Math.max(sc.max, c.kids.length);
    }
  }
  let best = null;
  for (const [sig, sc] of Object.entries(score)) if (!best || sc.max > best.max || (sc.max === best.max && sc.d > best.d)) best = { sig, ...sc };
  return !best || best.max === 0 ? 'generic' : best.sig;
}
async function measureRun(page, snaps) {
  const sigMain = chooseSig(snaps, 'main'); const sigPip = chooseSig(snaps, 'pip');
  const main = await page.evaluate((s) => window.__qaMeasure('main', s), sigMain).catch(() => null);
  const pip = await page.evaluate((s) => (window.__qaPip ? window.__qaMeasure('pip', s) : null), sigPip).catch(() => null);
  return { sigMain, sigPip, main, pip };
}
function textsAt(s, sig) {
  if (!s.d) return [];
  if (sig === 'generic') return ((s.d.generic && s.d.generic.kids) || []).map((k) => k.t);
  let best = null;
  for (const c of Object.values(s.d)) if (c && c.sig === sig && (!best || c.kids.length > best.kids.length)) best = c;
  return best ? best.kids.map((k) => k.t) : [];
}
// 时间线：每次变化后的完整条目列表（已滚出字幕区的较早条目按“头部移除 + 平移”识别并保留）
function timeline(snaps, kind, sig) {
  const out = []; let scrolled = []; let prev = null;
  for (const s of snaps || []) {
    if (s.k !== kind || s.closed) continue;
    const cur = textsAt(s, sig);
    if (prev && prev.length && cur.length && cur[0] !== prev[0]) {
      for (let k = 1; k < prev.length; k++) {
        if (prev[k] !== cur[0]) continue;
        const m = prev.length - 1 - k; let same = true;
        for (let j = 0; j < m; j++) if (prev[k + j] !== cur[j]) { same = false; break; }
        if (same) scrolled = scrolled.concat(prev.slice(0, k));
        break;
      }
    }
    out.push({ t: s.t, list: scrolled.concat(cur), f: s.f || {} });
    prev = cur;
  }
  return out;
}
const stateAt = (tl, T) => { let st = null; for (const o of tl) { if (o.t <= T) st = o; else break; } return st; };
const sameList = (a, b) => a.length === b.length && a.every((x, i) => norm(x) === norm(b[i]) && isHint(x) === isHint(b[i]));
const srcHit = (t, sentences) => sentences.some((s) => { const a = norm(t); const b = norm(s.text); return a === b || (b.length > 8 && a.includes(b)); });
function cp(step, passed, observation, cat = 'defect') { return { step, passed: !!passed, observation: short(observation, 600), cat: passed ? null : cat }; }

function prepare(r) {
  const sigMain = (r.measure && r.measure.sigMain) || chooseSig(r.snaps, 'main');
  const sigPip = (r.measure && r.measure.sigPip) || chooseSig(r.snaps, 'pip');
  const main = timeline(r.snaps, 'main', sigMain);
  const gen = timeline(r.snaps, 'main', 'generic');
  const pip = timeline(r.snaps, 'pip', sigPip);
  const tStop = r.tStop || Infinity;
  const finalSt = stateAt(main, tStop - 1);
  const pipFinal = stateAt(pip, tStop - 1);
  return { sigMain, sigPip, main, gen, pip, tStop, final: finalSt ? finalSt.list : [], pipFinal: pipFinal ? pipFinal.list : [] };
}
function g1(r) {
  if (!r.ok) return cp('G-1 页面可用', false, r.failMsg, r.failKind || 'gap');
  return cp('G-1 页面可用', true, `输入控件=${r.inputControl}；媒体调用=${(r.media || []).map((m) => m.api).join(',')}；出现“正在听”`);
}
function g2(r, P, sentences) {
  const bad = [];
  const scan = (tl, where) => { for (const o of tl) for (const t of o.list) if (RE_HANGUL.test(t) || RE_KANA.test(t) || srcHit(t, sentences)) bad.push(`${where}@${Math.round(o.t)}ms:「${short(t, 40)}」`); };
  scan(P.main, '主页面字幕区'); scan(P.gen, '主页面新增文字'); scan(P.pip, '小窗');
  for (const s of r.snaps || []) if (s.k === 'pip' && s.f && (s.f.hangul || s.f.kana)) bad.push(`小窗文档@${Math.round(s.t)}ms 含谚文/假名`);
  const uniq = [...new Set(bad)];
  return cp('G-2 识别原文与非中文从不出现', uniq.length === 0, uniq.length ? `出现 ${uniq.length} 处：${uniq.slice(0, 5).join('；')}` : `主页面 ${P.main.length} 次变化、小窗 ${P.pip.length} 次变化均无谚文/假名/识别原文`);
}
function finalChecks(P, n, { hintAllowed = [] } = {}) {
  const out = [];
  const f = P.final;
  out.push(cp('定稿条目数', f.length === n, `定稿 ${f.length} 条（期望 ${n}）：${f.map((t) => `「${short(t, 30)}」`).join(' ')}`));
  const nonZh = f.map((t, i) => ({ t, i })).filter((x) => !hintAllowed.includes(x.i) && (!isChinese(x.t) || isHint(x.t)));
  out.push(cp('定稿字幕均为中文', f.length > 0 && nonZh.length === 0, nonZh.length ? `非中文或提示条目：${nonZh.map((x) => `#${x.i + 1}「${short(x.t, 30)}」`).join(' ')}` : `${f.length} 条均判为中文`));
  const hints = f.filter((t, i) => isHint(t) && !hintAllowed.includes(i)).length;
  out.push(cp('中文提示条数为 0（PQ-301）', hints === 0, `意外的提示 ${hints} 条`));
  return out;
}
function entryHist(tl, i) { return tl.map((o) => ({ t: o.t, text: o.list[i] })); }
function tFinalShown(tl, i, finalText, tStop) {
  let tf = null;
  for (const o of tl) { if (o.t >= tStop) break; if (o.list[i] === finalText) { if (tf === null) tf = o.t; } else tf = null; }
  return tf;
}
function consistency(P, sentences) {
  if (!P.pip.length) return cp('主页面与小窗逐条一致', false, '小窗没有记录到字幕条目', 'defect');
  const times = [];
  sentences.forEach((s, i) => { const tf = tFinalShown(P.main, i, P.final[i], P.tStop); if (tf !== null) times.push(tf + 50); });
  times.push(P.tStop - 1);
  const bad = [];
  for (const T of times) {
    const m = stateAt(P.main, T); if (!m) continue;
    const cands = [stateAt(P.pip, T), ...P.pip.filter((o) => o.t > T && o.t <= T + 1500)].filter(Boolean);
    if (!cands.some((p) => sameList(p.list, m.list))) bad.push(`@${Math.round(T)}ms 主页面[${m.list.map((t) => short(t, 15)).join('|')}] 小窗[${(cands.at(-1) || { list: [] }).list.map((t) => short(t, 15)).join('|')}]`);
  }
  return cp('主页面与小窗逐条一致（1.5 秒同步容差）', bad.length === 0, bad.length ? `不一致 ${bad.length} 处：${bad.slice(0, 3).join('；')}` : `${times.length} 个检查时刻一致`);
}

const reqsOf = (r, i) => (r.req || []).filter((q) => q.sentence === i);
const retransCount = (r, i) => reqsOf(r, i).filter((q) => q.retrans).length;
function withPrefix(prefix, list) { return list.map((c) => ({ ...c, step: `${prefix}${c.step}` })); }

function anClear(r, sentences) {
  const out = [g1(r)];
  if (!r.ok) return out;
  const P = prepare(r);
  out.push(g2(r, P, sentences), ...finalChecks(P, sentences.length));
  return out;
}
function anRetrans(r, sentences, target) {
  const out = [g1(r)];
  if (!r.ok) return { out };
  const P = prepare(r);
  out.push(g2(r, P, sentences));
  const inj = reqsOf(r, target).filter((q) => q.action === 'corrupt');
  out.push(cp('受控注入生效（改写的非中文响应被页面完整读取）', inj.some((q) => q.done), `第 ${target + 1} 句改写请求 ${inj.length} 个，完整读取 ${inj.filter((q) => q.done).length} 个`, 'gap'));
  const rc = retransCount(r, target);
  out.push(cp(`第 ${target + 1} 句恰好 1 次重新翻译`, rc === 1, `重新翻译请求 ${rc} 次`, inj.some((q) => q.done) ? 'defect' : 'gap'));
  const finalText = P.final[target];
  const tf = finalText !== undefined ? tFinalShown(P.main, target, finalText, P.tStop) : null;
  const h = entryHist(P.main, target);
  const firstZh = h.find((x) => isChinese(x.text) && !isHint(x.text));
  const tc = Math.min(...inj.map((q) => q.tEnd || q.tResp || Infinity));
  const issues = [];
  if (firstZh && tf !== null) {
    for (const x of h) if (x.t >= firstZh.t && x.t < tf && !(x.text || '').trim()) issues.push(`@${Math.round(x.t)}ms 条目为空`);
    for (const x of h) if (x.t < tf && isHint(x.text)) issues.push(`@${Math.round(x.t)}ms 显示了提示`);
    if (Number.isFinite(tc)) {
      const base = stateAt(P.main, tc); const L0 = base && base.list[target] ? base.list[target].length : 0;
      for (const x of h) if (x.t >= tc && x.t < tf && (x.text || '').length < L0) issues.push(`@${Math.round(x.t)}ms 文字由 ${L0} 字缩短为 ${(x.text || '').length} 字`);
    }
  } else issues.push(firstZh ? '未找到定稿显示时刻' : '该句从未显示中文临时译文');
  out.push(cp('重新翻译期间不留空白、不缩短', issues.length === 0, issues.length ? issues.slice(0, 4).join('；') : `从首次中文临时译文到定稿（${Math.round(tf)}ms）共 ${h.filter((x) => firstZh && x.t >= firstZh.t && x.t < tf).length} 次变化均非空，未缩短`));
  out.push(...finalChecks(P, sentences.length));
  return { out, P };
}
function parseColor(s) { const m = /rgba?\(([^)]+)\)/.exec(s || ''); if (!m) return null; const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; }
function lum(c) { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); }
function contrast(e) {
  const c = parseColor(e.color) || { r: 0, g: 0, b: 0, a: 1 }; const a = (c.a ?? 1) * (e.opacity ?? 1); const bg = e.bg;
  const fg = { r: c.r * a + bg.r * (1 - a), g: c.g * a + bg.g * (1 - a), b: c.b * a + bg.b * (1 - a) };
  const L1 = lum(fg), L2 = lum(bg); return (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
}
const STYLE_KEYS = ['color', 'fontStyle', 'fontWeight', 'textDecoration', 'boxBg', 'border', 'before', 'after', 'fontFamily'];
function styleChecks(m, where) {
  const out = [];
  if (!m || !m.entries || !m.entries.length) return [cp(`${where}提示样式可测量`, false, '未能取得条目的计算样式', 'gap')];
  const hints = m.entries.filter((e) => isHint(e.text)); const normals = m.entries.filter((e) => !isHint(e.text) && isChinese(e.text));
  if (!hints.length || !normals.length) return [cp(`${where}提示样式可测量`, false, `提示 ${hints.length} 条、正常 ${normals.length} 条，无法比较`, 'defect')];
  const diffs = [];
  for (const k of STYLE_KEYS) if (hints.every((h) => normals.every((n) => String(h[k]) !== String(n[k])))) diffs.push(k);
  if (hints.every((h) => normals.every((n) => Math.abs(h.opacity - n.opacity) > 0.05))) diffs.push('opacity');
  if (hints.every((h) => normals.every((n) => Math.abs(lum(h.bg) - lum(n.bg)) > 0.01))) diffs.push('background');
  out.push(cp(`${where}提示与正常定稿样式可区分`, diffs.length > 0, diffs.length ? `不同的样式：${diffs.join(', ')}` : `提示 ${JSON.stringify(hints[0]).slice(0, 200)} 与正常条目样式无差别`));
  const minNormalSize = Math.min(...normals.map((n) => n.fontSize));
  const probs = [];
  for (const h of hints) {
    const c = parseColor(h.color);
    if (c && c.r >= 150 && c.g <= 110 && c.b <= 110) probs.push(`警示红色 ${h.color}`);
    if (h.animation.split(',').some((a) => a.trim() && a.trim() !== 'none')) probs.push(`动画 ${h.animation}`);
    if (/blink/.test(h.textDecoration)) probs.push('闪烁');
    if (h.fontSize > minNormalSize + 0.5) probs.push(`字号 ${h.fontSize}px > 正常 ${minNormalSize}px`);
    const cr = contrast(h); if (cr < 4.5) probs.push(`对比度 ${cr.toFixed(2)}:1 < 4.5:1`);
  }
  out.push(cp(`${where}提示不刺眼（非红色、无动画、字号不大于正常、对比度≥4.5:1）`, probs.length === 0, probs.length ? probs.join('；') : `颜色 ${hints[0].color}，字号 ${hints[0].fontSize}px，对比度 ${contrast(hints[0]).toFixed(2)}:1`));
  return out;
}
function an305(r, sentences) {
  const out = [g1(r)];
  if (!r.ok) return { out };
  const P = prepare(r);
  out.push(g2(r, P, sentences));
  const per = [0, 1, 2].map((i) => ({ i, rc: retransCount(r, i), inj: reqsOf(r, i).filter((q) => q.action === 'corrupt' && q.done).length, hint: isHint(P.final[i]) }));
  out.push(cp('受控注入生效', per.every((x) => x.inj >= 1), per.map((x) => `第${x.i + 1}句改写并读取 ${x.inj} 个`).join('，'), 'gap'));
  out.push(cp('第 1～3 句各 1 次重新翻译且定稿为中文提示', per.every((x) => x.rc === 1 && x.hint), per.map((x) => `第${x.i + 1}句：重新翻译 ${x.rc} 次，定稿「${short(P.final[x.i], 30)}」`).join('；')));
  const ok45 = [3, 4].every((i) => isChinese(P.final[i]) && !isHint(P.final[i]));
  out.push(cp('第 4、5 句为中文定稿，定稿共 5 条', ok45 && P.final.length === 5, `定稿 ${P.final.length} 条；第4句「${short(P.final[3], 30)}」第5句「${short(P.final[4], 30)}」`));
  const pre = (r.snaps || []).filter((s) => s.k === 'main' && s.t < P.tStop);
  const interrupted = pre.some((s) => s.f && s.f.interrupted);
  const lastMain = pre.at(-1);
  out.push(cp('翻译继续：未出现“翻译已中断”，播放结束时仍“正在听”', !interrupted && lastMain && lastMain.f.listening, `翻译已中断=${interrupted}；停止前正在听=${!!(lastMain && lastMain.f.listening)}`));
  out.push(...styleChecks(r.measure && r.measure.main, '主页面：'));
  const pipOk = r.pipOpened && P.pip.length;
  if (pipOk) { out.push(consistency(P, sentences)); out.push(...styleChecks(r.measure && r.measure.pip, '小窗：').slice(0, 1)); }
  else out.push(cp('主页面与小窗逐条一致', false, '小窗未打开或无条目', 'defect'));
  return { out, P };
}
function an306(r, sentences, target) {
  const out = [g1(r)];
  if (!r.ok) return out;
  const P = prepare(r);
  out.push(g2(r, P, sentences));
  const inj = (r.req || []).filter((q) => q.action === 'corrupt');
  const injDone = inj.filter((q) => q.done);
  out.push(cp('受控注入生效（恰 1 个临时请求被改写并读取）', injDone.length === 1, `改写 ${inj.length} 个，完整读取 ${injDone.length} 个`, 'gap'));
  const tf = P.final[target] !== undefined ? tFinalShown(P.main, target, P.final[target], P.tStop) : null;
  const issues = [];
  if (injDone.length) {
    const tc = injDone[0].tResp || injDone[0].t;
    for (const x of entryHist(P.main, target)) if (x.t >= tc && (tf === null || x.t < tf) && !(x.text || '').trim()) issues.push(`@${Math.round(x.t)}ms 条目为空`);
    const before = stateAt(P.main, tc);
    if (!before || !isChinese(before.list[target] || '')) issues.push('改写响应到达前该句未显示中文临时译文');
  } else issues.push('无有效注入，无法判断');
  out.push(cp('改写后继续显示此前的中文临时译文（不为空）', issues.length === 0, issues.length ? issues.slice(0, 3).join('；') : '改写响应读取期间及之后条目始终为非空中文', injDone.length ? 'defect' : 'gap'));
  const rc = retransCount(r, target);
  const anyHint = P.main.some((o) => o.list.some(isHint));
  out.push(cp('不重新翻译、不提示', rc === 0 && !anyHint, `第 ${target + 1} 句重新翻译 ${rc} 次；出现提示=${anyHint}`));
  out.push(...finalChecks(P, sentences.length));
  return out;
}
function an311en(r, sentences, withPip) {
  const out = [g1(r)];
  if (!r.ok) return out;
  const P = prepare(r);
  out.push(g2(r, P, sentences));
  const early = sentences.map((s, i) => {
    const first = P.main.find((o) => (o.list[i] || '').trim());
    const end = r.tl.t0 + r.tl.s[i].end * 1000;
    return first ? first.t < end : false;
  });
  out.push(cp('临时字幕在句末之前出现（至少 3 句）', early.filter(Boolean).length >= 3, `句末前出现：${early.map((b, i) => `第${i + 1}句=${b}`).join('，')}`));
  out.push(...finalChecks(P, sentences.length));
  const kwMiss = sentences.map((s, i) => ({ i, ok: s.zh.some((k) => (P.final[i] || '').includes(k)) })).filter((x) => !x.ok);
  out.push(cp('译文与原意一致（含中文关键词）', kwMiss.length === 0, kwMiss.length ? `缺关键词：${kwMiss.map((x) => `第${x.i + 1}句「${short(P.final[x.i], 30)}」`).join(' ')}` : '各句均含关键词'));
  if (withPip) out.push(r.pipOpened && P.pip.length ? consistency(P, sentences) : cp('小窗打开并一致', false, '小窗未打开或无条目'));
  const post = (r.snaps || []).filter((s) => s.k === 'main' && s.t > P.tStop);
  const leave = post.find((s) => s.f && !s.f.listening);
  let changed = false;
  if (leave) { const ref = stateAt(P.main, leave.t); for (const o of P.main) if (o.t > leave.t && !sameList(o.list, ref.list)) changed = true; }
  out.push(cp('停止后离开“正在听”，此后 10 秒字幕不变', !!leave && !r.listeningAfterStop && !changed, `离开正在听=${!!leave}；观察结束时正在听=${r.listeningAfterStop}；停止后字幕变化=${changed}${r.stopErr ? '；' + r.stopErr : ''}`));
  return out;
}
function an311reject(r, sentences) {
  const out = [g1(r)];
  if (!r.ok) return out;
  const P = prepare(r);
  out.push(g2(r, P, sentences));
  const rej = (r.req || []).filter((q) => q.action === 'reject').length;
  out.push(cp('受控网络错误生效', rej >= 1, `被拒请求 ${rej} 个`, 'gap'));
  const interrupted = (r.snaps || []).some((s) => s.k === 'main' && s.f && s.f.interrupted);
  out.push(cp('页面提示“翻译已中断”', interrupted, `出现“翻译已中断”=${interrupted}`, rej ? 'defect' : 'gap'));
  const hint = P.main.some((o) => o.list.some(isHint));
  out.push(cp('请求失败的句子不显示“（此句未能翻译成中文）”', !hint, `出现提示=${hint}`));
  return out;
}
function an312(r, sentences, target) {
  const out = [g1(r)];
  if (!r.ok) return out;
  const P = prepare(r);
  out.push(g2(r, P, sentences));
  const inj = reqsOf(r, target).filter((q) => q.action === 'corrupt' && q.done).length;
  out.push(cp('停止发生在重新翻译进行中', r.stopReason === 'retrans-pending', `停止原因=${r.stopReason}；第 ${target + 1} 句改写并读取 ${inj} 个；重新翻译 ${retransCount(r, target)} 次`, inj ? 'defect' : 'gap'));
  const atStop = stateAt(P.main, P.tStop);
  const t2 = atStop ? atStop.list[target] : undefined;
  out.push(cp(`停止时第 ${target + 1} 句显示中文临时译文（不为空）`, isChinese(t2 || '') && !isHint(t2), `停止时「${short(t2, 40)}」`));
  const changes = atStop ? P.main.filter((o) => o.t > P.tStop && !sameList(o.list, atStop.list)) : [];
  const anyHint = P.main.some((o) => o.t > P.tStop && o.list.some(isHint));
  out.push(cp('停止后 30 秒内条目不再变化（无定稿、无提示、无非中文）', atStop && changes.length === 0 && !anyHint, `停止后变化 ${changes.length} 次${changes.length ? '：' + changes.slice(0, 2).map((o) => `@${Math.round(o.t - P.tStop)}ms [${o.list.map((t) => short(t, 15)).join('|')}]`).join('；') : ''}；提示=${anyHint}`));
  return out;
}

// ---------------- IQA-308/309：直接请求的中止（依赖假设 A-1） ----------------
function makeTemplate(r) {
  const cands = (r && r.req ? r.req : []).filter((q) => q.action === 'pass' && q.status === 200 && !q.retrans && q.body && q.src);
  const pick = cands.filter((q) => q.marker === true).at(-1) || cands.at(-1);
  if (pick) {
    try {
      const obj = JSON.parse(pick.body);
      const key = Object.keys(obj).find((k) => obj[k] === pick.src);
      if (key) {
        for (const k of Object.keys(obj)) if (/retrans/i.test(k)) delete obj[k];
        return { url: new URL(pick.url, BASE).href, headers: pick.headers || {}, obj, key, from: 'browser' };
      }
    } catch (e) { /* ignore */ }
  }
  return { url: BASE + '/api/translations', headers: { 'content-type': 'application/json' }, obj: { text: '', sourceLanguage: 'ko', targetLanguage: 'zh-Hans' }, key: 'text', from: 'fallback' };
}
const tplBody = (tpl, text) => JSON.stringify({ ...tpl.obj, [tpl.key]: text });
const tplHeaders = (tpl) => ({ 'content-type': 'application/json', ...tpl.headers, origin: new URL(BASE).origin });

async function abortViaFetch(tpl, phase) {
  const ac = new AbortController();
  const rec = { way: 'cancel', phase, tSend: Date.now(), bytesAtAbort: 0, hanAtAbort: false, endedAtAbort: false, received: '' };
  let bytes = 0; let txt = ''; let ended = false;
  const p = (async () => {
    try {
      const res = await fetch(tpl.url, { method: 'POST', headers: tplHeaders(tpl), body: tplBody(tpl, ABORT_TEXT), signal: ac.signal });
      rec.status = res.status;
      const rd = res.body.getReader(); const dec = new TextDecoder();
      for (;;) {
        const { done, value } = await rd.read();
        if (done) { ended = true; break; }
        bytes += value.length; txt += dec.decode(value, { stream: true });
        if (phase === 'after' && !rec.tAbort && RE_HAN.test(unescapeU(txt))) {
          rec.bytesAtAbort = bytes; rec.hanAtAbort = true; rec.endedAtAbort = false; rec.tAbort = Date.now(); ac.abort();
        }
      }
    } catch (e) { rec.err = e.name; }
  })();
  if (phase === 'before') { await sleep(150); rec.bytesAtAbort = bytes; rec.endedAtAbort = ended; rec.tAbort = Date.now(); ac.abort(); }
  await Promise.race([p, sleep(60000)]);
  if (!rec.tAbort) { rec.tAbort = Date.now(); rec.endedAtAbort = ended; ac.abort(); }
  rec.received = txt;
  return rec;
}
function abortViaSocket(tpl, phase) {
  return new Promise((resolve) => {
    const u = new URL(tpl.url); const lib = u.protocol === 'https:' ? https : http;
    const body = tplBody(tpl, ABORT_TEXT);
    const rec = { way: 'disconnect', phase, tSend: Date.now(), bytesAtAbort: 0, hanAtAbort: false, endedAtAbort: false, received: '' };
    let bytes = 0; let txt = ''; let fin = false;
    const req = lib.request(u, { method: 'POST', agent: false, headers: { ...tplHeaders(tpl), 'content-length': Buffer.byteLength(body) } }, (res) => {
      rec.status = res.statusCode;
      res.on('data', (c) => {
        if (fin) return;
        bytes += c.length; txt += c.toString('utf8');
        if (phase === 'after' && RE_HAN.test(unescapeU(txt))) { rec.bytesAtAbort = bytes; rec.hanAtAbort = true; finish('first-han-fragment'); }
      });
      res.on('end', () => { if (!fin) { rec.endedAtAbort = true; rec.bytesAtAbort = bytes; finish('response-ended'); } });
      res.on('error', () => {});
    });
    req.on('error', (e) => { if (!fin) { rec.err = e.code || e.message; finish('error'); } });
    function finish(why) {
      if (fin) return; fin = true; rec.tAbort = Date.now(); rec.why = why; rec.received = txt;
      req.destroy();
      setTimeout(() => resolve(rec), 200);
    }
    if (phase === 'before') setTimeout(() => { rec.bytesAtAbort = bytes; finish('timer-150ms'); }, 150);
    setTimeout(() => finish('timeout-60s'), 60000);
    req.write(body); req.end();
  });
}
async function normalRequest(tpl) {
  const rec = { tSend: Date.now() };
  try {
    const res = await fetch(tpl.url, { method: 'POST', headers: tplHeaders(tpl), body: tplBody(tpl, NORMAL_TEXT), signal: AbortSignal.timeout(60000) });
    rec.status = res.status; const t = unescapeU(await res.text());
    rec.han = RE_HAN.test(t); rec.hangul = RE_HANGUL.test(t.replace(NORMAL_TEXT, '')); rec.received = t;
  } catch (e) { rec.err = e.name + ' ' + ((e.cause && e.cause.code) || ''); }
  rec.tEnd = Date.now();
  return rec;
}
async function runAbortCases(tpl) {
  const cases = [];
  for (const phase of ['before', 'after']) {
    for (const way of ['cancel', 'disconnect']) {
      if (timeLeft() < 6 * 60 * 1000) { cases.push({ phase, way, skipped: true }); continue; }
      const a = way === 'cancel' ? await abortViaFetch(tpl, phase) : await abortViaSocket(tpl, phase);
      await sleep(1000);
      const n = await normalRequest(tpl);
      const c = { phase, way, abort: a, normal: n, win: [a.tSend - 1500, n.tEnd + 3000] };
      cases.push(c);
      log('abort case', phase, way, 'status', a.status, 'bytesAtAbort', a.bytesAtAbort, 'normal', n.status);
      await sleep(3000 + 5000 + 1500);
    }
  }
  writeEv('abort-cases.json', { template: { url: tpl.url, from: tpl.from, key: tpl.key, fields: Object.keys(tpl.obj) }, cases: cases.map((c) => ({ ...c, abort: c.abort && { ...c.abort, received: short(c.abort.received, 300) }, normal: c.normal && { ...c.normal, received: short(c.normal.received, 300) } })) });
  return cases;
}

// ---------------- 服务日志 ----------------
function levelOf(text) {
  let j = null; const i = text.indexOf('{');
  if (i >= 0) { try { j = JSON.parse(text.slice(i)); } catch (e) { j = null; } }
  if (j && typeof j === 'object') {
    const lv = j.level ?? j.severity ?? j.lvl ?? j.levelname;
    if (typeof lv === 'number') return { lv: lv >= 50 ? 'error' : lv >= 40 ? 'warn' : lv >= 30 ? 'info' : 'debug', json: j };
    if (typeof lv === 'string') { const s = lv.toLowerCase(); return { lv: /^(error|fatal|critical|crit|err|panic|emerg|alert)$/.test(s) ? 'error' : /^(info|information|notice)$/.test(s) ? 'info' : s, json: j }; }
    return { lv: /"(error|fatal)"/i.test(text) ? 'error' : 'unknown', json: j };
  }
  if (/level=(error|fatal)|\[(ERROR|FATAL)\]|\bFATAL\b|Unhandled|uncaught/i.test(text) || /^\s*[A-Za-z]*Error:/.test(text)) return { lv: 'error', json: null };
  if (/level=info|\[INFO\]/i.test(text)) return { lv: 'info', json: null };
  return { lv: 'unknown', json: null };
}
function keysOf(o, pre = '', out = []) { for (const [k, v] of Object.entries(o || {})) { out.push(pre + k); if (v && typeof v === 'object' && !Array.isArray(v) && pre.split('.').length < 3) keysOf(v, pre + k + '.', out); } return out; }
const FORBIDDEN_KEY = /(^|\.)(text|source_?text|source|translation|translated_?text|content|prompt|input|output|body|api_?key|key|token|secret|password|authorization|credential)$/i;
function readLogStatus() {
  try { return JSON.parse(fs.readFileSync(path.join(LOGS_DIR, 'status.json'), 'utf8')); } catch (e) { return null; }
}
function gapsOf(st) {
  return (st && Array.isArray(st.gaps) ? st.gaps : []).map((g) => Array.isArray(g) ? [Date.parse(g[0]), Date.parse(g[1])] : [Date.parse(g.from ?? g.start ?? g.since), Date.parse(g.to ?? g.end ?? g.until)]);
}
async function waitLogs(untilMs) {
  if (!LOGS_DIR) return { usable: false, reason: '未提供 QA_SERVICE_LOGS_DIR' };
  for (;;) {
    const st = readLogStatus();
    if (st && st.status === 'ok' && Date.parse(st.logsReadAt) >= untilMs) {
      let lines = [];
      try { lines = fs.readFileSync(path.join(LOGS_DIR, 'logs.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean); } catch (e) { return { usable: false, reason: '无法读取 logs.jsonl', st }; }
      return { usable: true, st, lines: lines.map((l) => ({ ...l, ts: Date.parse(l.time), text: String(l.text ?? '') })) };
    }
    if (timeLeft() < 40000) return { usable: false, reason: st ? `截止前日志未读到所需时间（status=${st.status}，logsReadAt=${st.logsReadAt}，reason=${st.reason || ''}）` : '没有 status.json', st };
    await sleep(5000);
  }
}
function windowUsable(L, win) {
  if (!L.usable) return L.reason;
  if (gapsOf(L.st).some(([a, b]) => a <= win[1] && b >= win[0])) return '时间窗落在日志 gaps 中';
  if (Date.parse(L.st.logsReadAt) < win[1]) return '时间窗尚未读到';
  return null;
}
function fragmentsFor(c) {
  const frags = [];
  for (const s of ABORT_TEXT.split(/(?<=[.。])\s+/)) { const t = s.replace(/[.,]/g, ''); frags.push(t.slice(0, 8), t.slice(-8)); }
  frags.push(NORMAL_TEXT.slice(0, 8));
  for (const rcv of [c.abort && c.abort.received, c.normal && c.normal.received]) {
    const runs = unescapeU(rcv || '').match(/[\u4E00-\u9FFF]{4,}/g) || [];
    for (const run of runs) for (let i = 0; i + 4 <= run.length && frags.length < 60; i += 4) frags.push(run.slice(i, i + 4));
  }
  return [...new Set(frags.filter((f) => f && f.trim().length >= 4))];
}
function analyzeWindow(L, c) {
  const lines = L.lines.filter((l) => l.ts >= c.win[0] && l.ts <= c.win[1]);
  const errs = []; const aborted = []; let contentHits = 0; let redacted = 0; let secretHits = 0;
  const frags = fragmentsFor(c);
  for (const l of lines) {
    const { lv, json } = levelOf(l.text);
    const hay = l.text + '\n' + unescapeU(l.text);
    if (l.text.includes('client_aborted')) aborted.push({ lv, keys: json ? keysOf(json).sort() : null, service: l.service });
    else if (lv === 'error') errs.push({ service: l.service, lv });
    if (frags.some((f) => hay.includes(f))) contentHits++;
    if (hay.includes('***')) redacted++;
    if (SECRET_VALUES.some((v) => hay.includes(v))) secretHits++;
  }
  const abortedErr = aborted.filter((a) => a.lv === 'error').length;
  return { lines: lines.length, errors: errs.length + abortedErr, errorServices: [...new Set(errs.map((e) => e.service))], clientAborted: aborted.length, clientAbortedInfo: aborted.filter((a) => a.lv === 'info').length, abortedLevels: aborted.map((a) => a.lv), abortedKeys: aborted.map((a) => a.keys), contentHits, redacted, secretHits, fragments: frags.length };
}
function anAbort(cases, L, phase, tpl, browserErr) {
  const out = []; const stats = [];
  const keySets = cases.filter((c) => c.win && c.stat && c.stat.abortedKeys.length).flatMap((c) => c.stat.abortedKeys.map((k) => JSON.stringify(k)));
  const sameKeys = new Set(keySets).size <= 1;
  for (const c of cases.filter((x) => x.phase === phase)) {
    const pre = c.way === 'cancel' ? '主动取消：' : '断开连接：';
    if (c.skipped) { out.push(cp(pre + '执行', false, '截止时间内未执行', 'gap')); continue; }
    const a = c.abort; const n = c.normal;
    const tplBad = !(n.status === 200);
    if (phase === 'before') out.push(cp(pre + '中止时尚未收到任何响应正文片段', a.bytesAtAbort === 0 && !a.endedAtAbort, `发送后 ${a.tAbort - a.tSend}ms 中止，已收正文 ${a.bytesAtAbort} 字节，响应状态 ${a.status ?? '未收到'}`, 'gap'));
    else out.push(cp(pre + '中止时已收到含汉字的片段且响应未结束', a.hanAtAbort && !a.endedAtAbort, `发送后 ${a.tAbort - a.tSend}ms 中止，已收正文 ${a.bytesAtAbort} 字节，含汉字=${a.hanAtAbort}，响应已结束=${a.endedAtAbort}，状态 ${a.status ?? '未收到'}`, tplBad ? 'gap' : 'defect'));
    const why = windowUsable(L, c.win);
    if (why) {
      for (const s of ['时间窗内 error/fatal 级日志 0 条', '时间窗内 client_aborted 信息级记录恰 1 条', '日志不含内容、脱敏标记或凭据']) out.push(cp(pre + s, false, '服务日志不可用于判定：' + why, 'env'));
    } else {
      const s = c.stat; stats.push({ way: c.way, ...s });
      out.push(cp(pre + '时间窗内 error/fatal 级日志 0 条', s.errors === 0, `时间窗 ${s.lines} 行日志，error/fatal ${s.errors} 条${s.errorServices.length ? '（服务 ' + s.errorServices.join(',') + '）' : ''}`));
      const bad = (s.abortedKeys.flat().filter(Boolean)).filter((k) => FORBIDDEN_KEY.test(k));
      out.push(cp(pre + '时间窗内 client_aborted 信息级记录恰 1 条', s.clientAborted === 1 && s.clientAbortedInfo === 1 && !bad.length && sameKeys, `client_aborted ${s.clientAborted} 条（级别 ${s.abortedLevels.join(',') || '无'}）；字段 ${JSON.stringify(s.abortedKeys[0] || [])}；内容/凭据字段 ${bad.length ? bad.join(',') : '无'}；各次字段集一致=${sameKeys}`));
      out.push(cp(pre + '日志不含内容、脱敏标记或凭据', s.contentHits === 0 && s.redacted === 0 && s.secretHits === 0, `检索 ${s.fragments} 个原文/译文片段命中 ${s.contentHits} 行；“***”命中 ${s.redacted} 行；凭据值命中 ${s.secretHits} 行`));
    }
    out.push(cp(pre + '服务未退出：随后的正常请求成功', n.status === 200 && n.han && !n.hangul, `正常请求状态 ${n.status ?? n.err}，含汉字=${n.han}，含谚文=${n.hangul}${tpl.from === 'fallback' ? '（请求体为退回格式）' : ''}`, n.status && n.status >= 400 && n.status < 500 ? 'gap' : n.status ? 'defect' : 'env'));
  }
  if (phase === 'after') {
    if (browserErr.reason) out.push(cp('真实浏览器中止：浏览器运行期间 error/fatal 日志 0 条', false, '服务日志不可用于判定：' + browserErr.reason, 'env'));
    else out.push(cp('真实浏览器中止：浏览器运行期间 error/fatal 日志 0 条', browserErr.count === 0, `浏览器运行期间 ${browserErr.lines} 行日志，error/fatal ${browserErr.count} 条，client_aborted ${browserErr.aborted} 条`));
  }
  return { out, stats };
}

// ---------------- 主流程 ----------------
function writeResult(res) { fs.writeFileSync(RESULT, JSON.stringify(res, null, 1)); }
function envResult(reason, evidence = ['harness.log']) {
  writeResult({ passed: false, testedCommitSha: SHA, summary: '执行环境或平台问题，未能完成测试：' + reason, defects: [], testGaps: [], evidence: [...evidence, '诊断：' + reason], bugfixResults: [{ bugfixId: 'IR-001', verdict: 'partial', evidence: '环境问题，未能验证：' + short(reason, 200) }], scenarios: [] });
}
async function pool(jobs, n) {
  const res = {};
  let i = 0;
  const worker = async () => {
    while (i < jobs.length) {
      const j = jobs[i++];
      if (timeLeft() < (j.mode312 ? 220000 : 160000) + 40000) { res[j.key] = { ok: false, failKind: 'gap', failMsg: '截止时间内未执行（13 分钟截止保护）', name: j.name }; continue; }
      res[j.key] = await runBrowser(j);
    }
  };
  await Promise.all(Array.from({ length: n }, worker));
  return res;
}
async function main() {
  const { base, diag } = await pickBase();
  writeEv('targets.json', { diag, deps: DEPS });
  if (!base) return envResult('候选不可达：' + diag.join('；'), ['harness.log', 'targets.json']);
  BASE = base;
  log('base', BASE, 'deps', DEPS.join(','));
  let A;
  try { A = await synthAll(); } catch (e) { return envResult('语音合成不可用：' + short(e.message, 300)); }
  log('tts', A.engines.join(','));
  try { await launchBrowser(); } catch (e) { return envResult('浏览器无法启动：' + short(e.message, 300)); }
  const M = { KO5: [KO5, A.audio.KO5], JA5: [JA5, A.audio.JA5], KOLONG: [KOLONG, A.audio.KOLONG], EN4: [EN4, A.audio.EN4] };
  const job = (key, name, scen, mat, input, extra = {}) => ({ key, name, scen, sentences: M[mat][0], audio: M[mat][1], input, ...extra });
  const runs = {};
  runs.ko1 = await runBrowser(job('ko1', 'IQA-301-1', 'IQA-301', 'KO5', 'system', { pip: true }));
  if (!runs.ko1.ok && runs.ko1.failKind === 'env') { await browser.close().catch(() => {}); return envResult(runs.ko1.failMsg, ['harness.log', 'run-IQA-301-1.json']); }
  const tpl = makeTemplate(runs.ko1);
  log('template', tpl.from, tpl.url);
  const cases = await runAbortCases(tpl);
  const jobs = [
    job('r303', 'IQA-303', 'IQA-303', 'KO5', 'system', { pip: true, inject: { mode: 'final', targets: [2] } }),
    job('r305', 'IQA-305', 'IQA-305', 'KO5', 'system', { pip: true, inject: { mode: 'final+retrans', targets: [0, 1, 2] } }),
    job('r304', 'IQA-304', 'IQA-304', 'KO5', 'mic', { inject: { mode: 'final', targets: [2] } }),
    job('r312', 'IQA-312', 'IQA-312', 'KO5', 'system', { playCount: 2, inject: { mode: 'final-delay-retrans', targets: [1], delayMs: 25000 }, mode312: { sentence: 1 } }),
    job('r306s', 'IQA-306-system', 'IQA-306', 'KOLONG', 'system', { inject: { mode: 'interim-once', targets: [1] } }),
    job('r306m', 'IQA-306-mic', 'IQA-306', 'KOLONG', 'mic', { inject: { mode: 'interim-once', targets: [1] } }),
    job('en1', 'IQA-311-en-system', 'IQA-311', 'EN4', 'system', { pip: true }),
    job('en2', 'IQA-311-en-mic', 'IQA-311', 'EN4', 'mic'),
    job('rej', 'IQA-311-reject', 'IQA-311', 'KO5', 'system', { inject: { mode: 'reject', targets: [0, 1, 2] } }),
    job('ko2', 'IQA-301-2', 'IQA-301', 'KO5', 'system'),
    job('ko3', 'IQA-301-3', 'IQA-301', 'KO5', 'system'),
    job('ja1', 'IQA-302-1', 'IQA-302', 'JA5', 'system'),
    job('ja2', 'IQA-302-2', 'IQA-302', 'JA5', 'system'),
    job('ja3', 'IQA-302-3', 'IQA-302', 'JA5', 'system'),
  ];
  Object.assign(runs, await pool(jobs, 3));
  await browser.close().catch(() => {});

  // 服务日志
  const wins = cases.filter((c) => c.win).map((c) => c.win);
  const needUntil = Math.max(0, ...RUN_WINDOWS.map((w) => w[1]), ...wins.map((w) => w[1]));
  const L = await waitLogs(needUntil);
  for (const c of cases) if (c.win && L.usable) c.stat = analyzeWindow(L, c);
  const browserErr = { reason: null, count: 0, lines: 0, aborted: 0 };
  if (!L.usable) browserErr.reason = L.reason;
  else {
    for (const w of RUN_WINDOWS) { const why = windowUsable(L, w); if (why) { browserErr.reason = why; break; } }
    if (!browserErr.reason) for (const l of L.lines) {
      if (!RUN_WINDOWS.some(([a, b]) => l.ts >= a && l.ts <= b)) continue;
      browserErr.lines++;
      const { lv } = levelOf(l.text);
      if (l.text.includes('client_aborted')) { browserErr.aborted++; if (lv === 'error') browserErr.count++; } else if (lv === 'error') browserErr.count++;
    }
  }
  const s308 = anAbort(cases, L, 'before', tpl, browserErr);
  const s309 = anAbort(cases, L, 'after', tpl, browserErr);
  writeEv('logs-summary.json', { usable: L.usable, reason: L.reason || null, status: L.st ? { status: L.st.status, logsReadAt: L.st.logsReadAt, gaps: L.st.gaps, droppedOldest: L.st.droppedOldest } : null, windows: cases.map((c) => ({ phase: c.phase, way: c.way, win: c.win && c.win.map((t) => new Date(t).toISOString()), stat: c.stat || null })), browserRuns: browserErr });

  // 场景汇总
  const ev = (...names) => names.filter((n) => fs.existsSync(path.join(EV, n))).join(', ') || 'harness.log';
  const runEv = (r) => (r && r.name ? ev(`run-${r.name}.json`, `${r.name}-end.png`, `${r.name}-pip.png`, `${r.name}-nocontrol.png`, `${r.name}-nolisten.png`) : 'harness.log');
  const scenarios = [];
  const add = (id, cps, evidence) => scenarios.push({ id, passed: cps.length > 0 && cps.every((c) => c.passed), externalServices: DEPS, checkpoints: cps, evidence: evidence || 'harness.log' });
  const multi = (list) => list.flatMap(([label, r, fn]) => withPrefix(`[${label}] `, fn(r)));
  add('IQA-301', multi([['运行1', runs.ko1, (r) => anClear(r, KO5)], ['运行2', runs.ko2, (r) => anClear(r, KO5)], ['运行3', runs.ko3, (r) => anClear(r, KO5)]]), [runs.ko1, runs.ko2, runs.ko3].map(runEv).join(', '));
  add('IQA-302', multi([['运行1', runs.ja1, (r) => anClear(r, JA5)], ['运行2', runs.ja2, (r) => anClear(r, JA5)], ['运行3', runs.ja3, (r) => anClear(r, JA5)]]), [runs.ja1, runs.ja2, runs.ja3].map(runEv).join(', '));
  const a303 = anRetrans(runs.r303, KO5, 2);
  add('IQA-303', a303.out, runEv(runs.r303));
  add('IQA-304', anRetrans(runs.r304, KO5, 2).out, runEv(runs.r304));
  const a305 = an305(runs.r305, KO5);
  add('IQA-305', a305.out, runEv(runs.r305));
  add('IQA-306', multi([['系统声音', runs.r306s, (r) => an306(r, KOLONG, 1)], ['麦克风', runs.r306m, (r) => an306(r, KOLONG, 1)]]), [runs.r306s, runs.r306m].map(runEv).join(', '));
  const c307 = [];
  for (const [label, r] of [['IQA-301 运行1', runs.ko1], ['IQA-303', runs.r303], ['IQA-305', runs.r305]]) {
    if (!r || !r.ok) { c307.push(cp(`[${label}] 运行完成`, false, (r && r.failMsg) || '未运行', (r && r.failKind) || 'gap')); continue; }
    const P = prepare(r);
    c307.push(cp(`[${label}] 小窗打开并有字幕条目`, r.pipOpened && P.pip.some((o) => o.list.length), `小窗打开=${!!r.pipOpened}（${r.pipVia || '无'}），小窗变化 ${P.pip.length} 次，最终条目 ${P.pipFinal.length} 条`));
    c307.push({ ...consistency(P, KO5), step: `[${label}] 主页面与小窗逐条一致` });
    const pipBad = P.pip.flatMap((o) => o.list).filter((t) => RE_HANGUL.test(t) || RE_KANA.test(t) || srcHit(t, KO5)).concat((r.snaps || []).filter((s) => s.k === 'pip' && s.f && (s.f.hangul || s.f.kana)).map(() => '小窗文档含谚文/假名'));
    c307.push(cp(`[${label}] 小窗不出现谚文、假名、注入内容或识别原文`, pipBad.length === 0, pipBad.length ? `${pipBad.length} 处：${pipBad.slice(0, 3).map((t) => short(t, 30)).join('；')}` : '无'));
  }
  add('IQA-307', c307, [runs.ko1, runs.r303, runs.r305].map(runEv).join(', '));
  add('IQA-308', s308.out, ev('abort-cases.json', 'logs-summary.json'));
  add('IQA-309', s309.out, ev('abort-cases.json', 'logs-summary.json'));
  add('IQA-311', multi([['系统声音+英语+小窗', runs.en1, (r) => an311en(r, EN4, true)], ['麦克风+英语', runs.en2, (r) => an311en(r, EN4, false)], ['请求失败', runs.rej, (r) => an311reject(r, KO5)]]), [runs.en1, runs.en2, runs.rej].map(runEv).join(', '));
  add('IQA-312', an312(runs.r312, KO5, 1), runEv(runs.r312));

  const defects = []; const testGaps = []; const envNotes = [];
  for (const s of scenarios) for (const c of s.checkpoints) if (!c.passed) {
    const line = `${s.id} ${c.step}：${c.observation}`;
    if (c.cat === 'gap') testGaps.push(line); else if (c.cat === 'env') envNotes.push(line); else defects.push(line);
  }
  for (const s of scenarios) s.checkpoints = s.checkpoints.map(({ step, passed, observation }) => ({ step, passed, observation }));
  const passed = scenarios.every((s) => s.passed) && !defects.length && !testGaps.length && !envNotes.length;
  const abortScen = scenarios.filter((s) => s.id === 'IQA-308' || s.id === 'IQA-309');
  const abortDefect = defects.some((d) => /^IQA-30[89]/.test(d));
  const verdict = abortScen.every((s) => s.passed) ? 'verified' : abortDefect ? 'failed' : 'partial';
  const evidenceList = ['harness.log', 'setup.log', 'targets.json', 'abort-cases.json', 'logs-summary.json', ...fs.readdirSync(EV).filter((f) => /^run-.*\.json$/.test(f))].filter((f) => fs.existsSync(path.join(EV, f)));
  if (envNotes.length) evidenceList.push(...envNotes.slice(0, 10).map((n) => '环境或平台问题：' + short(n, 300)));
  const nPass = scenarios.filter((s) => s.passed).length;
  writeResult({
    passed, testedCommitSha: SHA,
    summary: `执行 ${scenarios.length} 个验收场景，通过 ${nPass} 个；产品缺陷 ${defects.length} 项，脚本未能完成验证 ${testGaps.length} 项，环境或平台问题 ${envNotes.length} 项。语音合成：${A.engines.join(',')}；请求体模板来源：${tpl.from}。IQA-310（AC-9）按 G2 决定为测试缺口，不在脚本中执行；IQA-313（AC-13）为执行会话中对 design.md 的文档检查，不在脚本中执行。`,
    defects, testGaps, evidence: evidenceList,
    bugfixResults: [{ bugfixId: 'IR-001', verdict, evidence: `IQA-308/309：${abortScen.map((s) => `${s.id} ${s.passed ? '通过' : '未通过'}`).join('，')}；见 abort-cases.json、logs-summary.json` }],
    scenarios,
  });
  log('result written', passed);
}
const hardStop = setTimeout(() => { log('hard deadline'); if (!fs.existsSync(RESULT)) envResult('脚本超过 14 分钟仍未完成'); process.exit(0); }, Math.max(60000, T0 + 14 * 60 * 1000 - Date.now()));
main().catch((e) => { log('fatal', e.stack || e.message); if (!fs.existsSync(RESULT)) envResult('测试程序异常：' + short(e.message, 300)); }).finally(() => { clearTimeout(hardStop); setTimeout(() => process.exit(0), 500); });
QA_MAIN_EOF

node qa.mjs >> "$QA_EVIDENCE_DIR/harness.log" 2>&1
if ! jq -e '.passed|type=="boolean"' "$QA_RESULT_PATH" >/dev/null 2>&1; then env_fail "测试程序异常退出"; fi
exit 0
