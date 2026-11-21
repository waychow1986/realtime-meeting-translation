import https from 'https'; import fs from 'fs';
const U = new URL(process.env.AIDH_SERVICE_WEB_URL);
const LONG = '안녕하세요 여러분. 오늘 회의에서는 올해 상반기 매출 실적과 하반기 계획을 자세히 말씀드리겠습니다. 먼저 상반기 매출은 작년 같은 기간보다 이십 퍼센트 증가했습니다. 특히 해외 시장에서의 성장이 두드러졌으며 신규 고객도 크게 늘었습니다. 하반기에는 새로운 제품 세 가지를 출시하고 고객 지원 체계를 강화할 예정입니다. 마지막으로 여러분의 의견을 듣고 싶으니 질문이 있으시면 언제든지 말씀해 주세요.';
const SHORT = '감사합니다. 좋은 하루 보내세요.';
const body = (t) => JSON.stringify({ kind: 'final', text: t, sourceLanguage: 'ko-KR', inputSource: 'microphone' });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const HAN = /[\u4E00-\u9FFF]/, HANGUL = /[\uAC00-\uD7AF]/;
function send(text, mode, phase) {
  return new Promise((resolve) => {
    const o = { tSend: Date.now(), mode, phase, bytes: 0, received: '', ended: false, status: null };
    const req = https.request({ host: U.host, path: '/api/translations', method: 'POST', headers: { 'content-type': 'application/json', origin: U.origin } }, (res) => {
      o.status = res.statusCode; res.setEncoding('utf8');
      res.on('data', (c) => { o.bytes += Buffer.byteLength(c); o.received += c;
        if (mode !== 'normal' && phase === 'after' && !o.tAbort && HAN.test(o.received)) doAbort(); });
      res.on('end', () => { o.ended = true; o.tEnd = Date.now(); if (!o.tAbort) resolve(o); });
      res.on('error', () => {});
    });
    req.on('error', (e) => { o.err = e.code || String(e); });
    const doAbort = () => { o.tAbort = Date.now(); o.bytesAtAbort = o.bytes; o.hanAtAbort = HAN.test(o.received); o.endedAtAbort = o.ended;
      if (mode === 'cancel') req.destroy(new Error('AbortError')); else req.socket && req.socket.destroy();
      setTimeout(() => resolve(o), 200); };
    if (mode !== 'normal' && phase === 'before') setTimeout(doAbort, 150);
    req.end(body(text));
  });
}
const cases = [];
for (const phase of ['before', 'after']) for (const mode of ['cancel', 'disconnect']) {
  const w0 = Date.now() - 1500;
  const a = await send(LONG, mode, phase);
  await sleep(1000);
  const n = await send(SHORT, 'normal');
  const w1 = Date.now() + 3000;
  const strip = (x) => ({ ...x, received: undefined, recvLen: x.received.length, han: HAN.test(x.received), hangul: HANGUL.test(x.received) });
  cases.push({ phase, mode, win: [new Date(w0).toISOString(), new Date(w1).toISOString()], abort: strip(a), normal: strip(n), fragments: [...a.received.matchAll(/"text":"([^"]{2,})"/g), ...n.received.matchAll(/"text":"([^"]{2,})"/g)].map(m => m[1]) });
  await sleep(8000);
}
fs.writeFileSync('/tmp/abort-manual.json', JSON.stringify(cases, null, 1));
for (const c of cases) console.log(c.phase, c.mode, JSON.stringify({ a: { st: c.abort.status, bytesAtAbort: c.abort.bytesAtAbort, hanAtAbort: c.abort.hanAtAbort, endedAtAbort: c.abort.endedAtAbort }, n: { st: c.normal.status, han: c.normal.han, hangul: c.normal.hangul } }));
