// Page init script (test browser only). Provides:
// - a controllable fake microphone (getUserMedia for audio returns a WebAudio stream; __qa.play() speaks a sentence)
// - controlled triggers on final translation requests (delay / Korean result / failure), per "可测性约定·受控触发"
// - a caption timeline: first time each caption becomes a Chinese final caption (Date.now()), per "出现时刻的对照"
(() => {
  if (window.__qa) return;
  const qa = (window.__qa = { rules: [], failAllFinal: false, finalReqs: [], seen: {}, order: [], playing: 0 });

  // ---------- fake microphone ----------
  let actx = null;
  let dest = null;
  function ensureAudio() {
    if (!actx) {
      actx = new AudioContext({ sampleRate: 48000 });
      dest = actx.createMediaStreamDestination();
    }
    return actx;
  }
  const md = navigator.mediaDevices;
  if (md && md.getUserMedia) {
    const orig = md.getUserMedia.bind(md);
    md.getUserMedia = async (c) => {
      if (c && c.audio && !c.video) {
        ensureAudio();
        try { await actx.resume(); } catch {}
        return new MediaStream(dest.stream.getAudioTracks().map((t) => t.clone()));
      }
      return orig(c);
    };
  }
  qa.play = async (b64) => {
    ensureAudio();
    try { await actx.resume(); } catch {}
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const buf = await actx.decodeAudioData(bytes.buffer);
    const src = actx.createBufferSource();
    src.buffer = buf;
    src.connect(dest);
    qa.playing++;
    src.onended = () => { qa.playing--; };
    src.start();
    return buf.duration;
  };

  // ---------- controlled triggers on /api/translations (final only) ----------
  const origFetch = window.fetch.bind(window);
  const sleep = (ms, signal) => new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    if (signal) signal.addEventListener('abort', () => { clearTimeout(t); reject(new DOMException('Aborted', 'AbortError')); }, { once: true });
  });
  const ndjson = (lines) => new Response(lines.map((l) => JSON.stringify(l)).join('\n') + '\n', { status: 200, headers: { 'Content-Type': 'application/x-ndjson' } });
  window.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : (input && input.url) || String(input);
    if (url.includes('/api/translations')) {
      let bodyText = init && typeof init.body === 'string' ? init.body : null;
      if (bodyText === null && input instanceof Request) { try { bodyText = await input.clone().text(); } catch {} }
      let body = null;
      try { body = JSON.parse(bodyText); } catch {}
      if (body && body.kind === 'final') {
        const text = String(body.text || '');
        const low = text.toLowerCase();
        const rec = { at: Date.now(), text, retranslate: !!body.retranslate, action: 'pass' };
        qa.finalReqs.push(rec);
        const signal = (init && init.signal) || (input instanceof Request ? input.signal : undefined);
        if (qa.failAllFinal) {
          rec.action = 'fail';
          return new Response(JSON.stringify({ error: 'upstream_unavailable' }), { status: 502, headers: { 'Content-Type': 'application/json' } });
        }
        const rule = qa.rules.find((r) => low.includes(r.key) && (r.action !== 'delay' || (!body.retranslate && !r.used)));
        if (rule) {
          rec.action = rule.action;
          if (rule.action === 'hangul') {
            rule.used = (rule.used || 0) + 1;
            return ndjson([{ type: 'delta', text: '이 문장은 테스트용 한국어 결과입니다' }, { type: 'done' }]);
          }
          if (rule.action === 'delay') {
            rule.used = 1;
            await sleep(rule.delayMs, signal);
          }
        }
      }
    }
    return origFetch(input, init);
  };

  // ---------- caption timeline ----------
  function scan() {
    const list = document.getElementById('captions');
    if (!list) return;
    const now = Date.now();
    for (const li of list.children) {
      const id = li.getAttribute('data-segment-id') || '';
      const st = li.getAttribute('data-status') || '';
      const kind = li.getAttribute('data-kind') || '';
      let e = qa.seen[id];
      if (!e) { e = qa.seen[id] = { id, firstAt: now, finalAt: null, finalText: null, history: [] }; qa.order.push(id); }
      const last = e.history[e.history.length - 1];
      if (!last || last.status !== st || last.kind !== kind) e.history.push({ status: st, kind, at: now, text: li.textContent });
      if (st === 'final' && kind === '' && e.finalAt === null) { e.finalAt = now; e.finalText = li.textContent; }
    }
  }
  qa.scan = scan;
  new MutationObserver(scan).observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
})();
