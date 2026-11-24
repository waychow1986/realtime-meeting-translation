// 测试的浏览器初始化脚本（只在测试浏览器中注入；按可测性约定“受控触发”）：
// - 记录状态区、提示区、字幕条目的变化时间线（Date.now()）；
// - 包装 WebSocket：触发后不再把语音服务连接的入站消息交给 SDK，发出的音频照常发送；
// - 包装 AudioContext：记录页面混音用的实例（无构造参数）与其 MediaStreamDestination；
// - 包装 getDisplayMedia：记录共享采集的流，用于检查采集是否已结束；
// - 包装 fetch：按测试模式替换 /api/translations 定稿请求的响应。
// 不记录识别原文与译文内容，只记录长度、时间与状态。
(() => {
  if (window.__qa) return;
  const T = (window.__qa = {
    states: [], notices: [], captions: {}, finals: [], blockWs: false, blockAt: null,
    wsCount: 0, wsInDropped: 0, wsInDelivered: 0, mix: null, mixDest: null, ctxCount: 0,
    displayStreams: [], translateMode: 'normal', translateHits: [], noticeTexts: [],
    sockets: [], blockedSockets: new Set(),
  });
  // blockRun：被制造停滞的那次运行结束（状态离开“正在听”）前新建的连接也一并拦截。
  T.block = () => { for (const s of T.sockets) T.blockedSockets.add(s); T.blockWs = true; T.blockRun = true; T.blockAt = Date.now(); return T.blockAt; };

  // ---- WebSocket ----
  const NativeWS = window.WebSocket;
  function QaWS(url, protocols) {
    const ws = protocols === undefined ? new NativeWS(url) : new NativeWS(url, protocols);
    const isSpeech = /^wss:/i.test(String(url)) && !String(url).startsWith('wss://' + location.host);
    if (!isSpeech) return ws;
    T.wsCount++;
    T.sockets.push(ws);
    if (T.blockRun) T.blockedSockets.add(ws);
    const nativeAdd = ws.addEventListener.bind(ws);
    const nativeRemove = ws.removeEventListener.bind(ws);
    const wrapped = new Map();
    // 只拦截触发时已存在的连接（被制造停滞的那次运行）；之后新建的连接不受影响。
    const gate = (fn) => function (ev) {
      if (T.blockedSockets.has(ws)) { T.wsInDropped++; return; }
      T.wsInDelivered++;
      return typeof fn === 'function' ? fn.call(this, ev) : fn && fn.handleEvent && fn.handleEvent(ev);
    };
    ws.addEventListener = function (type, fn, opts) {
      if (type === 'message' && fn) {
        const g = gate(fn); wrapped.set(fn, g); return nativeAdd(type, g, opts);
      }
      return nativeAdd(type, fn, opts);
    };
    ws.removeEventListener = function (type, fn, opts) {
      if (type === 'message' && wrapped.has(fn)) { const g = wrapped.get(fn); wrapped.delete(fn); return nativeRemove(type, g, opts); }
      return nativeRemove(type, fn, opts);
    };
    let handler = null;
    const onmsg = gate((ev) => handler && handler.call(ws, ev));
    nativeAdd('message', onmsg);
    Object.defineProperty(ws, 'onmessage', { configurable: true, get: () => handler, set: (h) => { handler = h; } });
    return ws;
  }
  QaWS.prototype = NativeWS.prototype;
  for (const k of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']) QaWS[k] = NativeWS[k];
  window.WebSocket = QaWS;

  // ---- AudioContext ----
  const NativeAC = window.AudioContext;
  if (NativeAC) {
    class QaAC extends NativeAC {
      constructor(...args) {
        super(...args);
        T.ctxCount++;
        const isMix = args.length === 0 || args[0] === undefined;
        if (isMix) { T.mix = this; T.mixDest = null; }
        const orig = this.createMediaStreamDestination.bind(this);
        this.createMediaStreamDestination = (...a) => { const d = orig(...a); if (isMix && T.mix === this) T.mixDest = d; return d; };
      }
    }
    window.AudioContext = QaAC;
  }

  // ---- getDisplayMedia ----
  if (navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia) {
    const orig = navigator.mediaDevices.getDisplayMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getDisplayMedia = async (...a) => { const s = await orig(...a); T.displayStreams.push(s); return s; };
  }
  T.liveCaptureTracks = () => T.displayStreams.flatMap((s) => s.getTracks()).filter((t) => t.readyState === 'live').length;

  // ---- fetch ----
  const nativeFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    if (url.includes('/api/translations') && init && typeof init.body === 'string') {
      let kind = null; try { kind = JSON.parse(init.body).kind; } catch { /* ignore */ }
      let code = null;
      if (kind === 'final' && T.translateMode === 'rejectNextFinal') { code = 'upstream_rejected'; T.translateMode = 'normal'; }
      else if (kind === 'final' && T.translateMode === 'failFinals') code = 'upstream_unavailable';
      if (code) {
        const seg = Array.from(document.querySelectorAll('#captions li.caption')).filter((li) => li.getAttribute('data-status') === 'finalizing').map((li) => li.getAttribute('data-segment-id'));
        T.translateHits.push({ at: Date.now(), code, finalizing: seg });
        return new Response(JSON.stringify({ type: 'error', code }) + '\n', { status: 200, headers: { 'content-type': 'application/x-ndjson' } });
      }
    }
    return nativeFetch(input, init);
  };

  // ---- 时间线 ----
  const textOf = (el) => (el ? (el.textContent || '').trim() : '');
  function observe() {
    const status = document.getElementById('status');
    const notice = document.getElementById('notice');
    const caps = document.getElementById('captions');
    if (!status || !notice || !caps) return false;
    const rec = () => {
      const s = textOf(status);
      const last = T.states[T.states.length - 1];
      if (!last || last.text !== s) {
        const data = document.body.getAttribute('data-state');
        T.states.push({ at: Date.now(), text: s, data });
        if (T.blockRun && data !== 'running') T.blockRun = false;
      }
      const n = notice.hidden ? '' : textOf(notice);
      const ln = T.notices[T.notices.length - 1];
      if (!ln || ln.text !== n) {
        let idx = T.noticeTexts.indexOf(n); if (idx < 0) { T.noticeTexts.push(n); idx = T.noticeTexts.length - 1; }
        T.notices.push({ at: Date.now(), text: n, idx, kind: notice.getAttribute('data-kind') });
      }
      for (const li of caps.querySelectorAll('li.caption')) {
        const id = li.getAttribute('data-segment-id') || '';
        const st = li.getAttribute('data-status');
        const c = T.captions[id] || (T.captions[id] = { first: Date.now(), status: null, notice: li.getAttribute('data-kind') === 'notice' });
        if (c.status !== st) {
          c.status = st; c.len = textOf(li).length;
          if (st === 'final' && !c.finalAt) { c.finalAt = Date.now(); if (!c.notice) T.finals.push({ id, at: c.finalAt }); }
        }
      }
    };
    rec();
    new MutationObserver(rec).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['hidden', 'data-status', 'data-state', 'data-kind'] });
    return true;
  }
  if (!observe()) document.addEventListener('DOMContentLoaded', observe, { once: true });
})();
