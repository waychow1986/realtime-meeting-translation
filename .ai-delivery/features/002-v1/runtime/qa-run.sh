#!/usr/bin/env bash
# 002-v1 独立测试脚本：系统声音实时中文字幕（IQA-101～IQA-123）。
# 依据 tasks-qa.md；在空的可写工作目录中运行，自包含，不依赖仓库源码。
set -uo pipefail

WORK="$(pwd)"
export QA_WORK="$WORK"
export QA_T0="$(date +%s)"
: "${QA_RESULT_PATH:?QA_RESULT_PATH 未设置}"
: "${QA_EVIDENCE_DIR:?QA_EVIDENCE_DIR 未设置}"
mkdir -p "$QA_EVIDENCE_DIR"
SETUP_LOG="$QA_EVIDENCE_DIR/setup.log"
: > "$SETUP_LOG"
log() { echo "[$(date -u +%H:%M:%S)] $*" | tee -a "$SETUP_LOG" >&2; }

# 环境或平台问题：passed=false，defects 与 testGaps 为空，诊断写入 evidence。
write_env_result() {
  QA_ENV_MSG="$1" python3 - <<'PYEOF'
import json, os
msg = os.environ.get("QA_ENV_MSG", "")
ids = ["IQA-%d" % i for i in range(101, 124)]
res = {
  "passed": False,
  "testedCommitSha": os.environ.get("QA_CANDIDATE_SHA", ""),
  "summary": "环境：" + msg + "；未能执行验收场景，不计产品缺陷。",
  "defects": [], "testGaps": [],
  "evidence": ["setup.log", "环境：" + msg],
  "bugfixResults": [],
  "scenarios": [{"id": i, "passed": False, "externalServices": [],
                 "checkpoints": [{"step": "执行环境", "passed": False, "observation": "环境：" + msg}],
                 "evidence": "环境：" + msg + "（见 setup.log）"} for i in ids],
}
with open(os.environ["QA_RESULT_PATH"], "w", encoding="utf-8") as f:
    json.dump(res, f, ensure_ascii=False, indent=1)
PYEOF
}

XVFB_PIDS=()
cleanup() { for p in "${XVFB_PIDS[@]}"; do kill "$p" 2>/dev/null; done; }
trap cleanup EXIT

# ---------- 1. 安装工具（并行） ----------
export PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-/ms-playwright}"
export npm_config_loglevel=error npm_config_fund=false npm_config_audit=false npm_config_update_notifier=false
VOICE_BASE="https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/medium"
(
  cd "$WORK" && echo '{"name":"qa","private":true,"type":"module"}' > package.json \
  && timeout 240 npm install --no-save playwright@1.65.1 >>"$SETUP_LOG" 2>&1 \
  && if ! ls "$PLAYWRIGHT_BROWSERS_PATH" 2>/dev/null | grep -q '^chromium-' || ! ls "$PLAYWRIGHT_BROWSERS_PATH" 2>/dev/null | grep -q '^firefox-'; then
       PLAYWRIGHT_BROWSERS_PATH="$WORK/pw-browsers" timeout 240 npx playwright install chromium firefox >>"$SETUP_LOG" 2>&1 && echo "$WORK/pw-browsers" > "$WORK/.pwpath"
     fi
) & P_NPM=$!
(
  cd "$WORK" && timeout 300 python3 -m venv venv >>"$SETUP_LOG" 2>&1 \
  && timeout 300 venv/bin/pip install -q --disable-pip-version-check piper-tts python-xlib >>"$SETUP_LOG" 2>&1
) & P_PIP=$!
(
  cd "$WORK" && timeout 300 curl -fsSL --retry 3 -o voice.onnx "$VOICE_BASE/en_US-lessac-medium.onnx" \
  && timeout 60 curl -fsSL --retry 3 -o voice.onnx.json "$VOICE_BASE/en_US-lessac-medium.onnx.json"
) >>"$SETUP_LOG" 2>&1 & P_VOICE=$!
wait $P_NPM; R_NPM=$?
wait $P_PIP; R_PIP=$?
wait $P_VOICE; R_VOICE=$?
log "setup npm=$R_NPM pip=$R_PIP voice=$R_VOICE elapsed=$(( $(date +%s) - QA_T0 ))s"
[ -f "$WORK/.pwpath" ] && export PLAYWRIGHT_BROWSERS_PATH="$(cat "$WORK/.pwpath")"
if [ $R_NPM -ne 0 ]; then write_env_result "安装 Playwright 或浏览器失败"; exit 0; fi
if [ $R_PIP -ne 0 ] || [ $R_VOICE -ne 0 ]; then write_env_result "安装 Piper 语音合成或下载声音模型失败"; exit 0; fi

# ---------- 2. 合成测试素材（tasks-qa.md 第 4 节） ----------
mkdir -p "$WORK/media"
cat > "$WORK/synth.py" <<'PYEOF'
import array, json, os, subprocess, sys, wave
W = os.environ["QA_WORK"]; OUT = os.path.join(W, "media")
PIPER = os.path.join(W, "venv", "bin", "piper"); MODEL = os.path.join(W, "voice.onnx")
SR = 22050
SENT = [
 "The quarterly sales report shows that our team in the European market sold many more products than we expected at the beginning of this year.",
 "The meeting will start at ten o'clock tomorrow morning.",
 "Please do not share this document with anyone outside the company.",
 "Our team sold twenty five thousand cars last year.",
 "The new office in Shanghai will open in July.",
 "We cannot accept this price because it is too high.",
]
INTF = "My favorite fruit is a banana, and I really like elephants."

def tts(text, scale=1.0):
    tmp = os.path.join(OUT, "tmp.wav")
    subprocess.run([PIPER, "-m", MODEL, "-f", tmp, "--length-scale", str(scale)], input=text.encode(), check=True,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    with wave.open(tmp) as w:
        assert w.getframerate() == SR and w.getnchannels() == 1 and w.getsampwidth() == 2
        a = array.array("h", w.readframes(w.getnframes()))
    os.remove(tmp)
    # 按 20 ms 帧 RMS 去掉首尾静音，得到语音起止
    fr = SR // 50; th = 300
    def rms(i):
        seg = a[i * fr:(i + 1) * fr]
        return (sum(x * x for x in seg) / max(1, len(seg))) ** 0.5
    n = len(a) // fr
    s = next((i for i in range(n) if rms(i) > th), 0)
    e = next((i for i in range(n - 1, -1, -1) if rms(i) > th), n - 1)
    return a[s * fr:(e + 1) * fr]

def sil(sec): return array.array("h", [0] * int(SR * sec))

def build(name, parts):
    buf = array.array("h"); marks = []
    for p in parts:
        if isinstance(p, tuple):
            idx, clip = p; st = len(buf) / SR; buf.extend(clip)
            marks.append({"i": idx, "start": round(st, 3), "end": round(len(buf) / SR, 3)})
        else:
            buf.extend(sil(p))
    with wave.open(os.path.join(OUT, name + ".wav"), "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR); w.writeframes(buf.tobytes())
    return {"file": name + ".wav", "duration": round(len(buf) / SR, 3), "sentences": marks}

clips = [tts(t) for t in SENT]
d1 = len(clips[0]) / SR
if d1 < 8.3:
    clips[0] = tts(SENT[0], round(8.8 / d1, 2))
intf = tts(INTF)
meta = {"firstSentenceSeconds": round(len(clips[0]) / SR, 3)}
sys_parts = [1.0]
for i, c in enumerate(clips):
    sys_parts += [(i + 1, c), 2.5]
sys_parts[-1] = 10.0
meta["SYS"] = build("SYS", sys_parts)
meta["ONE"] = build("ONE", [1.0, (2, clips[1]), 1.0])
loop_parts = []
for i, c in enumerate(clips):
    loop_parts += [(i + 1, c), 1.5]
meta["LOOP"] = build("LOOP", loop_parts)
meta["INTF"] = build("INTF", [(0, intf), 1.0])
meta["MIC"] = build("MIC", [2.0] + sys_parts)
ml = []
for i in (1, 2, 3, 4):
    ml += [(i + 1, clips[i]), 2.0]
meta["MICLOOP"] = build("MICLOOP", ml)
json.dump(meta, open(os.path.join(OUT, "meta.json"), "w"), indent=1)
print("ok first=%.2fs" % meta["firstSentenceSeconds"])
PYEOF

cat > "$WORK/esc.py" <<'PYEOF'
import sys, time
from Xlib import X, XK, display
from Xlib.ext import xtest
d = display.Display()
kc = d.keysym_to_keycode(XK.string_to_keysym("Escape"))
for _ in range(int(sys.argv[1]) if len(sys.argv) > 1 else 1):
    xtest.fake_input(d, X.KeyPress, kc); xtest.fake_input(d, X.KeyRelease, kc); d.sync(); time.sleep(0.4)
PYEOF

if ! timeout 180 "$WORK/venv/bin/python" "$WORK/synth.py" >>"$SETUP_LOG" 2>&1; then
  write_env_result "合成测试语音素材失败"; exit 0
fi
log "media ready elapsed=$(( $(date +%s) - QA_T0 ))s"

# ---------- 3. 虚拟显示（每个会话组一个） ----------
DISPLAYS=()
for n in $(seq 91 140); do
  [ ${#DISPLAYS[@]} -ge 6 ] && break
  [ -e "/tmp/.X11-unix/X$n" ] || [ -e "/tmp/.X$n-lock" ] && continue
  Xvfb ":$n" -screen 0 1920x1200x24 -nolisten tcp >>"$SETUP_LOG" 2>&1 &
  pid=$!; sleep 0.6
  if kill -0 "$pid" 2>/dev/null; then XVFB_PIDS+=("$pid"); DISPLAYS+=(":$n"); fi
done
if [ ${#DISPLAYS[@]} -lt 5 ]; then write_env_result "无法启动 Xvfb 虚拟显示"; exit 0; fi
export QA_DISPLAYS="$(IFS=,; echo "${DISPLAYS[*]}")"
log "displays=$QA_DISPLAYS"

# ---------- 4. 测试驱动（Node + Playwright） ----------
cat > "$WORK/qainit.js" <<'JSEOF'
// 页面初始化脚本：只做透传记录；合成麦克风仅在配置 mic 时启用（T-A4）。
function qaInit(cfg) {
  if (window.__qa) return;
  const qa = window.__qa = { cfg, media: [], tracks: [], _t: [], recorder: [], rtc: [], videoDraws: 0, timeline: [], baseline: null, micContent: cfg.mic || null };
  const safe = (o) => { try { return JSON.parse(JSON.stringify(o)); } catch (e) { return String(o); } };
  const reg = (s, call) => {
    for (const t of s.getTracks()) {
      const rec = { call, kind: t.kind, label: t.label, start: Date.now(), end: null, settings: safe(t.getSettings ? t.getSettings() : {}) };
      qa.tracks.push(rec); qa._t.push(t);
      t.addEventListener('ended', () => { rec.end = rec.end || Date.now(); rec.endedBy = rec.endedBy || 'source'; });
      const ostop = t.stop.bind(t);
      t.stop = () => { rec.end = rec.end || Date.now(); rec.endedBy = rec.endedBy || 'app'; ostop(); };
    }
  };
  qa.trackState = () => qa.tracks.map((r, i) => Object.assign({}, r, { readyState: qa._t[i].readyState }));
  const synth = async (name) => {
    const ac = new AudioContext();
    const buf = await (await fetch(location.origin + '/__qa__/' + name.toUpperCase() + '.wav')).arrayBuffer();
    const ab = await ac.decodeAudioData(buf);
    const src = ac.createBufferSource(); src.buffer = ab; src.loop = name !== 'one';
    const dst = ac.createMediaStreamDestination(); src.connect(dst); src.start(); try { await Promise.race([ac.resume(), new Promise((r) => setTimeout(r, 1500))]); } catch (e) {}
    if (ac.state !== 'running') {
      // 无音频输出设备时 Firefox 的 AudioContext 无法运行，改用媒体元素采集流（mozCaptureStream 在播放结束后不结束轨道）。
      try { src.stop(); ac.close(); } catch (e) {}
      const el = qa._synthEl = new Audio(location.origin + '/__qa__/' + name.toUpperCase() + '.wav'); el.loop = name !== 'one';
      await el.play();
      const s = el.mozCaptureStream ? el.mozCaptureStream() : el.captureStream();
      qa.synthStarted = Date.now(); qa.synthMode = 'element';
      s.getAudioTracks().forEach(t => { const os = t.stop.bind(t); t.stop = () => { os(); try { el.pause(); } catch (e) {} }; });
      return s;
    }
    qa.synthStarted = Date.now();
    dst.stream.getAudioTracks().forEach(t => { const os = t.stop.bind(t); t.stop = () => { os(); try { src.stop(); ac.close(); } catch (e) {} }; });
    return dst.stream;
  };
  const md = navigator.mediaDevices;
  if (md && md.getUserMedia) {
    const ogum = md.getUserMedia.bind(md);
    md.getUserMedia = async function (c) {
      const rec = { type: 'gum', t: Date.now(), constraints: safe(c), content: qa.micContent || 'real' };
      qa.media.push(rec);
      try {
        const s = (c && c.audio && qa.micContent) ? await synth(qa.micContent) : await ogum(c);
        rec.ok = Date.now(); rec.audio = s.getAudioTracks().length; rec.video = s.getVideoTracks().length; reg(s, 'gum');
        return s;
      } catch (e) { rec.error = e.name + ': ' + e.message; throw e; }
    };
    if (cfg.mic && md.enumerateDevices) {
      const oenum = md.enumerateDevices.bind(md);
      md.enumerateDevices = async function () {
        const l = await oenum();
        if (!l.some(d => d.kind === 'audioinput')) l.push({ deviceId: 'qa-synth', groupId: 'qa', kind: 'audioinput', label: 'QA synthetic microphone', toJSON() { return this; } });
        return l;
      };
    }
  }
  if (md && md.getDisplayMedia) {
    const ogdm = md.getDisplayMedia.bind(md);
    md.getDisplayMedia = async function (c) {
      const rec = { type: 'gdm', t: Date.now(), constraints: safe(c) };
      qa.media.push(rec);
      try {
        const s = await ogdm(c);
        rec.ok = Date.now(); rec.audio = s.getAudioTracks().length; rec.video = s.getVideoTracks().length; reg(s, 'gdm');
        return s;
      } catch (e) { rec.error = e.name + ': ' + e.message; rec.errT = Date.now(); throw e; }
    };
  }
  if (window.MediaRecorder) {
    const OMR = window.MediaRecorder;
    window.MediaRecorder = new Proxy(OMR, { construct(t, args, nt) {
      const s = args[0];
      qa.recorder.push({ t: Date.now(), video: s && s.getVideoTracks ? s.getVideoTracks().length : null, audio: s && s.getAudioTracks ? s.getAudioTracks().length : null, mime: args[1] && args[1].mimeType });
      return Reflect.construct(t, args, nt);
    } });
  }
  if (window.RTCPeerConnection) {
    const P = window.RTCPeerConnection.prototype;
    const oat = P.addTrack, oatr = P.addTransceiver;
    P.addTrack = function (t, ...r) { qa.rtc.push({ op: 'addTrack', kind: t && t.kind }); return oat.call(this, t, ...r); };
    P.addTransceiver = function (t, ...r) { qa.rtc.push({ op: 'addTransceiver', kind: typeof t === 'string' ? t : t && t.kind }); return oatr.call(this, t, ...r); };
  }
  if (window.CanvasRenderingContext2D) {
    const odi = CanvasRenderingContext2D.prototype.drawImage;
    CanvasRenderingContext2D.prototype.drawImage = function (src, ...r) {
      try { if (src instanceof HTMLVideoElement && src.srcObject && src.srcObject.getVideoTracks().length) qa.videoDraws++; } catch (e) {}
      return odi.call(this, src, ...r);
    };
  }

  // ---- 元素定位（T-A2、T-A17） ----
  const norm = (s) => (s || '').replace(/\s+/g, '');
  const vis = (el) => {
    if (!el || !el.ownerDocument) return false;
    const w = el.ownerDocument.defaultView; const cs = w.getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || +cs.opacity === 0) return false;
    const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0;
  };
  const nameOf = (el) => {
    if (!el) return '';
    const al = el.getAttribute && el.getAttribute('aria-label'); if (al) return al.trim();
    const lb = el.getAttribute && el.getAttribute('aria-labelledby');
    if (lb) { const t = lb.split(/\s+/).map(id => el.ownerDocument.getElementById(id)).filter(Boolean).map(e => e.innerText).join(''); if (t.trim()) return t.trim(); }
    if (el.labels && el.labels.length) return Array.from(el.labels).map(l => l.innerText).join('').trim();
    if (el.tagName === 'INPUT' && (el.type === 'button' || el.type === 'submit')) return (el.value || '').trim();
    return ((el.innerText != null ? el.innerText : el.textContent) || el.title || '').trim();
  };
  qa.nameOf = nameOf; qa.vis = vis;
  const ctlOf = (el) => el.tagName === 'LABEL' ? (el.control || el.querySelector('input')) : el;
  qa.isSelected = (el) => {
    if (!el) return false;
    if (el.tagName === 'OPTION') return el.selected;
    const c = ctlOf(el) || el;
    if (c.checked === true) return true;
    for (const a of ['aria-checked', 'aria-pressed', 'aria-selected']) { if (el.getAttribute(a) === 'true' || c.getAttribute(a) === 'true') return true; }
    const inner = el.querySelector && el.querySelector('input:checked'); return !!inner;
  };
  qa.isEnabled = (el) => {
    if (!el) return false;
    const c = el.tagName === 'OPTION' ? el.closest('select') : (ctlOf(el) || el);
    if (c.disabled || el.disabled) return false;
    if (el.getAttribute('aria-disabled') === 'true' || c.getAttribute('aria-disabled') === 'true') return false;
    if (c.closest && c.closest('fieldset[disabled],[inert]')) return false;
    return true;
  };
  const CLICKABLE = 'button,[role=button],input[type=button],input[type=submit],a[href],[role=link]';
  const OPTS = 'input[type=radio],[role=radio],[role=tab],[role=option],[role=menuitemradio],[role=switch],button,[role=button],label,option';
  const all = (doc, sel) => Array.from(doc.querySelectorAll(sel));
  const pick = (els, prefVisible = true) => { const v = els.filter(e => e.tagName === 'OPTION' || vis(e) || (e.tagName === 'INPUT' && e.labels && Array.from(e.labels).some(vis))); return prefVisible ? (v[0] || null) : (v[0] || els[0] || null); };
  qa.findEl = (kind, arg, doc) => {
    doc = doc || document;
    let el = null;
    if (kind === 'opt') {
      const els = all(doc, OPTS).filter(e => norm(nameOf(e)) === norm(arg));
      el = pick(els.filter(e => e.tagName === 'INPUT' || /radio|tab|option/.test(e.getAttribute('role') || '')).concat(els.filter(e => e.tagName === 'OPTION'), els));
    } else if (kind === 'btnPrefix') {
      el = pick(all(doc, CLICKABLE).filter(e => norm(nameOf(e)).startsWith(arg)));
    } else if (kind === 'btnExact') {
      el = pick(all(doc, CLICKABLE + ',input[type=radio],[role=radio],label,[role=tab],[role=option]').filter(e => norm(nameOf(e)) === arg));
    } else if (kind === 'btnHas') {
      const re = new RegExp(arg);
      el = pick(all(doc, CLICKABLE).filter(e => re.test(norm(nameOf(e)))));
    }
    return el;
  };
  qa.mark = (kind, arg, markId, doc) => {
    doc = doc || document;
    all(doc, '[data-qa-mark="' + markId + '"]').forEach(e => e.removeAttribute('data-qa-mark'));
    const el = qa.findEl(kind, arg, doc);
    if (!el) return { found: false };
    let target = el;
    if (el.tagName === 'OPTION') target = el.closest('select');
    else if (el.tagName === 'INPUT' && !vis(el) && el.labels && el.labels[0]) target = el.labels[0];
    target.setAttribute('data-qa-mark', markId);
    return { found: true, tag: el.tagName, isOption: el.tagName === 'OPTION', value: el.value, enabled: qa.isEnabled(el), selected: qa.isSelected(el), visible: vis(target), name: nameOf(el) };
  };
  qa.optState = (doc) => {
    doc = doc || document;
    const r = {};
    for (const n of ['麦克风', '系统声音']) { const el = qa.findEl('opt', n, doc); r[n] = el ? { enabled: qa.isEnabled(el), selected: qa.isSelected(el) } : null; }
    return r;
  };

  // ---- 状态（T-A2、T-A14） ----
  const STATUS_RE = /^(状态[:：]?)?(未开始|正在听|已停止|出错)$/;
  const styleSig = (el) => {
    const w = el.ownerDocument.defaultView; const cs = w.getComputedStyle(el);
    const b = w.getComputedStyle(el, '::before'), a = w.getComputedStyle(el, '::after');
    const icons = Array.from(el.querySelectorAll('svg,img,i,[class*=icon],[class*=dot]')).map(i => (i.getAttribute('class') || '') + (i.getAttribute('src') || '') + (i.getAttribute('data-icon') || '') + w.getComputedStyle(i).color + w.getComputedStyle(i).backgroundColor + w.getComputedStyle(i).fill).join(';');
    return [cs.color, cs.backgroundColor, cs.borderColor, cs.borderLeftColor, b.content, b.backgroundColor, b.color, a.content, a.backgroundColor, icons].join('|');
  };
  qa.status = (doc) => {
    doc = doc || document;
    const els = all(doc, 'body *').filter(e => !e.closest('button,[role=button],option,select,label') && e.innerText && STATUS_RE.test(norm(e.innerText)) && vis(e));
    if (!els.length) return { text: null };
    els.sort((x, y) => x.querySelectorAll('*').length - y.querySelectorAll('*').length);
    let el = els[0];
    const text = norm(el.innerText).match(STATUS_RE)[2];
    const host = (el.parentElement && norm(el.parentElement.innerText).match(STATUS_RE)) ? el.parentElement : el;
    el.setAttribute('data-qa-status', '1');
    return { text, sig: styleSig(el) + '#' + styleSig(host), rect: el.getBoundingClientRect().toJSON() };
  };

  // ---- 字幕区与字幕条目（T-A3） ----
  const isCtl = (el) => !!el.closest('button,[role=button],input,select,textarea,label,[role=radio],[role=tab],[role=option],[role=dialog],dialog,h1,h2,h3,h4,h5,h6,[data-qa-status]');
  const isBlock = (el) => { const d = el.ownerDocument.defaultView.getComputedStyle(el).display; return d !== 'inline' && d !== 'contents' && d !== 'none'; };
  const INT_RE = /interim|partial|tentative|pending|draft|temp|live|recognizing|hypothes|provisional|unstable/i;
  const FIN_RE = /final|committed|stable|done|recognized|complete|confirmed/i;
  const markOf1 = (el) => {
    const toks = [];
    const cls = typeof el.className === 'string' ? el.className : (el.getAttribute('class') || '');
    toks.push(cls);
    for (const at of Array.from(el.attributes)) {
      if (!/^(data-|aria-)/.test(at.name) || at.name === 'data-qa-mark' || at.name === 'aria-live' || at.name === 'aria-label') continue;
      if (/interim|partial|tentative|pending|draft/i.test(at.name)) { if (at.value !== 'false') return 'interim'; else return 'final'; }
      if (/final|committed|stable/i.test(at.name)) { if (at.value === 'false') return 'interim'; else return 'final'; }
      toks.push(at.value);
    }
    const s = toks.join(' ');
    if (FIN_RE.test(s)) return 'final';
    if (INT_RE.test(s)) return 'interim';
    return null;
  };
  const markOf = (el, region) => { for (let e = el; e && e !== region; e = e.parentElement) { const m = markOf1(e); if (m) return m; } return null; };
  const textSig = (el) => { const cs = el.ownerDocument.defaultView.getComputedStyle(el); return [cs.color, cs.opacity, cs.fontStyle, cs.fontWeight, cs.textDecorationLine, cs.backgroundColor, cs.borderLeftStyle + cs.borderLeftColor, cs.fontSize].join('|'); };
  const leafBlocks = (root) => {
    const out = [];
    const walk = (el) => {
      if (!vis(el) || isCtl(el)) return false;
      let childHas = false;
      for (const c of el.children) { if (walk(c)) childHas = true; }
      const t = norm(el.innerText);
      if (!childHas && t && isBlock(el) && el !== root) { out.push(el); return true; }
      return childHas || (!!t && isBlock(el));
    };
    for (const c of root.children) walk(c);
    return out;
  };
  qa.setBaseline = (doc) => { doc = doc || document; const s = new Set(); for (const el of leafBlocks(doc.body)) s.add(norm(el.innerText)); (doc === document ? qa : (qa.pipBase = qa.pipBase || {})).baseline = Array.from(s); return s.size; };
  const regionOf = (doc) => {
    const cands = all(doc, 'body *').filter(el => {
      const id = (el.getAttribute('data-testid') || '') + ' ' + el.id + ' ' + (typeof el.className === 'string' ? el.className : '');
      return (/caption|subtitle|transcript/i.test(id) || el.getAttribute('role') === 'log' || el.hasAttribute('aria-live')) && vis(el)
        && !all(el, 'button,[role=button]').some(b => /^(开始|停止)/.test(norm(nameOf(b)))) && el.getAttribute('role') !== 'status' && el.getAttribute('role') !== 'alert' && !STATUS_RE.test(norm(el.innerText));
    });
    const area = (e) => { const r = e.getBoundingClientRect(); return r.width * r.height; };
    const pri = (e) => /caption|subtitle|transcript/i.test((e.getAttribute('data-testid') || '') + ' ' + e.id + ' ' + (typeof e.className === 'string' ? e.className : '')) ? 2 : (e.getAttribute('role') === 'log' ? 1 : 0);
    cands.sort((x, y) => pri(y) - pri(x) || area(y) - area(x));
    return cands[0] || null;
  };
  const NOISE = /tip|hint|error|alert|toast|notice|status|guide|help|banner|warn|message|instruction|support/i;
  qa.captions = (doc) => {
    doc = doc || document;
    const baseline = new Set((doc === document ? qa.baseline : (qa.pipBase && qa.pipBase.baseline)) || []);
    let region = regionOf(doc), mode = 'region', blocks;
    if (region) blocks = leafBlocks(region);
    else {
      mode = 'fallback';
      blocks = leafBlocks(doc.body).filter(el => /[\u4e00-\u9fff]/.test(el.innerText) && !el.closest('[role=alert],[role=status],[role=dialog],dialog') && !Array.from({ length: 4 }).some((_, i) => { let e = el; for (let k = 0; k < i && e; k++) e = e.parentElement; return e && NOISE.test((typeof e.className === 'string' ? e.className : '') + ' ' + e.id); }));
    }
    const items = [];
    for (const b of blocks) {
      const t = norm(b.innerText);
      if (!t || baseline.has(t) || STATUS_RE.test(t)) continue;
      const own = markOf(b, region);
      const marked = own ? [] : all(b, '*').filter(e => markOf1(e) && vis(e) && !(e.parentElement && e.parentElement !== b && markOf1(e.parentElement)));
      if (marked.length) { for (const m of marked) { const mt = norm(m.innerText); if (mt) items.push({ text: mt, mark: markOf1(m), sig: textSig(m) }); } }
      else items.push({ text: t, mark: own, sig: textSig(b) });
    }
    let lastVisible = null;
    if (blocks.length) {
      const last = blocks[blocks.length - 1]; const r = last.getBoundingClientRect(); const vh = doc.defaultView.innerHeight;
      let inView = r.bottom <= vh + 1 && r.top >= -1;
      if (region) { const rr = region.getBoundingClientRect(); inView = inView && r.bottom <= Math.max(rr.bottom, 0) + 2 && r.top >= rr.top - 2; }
      lastVisible = inView;
    }
    return { mode, items, lastVisible, regionRect: region ? region.getBoundingClientRect().toJSON() : null };
  };
  qa.recording = false;
  qa.startTimeline = () => {
    if (qa._tl) return;
    let last = '';
    qa._tl = setInterval(() => {
      try {
        const c = qa.captions();
        const key = JSON.stringify(c.items.map(i => [i.text, i.mark, i.sig]));
        if (key !== last && qa.timeline.length < 6000) { last = key; qa.timeline.push({ t: Date.now(), mode: c.mode, items: c.items }); }
      } catch (e) {}
    }, 100);
  };

  // ---- 引导（T-A2） ----
  qa.guide = (doc) => {
    doc = doc || document;
    let d = all(doc, '[role=dialog],[role=alertdialog],dialog[open],[aria-modal=true]').filter(vis)[0];
    if (!d) d = all(doc, 'body *').filter(e => { const cs = getComputedStyle(e); const r = e.getBoundingClientRect(); return (cs.position === 'fixed' || cs.position === 'absolute') && r.width * r.height > 40000 && vis(e) && /引导|使用说明|欢迎|怎么用|使用步骤|如何使用/.test(e.innerText || ''); })[0];
    if (!d) return { open: false };
    d.setAttribute('data-qa-guide', '1');
    all(doc, '[data-qa-mark="guideClose"]').forEach(e => e.removeAttribute('data-qa-mark'));
    const close = all(d, CLICKABLE).filter(vis).find(b => /关闭|知道了|开始使用|跳过|×|✕|好的|明白|完成/.test(nameOf(b) + (b.getAttribute('title') || '')));
    if (close) close.setAttribute('data-qa-mark', 'guideClose');
    return { open: true, text: d.innerText, hasClose: !!close };
  };

  // ---- 测量（T-A13） ----
  const parseC = (s) => { const m = (s || '').match(/rgba?\(([^)]+)\)/); if (!m) return null; const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; };
  const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
  const bgOf = (el) => {
    const layers = [];
    for (let e = el; e && e.nodeType === 1; e = e.parentElement) { const c = parseC(getComputedStyle(e).backgroundColor); if (c && c.a > 0) { layers.push(c); if (c.a >= 1) break; } }
    let base = { r: 255, g: 255, b: 255 };
    for (let i = layers.length - 1; i >= 0; i--) { const c = layers[i]; base = { r: c.r * c.a + base.r * (1 - c.a), g: c.g * c.a + base.g * (1 - c.a), b: c.b * c.a + base.b * (1 - c.a) }; }
    return base;
  };
  qa.contrastOf = (el) => {
    const cs = getComputedStyle(el); const bg = bgOf(el); let fg = parseC(cs.color) || { r: 0, g: 0, b: 0, a: 1 };
    let op = 1; for (let e = el; e && e.nodeType === 1; e = e.parentElement) op *= +getComputedStyle(e).opacity;
    const a = fg.a * op; const f = { r: fg.r * a + bg.r * (1 - a), g: fg.g * a + bg.g * (1 - a), b: fg.b * a + bg.b * (1 - a) };
    const L1 = lum(f), L2 = lum(bg); return (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
  };
  qa.metrics = (doc) => {
    doc = doc || document;
    const region = regionOf(doc);
    const blocks = region ? leafBlocks(region) : [];
    const baseline = new Set(qa.baseline || []);
    const caps = blocks.filter(b => !baseline.has(norm(b.innerText))).map(b => {
      const cs = getComputedStyle(b); const fs = parseFloat(cs.fontSize); const lh = cs.lineHeight === 'normal' ? fs * 1.2 : parseFloat(cs.lineHeight);
      return { text: norm(b.innerText).slice(0, 30), mark: markOf(b, region), fontSize: fs, lineHeight: lh, contrast: qa.contrastOf(b), sig: textSig(b), overflowX: b.scrollWidth > b.clientWidth + 1, ellipsis: cs.textOverflow === 'ellipsis' && cs.overflow !== 'visible' };
    });
    let maxOther = 0, maxOtherText = '';
    for (const el of all(doc, 'body *')) {
      if (!vis(el) || (region && region.contains(el))) continue;
      const own = Array.from(el.childNodes).some(n => n.nodeType === 3 && n.textContent.trim());
      if (!own) continue;
      const fs = parseFloat(getComputedStyle(el).fontSize); if (fs > maxOther) { maxOther = fs; maxOtherText = norm(el.innerText).slice(0, 20); }
    }
    const area = (e) => { const r = e.getBoundingClientRect(); return r.width * r.height; };
    const regionArea = region ? area(region) : 0;
    let maxBlockArea = 0, maxBlockDesc = '';
    for (const el of all(doc, 'body *')) {
      if (!vis(el) || /^(MAIN|BODY|HTML)$/.test(el.tagName) || (region && (el.contains(region) || region.contains(el)))) continue;
      const a = area(el); if (a > maxBlockArea && a < innerWidth * innerHeight * 0.95) { maxBlockArea = a; maxBlockDesc = el.tagName + '.' + (typeof el.className === 'string' ? el.className.slice(0, 40) : ''); }
    }
    const de = doc.documentElement;
    return { caps, maxOther, maxOtherText, regionArea, maxBlockArea, maxBlockDesc, scrollWidth: de.scrollWidth, clientWidth: de.clientWidth, region: region ? region.getBoundingClientRect().toJSON() : null };
  };
  qa.visibleText = (doc) => (doc || document).body.innerText;
}
JSEOF

cat > "$WORK/qa.mjs" <<'JSEOF'
import { chromium, firefox } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { execFile } from 'node:child_process';

const W = process.env.QA_WORK, EV = process.env.QA_EVIDENCE_DIR;
const T0 = Number(process.env.QA_T0) * 1000;
const DEADLINE = T0 + 13.6 * 60 * 1000;
const DISPLAYS = process.env.QA_DISPLAYS.split(',');
const META = JSON.parse(fs.readFileSync(path.join(W, 'media', 'meta.json'), 'utf8'));
const INIT = fs.readFileSync(path.join(W, 'qainit.js'), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const left = () => DEADLINE - Date.now();
const log = (...a) => console.error(new Date().toISOString().slice(11, 19), ...a);

// ---------- 机密比对值（只在内存中使用，不写入证据） ----------
const SECRETS = [];
for (const [k, v] of Object.entries(process.env)) {
  if (!v || v.length < 8) continue;
  if (/^AIDH_SECRET_/.test(k) || (/^AIDH_DEP_/.test(k) && /KEY|SECRET|PASSWORD|PASSWD|TOKEN|CONNECTION|CONN_STR|CREDENTIAL/i.test(k))) {
    SECRETS.push(v);
    for (const part of v.split(';')) { const i = part.indexOf('='); if (i > 0 && part.length - i > 16) SECRETS.push(part.slice(i + 1)); }
  }
}
const SECRET_BUFS = [...new Set(SECRETS)].flatMap((s) => [Buffer.from(s), Buffer.from(encodeURIComponent(s))]);
const redact = (s) => { let o = String(s); for (const v of new Set(SECRETS)) o = o.split(v).join('***'); return o; };
const noQuery = (u) => { try { const x = new URL(u); return x.origin + x.pathname; } catch (e) { return String(u).split('?')[0]; } };

// ---------- 依赖（AIDH_DEP_*） ----------
const DEP = {};
for (const [k, v] of Object.entries(process.env)) {
  const m = k.match(/^AIDH_DEP_(.+?)_(ENDPOINT|KIND|RESOURCE_ID|AUTH_MODE|REGION|LOCATION|DEPLOYMENT[A-Z_]*|MODEL[A-Z_]*|NAME|[A-Z_]*URL|[A-Z_]*HOST)$/);
  if (m) { (DEP[m[1]] = DEP[m[1]] || {})[m[2]] = v; }
}
const DEP_NAMES = Object.keys(DEP).map((n) => n.toLowerCase().replace(/_/g, '-'));
const DEP_HOSTS = new Set(); const DEP_TOKENS = new Set();
for (const d of Object.values(DEP)) for (const [f, v] of Object.entries(d)) {
  if (/ENDPOINT|URL|HOST/.test(f)) { try { DEP_HOSTS.add(new URL(/^\w+:\/\//.test(v) ? v : 'https://' + v).hostname.toLowerCase()); } catch (e) {} }
  if (/REGION|LOCATION/.test(f)) DEP_TOKENS.add(v.toLowerCase());
  if (/RESOURCE_ID/.test(f)) { const n = v.split('/').pop(); if (n) DEP_TOKENS.add(n.toLowerCase()); }
  if (/DEPLOYMENT|MODEL/.test(f)) DEP_TOKENS.add(v.toLowerCase());
}
for (const h of DEP_HOSTS) DEP_TOKENS.add(h.split('.')[0]);
const AZ_RE = /(cognitiveservices\.azure\.com|openai\.azure\.com|services\.ai\.azure\.com|speech\.microsoft\.com|api\.cognitive\.microsoft\.com|cognitive\.microsoft\.com|azure-api\.net|inference\.ai\.azure\.com)$/i;
const depOwnsHost = (h) => {
  h = h.toLowerCase();
  if (DEP_HOSTS.has(h)) return true;
  const m = h.match(/^([a-z0-9-]+)\.(stt|tts|s2s)?\.?speech\.microsoft\.com$/) || h.match(/^([a-z0-9-]+)\.api\.cognitive\.microsoft\.com$/);
  return !!(m && DEP_TOKENS.has(m[1]));
};

// ---------- 结果 ----------
const IDS = Array.from({ length: 23 }, (_, i) => 'IQA-' + (101 + i));
const R = Object.fromEntries(IDS.map((id) => [id, { cps: [], ev: new Set(), ext: new Set() }]));
const ENV_ISSUES = [];
function cp(id, step, passed, observation, kind = 'defect') {
  R[id].cps.push({ step, passed: !!passed, observation: redact(observation).slice(0, 1500), kind: passed ? null : kind });
  log(id, step, passed ? 'PASS' : 'FAIL(' + kind + ')', String(observation).slice(0, 200));
}
const evAdd = (id, f) => { if (f) R[id].ev.add(f); };
const usesDeps = (id) => { for (const n of DEP_NAMES) R[id].ext.add(n); };
function evWrite(name, data) {
  try {
    const s = typeof data === 'string' ? data : JSON.stringify(data, null, 1);
    fs.writeFileSync(path.join(EV, name), redact(s).slice(0, 4_000_000));
    return name;
  } catch (e) { return null; }
}
async function shot(page, name) {
  try { await page.screenshot({ path: path.join(EV, name), timeout: 8000 }); return name; } catch (e) { return null; }
}

// ---------- 扫描（IQA-115 凭据、IQA-117 画面数据） ----------
const KEY_HDR = /^(ocp-apim-subscription-key|api-key|x-api-key|subscription-key|x-functions-key)$/i;
const KEY_PAT = /(api[-_]?key|subscription[-_]?key|client[-_]?secret|account[-_]?key|access[-_]?key|secret[-_]?key)["'\s]*[:=]\s*["']?([A-Za-z0-9+\/_\-]{24,})/gi;
const JWT_RE = /eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g;
class Scanner {
  constructor() { this.c = { secretValue: 0, connStringKey: 0, keyHeader: 0, keyPattern: 0, longLivedJwt: 0, jwtNoExp: 0, sentImage: 0, sentVideo: 0 }; this.bytes = 0; this.items = 0; this.jwts = new Set(); this.where = {}; }
  hit(k, where) { this.c[k]++; this.where[k] = (this.where[k] || new Set()).add(where); }
  secrets(data, where) {
    if (data == null) return;
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
    this.bytes += buf.length; this.items++;
    for (const s of SECRET_BUFS) if (buf.indexOf(s) >= 0) this.hit('secretValue', where);
    const t = buf.subarray(0, 3_000_000).toString('latin1');
    if (/(AccountKey|SharedAccessKey)=[A-Za-z0-9+\/]{20,}/.test(t)) this.hit('connStringKey', where);
    for (const m of t.matchAll(KEY_PAT)) if (/\d/.test(m[2]) && /[A-Za-z]/.test(m[2])) this.hit('keyPattern', where);
    for (const m of t.matchAll(JWT_RE)) {
      if (this.jwts.has(m[0])) continue; this.jwts.add(m[0]);
      try {
        const p = JSON.parse(Buffer.from(m[0].split('.')[1], 'base64url').toString());
        if (!p.exp) this.hit('jwtNoExp', where);
        else if (p.exp - (p.iat || p.nbf || Date.now() / 1000) > 86400) this.hit('longLivedJwt', where);
      } catch (e) {}
    }
  }
  headers(h, where) { for (const [k, v] of Object.entries(h || {})) { if (KEY_HDR.test(k) && v && v.length >= 16) this.hit('keyHeader', where); this.secrets(k + ': ' + v, where); } }
  sent(data, where, ctype) {
    if (data == null) return;
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
    if (ctype && /^(image|video)\//i.test(ctype)) this.hit(/^video/i.test(ctype) ? 'sentVideo' : 'sentImage', where);
    const h = buf.subarray(0, 12).toString('hex');
    if (/^ffd8ff|^89504e47|^47494638/.test(h) || (h.startsWith('52494646') && buf.subarray(8, 12).toString() === 'WEBP')) this.hit('sentImage', where);
    const t = buf.subarray(0, 3_000_000).toString('latin1');
    if (/data:image\//i.test(t) || /Content-Type:\s*image\//i.test(t) || /["':,=\s]\/9j\/[A-Za-z0-9+\/]{60}/.test(t) || /["':,=\s]iVBORw0KGgo/.test(t)) this.hit('sentImage', where);
    if (/V_VP8|V_VP9|V_AV1|ftypisom|ftypmp42|Content-Type:\s*video\//.test(t) || /avc1/.test(t.slice(0, 4096))) this.hit('sentVideo', where);
  }
  secretHits() { const c = this.c; return c.secretValue + c.connStringKey + c.keyHeader + c.keyPattern + c.longLivedJwt + c.jwtNoExp; }
  summary() { return { counts: this.c, scannedBytes: this.bytes, scannedItems: this.items, where: Object.fromEntries(Object.entries(this.where).map(([k, v]) => [k, [...v].slice(0, 10)])) }; }
}

// ---------- 素材页服务（共享目标：标题 QA-SHARE-TARGET） ----------
const TITLE = 'QA-SHARE-TARGET';
const TARGET_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>${TITLE}</title>
<style>body{margin:0;background:repeating-conic-gradient(#e00 0 25%,#0c0 0 50%) 0 0/120px 120px}h1{font:bold 140px sans-serif;color:#fff;background:#000;display:inline-block;margin:80px}</style></head>
<body><h1>QA-CANARY</h1><audio id="a" preload="auto"></audio><script>
window.__ev=[];const a=document.getElementById('a');
['play','playing','pause','ended','volumechange','stalled','waiting'].forEach(e=>a.addEventListener(e,()=>__ev.push({e,t:Date.now(),muted:a.muted,volume:a.volume,ct:a.currentTime})));
window.qaPlay=(name,loop)=>new Promise((res,rej)=>{a.loop=!!loop;a.src='/media/'+name+'.wav';a.currentTime=0;
 a.addEventListener('playing',()=>res(Date.now()),{once:true});a.play().catch(e=>rej(String(e)));});
window.qaStop=()=>{a.pause();};
</script></body></html>`;
let MAT = '';
function startMaterialServer() {
  return new Promise((res) => {
    const srv = http.createServer((req, rsp) => {
      const u = req.url.split('?')[0];
      if (u === '/target') { rsp.setHeader('content-type', 'text/html; charset=utf-8'); return rsp.end(TARGET_HTML); }
      const m = u.match(/^\/media\/([A-Z]+)\.wav$/);
      if (m && fs.existsSync(path.join(W, 'media', m[1] + '.wav'))) { rsp.setHeader('content-type', 'audio/wav'); return rsp.end(fs.readFileSync(path.join(W, 'media', m[1] + '.wav'))); }
      rsp.statusCode = 404; rsp.end();
    }).listen(0, '127.0.0.1', () => { MAT = 'http://127.0.0.1:' + srv.address().port; res(srv); });
  });
}

// ---------- 被测地址（T-A1） ----------
async function pickApp() {
  const svc = Object.entries(process.env).filter(([k, v]) => /^AIDH_SERVICE_.+_URL$/.test(k) && v);
  if (!svc.length) return { error: '未注入任何 AIDH_SERVICE_*_URL' };
  if (svc.length === 1) return { url: svc[0][1], name: svc[0][0] };
  const scored = [];
  for (const [k, v] of svc) {
    let s = /WEB|APP|UI|FRONT/.test(k) ? 1 : 0;
    try { const r = await fetch(v, { signal: AbortSignal.timeout(15000) }); const t = await r.text(); if (/麦克风/.test(t)) s += 4; if (/<html/i.test(t)) s += 2; } catch (e) {}
    scored.push([s, k, v]);
  }
  scored.sort((a, b) => b[0] - a[0]);
  return { url: scored[0][2], name: scored[0][1] };
}
let APP = '', APP_ORIGIN = '';

// ---------- 浏览器与上下文 ----------
const BASE_ARGS = ['--autoplay-policy=no-user-gesture-required', '--no-first-run', '--no-default-browser-check', '--disable-features=Translate,MediaRouter', '--window-size=1600,1000', '--window-position=0,0'];
const TAB_ARG = '--auto-select-tab-capture-source-by-title=' + TITLE;
const SCREEN_ARG = '--auto-select-desktop-capture-source=Entire screen';
const fakeMicArgs = (file, loop) => ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--use-file-for-fake-audio-capture=' + path.join(W, 'media', file) + (loop ? '' : '%noloop')];
const BROWSERS = [];
async function launchChrome(display, extra = []) {
  const b = await chromium.launch({ headless: false, env: { ...process.env, DISPLAY: display }, args: [...BASE_ARGS, ...extra], timeout: 60000 });
  BROWSERS.push(b); return b;
}
async function launchFirefox(display) {
  const b = await firefox.launch({ headless: false, env: { ...process.env, DISPLAY: display }, timeout: 60000,
    firefoxUserPrefs: { 'media.navigator.streams.fake': true, 'media.navigator.permission.disabled': true, 'permissions.default.microphone': 1, 'media.autoplay.default': 0, 'media.autoplay.block-webaudio': false, 'media.autoplay.blocking_policy': 0 } });
  BROWSERS.push(b); return b;
}
function attachNet(ctx, tag) {
  const net = { tag, scan: new Scanner(), reqs: [], hosts: new Set(), ws: [], wsFull: [], textSent: [], textRecv: [], downloads: 0, navs: [], wsSent: 0, wsRecv: 0 };
  const skip = (u) => u.includes('/__qa__/') || (MAT && u.startsWith(MAT)) || u.startsWith('data:') || u.startsWith('blob:');
  ctx.on('request', async (req) => {
    const u = req.url(); if (skip(u)) return;
    try { net.hosts.add(new URL(u).hostname.toLowerCase()); } catch (e) {}
    const rec = { m: req.method(), u: noQuery(u), type: req.resourceType() }; if (net.reqs.length < 1500) net.reqs.push(rec);
    net.scan.secrets(u, 'url');
    if (req.isNavigationRequest()) net.navs.push(noQuery(u));
    try {
      const h = await req.allHeaders(); net.scan.headers(h, 'reqHeader');
      const body = req.postDataBuffer();
      if (body) { net.scan.secrets(body, 'reqBody:' + rec.u); net.scan.sent(body, 'reqBody:' + rec.u, h['content-type']); }
    } catch (e) {}
  });
  ctx.on('response', async (res) => {
    const u = res.url(); if (skip(u)) return;
    const rec = net.reqs.find((r) => r.u === noQuery(u) && r.s == null); if (rec) rec.s = res.status();
    try { net.scan.headers(await res.allHeaders(), 'resHeader'); } catch (e) {}
    const type = res.request().resourceType();
    if (['document', 'script', 'xhr', 'fetch', 'other'].includes(type)) { try { const b = await res.body(); net.scan.secrets(b, type + ':' + noQuery(u)); if (/^(xhr|fetch)$/.test(type) && net.textRecv.length < 200) net.textRecv.push(b.subarray(0, 4000).toString()); } catch (e) {} }
  });
  net.console = [];
  const onPage = (p) => {
    p.on('download', () => net.downloads++);
    p.on('console', (msg) => { if (net.console.length < 400) net.console.push({ t: Date.now(), type: msg.type(), text: msg.text().replace(/([?&][^=\s]+=)[^&\s]+/g, '$1***').slice(0, 300) }); });
    p.on('pageerror', (err) => { if (net.console.length < 400) net.console.push({ t: Date.now(), type: 'pageerror', text: String(err).slice(0, 300) }); });
    p.on('websocket', (ws) => {
      const u = ws.url(); net.ws.push(noQuery(u)); net.wsFull.push(u); net.scan.secrets(u, 'wsUrl');
      try { net.hosts.add(new URL(u).hostname.toLowerCase()); } catch (e) {}
      ws.on('framesent', (f) => { net.wsSent++; const d = f.payload; net.scan.secrets(d, 'wsSent'); net.scan.sent(d, 'wsSent'); if (typeof d === 'string' && net.textSent.length < 300) net.textSent.push(d.slice(0, 4000)); else if (Buffer.isBuffer(d) && net.textSent.length < 300) { const hd = d.subarray(0, 600).toString('latin1'); if (/Path:/i.test(hd)) net.textSent.push(hd); } });
      ws.on('framereceived', (f) => { net.wsRecv++; const d = f.payload; net.scan.secrets(d, 'wsRecv'); if (typeof d === 'string' && net.textRecv.length < 300) net.textRecv.push(d.slice(0, 4000)); });
    });
  };
  ctx.on('page', onPage); for (const p of ctx.pages()) onPage(p);
  return net;
}
async function newCtx(browser, { mic = null, viewport = { width: 1366, height: 768 }, tag = 'ctx' } = {}) {
  const ctx = await browser.newContext({ viewport });
  await ctx.addInitScript({ content: INIT + '\nqaInit(' + JSON.stringify({ mic }) + ');' });
  await ctx.route((u) => u.pathname.startsWith('/__qa__/'), (route) => {
    const n = new URL(route.request().url()).pathname.split('/').pop();
    const f = path.join(W, 'media', n);
    if (/^[A-Z]+\.wav$/.test(n) && fs.existsSync(f)) return route.fulfill({ status: 200, contentType: 'audio/wav', body: fs.readFileSync(f) });
    return route.fulfill({ status: 404, body: '' });
  });
  const net = attachNet(ctx, tag);
  return { ctx, net };
}
async function openTarget(ctx) {
  const p = await ctx.newPage(); await p.goto(MAT + '/target', { waitUntil: 'load' }); return p;
}
async function playOn(target, name, loop = false) { return target.evaluate(([n, l]) => window.qaPlay(n, l), [name, loop]); }

// ---------- 页面操作（T-A2） ----------
const ev = (page, fn, arg) => page.evaluate(fn, arg);
async function closeGuide(page) {
  const g = await ev(page, () => window.__qa.guide());
  if (!g.open) return g;
  if (g.hasClose) { try { await page.click('[data-qa-mark="guideClose"]', { timeout: 3000 }); } catch (e) {} }
  else await page.keyboard.press('Escape');
  await sleep(500);
  return Object.assign(g, { closed: !(await ev(page, () => window.__qa.guide())).open });
}
async function openApp(ctx, { guide = 'close', settle = 1500 } = {}) {
  const page = await ctx.newPage();
  await page.goto(APP, { waitUntil: 'load', timeout: 45000 });
  try { await page.waitForLoadState('networkidle', { timeout: 8000 }); } catch (e) {}
  await sleep(settle);
  let g = null;
  if (guide === 'close') g = await closeGuide(page);
  await ev(page, () => { window.__qa.setBaseline(); window.__qa.startTimeline(); });
  return { page, guide: g };
}
async function rebaseline(page) { await ev(page, () => { window.__qa.setBaseline(); window.__qa.startTimeline(); }); }
async function selectInput(page, name) {
  const m = await ev(page, ([n]) => window.__qa.mark('opt', n, 'opt'), [name]);
  if (!m.found) return { found: false };
  try {
    if (m.isOption) await page.selectOption('[data-qa-mark="opt"]', { label: name }, { timeout: 3000 });
    else await page.click('[data-qa-mark="opt"]', { timeout: 3000, force: !m.enabled });
  } catch (e) { m.clickError = String(e).slice(0, 120); }
  await sleep(300);
  m.after = await ev(page, () => window.__qa.optState());
  return m;
}
async function clickBtn(page, prefix, markId, { force = false } = {}) {
  const m = await ev(page, ([p, id]) => window.__qa.mark('btnPrefix', p, id), [prefix, markId]);
  if (!m.found) return m;
  try { await page.click('[data-qa-mark="' + markId + '"]', { timeout: 4000, force }); m.clicked = Date.now(); } catch (e) { m.clickError = String(e).slice(0, 120); }
  return m;
}
const clickStart = (page, o) => clickBtn(page, '开始', 'start', o);
const clickStop = (page, o) => clickBtn(page, '停止', 'stop', o);
const btnState = (page, prefix) => ev(page, ([p]) => { const el = window.__qa.findEl('btnPrefix', p); return el ? { found: true, enabled: window.__qa.isEnabled(el), visible: window.__qa.vis(el) } : { found: false }; }, [prefix]);
const getStatus = (page) => ev(page, () => window.__qa.status());
async function waitStatus(page, want, ms) {
  const end = Date.now() + ms; let s = null; const seen = new Set();
  while (Date.now() < end) {
    try { s = await getStatus(page); if (s.text) seen.add(s.text); if (s.text === want) return { ok: true, t: Date.now(), seen: [...seen] }; } catch (e) {}
    await sleep(200);
  }
  return { ok: false, got: s && s.text, seen: [...seen] };
}
const caps = (page) => ev(page, () => window.__qa.captions());
const finals = async (page) => (await caps(page)).items.filter((i) => i.mark !== 'interim');
async function waitCaption(page, pred, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { const c = await caps(page); if (pred(c.items)) return { ok: true, items: c.items, t: Date.now() }; } catch (e) {} await sleep(300); }
  return { ok: false, items: (await caps(page).catch(() => ({ items: [] }))).items };
}
const media = (page) => ev(page, () => ({ media: window.__qa.media, tracks: window.__qa.trackState(), recorder: window.__qa.recorder, rtc: window.__qa.rtc, videoDraws: window.__qa.videoDraws }));
const timeline = (page) => ev(page, () => window.__qa.timeline);
const visibleText = (page) => ev(page, () => document.body.innerText);
async function escKey(display, n = 1) {
  return new Promise((res) => execFile(path.join(W, 'venv', 'bin', 'python'), [path.join(W, 'esc.py'), String(n)], { env: { ...process.env, DISPLAY: display }, timeout: 15000 }, (e) => res(!e)));
}

// ---------- 判定工具（T-A9、T-A11） ----------
const KW = [null,
  [['销售', '销量', '售出', '卖'], ['欧洲'], ['产品', '商品'], ['预期', '预计', '预想', '期望', '想象', '预料']],
  [['会议', '会'], ['十点', '10点', '10:00', '10：00', '十时', '10时'], ['明天', '明早', '明日']],
  [['不要', '请勿', '切勿', '别', '不得', '不可'], ['文件', '文档'], ['公司']],
  [['25000', '25,000', '两万五', '2.5万', '二万五', '25 000', '25000'], ['车'], ['去年']],
  [['上海'], ['七月', '7月'], ['办公室', '办事处', '办公']],
  [['不能', '无法', '不接受', '不可', '不予'], ['价格', '价钱', '报价', '价'], ['太高', '过高', '偏高', '太贵', '高了']],
];
const INTF_WORDS = ['香蕉', '大象'];
const nz = (s) => String(s || '').replace(/[\s,，]/g, (m) => (m === ',' || m === '，') ? ',' : '');
const hitsOf = (t, i) => KW[i].filter((g) => g.some((w) => nz(t).includes(nz(w)) || t.includes(w))).length;
const fullOf = (t, i) => hitsOf(t, i) === KW[i].length;
const bestOf = (t) => { let b = 0, bh = 0; for (let i = 1; i <= 6; i++) { const h = hitsOf(t, i) / KW[i].length; if (h > bh) { bh = h; b = i; } } return b; };
const isChinese = (t) => {
  const s = String(t || '').replace(/[\s\p{P}\p{S}\d]/gu, '');
  if (!s) return false;
  const han = (s.match(/[\u4e00-\u9fff]/g) || []).length;
  return han / s.length >= 0.8 && !/[A-Za-z]+[\s,.]+[A-Za-z]+[\s,.]+[A-Za-z]+/.test(t);
};
// 相邻且同属一句、各自不完整而合并后完整的定稿视为服务分段，计为一条（IQA-105 c1）
function mergeFinals(texts) {
  const arr = texts.map((t) => ({ text: t, idx: bestOf(t) }));
  const out = [];
  for (const x of arr) {
  const p = out[out.length - 1];
  if (p && x.idx && p.idx === x.idx && !fullOf(p.text, x.idx) && !fullOf(x.text, x.idx) && fullOf(p.text + x.text, x.idx)) { p.text += x.text; p.parts++; }
  else out.push({ ...x, parts: 1 });
  }
  return out.map((x) => ({ ...x, full: x.idx ? fullOf(x.text, x.idx) : false, zh: isChinese(x.text) }));
}
function tlIndex(tl) {
  // 每个条目序号的出现时间、文本变化历史、标记与样式
  const idx = [];
  let prev = [];
  const violations = { multiInterim: 0, interimNotLast: 0, nonLastChanged: 0 };
  for (const s of tl) {
  const it = s.items;
  const interims = it.map((x, i) => [x.mark, i]).filter(([m]) => m === 'interim');
  if (interims.length > 1) violations.multiInterim++;
  if (interims.length === 1 && interims[0][1] !== it.length - 1) violations.interimNotLast++;
  it.forEach((x, k) => {
    const e = idx[k] = idx[k] || { first: s.t, hist: [], last: s.t };
    const h = e.hist[e.hist.length - 1];
    if (!h || h.text !== x.text || h.mark !== x.mark || h.sig !== x.sig) { e.hist.push({ t: s.t, text: x.text, mark: x.mark, sig: x.sig }); e.last = s.t; }
    if (prev.length && k < prev.length - 1 && prev[k] && prev[k].text !== x.text) violations.nonLastChanged++;
  });
  prev = it;
  }
  const anyMark = tl.some((s) => s.items.some((x) => x.mark));
  return { idx, violations, anyMark };
}
const timesAbs = (P, m) => m.sentences.map((s) => ({ i: s.i, start: P + s.start * 1000, end: P + s.end * 1000 }));

// 流式时序（IQA-103 / M2）：以字幕条目序号 0 对应第 1 句
function analyzeStream(tl, s1) {
  const { idx, violations, anyMark } = tlIndex(tl);
  const e = idx[0];
  if (!e) return { none: true, anyMark, violations };
  const firstT = e.first;
  const texts = e.hist.filter((h) => h.t < s1.end).map((h) => h.text);
  const changesBefore = new Set(texts).size - 1;
  const lastChange = e.hist[e.hist.length - 1].t;
  const finalH = e.hist.find((h) => h.mark === 'final');
  const finalT = anyMark ? (finalH ? finalH.t : null) : lastChange;
  const interimH = e.hist.filter((h) => h.mark === 'interim' || (!anyMark && h !== e.hist[e.hist.length - 1]));
  const finalSig = (finalH || e.hist[e.hist.length - 1]).sig;
  const sigDiff = interimH.length ? interimH.some((h) => h.sig !== finalSig) : null;
  return { firstT, rel: { firstVsEnd: firstT - s1.end, lastChangeVsEnd: lastChange - s1.end, finalVsEnd: finalT == null ? null : finalT - s1.end }, changesBefore, lastChange, finalT, sigDiff, anyMark, violations, hist: e.hist.slice(0, 60) };
}
function streamCps(id, prefix, a, s1) {
  if (a.none) { for (const c of ['c1', 'c2', 'c3', 'c4', 'c5']) cp(id, prefix + c, false, '时间线中没有任何字幕条目'); return; }
  cp(id, prefix + 'c1 首条字幕早于语音结束', a.firstT < s1.end, `首次出现相对第 1 句结束 ${(a.rel.firstVsEnd / 1000).toFixed(2)} s`);
  cp(id, prefix + 'c2 结束前至少再变化一次', a.changesBefore >= 1, `语音结束前变化次数 ${a.changesBefore}`);
  const fin = a.finalT != null && a.finalT <= s1.end + 15000 && a.lastChange <= s1.end + 15000;
  cp(id, prefix + 'c3 结束后 ≤15 s 定稿且不再改变', fin, `定稿相对结束 ${a.rel.finalVsEnd == null ? '无' : (a.rel.finalVsEnd / 1000).toFixed(2) + ' s'}，最后变化相对结束 ${(a.rel.lastChangeVsEnd / 1000).toFixed(2)} s，定稿标记${a.anyMark ? '有' : '无'}`);
  cp(id, prefix + 'c4 临时与定稿样式不同', a.sigDiff === true, a.sigDiff == null ? '未观察到临时状态' : (a.sigDiff ? '样式签名不同' : '临时与定稿样式签名相同'));
  const v = a.violations; const ok5 = v.multiInterim === 0 && v.interimNotLast === 0 && (a.anyMark || v.nonLastChanged === 0);
  cp(id, prefix + 'c5 最多一条临时字幕且在末尾', ok5, JSON.stringify(v));
}
// 顺序与含义（IQA-104/105 / M4/M5）
function analyzeSeq(finalTexts, tl, lastEndAbs) {
  const merged = mergeFinals(finalTexts);
  const { idx } = tlIndex(tl);
  const lateNew = idx.filter((e) => e.first > lastEndAbs + 15000).length;
  const per = {};
  for (let i = 1; i <= 6; i++) per[i] = merged.filter((m) => m.idx === i);
  const seq = merged.map((m) => m.idx);
  const inc = seq.every((x, k) => k === 0 || x > seq[k - 1]) && seq.every((x) => x > 0);
  return { merged, per, seq, inc, lateNew, table: merged.map((m) => ({ sentence: m.idx, full: m.full, zh: m.zh, parts: m.parts, text: m.text })) };
}
function meaningCps(id, prefix, s, finalTexts) {
  const nonZh = finalTexts.filter((t) => !isChinese(t));
  cp(id, prefix + 'c2 定稿均为中文', finalTexts.length > 0 && nonZh.length === 0, `定稿 ${finalTexts.length} 条，非中文 ${nonZh.length} 条${nonZh.length ? '：' + nonZh.slice(0, 3).join(' / ') : ''}`);
  const bad = []; for (let i = 1; i <= 6; i++) if (!s.per[i].some((m) => m.full)) bad.push(i);
  cp(id, prefix + 'c3 六句含义一致', bad.length === 0, bad.length ? `未一致的句：${bad.join(',')}` : '6 句均命中全部关键词组');
}
function orderCps(id, prefix, s) {
  cp(id, prefix + 'c1 归并后 6 条', s.merged.length === 6, `归并后 ${s.merged.length} 条，对应句序 ${s.seq.join(',')}`);
  cp(id, prefix + 'c2 顺序递增', s.inc, `句序 ${s.seq.join(',')}`);
  const dup = [], miss = []; for (let i = 1; i <= 6; i++) { if (s.per[i].length > 1) dup.push(i); if (!s.per[i].length) miss.push(i); }
  cp(id, prefix + 'c3 不重不漏', !dup.length && !miss.length, `重复 ${dup.join(',') || '无'}；遗漏 ${miss.join(',') || '无'}`);
  cp(id, prefix + 'c4 静音段无新增', s.lateNew === 0, `末句结束 15 s 后新增条目 ${s.lateNew}`);
}
const LANG_CTL = () => {
  const re = /语言|语种|English|英语|Language/i;
  const els = Array.from(document.querySelectorAll('select,input[type=radio],[role=radio],[role=combobox],[role=listbox],button,[role=button],[role=tab],[role=option]'));
  return els.filter((e) => window.__qa.vis(e) || e.tagName === 'SELECT' || e.tagName === 'INPUT').filter((e) => re.test(window.__qa.nameOf(e) + ' ' + (e.tagName === 'SELECT' ? Array.from(e.options).map((o) => o.text).join(' ') : ''))).map((e) => e.tagName + ':' + window.__qa.nameOf(e).slice(0, 30));
};
const SAVE_CTL = () => Array.from(document.querySelectorAll('button,[role=button],a,[role=menuitem]')).filter((e) => window.__qa.vis(e) && /保存|导出|下载|录制/.test(window.__qa.nameOf(e))).map((e) => window.__qa.nameOf(e).slice(0, 30));
const VIDEO_SHOWN = () => Array.from(document.querySelectorAll('video,canvas')).filter((e) => {
  if (!window.__qa.vis(e)) return false;
  if (e.tagName === 'VIDEO') return !!(e.srcObject && e.srcObject.getVideoTracks && e.srcObject.getVideoTracks().length);
  return window.__qa.videoDraws > 0;
}).length;
async function domScan(page, scan, where) {
  try {
    const d = await page.evaluate(() => ({ html: document.documentElement.outerHTML, ls: JSON.stringify(Object.assign({}, localStorage)), ss: JSON.stringify(Object.assign({}, sessionStorage)), pip: (window.documentPictureInPicture && documentPictureInPicture.window) ? documentPictureInPicture.window.document.documentElement.outerHTML : '' }));
    scan.secrets(d.html, where + ':dom'); scan.secrets(d.ls, where + ':localStorage'); scan.secrets(d.ss, where + ':sessionStorage'); if (d.pip) scan.secrets(d.pip, where + ':pip');
  } catch (e) {}
}
const finalTextsOf = (items) => items.filter((i) => i.mark !== 'interim').map((i) => i.text);
const prefixKept = (before, after) => before.every((t, k) => after[k] === t);
const allTextOfTl = (tl) => [...new Set(tl.flatMap((s) => s.items.map((i) => i.text)))];
async function waitNewFinal(page, n, ms, pred = () => true) {
  return waitCaption(page, (items) => { const f = finalTextsOf(items); return f.length > n && f.slice(n).some(pred); }, ms);
}
const gdmTracksEnded = async (page) => { const m = await media(page); const g = m.tracks.filter((t) => t.call === 'gdm'); return { n: g.length, live: g.filter((t) => t.readyState === 'live').length, tracks: g }; };
async function waitTracksEnded(page, call, ms, since = 0) {
  const end = Date.now() + ms; let r;
  while (Date.now() < end) { const m = await media(page); const g = m.tracks.filter((t) => t.call === call && t.start >= since); r = { n: g.length, live: g.filter((t) => t.readyState === 'live').length }; if (g.length && !r.live) return { ok: true, ...r, t: Date.now() }; await sleep(200); }
  return { ok: false, ...r };
}
async function midSentence(target, m, maxMs = 30000) {
  const end = Date.now() + maxMs;
  while (Date.now() < end) {
    const ct = await target.evaluate(() => document.getElementById('a').currentTime).catch(() => -1);
    if (m.sentences.some((s) => ct > s.start + 0.6 && ct < s.end - 0.6 && s.end - s.start > 1.6)) return ct;
    await sleep(100);
  }
  return null;
}

// ---------- G-SYS ----------
const SHARED = { sysMain: null, ui122: null, micMain: null, sysLive: null, nets: [] };
async function gSys(D) {
  const b = await launchChrome(D, [TAB_ARG]);
  // ---- SYS-MAIN ----
  {
    const ids = ['IQA-102', 'IQA-103', 'IQA-104', 'IQA-105', 'IQA-112', 'IQA-117'];
    ids.forEach(usesDeps);
    const { ctx, net } = await newCtx(b, { mic: 'intf', tag: 'SYS-MAIN' }); SHARED.nets.push(net);
    const tStart = Date.now();
    const target = await openTarget(ctx);
    const { page } = await openApp(ctx);
    const env = await page.evaluate(async () => ({ plugins: Array.from(navigator.plugins || []).map((p) => p.name), devices: (await navigator.mediaDevices.enumerateDevices()).map((d) => d.kind + ':' + d.label), ua: navigator.userAgent }));
    const langCtl = await page.evaluate(LANG_CTL);
    const sel = await selectInput(page, '系统声音');
    await page.bringToFront();
    const st = await clickStart(page);
    const w = await waitStatus(page, '正在听', 20000);
    let m = await media(page);
    const gdm = m.media.filter((x) => x.type === 'gdm');
    cp('IQA-102', 'c1 共享含音频且 ≤20 s 正在听', w.ok && gdm.some((x) => x.audio >= 1), `选择系统声音:${sel.found}，开始按钮:${st.found}，状态:${w.ok ? '正在听' : w.got}（经历 ${w.seen.join('/')}），共享调用 ${gdm.length} 次，音频轨道 ${gdm.map((x) => x.audio).join(',')}${gdm.some((x) => x.error) ? '，错误 ' + gdm.map((x) => x.error).join(',') : ''}`, sel.found && st.found ? 'defect' : 'gap');
    evAdd('IQA-102', await shot(page, 'sys-main-listening.png'));
    let P = null, tl = [], items = [], finals = [];
    if (w.ok) {
      P = await playOn(target, 'SYS');
      const durMs = META.SYS.duration * 1000;
      await page.bringToFront();
      while (Date.now() < P + durMs + 6000) await sleep(500);
      SHARED.sysLive = { start: P, end: Date.now() };
      items = (await caps(page)).items; finals = finalTextsOf(items);
      evAdd('IQA-104', await shot(page, 'sys-main-captions.png'));
    }
    const stp = await clickStop(page);
    const ws = await waitStatus(page, '已停止', 5000);
    tl = await timeline(page); m = await media(page);
    const tEv = await target.evaluate(() => window.__ev).catch(() => []);
    const S = timesAbs(P || 0, META.SYS);
    const tlF = evWrite('sys-main-timeline.json', { playingAt: P, sentencesAbs: S, timeline: tl });
    const mdF = evWrite('sys-main-media.json', { media: m, targetAudioEvents: tEv, env });
    ['IQA-102', 'IQA-103', 'IQA-104', 'IQA-105'].forEach((id) => { evAdd(id, tlF); evAdd(id, mdF); });
    if (!w.ok) {
      for (const id of ['IQA-103', 'IQA-104', 'IQA-105']) cp(id, '前置 系统声音进入正在听', false, '系统声音未进入“正在听”，无法播放素材（见 IQA-102 c1）');
      cp('IQA-102', 'c2 至少 5 句出中文字幕', false, '未进入正在听');
    } else {
      const okS = new Set(finals.filter(isChinese).map(bestOf).filter((x) => x > 0));
      cp('IQA-102', 'c2 至少 5 句出中文字幕', okS.size >= 5, `有中文定稿对应的句：${[...okS].sort().join(',') || '无'}（定稿共 ${finals.length} 条）`);
      const a = analyzeStream(tl, S[0]);
      evAdd('IQA-103', evWrite('iqa-103-stream.json', { firstSentenceSeconds: META.firstSentenceSeconds, s1: S[0], analysis: a }));
      streamCps('IQA-103', '', a, S[0]);
      const s = analyzeSeq(finals, tl, S[5].end);
      evAdd('IQA-104', evWrite('iqa-104-105-sentences.json', s.table));
      cp('IQA-104', 'c1 无语言选择控件', langCtl.length === 0 && (await page.evaluate(LANG_CTL)).length === 0, langCtl.length ? '发现：' + langCtl.join('；') : '未发现语言选择控件');
      meaningCps('IQA-104', '', s, finals);
      orderCps('IQA-105', '', s);
    }
    const gumAfter = m.media.filter((x) => x.type === 'gum');
    const intfHits = allTextOfTl(tl).filter((t) => INTF_WORDS.some((x) => t.includes(x)));
    cp('IQA-102', 'c3 未调用麦克风且无干扰内容', gumAfter.length === 0 && intfHits.length === 0, `getUserMedia 调用 ${gumAfter.length} 次；字幕中香蕉/大象 ${intfHits.length} 次`);
    const evs = tEv.filter((x) => x.t > (P || 0));
    // 自然播放完毕时浏览器会先触发 pause 再触发 ended，该 pause 不算中断。
    const pauses = evs.filter((x, k) => (x.e === 'pause' && !(evs[k + 1] && evs[k + 1].e === 'ended' && evs[k + 1].t - x.t < 1000)) || x.e === 'waiting' || x.e === 'stalled').length;
    const vol = evs.filter((x) => x.e === 'volumechange' || x.muted || x.volume !== 1).length;
    const sup = gdm.some((x) => { const c = x.constraints; return c && c.audio && typeof c.audio === 'object' && c.audio.suppressLocalAudioPlayback === true; }) || m.tracks.some((t) => t.call === 'gdm' && t.settings && t.settings.suppressLocalAudioPlayback === true);
    cp('IQA-102', 'c4 原声未被静音或中断', P != null && pauses === 0 && vol === 0 && !sup, `播放事件 ${evs.map((x) => x.e).join(',')}；暂停/卡顿 ${pauses}，静音/音量变化 ${vol}，suppressLocalAudioPlayback=${sup}`);
    // IQA-112
    cp('IQA-112', 'c1 全新配置完成开始→字幕→停止', w.ok && finals.length > 0 && ws.ok, `扩展 0 个（Playwright 全新配置）；plugins=${JSON.stringify(env.plugins)}；devices=${JSON.stringify(env.devices)}；正在听:${w.ok}，定稿 ${finals.length} 条，停止后状态:${ws.ok ? '已停止' : ws.got}`);
    const storeNav = net.navs.filter((u) => /chrome\.google\.com\/webstore|chromewebstore|microsoftedge\.microsoft\.com\/addons|addons\.mozilla|\.(exe|msi|dmg|pkg|crx)$/i.test(u));
    cp('IQA-112', 'c2 无下载与扩展商店跳转', net.downloads === 0 && storeNav.length === 0, `下载 ${net.downloads}，商店/安装包导航 ${storeNav.length}；导航 ${net.navs.length} 次`);
    const vt = await visibleText(page);
    const inst = vt.split(/[。！？\n]/).filter((x) => /(安装|下载).{0,12}(插件|扩展|驱动|虚拟声卡|桌面应用|客户端|软件)|(插件|扩展|驱动|虚拟声卡|桌面应用|客户端).{0,8}(安装|下载)/.test(x) && !/无需|不需要|不用|无须|不必/.test(x));
    cp('IQA-112', 'c3 无安装要求语句', inst.length === 0, inst.length ? '发现：' + inst.slice(0, 3).join(' / ') : '未发现安装要求语句');
    evAdd('IQA-112', evWrite('iqa-112-env.json', { env, navs: net.navs, downloads: net.downloads }));
    evAdd('IQA-112', await shot(page, 'sys-main-stopped.png'));
    // IQA-117（主页面部分）
    const vshown = await page.evaluate(VIDEO_SHOWN);
    const canary = vt.includes('QA-CANARY');
    SHARED.sysMain = { tStart, tEnd: Date.now(), net, finals, items, allText: allTextOfTl(tl), video: { shown: vshown, canary, recorder: m.recorder, rtc: m.rtc }, save: await page.evaluate(SAVE_CTL), streamOk: w.ok, interimSeen: tl.some((s) => s.items.some((i) => i.mark === 'interim')) || (tlIndex(tl).idx[0] || { hist: [] }).hist.length > 1 };
    await domScan(page, net.scan, 'SYS-MAIN');
    evAdd('IQA-117', 'sys-main-captions.png');
    await ctx.close();
  }
  // ---- IQA-106 ----
  if (left() > 150000) {
    const id = 'IQA-106'; usesDeps(id);
    const { ctx, net } = await newCtx(b, { mic: 'intf', tag: 'IQA-106' }); SHARED.nets.push(net);
    const target = await openTarget(ctx);
    const { page } = await openApp(ctx);
    await selectInput(page, '系统声音'); await page.bringToFront(); await clickStart(page);
    const w = await waitStatus(page, '正在听', 20000);
    if (!w.ok) { cp(id, '前置 正在听', false, '系统声音未进入正在听：' + w.got); }
    else {
      await playOn(target, 'LOOP', true); await page.bringToFront();
      const f1 = await waitNewFinal(page, 0, 45000);
      if (!f1.ok) cp(id, '前置 至少 1 条定稿', false, '45 s 内无定稿字幕');
      else {
        await midSentence(target, META.LOOP);
        const before = finalTextsOf((await caps(page)).items);
        const tStop = Date.now(); await clickStop(page);
        const te = await waitTracksEnded(page, 'gdm', 5000);
        const s1 = await waitStatus(page, '已停止', Math.max(500, tStop + 5000 - Date.now()));
        const opt = await page.evaluate(() => window.__qa.optState()); const sb = await btnState(page, '开始');
        cp(id, 'c1 ≤5 s 共享结束、已停止、可操作', te.ok && s1.ok && opt['麦克风'] && opt['麦克风'].enabled && opt['系统声音'].enabled && sb.enabled, `轨道全部结束:${te.ok}（live ${te.live}），状态:${s1.ok ? '已停止' : s1.got}，输入可选:${JSON.stringify(opt)}，开始可用:${sb.enabled}`);
        evAdd(id, await shot(page, 'iqa-106-stopped.png'));
        await sleep(Math.max(0, tStop + 1000 - Date.now()));
        const snapA = (await caps(page)).items.map((i) => i.text);
        await sleep(30000);
        const snapB = (await caps(page)).items.map((i) => i.text);
        const kept = prefixKept(before, snapB);
        cp(id, 'c2 停止后 30 s 无新增或修改', JSON.stringify(snapA) === JSON.stringify(snapB) && kept, `停止后 1 s 条目 ${snapA.length}，31 s 条目 ${snapB.length}，停止前定稿 ${before.length} 条保留:${kept}`);
        await target.evaluate(() => window.qaStop());
        const base = finalTextsOf((await caps(page)).items);
        await page.evaluate(() => { window.__qa.micContent = 'one'; });
        await selectInput(page, '麦克风'); await clickStart(page);
        const wm = await waitStatus(page, '正在听', 20000);
        const nf = wm.ok ? await waitNewFinal(page, base.length, 40000, (t) => bestOf(t) === 2) : { ok: false, items: [] };
        const after = finalTextsOf(nf.items);
        cp(id, 'c3 麦克风再开始新字幕接在后面', wm.ok && nf.ok && prefixKept(base, after), `正在听:${wm.ok}，新定稿:${nf.ok}，原有 ${base.length} 条保留:${prefixKept(base, after)}，现 ${after.length} 条`);
        await clickStop(page); await waitStatus(page, '已停止', 5000);
        const base2 = finalTextsOf((await caps(page)).items);
        const g0 = (await media(page)).media.filter((x) => x.type === 'gdm').length;
        await selectInput(page, '系统声音'); await page.bringToFront(); await clickStart(page);
        const ws2 = await waitStatus(page, '正在听', 20000);
        const g1 = (await media(page)).media.filter((x) => x.type === 'gdm').length;
        let nf2 = { ok: false, items: [] };
        if (ws2.ok) { await playOn(target, 'ONE'); await page.bringToFront(); nf2 = await waitNewFinal(page, base2.length, 40000); }
        const after2 = finalTextsOf(nf2.items);
        cp(id, 'c4 系统声音再开始重新共享且接在后面', g1 > g0 && ws2.ok && nf2.ok && prefixKept(base2, after2), `getDisplayMedia 次数 ${g0}→${g1}，正在听:${ws2.ok}，新定稿:${nf2.ok}，原有保留:${prefixKept(base2, after2)}`);
        await clickStop(page);
      }
    }
    evAdd(id, evWrite('iqa-106-timeline.json', { timeline: await timeline(page), media: await media(page) }));
    await ctx.close();
  }
  // ---- IQA-107 ----
  if (left() > 110000) {
    const id = 'IQA-107'; usesDeps(id);
    const { ctx, net } = await newCtx(b, { mic: 'intf', tag: 'IQA-107' }); SHARED.nets.push(net);
    let target = await openTarget(ctx);
    const { page } = await openApp(ctx);
    await selectInput(page, '系统声音'); await page.bringToFront(); await clickStart(page);
    const w = await waitStatus(page, '正在听', 20000);
    if (!w.ok) cp(id, '前置 正在听', false, '系统声音未进入正在听：' + w.got);
    else {
      await playOn(target, 'LOOP', true); await page.bringToFront();
      const f1 = await waitNewFinal(page, 0, 45000);
      if (!f1.ok) cp(id, '前置 至少 1 条定稿', false, '45 s 内无定稿字幕');
      else {
        const before = finalTextsOf((await caps(page)).items);
        const tClose = Date.now(); await target.close();
        const te = await waitTracksEnded(page, 'gdm', 5000);
        const s1 = await waitStatus(page, '已停止', Math.max(500, tClose + 5000 - Date.now()));
        cp(id, 'c1 ≤5 s 共享结束且已停止', te.ok && s1.ok, `关闭素材页后：轨道全部结束:${te.ok}，状态:${s1.ok ? '已停止' : s1.got}`);
        const vt = await visibleText(page);
        const hint = vt.split(/\n/).filter((l) => /共享/.test(l) && /结束|停止|断开/.test(l));
        cp(id, 'c2 中文“共享已结束”提示', hint.length > 0, hint.length ? '提示：' + hint[0].slice(0, 80) : '未发现含“共享”与“结束/停止/断开”的提示');
        evAdd(id, await shot(page, 'iqa-107-share-ended.png'));
        await sleep(Math.max(0, tClose + 6000 - Date.now()));
        const snapA = (await caps(page)).items.map((i) => i.text);
        await sleep(30000);
        const snapB = (await caps(page)).items.map((i) => i.text);
        cp(id, 'c3 此后 30 s 无新增或修改', JSON.stringify(snapA) === JSON.stringify(snapB) && prefixKept(before, snapB), `前后条目 ${snapA.length}/${snapB.length}，原有定稿保留:${prefixKept(before, snapB)}`);
        const base = finalTextsOf((await caps(page)).items);
        target = await openTarget(ctx);
        const sb = await btnState(page, '开始');
        await page.bringToFront(); await clickStart(page);
        const w2 = await waitStatus(page, '正在听', 20000);
        let nf = { ok: false, items: [] };
        if (w2.ok) { await playOn(target, 'ONE'); await page.bringToFront(); nf = await waitNewFinal(page, base.length, 40000); }
        cp(id, 'c4 开始可用且再次开始后接在后面', sb.enabled && w2.ok && nf.ok && prefixKept(base, finalTextsOf(nf.items)), `开始可用:${sb.enabled}，正在听:${w2.ok}，新定稿:${nf.ok}，原有保留:${prefixKept(base, finalTextsOf(nf.items))}`);
        await clickStop(page);
      }
    }
    evAdd(id, evWrite('iqa-107-timeline.json', { timeline: await timeline(page), media: await media(page) }));
    await ctx.close();
  }
}

// ---------- G-MIC（IQA-113） ----------
const nw = (s) => String(s || '').replace(/\s+/g, '');
async function gMic(D) {
  const id = 'IQA-113'; usesDeps(id);
  // B1：MIC 素材播放一次（M1～M5，M7～M9 取证）
  {
    const b = await launchChrome(D, fakeMicArgs('MIC.wav', false));
    const { ctx, net } = await newCtx(b, { tag: 'MIC-MAIN' }); SHARED.nets.push(net);
    const tStart = Date.now();
    const { page } = await openApp(ctx);
    const url = page.url();
    const login = /login|signin|sign-in|oauth|microsoftonline|auth0|登录/i.test(url) || /请登录|登录后/.test(await visibleText(page));
    const lang0 = await page.evaluate(LANG_CTL);
    await clickStart(page);
    const w = await waitStatus(page, '正在听', 20000);
    let m = await media(page);
    const gum = m.media.filter((x) => x.type === 'gum'), gdm = m.media.filter((x) => x.type === 'gdm');
    cp(id, 'M1 打开即用、只调用麦克风、≤20 s 正在听', !login && w.ok && gum.length > 0 && gdm.length === 0, `登录要求:${login}，状态:${w.ok ? '正在听' : w.got}，getUserMedia ${gum.length} 次，getDisplayMedia ${gdm.length} 次`);
    let finals = [], tl = [];
    const P = (gum.find((x) => x.ok) || {}).ok || Date.now();
    const S = timesAbs(P, META.MIC);
    if (w.ok) {
      while (Date.now() < P + META.MIC.duration * 1000 + 6000) await sleep(500);
      finals = finalTextsOf((await caps(page)).items);
      evAdd(id, await shot(page, 'mic-main-captions.png'));
    }
    await clickStop(page); await waitStatus(page, '已停止', 5000);
    tl = await timeline(page);
    evAdd(id, evWrite('mic-main-timeline.json', { captureStartedAt: P, sentencesAbs: S, timeline: tl }));
    if (w.ok) {
      const a = analyzeStream(tl, S[0]);
      evAdd(id, evWrite('mic-main-stream.json', a));
      const ok2 = !a.none && a.firstT < S[0].end && a.changesBefore >= 1 && a.finalT != null && a.finalT <= S[0].end + 15000 && a.lastChange <= S[0].end + 15000;
      cp(id, 'M2 流式', ok2, a.none ? '无字幕' : `首次出现相对结束 ${(a.rel.firstVsEnd / 1000).toFixed(2)} s，结束前变化 ${a.changesBefore} 次，定稿相对结束 ${a.rel.finalVsEnd == null ? '无' : (a.rel.finalVsEnd / 1000).toFixed(2) + ' s'}`);
      const lang1 = await page.evaluate(LANG_CTL);
      cp(id, 'M3 无语言选择控件', !lang0.length && !lang1.length, lang0.concat(lang1).join('；') || '未发现');
      const s = analyzeSeq(finals, tl, S[5].end);
      evAdd(id, evWrite('mic-main-sentences.json', s.table));
      const nonZh = finals.filter((t) => !isChinese(t)); const bad = []; for (let i = 1; i <= 6; i++) if (!s.per[i].some((x) => x.full)) bad.push(i);
      cp(id, 'M4 只显示中文且含义一致', finals.length > 0 && !nonZh.length && !bad.length, `非中文 ${nonZh.length} 条；未一致的句 ${bad.join(',') || '无'}`);
      const dup = [], miss = []; for (let i = 1; i <= 6; i++) { if (s.per[i].length > 1) dup.push(i); if (!s.per[i].length) miss.push(i); }
      cp(id, 'M5 顺序不重不漏', s.merged.length === 6 && s.inc && !dup.length && !miss.length && s.lateNew === 0, `归并后 ${s.merged.length} 条，句序 ${s.seq.join(',')}，重复 ${dup.join(',') || '无'}，遗漏 ${miss.join(',') || '无'}，静音段新增 ${s.lateNew}`);
    } else for (const c of ['M2 流式', 'M3 无语言选择控件', 'M4 只显示中文且含义一致', 'M5 顺序不重不漏']) cp(id, c, false, '麦克风未进入正在听');
    await domScan(page, net.scan, 'MIC-MAIN');
    SHARED.micMain = { tStart, tEnd: Date.now(), net, finals, allText: allTextOfTl(tl), streamOk: w.ok, interimSeen: tl.length > 2 };
    await ctx.close(); await b.close();
  }
  // B2：MICLOOP 循环（M6、M10、M11）
  if (left() > 90000) {
    const b = await launchChrome(D, fakeMicArgs('MICLOOP.wav', true));
    const { ctx, net } = await newCtx(b, { tag: 'MIC-LOOP' }); SHARED.nets.push(net);
    const { page } = await openApp(ctx);
    await clickStart(page);
    const w = await waitStatus(page, '正在听', 20000);
    const f1 = w.ok ? await waitNewFinal(page, 0, 40000) : { ok: false };
    if (!f1.ok) { for (const c of ['M6 停止与重新开始', 'M10 刷新不保留', 'M11 各页面互不显示']) cp(id, c, false, `前置未满足：正在听:${w.ok}，定稿:${f1.ok}`); }
    else {
      // M11：同一浏览器另开页面 B
      const { page: pB } = await openApp(ctx);
      await sleep(8000);
      const aTexts = finalTextsOf((await caps(page)).items);
      const bText = nw(await visibleText(pB)); const bItems = (await caps(pB)).items;
      const leak = aTexts.filter((t) => t.length >= 4 && bText.includes(nw(t)));
      cp(id, 'M11 各页面互不显示', leak.length === 0 && bItems.length === 0, `页面 A 定稿 ${aTexts.length} 条；页面 B 字幕条目 ${bItems.length}，A 的字幕在 B 中出现 ${leak.length} 次`);
      evAdd(id, await shot(pB, 'mic-page-b.png')); await pB.close();
      await page.bringToFront();
      // M6
      const before = finalTextsOf((await caps(page)).items);
      const tStop = Date.now(); await clickStop(page);
      const te = await waitTracksEnded(page, 'gum', 5000);
      const s1 = await waitStatus(page, '已停止', Math.max(500, tStop + 5000 - Date.now()));
      await sleep(Math.max(0, tStop + 1000 - Date.now()));
      const snapA = (await caps(page)).items.map((i) => i.text);
      await sleep(20000);
      const snapB = (await caps(page)).items.map((i) => i.text);
      const base = finalTextsOf((await caps(page)).items);
      await clickStart(page);
      const w2 = await waitStatus(page, '正在听', 20000);
      const nf = w2.ok ? await waitNewFinal(page, base.length, 40000) : { ok: false, items: [] };
      cp(id, 'M6 停止与重新开始', te.ok && s1.ok && JSON.stringify(snapA) === JSON.stringify(snapB) && prefixKept(before, snapB) && w2.ok && nf.ok && prefixKept(base, finalTextsOf(nf.items)), `麦克风轨道结束:${te.ok}，已停止:${s1.ok}，20 s 无变化:${JSON.stringify(snapA) === JSON.stringify(snapB)}，再开始正在听:${w2.ok}，新字幕接在后面:${nf.ok && prefixKept(base, finalTextsOf(nf.items))}`);
      // M10
      const prior = finalTextsOf((await caps(page)).items);
      await page.reload({ waitUntil: 'load' }); await sleep(2500); await closeGuide(page);
      const rt = nw(await visibleText(page));
      const remain = prior.filter((t) => t.length >= 4 && rt.includes(nw(t)));
      const opt = await page.evaluate(() => window.__qa.optState()); const st = await getStatus(page);
      cp(id, 'M10 刷新不保留', remain.length === 0 && opt['麦克风'] && opt['麦克风'].selected && st.text === '未开始', `刷新后残留此前字幕 ${remain.length} 条，输入方式:${JSON.stringify(opt)}，状态:${st.text}`);
      evAdd(id, await shot(page, 'mic-after-reload.png'));
    }
    await ctx.close(); await b.close();
  }
  // B3：麦克风被拒绝（M12）
  if (left() > 40000) {
    const b = await launchChrome(D, ['--use-fake-device-for-media-stream', '--deny-permission-prompts']);
    const { ctx } = await newCtx(b, { tag: 'MIC-DENY' });
    const { page } = await openApp(ctx);
    await clickStart(page);
    const w = await waitStatus(page, '出错', 10000);
    const vt = await visibleText(page);
    const hint = vt.split('\n').filter((l) => /麦克风/.test(l) && /权限|允许|拒绝/.test(l));
    const ci = (await caps(page)).items;
    cp(id, 'M12 麦克风被拒绝', w.ok && !w.seen.includes('正在听') && hint.length > 0 && ci.length === 0, `状态:${w.ok ? '出错' : w.got}（经历 ${w.seen.join('/')}），提示:${hint[0] ? hint[0].slice(0, 80) : '无'}，字幕 ${ci.length} 条；媒体:${JSON.stringify((await media(page)).media.map((x) => x.error || 'ok'))}`);
    evAdd(id, await shot(page, 'mic-denied.png'));
    await ctx.close(); await b.close();
  }
}

// ---------- G-UI1：IQA-120 → 101 → 108 → 110 → 122（含 119、117） ----------
const OPT_GROUP = () => {
  const q = window.__qa; const a = q.findEl('opt', '麦克风'), b = q.findEl('opt', '系统声音');
  if (!a || !b) return { found: false, a: !!a, b: !!b };
  let anc = a; while (anc && !anc.contains(b)) anc = anc.parentElement;
  const names = new Set();
  if (a.tagName === 'OPTION') Array.from(a.closest('select').options).forEach((o) => names.add(o.text.trim()));
  else anc.querySelectorAll('input[type=radio],[role=radio],[role=tab],[role=option],[role=menuitemradio]').forEach((e) => { const n = q.nameOf(e).replace(/\s+/g, ''); if (n) names.add(n); });
  if (!names.size) [a, b].forEach((e) => names.add(q.nameOf(e).replace(/\s+/g, '')));
  return { found: true, names: [...names], micSelected: q.isSelected(a), sysSelected: q.isSelected(b) };
};
async function g120(b, D) {
  const id = 'IQA-120';
  const { ctx } = await newCtx(b, { mic: 'loop', tag: 'IQA-120' });
  const page = await ctx.newPage();
  const t0 = Date.now();
  await page.goto(APP, { waitUntil: 'load', timeout: 45000 });
  let g = { open: false };
  while (Date.now() - t0 < 5000) { g = await ev(page, () => window.__qa.guide()); if (g.open) break; await sleep(200); }
  const tOpen = Date.now() - t0;
  cp(id, 'c1 首次打开 ≤5 s 出现中文引导', g.open && ((g.text || '').match(/[\u4e00-\u9fff]/g) || []).length > ((g.text || '').match(/[A-Za-z]/g) || []).length, g.open ? `引导出现于 ${tOpen} ms` : '5 s 内未出现引导', 'defect');
  evAdd(id, await shot(page, 'iqa-120-guide.png'));
  const t = g.text || '';
  evAdd(id, evWrite('iqa-120-guide.txt', t));
  const miss = [];
  if (!/麦克风/.test(t) || !/系统声音/.test(t)) miss.push('输入方式');
  if (!/开始/.test(t)) miss.push('开始');
  if (!/共享/.test(t) || !/音频/.test(t)) miss.push('共享与音频');
  if (!/字号|字体/.test(t)) miss.push('字号');
  if (!/小窗/.test(t)) miss.push('小窗');
  cp(id, 'c2 引导内容完整', g.open && !miss.length, g.open ? (miss.length ? '缺少：' + miss.join('、') : '五项均包含') : '无引导');
  let closed = false;
  if (g.open && g.hasClose) { await page.click('[data-qa-mark="guideClose"]', { timeout: 3000 }).catch(() => {}); await sleep(600); closed = !(await ev(page, () => window.__qa.guide())).open; }
  await rebaseline(page);
  const st = await clickStart(page);
  const w = await waitStatus(page, '正在听', 20000);
  cp(id, 'c3 一次点击关闭且可直接开始', g.open && g.hasClose && closed && w.ok, `关闭按钮:${!!g.hasClose}，一次点击后关闭:${closed}，开始按钮:${st.found}，状态:${w.ok ? '正在听' : w.got}`);
  await clickStop(page); await waitStatus(page, '已停止', 5000);
  await page.reload({ waitUntil: 'load' });
  const t1 = Date.now(); let again = false;
  while (Date.now() - t1 < 5000) { if ((await ev(page, () => window.__qa.guide())).open) { again = true; break; } await sleep(250); }
  cp(id, 'c4 刷新后引导不自动出现', !again, again ? '刷新后引导再次自动出现' : '5 s 内未出现');
  if (again) await closeGuide(page);
  const entry = await ev(page, () => window.__qa.mark('btnHas', '引导|帮助|使用说明|怎么用|如何使用|操作说明', 'guideEntry'));
  let reopened = false;
  if (entry.found) { await page.click('[data-qa-mark="guideEntry"]', { timeout: 3000 }).catch(() => {}); await sleep(800); reopened = (await ev(page, () => window.__qa.guide())).open; }
  cp(id, 'c5 入口可重新打开引导', reopened, entry.found ? `入口“${entry.name}”，打开:${reopened}` : '未找到名称含 引导/帮助/使用说明/怎么用 的入口', entry.found ? 'defect' : 'gap');
  evAdd(id, await shot(page, 'iqa-120-reopened.png'));
  await ctx.close();
}
async function g101(b) {
  const id = 'IQA-101';
  const { ctx } = await newCtx(b, { mic: 'loop', tag: 'IQA-101' });
  const target = await openTarget(ctx);
  const { page } = await openApp(ctx);
  const og = await page.evaluate(OPT_GROUP);
  const two = og.found && og.names.length === 2 && og.names.includes('麦克风') && og.names.includes('系统声音');
  cp(id, 'c1 恰有两项且默认麦克风', two && og.micSelected && !og.sysSelected, JSON.stringify(og), og.found ? 'defect' : 'gap');
  const st = await clickStart(page);
  const w = await waitStatus(page, '正在听', 20000);
  let m = await media(page);
  cp(id, 'c2 默认开始只调用麦克风', w.ok && m.media.some((x) => x.type === 'gum' && x.constraints && x.constraints.audio) && !m.media.some((x) => x.type === 'gdm'), `开始按钮:${st.found}，状态:${w.ok ? '正在听' : w.got}，调用:${m.media.map((x) => x.type).join(',')}`, st.found ? 'defect' : 'gap');
  evAdd(id, await shot(page, 'iqa-101-mic-listening.png'));
  const tryS = await selectInput(page, '系统声音');
  const after = await page.evaluate(() => window.__qa.optState());
  const locked = tryS.found && (!tryS.enabled || (after['麦克风'] && after['麦克风'].selected && !(after['系统声音'] && after['系统声音'].selected)));
  cp(id, 'c3 正在听时不可改选', w.ok && locked, `系统声音控件可用:${tryS.enabled}，点击后:${JSON.stringify(after)}`);
  await clickStop(page); await waitStatus(page, '已停止', 5000);
  await selectInput(page, '系统声音');
  m = await media(page); const nGum = m.media.filter((x) => x.type === 'gum').length; const tS = Date.now();
  await page.bringToFront(); await clickStart(page);
  const w2 = await waitStatus(page, '正在听', 20000);
  m = await media(page);
  const gdmN = m.media.filter((x) => x.type === 'gdm').length, gumN = m.media.filter((x) => x.type === 'gum').length;
  const micLive = m.tracks.filter((t) => t.call === 'gum' && t.readyState === 'live').length;
  cp(id, 'c4 系统声音只调用共享', gdmN >= 1 && gumN === nGum && micLive === 0, `getDisplayMedia ${gdmN} 次，此次开始后 getUserMedia ${gumN - nGum} 次，live 麦克风轨道 ${micLive}，状态:${w2.ok ? '正在听' : w2.got}`);
  await clickStop(page); await waitStatus(page, '已停止', 5000);
  await page.reload({ waitUntil: 'load' }); await sleep(1500); await closeGuide(page);
  const og2 = await page.evaluate(OPT_GROUP);
  cp(id, 'c5 刷新后回到麦克风', og2.found && og2.micSelected && !og2.sysSelected, JSON.stringify(og2));
  evAdd(id, evWrite('iqa-101-media.json', m));
  await target.close().catch(() => {}); await ctx.close();
}
async function g108(b) {
  const id = 'IQA-108';
  const { ctx } = await newCtx(b, { tag: 'IQA-108' });
  const { page } = await openApp(ctx);
  await selectInput(page, '系统声音'); await sleep(800);
  await page.evaluate(() => {
    document.querySelectorAll('details').forEach((d) => { d.open = true; });
    Array.from(document.querySelectorAll('[aria-expanded=false]')).filter((e) => /支持|详情|说明|浏览器|帮助|更多|展开|步骤/.test(window.__qa.nameOf(e))).forEach((e) => { try { e.click(); } catch (x) {} });
  });
  await sleep(800);
  const vt = await visibleText(page);
  const all = vt + '\n' + await page.evaluate(() => Array.from(document.querySelectorAll('[title]')).map((e) => e.title).join('\n'));
  evAdd(id, evWrite('iqa-108-text.txt', all));
  evAdd(id, await page.screenshot({ path: path.join(EV, 'iqa-108-full.png'), fullPage: true }).then(() => 'iqa-108-full.png').catch(() => null));
  const lines = all.split('\n');
  const miss1 = ['标签页', '窗口', '整个屏幕', '音频', '共享', '停止共享'].filter((k) => !all.includes(k));
  cp(id, 'c1 中文操作步骤', !miss1.length && /停止/.test(all.replace(/停止共享/g, '')), miss1.length ? '缺少：' + miss1.join('、') : '含 标签页/窗口/整个屏幕/音频/共享/停止/停止共享');
  const names = { Windows: /Windows/, macOS: /mac\s?OS|Mac/i, Chrome: /Chrome/, Edge: /Edge/, Firefox: /Firefox/, Safari: /Safari/ };
  const missN = Object.entries(names).filter(([, re]) => !re.test(all)).map(([n]) => n);
  const noState = ['Chrome', 'Edge', 'Firefox', 'Safari'].filter((n) => !lines.some((l, k) => l.includes(n) && /支持/.test(lines.slice(k, k + 3).join(' '))));
  cp(id, 'c2 支持列表', !missN.length && !noState.length, `缺少名称：${missN.join(',') || '无'}；未写明支持情况：${noState.join(',') || '无'}`);
  const c3 = /标签页.{0,30}声音/.test(all) && /(全部|系统|所有|整台|电脑).{0,6}声音/.test(all) && /会议|播放器/.test(all);
  cp(id, 'c3 三种共享方式能采到的声音', c3, `标签页声音:${/标签页.{0,30}声音/.test(all)}，全部/系统声音:${/(全部|系统|所有|整台|电脑).{0,6}声音/.test(all)}，会议软件/播放器:${/会议|播放器/.test(all)}`);
  const nn = ['不显示', '不上传', '不保存'].filter((k) => all.includes(k)).length;
  const c4 = (nn >= 2 || /不会.{0,6}(显示|上传|保存).{0,10}(上传|保存)/.test(all)) && /听到/.test(all);
  cp(id, 'c4 画面不显示/上传/保存，仍可听到原声', c4, `否定词命中 ${nn} 个，含“听到”:${/听到/.test(all)}`);
  const c5 = /背景音乐|音效/.test(all) && /多人|同时说话|多个人/.test(all) && /不完整|不准确|不准/.test(all);
  cp(id, 'c5 背景音乐/多人说话提示', c5, `背景音乐或音效:${/背景音乐|音效/.test(all)}，多人:${/多人|同时说话|多个人/.test(all)}，不完整/不准确:${/不完整|不准确|不准/.test(all)}`);
  const tabLine = lines.filter((l, k) => /标签页/.test(lines.slice(Math.max(0, k - 2), k + 3).join(' ')) && /Chrome/.test(lines.slice(Math.max(0, k - 2), k + 3).join(' ')) && /声音/.test(lines.slice(Math.max(0, k - 2), k + 3).join(' ')));
  SHARED.doc108 = { tabDoc: tabLine.length > 0, sample: (tabLine[0] || '').slice(0, 80) };
  await ctx.close();
}
async function g110(D, bTab) {
  const id = 'IQA-110';
  const b = await launchChrome(D, []);
  const { ctx } = await newCtx(b, { mic: 'intf', tag: 'IQA-110' });
  const { page } = await openApp(ctx);
  await selectInput(page, '系统声音'); await page.bringToFront();
  await clickStart(page);
  await sleep(3000);
  const esc1 = await escKey(D, 1); const tEsc = Date.now();
  await sleep(1500);
  let m = await media(page);
  if (m.media.some((x) => x.type === 'gdm' && !x.ok && !x.error)) { await escKey(D, 1); await sleep(1000); m = await media(page); }
  const w = await waitStatus(page, '出错', Math.max(1000, tEsc + 10000 - Date.now()));
  m = await media(page);
  const errs = m.media.filter((x) => x.type === 'gdm').map((x) => x.error || (x.ok ? 'ok' : 'pending'));
  cp(id, 'c1 取消后 ≤10 s 出错且未正在听', w.ok && !w.seen.includes('正在听'), `Esc 发送:${esc1}，共享调用结果:${errs.join(',')}，状态:${w.ok ? '出错' : w.got}（经历 ${w.seen.join('/')}）`, errs.some((e) => /NotAllowed/.test(e)) ? 'defect' : 'env');
  const vt = await visibleText(page);
  const reason = /取消|拒绝|未选择|未授权|没有选择/.test(vt), how = /开始[\s\S]{0,40}共享|共享[\s\S]{0,40}开始/.test(vt);
  cp(id, 'c2 中文原因与重新操作方法', reason && how, `原因:${reason}，重新操作方法:${how}`);
  const ci = (await caps(page)).items; const live = m.tracks.filter((t) => t.readyState === 'live').length;
  cp(id, 'c3 无字幕、无 live 轨道', ci.length === 0 && live === 0, `字幕 ${ci.length} 条，live 轨道 ${live}`);
  evAdd(id, await shot(page, 'iqa-110-cancelled.png')); evAdd(id, evWrite('iqa-110-media.json', m));
  await ctx.close(); await b.close();
  usesDeps(id);
  const r = await secondTry(bTab, 'IQA-110');
  cp(id, 'c4 再次共享正常出字幕', r.ok, r.obs);
}
async function secondTry(b, tag) {
  const { ctx } = await newCtx(b, { mic: 'intf', tag });
  const target = await openTarget(ctx);
  const { page } = await openApp(ctx);
  await selectInput(page, '系统声音'); await page.bringToFront(); await clickStart(page);
  const w = await waitStatus(page, '正在听', 20000);
  let nf = { ok: false, items: [] };
  if (w.ok) { await playOn(target, 'ONE'); await page.bringToFront(); nf = await waitNewFinal(page, 0, 40000, (t) => isChinese(t)); }
  const f = finalTextsOf(nf.items);
  await shot(page, tag.toLowerCase() + '-second.png');
  await clickStop(page).catch(() => {});
  await ctx.close();
  return { ok: w.ok && nf.ok, obs: `正在听:${w.ok}，中文定稿:${nf.ok}${f.length ? '（' + f[f.length - 1].slice(0, 40) + '）' : ''}` };
}

const PIP_SNAP = () => {
  const q = window.__qa; const w = window.documentPictureInPicture && documentPictureInPicture.window;
  const r = { open: !!w, videoPip: !!document.pictureInPictureElement, main: q.captions(), mainStatus: q.status().text };
  if (w) {
    r.pip = q.captions(w.document); r.pipStatus = q.status(w.document).text; r.pipText = w.document.body.innerText;
    r.pipVideo = Array.from(w.document.querySelectorAll('video,canvas')).filter((e) => q.vis(e) && (e.tagName === 'CANVAS' ? q.videoDraws > 0 : !!(e.srcObject && e.srcObject.getVideoTracks && e.srcObject.getVideoTracks().length))).length;
    r.pipMetrics = q.metrics(w.document);
  }
  return r;
};
// 小窗字幕与主页面比对：去掉小窗中始终不变且不属于主页面的静态文字
function pipCompare(snap, staticSet) {
  const mainF = finalTextsOf(snap.main.items);
  const pipF = finalTextsOf((snap.pip || { items: [] }).items).filter((t) => !staticSet.has(t));
  return { ok: JSON.stringify(mainF) === JSON.stringify(pipF), mainF, pipF };
}
async function openPip(page, ctx) {
  const n0 = ctx.pages().length;
  const mk = await ev(page, () => window.__qa.mark('btnHas', '字幕小窗', 'pip'));
  if (!mk.found) return { found: false };
  const t0 = Date.now();
  await page.click('[data-qa-mark="pip"]', { timeout: 4000, force: !mk.enabled }).catch(() => {});
  let s = null;
  while (Date.now() - t0 < 5000) { s = await ev(page, PIP_SNAP); if (s.open || s.videoPip) break; await sleep(200); }
  await sleep(300);
  return { found: true, enabled: mk.enabled, open: !!(s && s.open), videoPip: !!(s && s.videoPip), newWindow: ctx.pages().length > n0, ms: Date.now() - t0, snap: s };
}
async function g122(b) {
  const id = 'IQA-122', i19 = 'IQA-119'; usesDeps(id); usesDeps(i19);
  const { ctx, net } = await newCtx(b, { mic: 'loop', tag: 'IQA-122' }); SHARED.nets.push(net);
  const target = await openTarget(ctx);
  const { page } = await openApp(ctx);
  const defMid = await ev(page, () => { const e = window.__qa.findEl('opt', '中'); return e ? window.__qa.isSelected(e) : null; });
  await selectInput(page, '系统声音'); await page.bringToFront(); await clickStart(page);
  const w = await waitStatus(page, '正在听', 20000);
  const f2 = w.ok ? (await playOn(target, 'LOOP', true), await page.bringToFront(), await waitNewFinal(page, 1, 60000)) : { ok: false };
  if (!f2.ok) {
    for (const c of ['c1', 'c2', 'c3', 'c4', 'c5']) cp(id, c + ' 前置', false, `前置未满足：正在听:${w.ok}，≥2 条定稿:${f2.ok}`);
    for (const c of ['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7']) cp(i19, c + ' 前置', false, `前置未满足：正在听:${w.ok}，≥2 条定稿:${f2.ok}`);
    await ctx.close(); return;
  }
  // IQA-119 c1～c4：等待一条临时字幕出现时测量
  let mt = null; const tI = Date.now();
  while (Date.now() - tI < 20000) { mt = await ev(page, () => window.__qa.metrics()); if (mt.caps.some((c) => c.mark === 'interim')) break; await sleep(150); }
  const anyMark = mt.caps.some((c) => c.mark);
  let interim = mt.caps.find((c) => c.mark === 'interim');
  const finalsM = mt.caps.filter((c) => c.mark !== 'interim' && c !== interim);
  if (!interim && !anyMark) {
    const a = await ev(page, () => window.__qa.metrics()); await sleep(250); const bb = await ev(page, () => window.__qa.metrics());
    const la = a.caps[a.caps.length - 1], lb = bb.caps[bb.caps.length - 1];
    if (la && lb && la.text !== lb.text) interim = lb;
  }
  evAdd(i19, evWrite('iqa-119-metrics.json', mt)); evAdd(i19, await shot(page, 'iqa-119-default.png'));
  cp(i19, 'c1 字幕区面积最大', mt.regionArea > 0 && mt.regionArea >= mt.maxBlockArea, `字幕区 ${Math.round(mt.regionArea)} px²，其他最大区块 ${Math.round(mt.maxBlockArea)} px²（${mt.maxBlockDesc}）`, mt.region ? 'defect' : 'gap');
  const fsF = finalsM.map((c) => c.fontSize);
  cp(i19, 'c2 默认“中”、定稿 ≥28 px 且不小于其他文字', defMid === true && fsF.length > 0 && Math.min(...fsF) >= 28 && Math.min(...fsF) >= mt.maxOther, `默认中:${defMid}，定稿字号 ${[...new Set(fsF)].join('/')} px，其他文字最大 ${mt.maxOther} px（${mt.maxOtherText}）`);
  const cF = finalsM.map((c) => c.contrast);
  cp(i19, 'c3 对比度', cF.length > 0 && Math.min(...cF) >= 7 && !!interim && interim.contrast >= 4.5, `定稿最小 ${cF.length ? Math.min(...cF).toFixed(2) : '无'}，临时 ${interim ? interim.contrast.toFixed(2) : '未观察到'}`, interim ? 'defect' : 'gap');
  cp(i19, 'c4 临时与定稿样式不同', !!interim && finalsM.length > 0 && finalsM.every((c) => c.sig !== interim.sig), interim ? `临时 ${interim.sig} / 定稿 ${finalsM[0] && finalsM[0].sig}` : '20 s 内未观察到临时字幕', interim ? 'defect' : 'gap');
  // IQA-122 a)
  const p1 = await openPip(page, ctx);
  cp(id, 'c1 ≤5 s 出现独立窗口', p1.found && (p1.open && p1.newWindow || p1.videoPip), p1.found ? `可用:${p1.enabled}，Document PiP:${p1.open}，新顶层窗口:${p1.newWindow}，视频画中画:${p1.videoPip}，用时 ${p1.ms} ms` : '未找到含“字幕小窗”的按钮', p1.found ? 'defect' : 'gap');
  const pipPage = ctx.pages().find((p) => p !== page && p !== target);
  if (pipPage) evAdd(id, await shot(pipPage, 'iqa-122-pip.png'));
  if (p1.open) {
    const samples = [];
    for (let k = 0; k < 20; k++) { samples.push(await ev(page, PIP_SNAP)); await sleep(1000); }
    const mainAll = new Set(samples.flatMap((s) => s.main.items.map((i) => i.text)));
    const pipTexts = samples.map((s) => new Set((s.pip ? s.pip.items : []).map((i) => i.text)));
    const staticSet = new Set([...pipTexts[0]].filter((t) => !mainAll.has(t) && pipTexts.every((S) => S.has(t))));
    let bad = 0; const badEx = [];
    for (let k = 0; k < samples.length; k++) {
      const r = pipCompare(samples[k], staticSet);
      if (!r.ok) { await sleep(0); const nx = samples[k + 1]; const r2 = nx ? pipCompare(nx, staticSet) : r; if (!r2.ok || nx.main.items.length === 0) { bad++; if (badEx.length < 3) badEx.push(r); } }
    }
    const pipStat = samples.filter((s) => s.pipStatus === '正在听').length;
    evAdd(id, evWrite('iqa-122-sync.json', { staticTexts: [...staticSet], samples: samples.map((s) => ({ main: s.main.items, pip: s.pip && s.pip.items, pipStatus: s.pipStatus })) }));
    cp(id, 'c2 小窗与主页面一致且显示正在听', bad === 0 && pipStat === samples.length, `20 次采样不一致 ${bad} 次（容许 0.5 s 内消失的差异按下一次采样复核；采样间隔 1 s 时以下一次为准），小窗状态“正在听” ${pipStat}/20${badEx.length ? '；例：主 ' + badEx[0].mainF.slice(-2).join('|') + ' / 小窗 ' + badEx[0].pipF.slice(-2).join('|') : ''}`);
    SHARED.pip117 = { video: samples.reduce((a, s) => a + (s.pipVideo || 0), 0), canary: samples.some((s) => (s.pipText || '').includes('QA-CANARY')) };
  } else cp(id, 'c2 小窗与主页面一致且显示正在听', false, p1.videoPip ? '视频画中画无法读取文字（T-A15）' : '小窗未打开', p1.videoPip ? 'gap' : 'defect');
  // IQA-119 c5～c7（小窗打开时切换字号）
  const sizes = ['小', '中', '大', '特大'];
  const found = await ev(page, (ns) => ns.map((n) => !!window.__qa.findEl('opt', n)), sizes);
  if (found.every(Boolean)) {
    const rows = []; let lagBad = 0, lhBad = 0, visBad = 0, liveBad = 0;
    for (const s of sizes) {
      const pre = await ev(page, PIP_SNAP);
      const preMain = (pre.pipMetrics, (await ev(page, () => window.__qa.metrics())).caps.map((c) => c.fontSize));
      await selectInput(page, s); const tc = Date.now();
      let r = null;
      while (Date.now() - tc < 1000) { r = { m: await ev(page, () => window.__qa.metrics()), p: await ev(page, PIP_SNAP), c: await caps(page) }; const fm = r.m.caps.filter((c) => c.mark !== 'interim').map((c) => c.fontSize); if (fm.length && !preMain.includes(fm[0]) || s === '小' && fm.length && preMain.length && fm[0] !== preMain[0]) break; await sleep(100); }
      const fm = r.m.caps.filter((c) => c.mark !== 'interim');
      const fs = fm.length ? fm[0].fontSize : null, lh = fm.length ? fm[0].lineHeight : null;
      const pfs = r.p.pipMetrics && r.p.pipMetrics.caps.length ? r.p.pipMetrics.caps[0].fontSize : null;
      const prePip = pre.pipMetrics && pre.pipMetrics.caps.length ? pre.pipMetrics.caps[0].fontSize : null;
      if (!(lh >= fs * 1.4 - 0.01)) lhBad++;
      if (r.c.lastVisible === false) visBad++;
      const st = await getStatus(page); const tr = await gdmTracksEnded(page); if (st.text !== '正在听' || tr.live === 0) liveBad++;
      rows.push({ size: s, fontSize: fs, lineHeight: lh, pipFontSize: pfs, pipBefore: prePip, mainBefore: preMain[0] || null, ms: Date.now() - tc, lastVisible: r.c.lastVisible, status: st.text });
      await shot(page, `iqa-119-${sizes.indexOf(s)}.png`);
    }
    evAdd(i19, evWrite('iqa-119-sizes.json', rows));
    const fsList = rows.map((r) => r.fontSize); const pList = rows.map((r) => r.pipFontSize);
    const incM = fsList.every((x, k) => x != null && (k === 0 || x > fsList[k - 1]));
    const incP = p1.open ? pList.every((x, k) => x != null && (k === 0 || x > pList[k - 1])) : false;
    const changedFast = rows.every((r) => r.ms <= 1100);
    cp(i19, 'c5 四档字号、≤1 s 生效、递增、特大 ≥48、行距 ≥1.4', incM && incP && changedFast && fsList[3] >= 48 && lhBad === 0, `主页面 ${fsList.join('/')} px，小窗 ${pList.join('/')} px，行距不足 ${lhBad} 档，生效用时 ${rows.map((r) => r.ms).join('/')} ms`);
    const n0 = finalTextsOf((await caps(page)).items).join('|');
    const ch = await waitCaption(page, (it) => finalTextsOf(it).join('|') !== n0 || it.some((i) => i.mark === 'interim'), 15000);
    cp(i19, 'c6 切换中保持正在听与 live，之后仍有新字幕', liveBad === 0 && ch.ok, `状态或轨道异常 ${liveBad} 次，15 s 内字幕更新:${ch.ok}`);
    const lv = (await caps(page)).lastVisible;
    cp(i19, 'c7 最新字幕在可视范围内', visBad === 0 && lv !== false, `切换后不可见 ${visBad} 次，新字幕后可见:${lv}`);
    await selectInput(page, '中');
  } else for (const c of ['c5', 'c6', 'c7']) cp(i19, c + ' 字号档', false, `未找到字号档：${sizes.filter((_, k) => !found[k]).join('、')}`, 'defect');
  // IQA-122 c3：关闭小窗
  if (p1.open) {
    await ev(page, () => documentPictureInPicture.window && documentPictureInPicture.window.close());
    await sleep(500);
    const n0 = JSON.stringify((await caps(page)).items.map((i) => i.text));
    const ch = await waitCaption(page, (it) => JSON.stringify(it.map((i) => i.text)) !== n0, 15000);
    const st = await getStatus(page); const tr = await gdmTracksEnded(page);
    cp(id, 'c3 关闭小窗后主页面继续', ch.ok && st.text === '正在听' && tr.live > 0, `15 s 内字幕更新:${ch.ok}，状态:${st.text}，live 共享轨道 ${tr.live}`);
    const p2 = await openPip(page, ctx);
    let ok4 = false, obs4 = '再次弹出失败';
    if (p2.open) {
      await sleep(800);
      const s = await ev(page, PIP_SNAP); const mainSet = new Set(s.main.items.map((i) => i.text));
      const mainF = finalTextsOf(s.main.items); const pipF = finalTextsOf(s.pip.items).filter((t) => mainSet.has(t) || isChinese(t) && t.length > 6);
      ok4 = JSON.stringify(mainF) === JSON.stringify(pipF.filter((t) => mainSet.has(t))) && pipF.every((t) => mainSet.has(t)) || mainF.length > 0 && mainF.every((t, k) => pipF[k] === t);
      obs4 = `主页面定稿 ${mainF.length} 条，小窗 ${pipF.length} 条`;
    }
    cp(id, 'c4 再次弹出显示当前全部字幕', ok4, obs4);
  } else { cp(id, 'c3 关闭小窗后主页面继续', false, '小窗未打开', 'defect'); cp(id, 'c4 再次弹出显示当前全部字幕', false, '小窗未打开', 'defect'); }
  // IQA-117 小窗与主页面（共享画面不显示）
  const v = await ev(page, VIDEO_SHOWN); const vt = await visibleText(page);
  SHARED.ui117 = { video: v, canary: vt.includes('QA-CANARY'), save: await ev(page, SAVE_CTL), m: await media(page) };
  await domScan(page, net.scan, 'IQA-122');
  // IQA-122 b) 麦克风模式
  await ev(page, () => documentPictureInPicture.window && documentPictureInPicture.window.close()).catch(() => {});
  await target.evaluate(() => window.qaStop()).catch(() => {});
  await clickStop(page); await waitStatus(page, '已停止', 5000);
  await selectInput(page, '麦克风');
  const base = finalTextsOf((await caps(page)).items).length;
  await clickStart(page);
  const wm = await waitStatus(page, '正在听', 20000);
  const p3 = await openPip(page, ctx);
  const nf = wm.ok ? await waitNewFinal(page, base + 1, 60000) : { ok: false };
  let ok5 = false, obs5 = `正在听:${wm.ok}，小窗按钮可用:${p3.enabled}，小窗:${p3.open}，2 条新定稿:${nf.ok}`;
  if (p3.open && nf.ok) {
    await sleep(600);
    const s = await ev(page, PIP_SNAP); const mainF = finalTextsOf(s.main.items); const pipF = finalTextsOf(s.pip.items);
    const tail = mainF.slice(-2); ok5 = tail.every((t) => pipF.includes(t)) && pipF.filter((t) => isChinese(t) && t.length > 6).every((t) => mainF.includes(t));
    obs5 += `，最新 2 条在小窗中:${tail.every((t) => pipF.includes(t))}`;
  }
  cp(id, 'c5 麦克风模式小窗可用且一致', p3.found && p3.enabled && p3.open && ok5, obs5);
  await domScan(page, net.scan, 'IQA-122-mic');
  SHARED.ui122 = { net };
  evAdd(id, evWrite('iqa-122-timeline.json', { timeline: await timeline(page), media: await media(page) }));
  await clickStop(page).catch(() => {});
  await ctx.close();
}
async function gUi1(D) {
  const b = await launchChrome(D, [TAB_ARG]);
  const steps = [['IQA-120', () => g120(b, D)], ['IQA-101', () => g101(b)], ['IQA-108', () => g108(b)], ['IQA-110', () => g110(D, b)], ['IQA-122', () => g122(b)]];
  for (const [id, fn] of steps) {
    if (left() < (id === 'IQA-122' ? 150000 : 60000)) { cp(id, '执行', false, '时间预算用尽，未执行', 'gap'); if (id === 'IQA-122') cp('IQA-119', '执行', false, '时间预算用尽，未执行', 'gap'); continue; }
    try { await fn(); } catch (e) { cp(id, '执行异常', false, '脚本异常：' + String(e && e.message || e).slice(0, 300), 'gap'); if (id === 'IQA-122' && !R['IQA-119'].cps.length) cp('IQA-119', '执行异常', false, '所在会话脚本异常', 'gap'); }
  }
}

// ---------- G-UI2：IQA-111 → IQA-121（含 IQA-118） ----------
const NO_AUDIO_RE = /没有包含声音|未包含声音|没有声音|不含声音|未共享音频|没有共享音频|未包含音频|没有包含音频/;
async function g111(b, D) {
  const id = 'IQA-111';
  const { ctx } = await newCtx(b, { mic: 'intf', tag: 'IQA-111' });
  const { page } = await openApp(ctx);
  await selectInput(page, '系统声音'); await page.bringToFront(); await clickStart(page);
  const w = await waitStatus(page, '出错', 10000);
  const m = await media(page);
  const g = m.media.filter((x) => x.type === 'gdm');
  const aud = g.map((x) => x.audio);
  cp(id, 'c1 0 条音频轨道且 ≤10 s 出错', g.length > 0 && aud.every((a) => a === 0) && w.ok && !w.seen.includes('正在听'), `共享调用 ${g.length} 次，音频轨道 ${aud.join(',') || '无'}，视频轨道 ${g.map((x) => x.video).join(',')}，状态:${w.ok ? '出错' : w.got}（经历 ${w.seen.join('/')}）`, g.length && g.every((x) => x.ok) ? 'defect' : 'env');
  const tHint = Date.now();
  const vt = await visibleText(page);
  const c2 = NO_AUDIO_RE.test(vt) && /标签页|整个屏幕/.test(vt) && /音频/.test(vt);
  cp(id, 'c2 中文提示无声音及可带声音的方式', c2, `无声音提示:${NO_AUDIO_RE.test(vt)}，标签页/整个屏幕:${/标签页|整个屏幕/.test(vt)}，音频:${/音频/.test(vt)}`);
  const te = await waitTracksEnded(page, 'gdm', Math.max(500, tHint + 5000 - Date.now()));
  const ci = (await caps(page)).items;
  cp(id, 'c3 ≤5 s 共享轨道结束、无字幕', te.ok && ci.length === 0, `共享轨道 ${te.n || 0} 条，仍 live ${te.live || 0}，字幕 ${ci.length} 条`);
  evAdd(id, await shot(page, 'iqa-111-noaudio.png')); evAdd(id, evWrite('iqa-111-media.json', m));
  await ctx.close();
  usesDeps(id);
  const b2 = await launchChrome(D, [TAB_ARG]);
  const r = await secondTry(b2, 'IQA-111');
  await b2.close();
  cp(id, 'c4 再次共享正常出字幕', r.ok, r.obs);
}
const CTL_LAYOUT = () => {
  const q = window.__qa;
  const a = q.findEl('opt', '麦克风'), s = q.findEl('opt', '系统声音');
  let grp = null;
  if (a && s) { if (a.tagName === 'OPTION') grp = a.closest('select'); else { grp = a; while (grp && !grp.contains(s)) grp = grp.parentElement; } }
  const st = q.findEl('btnPrefix', '开始'), sp = q.findEl('btnPrefix', '停止');
  q.status(); const stEl = document.querySelector('[data-qa-status]');
  const out = {};
  const items = { input: grp, start: st, stop: sp, status: stEl };
  for (const [k, el] of Object.entries(items)) {
    if (!el) { out[k] = { found: false }; continue; }
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const hit = document.elementFromPoint(cx, cy);
    out[k] = { found: true, visible: q.vis(el), enabled: k === 'start' || k === 'stop' ? q.isEnabled(el) : null, rect: { l: r.left, t: r.top, r: r.right, b: r.bottom }, hit: !!hit && (el.contains(hit) || hit.contains(el) || (el.labels && Array.from(el.labels).some((l) => l.contains(hit)))), inView: r.left >= -1 && r.top >= -1 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1 };
  }
  const ks = Object.keys(out).filter((k) => out[k].found && out[k].visible);
  const overlaps = [];
  for (let i = 0; i < ks.length; i++) for (let j = i + 1; j < ks.length; j++) {
    const A = out[ks[i]].rect, B = out[ks[j]].rect;
    if (A.l < B.r - 1 && B.l < A.r - 1 && A.t < B.b - 1 && B.t < A.b - 1 && !(items[ks[i]].contains(items[ks[j]]) || items[ks[j]].contains(items[ks[i]]))) overlaps.push(ks[i] + '×' + ks[j]);
  }
  const de = document.documentElement;
  return { ctl: out, overlaps, scrollW: de.scrollWidth, clientW: de.clientWidth, scrollY: window.scrollY };
};
const UI_ENGLISH = () => {
  const q = window.__qa; const c = q.captions();
  let t = document.body.innerText;
  for (const i of c.items) t = t.split(i.text).join(' ');
  const titleToks = (document.title || '').split(/[^A-Za-z]+/).filter((w) => w.length > 1);
  const PROPER = ['Chrome', 'Edge', 'Firefox', 'Safari', 'Windows', 'macOS', 'Mac', 'OS', 'Microsoft', 'Google', 'Apple', 'Azure', 'Linux', 'iOS', 'Android', 'Chromium', 'Opera', 'Brave', 'Teams', 'Zoom', 'Meet', 'Webex', 'Tencent', 'Wi-Fi', 'AI', 'PiP', ...titleToks];
  const lines = t.split('\n').map((l) => l.split(/\s+/).map((w) => { const b = w.replace(/[^A-Za-z\-]/g, ''); return b && PROPER.some((p) => p.toLowerCase() === b.toLowerCase()) ? '·' : w; }).join(' '));
  const hits = [];
  for (const l of lines) { const m = l.match(/\b[A-Za-z][A-Za-z'\-]+\b(?:\s+\b[A-Za-z][A-Za-z'\-]+\b)+/g); if (m) hits.push(...m); }
  return hits.slice(0, 10);
};
async function g121(b) {
  const id = 'IQA-121', i18 = 'IQA-118';
  const VPS = [[1366, 768], [1440, 900], [1600, 900], [1920, 1080], [480, 800]];
  const rows = [];
  for (const [W0, H0] of VPS) {
    if (left() < 45000) { rows.push({ vp: `${W0}×${H0}`, skipped: true }); continue; }
    const { ctx } = await newCtx(b, { mic: 'loop', viewport: { width: W0, height: H0 }, tag: `IQA-121-${W0}` });
    const { page } = await openApp(ctx);
    const states = [];
    const measure = async (want, w) => {
      const st = await getStatus(page);
      const L = await ev(page, CTL_LAYOUT); const M = await ev(page, () => window.__qa.metrics());
      const f = `iqa-121-${W0}x${H0}-${want}.png`; await shot(page, f);
      const eng = W0 === 1366 ? await ev(page, UI_ENGLISH) : [];
      states.push({ want, got: st.text, waited: w, sig: st.sig, L, capOverflow: M.caps.filter((c) => c.overflowX || c.ellipsis).map((c) => c.text), nCaps: M.caps.length, shot: f, eng });
    };
    await measure('未开始', true);
    await clickStart(page);
    const w1 = await waitStatus(page, '正在听', 20000);
    const nf = w1.ok ? await waitNewFinal(page, 0, 45000) : { ok: false };
    await measure('正在听', w1.ok && nf.ok);
    await clickStop(page); const w2 = await waitStatus(page, '已停止', 6000);
    await measure('已停止', w2.ok);
    await selectInput(page, '系统声音'); await page.bringToFront(); await clickStart(page);
    const w3 = await waitStatus(page, '出错', 10000);
    await measure('出错', w3.ok);
    rows.push({ vp: `${W0}×${H0}`, states });
    await ctx.close();
  }
  evAdd(id, evWrite('iqa-121-layout.json', rows));
  for (const r of rows) for (const s of r.states || []) { evAdd(id, s.shot); if (r.vp === '1366×768') evAdd(i18, s.shot); }
  const done = rows.filter((r) => !r.skipped);
  const skipped = rows.filter((r) => r.skipped).map((r) => r.vp);
  const c1bad = done.flatMap((r) => r.states.filter((s) => s.L.scrollW > s.L.clientW).map((s) => `${r.vp}/${s.want} ${s.L.scrollW}>${s.L.clientW}`));
  cp(id, 'c1 无横向滚动', !skipped.length && !c1bad.length, (c1bad.join('；') || '各尺寸各状态 scrollWidth ≤ clientWidth') + (skipped.length ? `；未执行：${skipped.join(',')}` : ''), skipped.length && !c1bad.length ? 'gap' : 'defect');
  const notes = [], c2bad = [];
  for (const r of done) for (const s of r.states) {
    for (const k of ['input', 'start', 'stop', 'status']) {
      const c = s.L.ctl[k];
      if (!c.found || !c.visible) {
        // 不可用时隐藏的按钮按 IQA-118 c4“或不显示”容许
        if ((k === 'start' && s.want === '正在听') || (k === 'stop' && s.want !== '正在听')) { notes.push(`${r.vp}/${s.want} ${k} 不显示（不可用时隐藏，容许）`); continue; }
        c2bad.push(`${r.vp}/${s.want} ${k} 不可见`); continue;
      }
      if (!c.hit) c2bad.push(`${r.vp}/${s.want} ${k} 被遮挡`);
    }
    if (s.L.overlaps.length) c2bad.push(`${r.vp}/${s.want} 重叠 ${s.L.overlaps.join(',')}`);
  }
  cp(id, 'c2 控制区四项可见、不重叠、可点击', done.length > 0 && !c2bad.length, (c2bad.slice(0, 8).join('；') || '全部满足') + (notes.length ? '；' + [...new Set(notes)].slice(0, 3).join('；') : ''));
  const c3bad = done.flatMap((r) => r.states.filter((s) => s.capOverflow.length).map((s) => `${r.vp}/${s.want}`));
  const capSeen = done.some((r) => r.states.some((s) => s.nCaps > 0));
  cp(id, 'c3 字幕无溢出与截断', capSeen && !c3bad.length, capSeen ? (c3bad.join('；') || '无溢出') : '未产生字幕，无法测量', capSeen ? 'defect' : 'gap');
  // IQA-118（1366×768 一轮）
  const r0 = rows.find((r) => r.vp === '1366×768');
  if (!r0 || r0.skipped) { cp(i18, '执行', false, '1366×768 一轮未执行', 'gap'); return; }
  const S = r0.states;
  const c1b = S.filter((s) => s.L.scrollY !== 0 || ['input', 'start', 'stop', 'status'].some((k) => { const c = s.L.ctl[k]; if (!c.found || !c.visible) return !((k === 'start' && s.want === '正在听') || (k === 'stop' && s.want !== '正在听')); return !c.inView; })).map((s) => s.want);
  cp(i18, 'c1 四项均在首屏', !c1b.length, c1b.length ? '不满足的状态：' + c1b.join('、') : '四种状态下四项均在视口内、scrollY=0');
  cp(i18, 'c2 状态文字', S.every((s) => s.got === s.want), S.map((s) => `${s.want}→${s.got}`).join('，'));
  const sigs = S.map((s) => s.sig || '');
  const dup = []; for (let i = 0; i < 4; i++) for (let j = i + 1; j < 4; j++) if (sigs[i] === sigs[j]) dup.push(S[i].want + '=' + S[j].want);
  evAdd(i18, evWrite('iqa-118-sigs.json', S.map((s) => ({ state: s.want, sig: s.sig }))));
  cp(i18, 'c3 四种状态样式两两不同', sigs.every(Boolean) && !dup.length, dup.length ? '样式相同：' + dup.join('、') : '两两不同');
  const c4b = S.filter((s) => {
    const st = s.L.ctl.start, sp = s.L.ctl.stop;
    const stOn = st.found && st.visible && st.enabled, spOn = sp.found && sp.visible && sp.enabled;
    return s.want === '正在听' ? !(spOn && !stOn) : !(stOn && !spOn);
  }).map((s) => `${s.want}(开始:${s.L.ctl.start.enabled}/停止:${s.L.ctl.stop.enabled})`);
  cp(i18, 'c4 按钮可用性', !c4b.length, c4b.length ? '不符合：' + c4b.join('、') : '符合');
  const eng = [...new Set(S.flatMap((s) => s.eng))];
  cp(i18, 'c5 界面文字为中文', !eng.length, eng.length ? '连续英文单词：' + eng.slice(0, 5).join(' | ') : '未发现连续 2 个以上英文单词');
}
async function gUi2(D) {
  const b = await launchChrome(D, [SCREEN_ARG]);
  for (const [id, fn] of [['IQA-111', () => g111(b, D)], ['IQA-121', () => g121(b)]]) {
    if (left() < 60000) { cp(id, '执行', false, '时间预算用尽，未执行', 'gap'); if (id === 'IQA-121') cp('IQA-118', '执行', false, '时间预算用尽，未执行', 'gap'); continue; }
    try { await fn(); } catch (e) { cp(id, '执行异常', false, '脚本异常：' + String(e && e.message || e).slice(0, 300), 'gap'); if (id === 'IQA-121' && !R['IQA-118'].cps.length) cp('IQA-118', '执行异常', false, '所在会话脚本异常', 'gap'); }
  }
}

// ---------- G-FF：IQA-109、IQA-123 ----------
async function gFf(D) {
  let b;
  try { b = await launchFirefox(D); } catch (e) {
    for (const id of ['IQA-109', 'IQA-123']) cp(id, '启动 Firefox', false, '环境：Firefox 无法启动：' + String(e.message || e).slice(0, 200), 'env');
    return;
  }
  const ver = b.version();
  const { ctx } = await newCtx(b, { mic: 'one', tag: 'IQA-FF' });
  const { page } = await openApp(ctx);
  const id = 'IQA-109';
  try {
    evAdd(id, evWrite('firefox-version.txt', 'Firefox ' + ver));
    const sel = await selectInput(page, '系统声音'); const t0 = Date.now();
    let vt = '', ok1 = false;
    while (Date.now() - t0 < 2000) { vt = await visibleText(page); if (/不支持/.test(vt) && /系统声音/.test(vt) && /Chrome|Edge/.test(vt)) { ok1 = true; break; } await sleep(200); }
    cp(id, 'c1 ≤2 s 显示不支持说明与可用浏览器', ok1, `系统声音选项:${sel.found}（可用:${sel.enabled}），不支持:${/不支持/.test(vt)}，Chrome/Edge:${/Chrome|Edge/.test(vt)}`);
    evAdd(id, await shot(page, 'iqa-109-firefox.png'));
    const bs = await btnState(page, '开始');
    let c2 = false, obs2 = `开始按钮:${bs.found ? (bs.enabled ? '可用' : '禁用') : '未找到'}`;
    if (sel.found && sel.after && sel.after['系统声音'] && !sel.after['系统声音'].selected) { c2 = true; obs2 += '；系统声音不可选中'; }
    else if (bs.found && !bs.enabled) c2 = true;
    else if (bs.found) {
      await clickStart(page, { force: true }); const w = await waitStatus(page, '正在听', 4000); const m = await media(page);
      c2 = !w.ok && !m.media.some((x) => x.type === 'gdm'); obs2 += `；点击后正在听:${w.ok}，共享调用:${m.media.filter((x) => x.type === 'gdm').length}`;
      if (w.ok) { await clickStop(page); await waitStatus(page, '已停止', 4000); }
    }
    cp(id, 'c2 系统声音模式下开始不可操作', c2, obs2);
    await selectInput(page, '麦克风'); await rebaseline(page);
    const st = await clickStart(page);
    const w = await waitStatus(page, '正在听', 20000);
    const m = await media(page);
    const okAlt = !w.ok && m.media.some((x) => x.type === 'gum' && x.ok) && (await getStatus(page)).text !== '出错';
    cp(id, 'c3 麦克风模式可开始', w.ok || okAlt, `开始按钮:${st.found}，状态:${w.ok ? '正在听' : w.got}，麦克风调用:${m.media.filter((x) => x.type === 'gum').map((x) => x.ok ? 'ok' : x.error).join(',')}`);
    // IQA-123（同一会话，麦克风模式进行中）
    const i23 = 'IQA-123'; usesDeps(i23);
    evAdd(i23, evWrite('firefox-version.txt', 'Firefox ' + ver));
    const pk = await ev(page, () => window.__qa.mark('btnHas', '字幕小窗', 'pip'));
    let c1 = false, o1 = '未找到含“字幕小窗”的按钮';
    if (pk.found) {
      if (!pk.visible) o1 = '按钮不可见';
      else if (!pk.enabled) { c1 = true; o1 = '按钮可见且禁用'; }
      else { const n0 = ctx.pages().length; await page.click('[data-qa-mark="pip"]', { timeout: 3000 }).catch(() => {}); await sleep(2500); c1 = ctx.pages().length === n0; o1 = `按钮可见可点，点击后新窗口:${!c1}`; }
    }
    // T-A5 假定 Firefox 不支持小窗；若该版本实际提供 Document PiP 且按钮可用，不满足的检查点归为测试计划问题而非产品缺陷。
    const ffPip = await ev(page, () => 'documentPictureInPicture' in window).catch(() => false);
    const k23 = ffPip && pk.found && pk.enabled ? 'gap' : 'defect';
    const n23 = k23 === 'gap' ? `；测试计划问题：Firefox ${ver} 支持 Document Picture-in-Picture，T-A5“Firefox 不支持字幕小窗”不成立，本检查点不作为产品缺陷` : '';
    cp(i23, 'c1 按钮可见但不可用', c1, o1 + (c1 ? '' : n23), k23);
    let c2t = '';
    if (pk.found) {
      await page.hover('[data-qa-mark="pip"]', { force: true, timeout: 3000 }).catch(() => {}); await sleep(800);
      c2t = await ev(page, () => {
        const el = document.querySelector('[data-qa-mark="pip"]'); const parts = [el.title || '', el.getAttribute('aria-description') || ''];
        const ids = (el.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean); ids.forEach((i) => { const d = document.getElementById(i); if (d) parts.push(d.textContent); });
        let p = el; for (let k = 0; k < 3 && p.parentElement; k++) p = p.parentElement; parts.push(p.innerText);
        document.querySelectorAll('[role=tooltip]').forEach((t) => { if (window.__qa.vis(t)) parts.push(t.innerText); });
        return parts.join('\n');
      });
    }
    const c2ok = /不支持/.test(c2t) && /Chrome|Edge/.test(c2t);
    cp(i23, 'c2 按钮附近有不支持原因与支持的浏览器', c2ok, (pk.found ? `附近文字含 不支持:${/不支持/.test(c2t)}，Chrome/Edge:${/Chrome|Edge/.test(c2t)}` : '无按钮') + (c2ok ? '' : n23), k23);
    evAdd(i23, await shot(page, 'iqa-123-firefox.png'));
    let nf = { ok: false, items: [] };
    if (w.ok || okAlt) nf = await waitNewFinal(page, 0, 45000, (t) => isChinese(t) && fullOf(t, 2));
    const f = finalTextsOf(nf.items);
    cp(i23, 'c3 麦克风模式出中文字幕', (w.ok || okAlt) && nf.ok, `正在听:${w.ok}，中文且命中第 2 句关键词的定稿:${nf.ok}${f.length ? '（' + f[f.length - 1].slice(0, 40) + '）' : ''}`);
    usesDeps(id);
    await clickStop(page).catch(() => {});
  } finally { await ctx.close().catch(() => {}); await b.close().catch(() => {}); }
}

// ---------- 汇总判定：IQA-108 c6、113 M7～M9、114～117 ----------
const EN = [
  "The quarterly sales report shows that our team in the European market sold many more products than we expected at the beginning of this year.",
  "The meeting will start at ten o'clock tomorrow morning.",
  "Please do not share this document with anyone outside the company.",
  "Our team sold twenty five thousand cars last year.",
  "The new office in Shanghai will open in July.",
  "We cannot accept this price because it is too high.",
];
const HEALTH = {};
async function readHealth() {
  if (!APP_ORIGIN) return;
  for (const p of ['/api/health', '/healthz', '/health', '/api/config', '/api/diagnostics', '/api/status', '/api/version']) {
    try { const r = await fetch(APP_ORIGIN + p, { signal: AbortSignal.timeout(6000) }); const t = await r.text(); HEALTH[p] = { status: r.status, body: r.ok && !/^\s*<(!doctype|html)/i.test(t) ? t.slice(0, 20000) : '' }; } catch (e) { HEALTH[p] = { status: 'error', body: '' }; }
  }
}
const toMs = (v) => (typeof v === 'number' ? (v < 1e12 ? v * 1000 : v) : Date.parse(v));
async function readLogs(from, to) {
  const dir = process.env.QA_SERVICE_LOGS_DIR;
  if (!dir) return { env: '未提供 QA_SERVICE_LOGS_DIR' };
  const sf = path.join(dir, 'status.json'), lf = path.join(dir, 'logs.jsonl');
  const waitUntil = Math.min(Date.now() + 240000, DEADLINE - 20000);
  let st = null;
  for (;;) {
    try { st = JSON.parse(fs.readFileSync(sf, 'utf8')); } catch (e) { st = null; }
    if (st && st.status === 'ok' && toMs(st.logsReadAt) > to && !st.pending) break;
    if (st && st.status && st.status !== 'ok' && st.status !== 'pending') break;
    if (Date.now() > waitUntil) break;
    await sleep(5000);
  }
  if (!st) return { env: '没有可读的 status.json' };
  if (st.status !== 'ok') return { env: `日志读取状态 ${st.status}（${String(st.reason || '').slice(0, 120)}）` };
  if (!(toMs(st.logsReadAt) > to)) return { env: `日志最近成功读取时间 ${st.logsReadAt} 未晚于检查时段结束` };
  const gaps = Array.isArray(st.gaps) ? st.gaps : [];
  const ov = gaps.filter((g) => { const vs = Object.values(g || {}).map(toMs).filter((x) => !isNaN(x)); if (vs.length < 2) return true; return Math.min(...vs) < to && Math.max(...vs) > from; });
  if (ov.length) return { env: `检查时段落在日志缺口 ${JSON.stringify(ov).slice(0, 200)} 中` };
  if (!fs.existsSync(lf)) return { env: '没有 logs.jsonl' };
  const lines = [];
  let total = 0, earliest = Infinity;
  for (const l of fs.readFileSync(lf, 'utf8').split('\n')) {
    if (!l.trim()) continue; total++;
    try { const o = JSON.parse(l); const t = toMs(o.time); if (t < earliest) earliest = t; if (t >= from - 2000 && t <= to) lines.push({ t, service: o.service, text: String(o.text || '') }); } catch (e) {}
  }
  if (earliest > from && (st.droppedOldest || 0) > 0) return { env: `检查时段开始前的日志已被丢弃（droppedOldest=${st.droppedOldest}）` };
  return { lines, total, status: { status: st.status, logsReadAt: st.logsReadAt, droppedOldest: st.droppedOldest || 0, gaps: gaps.length } };
}
function contentHits(lines, zhTexts) {
  const nzE = (s) => s.toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ').trim();
  const frags = new Set();
  for (const s of EN) { const w = nzE(s).split(' '); for (let i = 0; i + 4 <= w.length; i++) frags.add(w.slice(i, i + 4).join(' ')); }
  const zw = new Set();
  const nzZ = (s) => s.replace(/[\s，。、！？,.!?：:；;“”"'（）()]/g, '');
  for (const t of zhTexts) { const z = nzZ(t); if (z.length < 8) { if (z.length >= 4 && /[\u4e00-\u9fff]{4}/.test(z)) zw.add(z); continue; } for (let i = 0; i + 8 <= z.length; i++) { const w = z.slice(i, i + 8); if ((w.match(/[\u4e00-\u9fff]/g) || []).length >= 6) zw.add(w); } }
  const c = { source: 0, translation: 0, image: 0, secret: 0 };
  const IMG = /data:image\/|["':,=\s]\/9j\/[A-Za-z0-9+\/]{20}|iVBORw0KGgo|image\/(jpeg|png|webp)|\bvideo\/(webm|mp4|x-matroska)/i;
  for (const l of lines) {
    const e = ' ' + nzE(l.text) + ' ';
    for (const f of frags) if (e.includes(' ' + f + ' ')) { c.source++; break; }
    const z = nzZ(l.text);
    let hit = false;
    if (zw.size && /[\u4e00-\u9fff]/.test(z)) { for (let i = 0; i + 8 <= z.length && !hit; i++) if (zw.has(z.slice(i, i + 8))) hit = true; if (!hit) for (const w of zw) if (w.length < 8 && z.includes(w)) { hit = true; break; } }
    if (hit) c.translation++;
    if (IMG.test(l.text)) c.image++;
    for (const s of SECRETS) if (l.text.includes(s)) { c.secret++; break; }
  }
  return { counts: c, fragments: frags.size, zhWindows: zw.size };
}
async function logCheck(id, prefix, sess, label) {
  if (!sess) { for (const k of ['c1', 'c2', 'c3', 'c4']) if (!prefix || k === 'c1') cp(id, (prefix || k) + ' 日志无客户内容', false, `${label}会话未完成，无检查时段`, 'gap'); return; }
  const from = sess.tStart, to = sess.tEnd + 60000;
  const L = await readLogs(from, to);
  if (L.env) {
    const o = '环境：' + L.env;
    ENV_ISSUES.push(`${id}${prefix ? ' ' + prefix : ''}：${o}`);
    if (prefix) cp(id, prefix + ' 日志无客户内容', false, o, 'env');
    else for (const k of ['c1 原句', 'c2 译文', 'c3 画面数据', 'c4 secret']) cp(id, k + '命中 0', false, o, 'env');
    return;
  }
  const h = contentHits(L.lines, sess.allText || []);
  const info = `时段 ${new Date(from).toISOString()}～${new Date(to).toISOString()}，日志共 ${L.total} 行、时段内 ${L.lines.length} 行（${JSON.stringify(L.status)}），英文片段 ${h.fragments} 个、中文窗口 ${h.zhWindows} 个`;
  evAdd(id, evWrite(`${id.toLowerCase()}${prefix ? '-' + prefix.toLowerCase() : ''}-logscan.json`, { range: [from, to], linesInRange: L.lines.length, total: L.total, status: L.status, counts: h.counts, services: [...new Set(L.lines.map((l) => l.service))] }));
  if (L.lines.length === 0) {
    const o = '环境：' + info + '；时段内没有任何日志行，无法据此判断';
    ENV_ISSUES.push(`${id}${prefix ? ' ' + prefix : ''}：${o}`);
    if (prefix) cp(id, prefix + ' 日志无客户内容', false, o, 'env'); else for (const k of ['c1 原句', 'c2 译文', 'c3 画面数据', 'c4 secret']) cp(id, k + '命中 0', false, o, 'env');
    return;
  }
  const c = h.counts;
  if (prefix) cp(id, prefix + ' 日志无客户内容', !c.source && !c.translation && !c.image && !c.secret, `${info}；原句 ${c.source}、译文 ${c.translation}、画面 ${c.image}、secret ${c.secret}`);
  else {
    cp(id, 'c1 原句命中 0', !c.source, `${info}；原句命中 ${c.source} 行`);
    cp(id, 'c2 译文命中 0', !c.translation, `译文命中 ${c.translation} 行`);
    cp(id, 'c3 画面数据命中 0', !c.image, `画面数据特征命中 ${c.image} 行`);
    cp(id, 'c4 secret 命中 0', !c.secret, `secret 命中 ${c.secret} 行（日志已由平台脱敏，此项为补充）`);
  }
  return L;
}
function serviceEvidence(nets, logLines) {
  const hosts = new Set(); const wsFull = []; const texts = [];
  for (const n of nets) { if (!n) continue; n.hosts.forEach((h) => hosts.add(h)); wsFull.push(...n.wsFull); texts.push(...n.textSent, ...n.textRecv, ...n.console.map((c) => c.text)); }
  const logText = (logLines || []).map((l) => l.text);
  const healthText = Object.values(HEALTH).map((h) => h.body).filter(Boolean);
  const HOST_RE = /\b([a-z0-9-]+\.)+(cognitiveservices\.azure\.com|openai\.azure\.com|services\.ai\.azure\.com|speech\.microsoft\.com|api\.cognitive\.microsoft\.com|azure-api\.net|inference\.ai\.azure\.com)\b/gi;
  const logHosts = new Set(); for (const t of [...logText, ...healthText]) for (const m of t.matchAll(HOST_RE)) logHosts.add(m[0].toLowerCase());
  const azAll = new Set([...hosts].filter((h) => AZ_RE.test(h)).concat([...logHosts]));
  const corpus = [...wsFull, ...texts, ...logText, ...healthText].join('\n').toLowerCase();
  const tokenHit = [...DEP_TOKENS].filter((t) => t.length >= 4 && corpus.includes(t));
  const depHostHit = [...DEP_HOSTS].filter((h) => hosts.has(h) || corpus.includes(h));
  const mock = [...hosts, ...wsFull.map((u) => { try { return new URL(u).hostname; } catch (e) { return ''; } })].filter((h) => /mock|stub|fake/i.test(h));
  const fixedLang = wsFull.filter((u) => /[?&]language=[a-z]{2}-[A-Z]{2}/i.test(u) && !/autoDetect|lid|LanguageId|AutoDetectSourceLanguage|languageIdentification/i.test(u)).map(noQuery);
  const LID_RE = /autoDetect|LanguageId|AutoDetectSourceLanguage|languageIdentification|lidEnabled|["']lid["']|[?&]lid=|AtStart.?|Continuous/i;
  const lidSrc = [['网络', [...wsFull, ...texts]], ['服务日志', logText], ['诊断接口', healthText]].filter(([, arr]) => arr.some((t) => LID_RE.test(t))).map(([n]) => n);
  const RS_RE = /reasoning[_\s-]?effort["'\s:=]+["']?(none|minimal|off|disabled)|["']?reasoning["']?\s*[:=]\s*["']?(disabled|false|off|none)|["']?thinking["']?\s*[:=]\s*["']?(disabled|false|off|none)|reasoning\s*(disabled|off)/i;
  const rsSrc = [['服务日志', logText], ['诊断接口', healthText]].filter(([, arr]) => arr.some((t) => RS_RE.test(t))).map(([n]) => n);
  const depDeploy = Object.values(DEP).flatMap((d) => Object.entries(d).filter(([f]) => /DEPLOYMENT|MODEL/.test(f)).map(([, v]) => v.toLowerCase()));
  const llmHit = depDeploy.filter((v) => corpus.includes(v)).length > 0 || [...azAll].some((h) => /openai|services\.ai|inference/.test(h) && depOwnsHost(h));
  const declared = Object.values(DEP).filter((d) => Object.keys(d).some((f) => /ENDPOINT|URL|HOST/.test(f))).length;
  return { hosts: [...hosts], azAll: [...azAll], tokenHit, depHostHit, mock, fixedLang, lidSrc, rsSrc, llmHit, declared, notOwned: [...azAll].filter((h) => !depOwnsHost(h)) };
}
function svcCps(id, pre, sess, E) {
  const P = (c) => pre ? `${pre}（${c}）` : c;
  const stream = !!(sess && sess.streamOk && sess.interimSeen);
  const trace = E.tokenHit.length + E.depHostHit.length > 0;
  cp(id, P('c1 真实服务'), stream && trace && !E.mock.length, `流式临时结果:${stream}，依赖迹象：主机 ${E.depHostHit.length} 个、名称 ${E.tokenHit.length} 个；mock/stub/fake 端点 ${E.mock.length}`, E.mock.length || !stream ? 'defect' : 'gap');
  if (!pre) {
    cp(id, 'c2 同一现有实例', E.notOwned.length === 0, `观测到 Azure 主机 ${E.azAll.length} 个，不属于注入依赖的 ${E.notOwned.length} 个${E.notOwned.length ? '：' + E.notOwned.slice(0, 3).join(',') : ''}`);
    cp(id, 'c3 语言自动识别', !E.fixedLang.length && E.lidSrc.length > 0, `固定单一语言的连接 ${E.fixedLang.length} 个；自动识别正面证据来源：${E.lidSrc.join('、') || '无（已查网络消息、服务日志、诊断接口 ' + Object.keys(HEALTH).join(',') + '）'}`, E.fixedLang.length ? 'defect' : 'gap');
    cp(id, 'c4 reasoning 关闭', E.rsSrc.length > 0 && E.llmHit, `reasoning 关闭证据来源：${E.rsSrc.join('、') || '无（已查服务日志、诊断接口）'}；翻译调用指向注入的大模型部署:${E.llmHit}`, 'gap');
    cp(id, 'c5 未新增实例', E.azAll.length > 0 && E.notOwned.length === 0 && E.azAll.length <= Math.max(E.declared, 1) * 3, `观测端点 ${E.azAll.length} 个（声明依赖 ${E.declared} 个，均属注入依赖:${E.notOwned.length === 0}）`, E.notOwned.length ? 'defect' : 'gap');
  }
}
async function aggregate() {
  await readHealth();
  const s = SHARED.sysMain, m = SHARED.micMain, u = SHARED.ui122;
  // IQA-108 c6
  if (R['IQA-108'].cps.length && SHARED.doc108) {
    const c102 = R['IQA-102'].cps.filter((c) => /^c[12] /.test(c.step));
    const ok = SHARED.doc108.tabDoc && c102.length === 2 && c102.every((c) => c.passed);
    cp('IQA-108', 'c6 说明与实测一致', ok, `说明称 Chrome 标签页声音可采集:${SHARED.doc108.tabDoc}；IQA-102 c1/c2 通过:${c102.length === 2 && c102.every((c) => c.passed)}`);
  }
  // IQA-116、IQA-113 M9
  let sysLog = null;
  if (s) sysLog = await logCheck('IQA-116', '', s, 'SYS-MAIN');
  else for (const k of ['c1 原句', 'c2 译文', 'c3 画面数据', 'c4 secret']) cp('IQA-116', k + '命中 0', false, 'SYS-MAIN 未完成，无检查时段', 'gap');
  let micLog = null;
  if (R['IQA-113'].cps.length) {
    if (m) { const L = await logCheck('IQA-113', 'M9', m, '麦克风'); micLog = (L && L.lines) || null; }
    else cp('IQA-113', 'M9 日志无客户内容', false, '麦克风主会话未完成', 'gap');
  }
  // IQA-114、IQA-113 M7
  const nets = [s && s.net, u && u.net].filter(Boolean);
  const E = serviceEvidence(nets.length ? nets : SHARED.nets, sysLog && sysLog.lines);
  evAdd('IQA-114', evWrite('iqa-114-services.json', { ...E, health: Object.fromEntries(Object.entries(HEALTH).map(([k, v]) => [k, { status: v.status, bytes: v.body.length }])), depNames: DEP_NAMES, depHosts: [...DEP_HOSTS] }));
  usesDeps('IQA-114'); usesDeps('IQA-116'); usesDeps('IQA-115');
  if (s) svcCps('IQA-114', '', s, E); else cp('IQA-114', 'c1 真实服务', false, 'SYS-MAIN 未完成', 'gap');
  if (R['IQA-113'].cps.length) {
    if (m) { const Em = serviceEvidence([m.net], micLog); svcCps('IQA-113', 'M7 真实服务', m, Em); evAdd('IQA-113', evWrite('iqa-113-services.json', Em)); }
    else cp('IQA-113', 'M7 真实服务', false, '麦克风主会话未完成', 'gap');
  }
  // IQA-115、IQA-113 M8
  const scanCp = (id, step, ns, label) => {
    if (!ns.length) { cp(id, step, false, `${label}未完成，无扫描数据`, 'gap'); return; }
    const sums = ns.map((n) => ({ tag: n.tag, ...n.scan.summary(), wsFrames: n.wsSent + n.wsRecv, requests: n.reqs.length }));
    const hits = ns.reduce((a, n) => a + n.scan.secretHits(), 0);
    const f = evWrite(`${id.toLowerCase()}-${step.split(' ')[0].toLowerCase()}-scan.json`, sums); evAdd(id, f);
    const cnt = {}; for (const x of sums) for (const [k, v] of Object.entries(x.counts)) if (!/^sent/.test(k)) cnt[k] = (cnt[k] || 0) + v;
    cp(id, step, hits === 0, `${label}：扫描 ${sums.reduce((a, x) => a + x.scannedBytes, 0)} 字节、${sums.reduce((a, x) => a + x.scannedItems, 0)} 项、请求 ${sums.reduce((a, x) => a + x.requests, 0)} 个、WebSocket 帧 ${sums.reduce((a, x) => a + x.wsFrames, 0)}；命中 ${JSON.stringify(cnt)}（比对值 ${new Set(SECRETS).size} 个）`);
  };
  scanCp('IQA-115', 'c1 系统声音与小窗会话无长期凭据', [s && s.net, u && u.net].filter(Boolean), 'SYS-MAIN 与 IQA-122');
  scanCp('IQA-115', 'c2 麦克风会话无长期凭据', [m && m.net].filter(Boolean), '麦克风主会话');
  if (R['IQA-113'].cps.length) scanCp('IQA-113', 'M8 无长期凭据', [m && m.net].filter(Boolean), '麦克风主会话');
  // IQA-117
  if (s) {
    const ui = SHARED.ui117, pip = SHARED.pip117;
    const vids = (Number(s.video.shown) || 0) + (ui ? Number(ui.video) || 0 : 0) + (pip ? Number(pip.video) || 0 : 0);
    const can = s.video.canary || (ui && ui.canary) || (pip && pip.canary);
    cp('IQA-117', 'c1 页面与小窗不显示共享画面', !vids && !can, `可见共享视频元素 ${vids} 个，QA-CANARY 可见:${!!can}；小窗已检查:${!!pip}${pip ? '' : '（小窗未打开，仅检查主页面）'}`);
    const sn = [s.net, u && u.net].filter(Boolean);
    const img = sn.reduce((a, n) => a + n.scan.c.sentImage, 0), vid = sn.reduce((a, n) => a + n.scan.c.sentVideo, 0);
    const ctype = {}; for (const n of sn) for (const r of n.reqs) ctype[r.type] = (ctype[r.type] || 0) + 1;
    cp('IQA-117', 'c2 未上传画面数据', !img && !vid, `图像特征 ${img}、视频特征 ${vid}；请求类型 ${JSON.stringify(ctype)}，WebSocket 发送帧 ${sn.reduce((a, n) => a + n.wsSent, 0)}`);
    const rec = [...(s.video.recorder || []), ...(ui && ui.m ? ui.m.recorder : [])], rtc = [...(s.video.rtc || []), ...(ui && ui.m ? ui.m.rtc : [])];
    cp('IQA-117', 'c3 未把视频轨道交给录制或 RTC', !rec.some((r) => r.video > 0) && !rtc.some((r) => r.kind === 'video'), `MediaRecorder ${rec.length} 次（含视频 ${rec.filter((r) => r.video > 0).length}），RTC 轨道 ${rtc.map((r) => r.kind).join(',') || '无'}`);
    const save = [...(s.save || []), ...(ui ? ui.save || [] : [])];
    cp('IQA-117', 'c4 无保存/导出入口', save.length === 0, save.length ? '发现：' + [...new Set(save)].slice(0, 5).join('、') : '未发现');
  } else for (const k of ['c1', 'c2', 'c3', 'c4']) cp('IQA-117', k, false, 'SYS-MAIN 未完成', 'gap');
}

// ---------- 结果 ----------
function buildResult() {
  const scenarios = [], defects = [], testGaps = [], envs = [...ENV_ISSUES];
  for (const id of IDS) {
    const r = R[id];
    if (!r.cps.length) r.cps.push({ step: '执行', passed: false, observation: '未执行（时间预算用尽或前置失败）', kind: 'gap' });
    for (const c of r.cps) {
      if (c.passed) continue;
      const line = `${id} ${c.step}：${c.observation}`.slice(0, 600);
      if (c.kind === 'env') { if (!envs.some((e) => e.startsWith(id))) envs.push(line); }
      else if (c.kind === 'gap') testGaps.push(line);
      else defects.push(line);
    }
    const passed = r.cps.every((c) => c.passed);
    const ev = [...r.ev].filter(Boolean);
    scenarios.push({ id, passed, externalServices: [...r.ext], checkpoints: r.cps.map((c) => ({ step: c.step, passed: c.passed, observation: c.observation })), evidence: ev.length ? ev.join(', ') : 'run.log' });
  }
  const pass = scenarios.filter((s) => s.passed).length;
  const envDiag = [...new Set(envs)].map((e) => (/^环境：/.test(e) ? e : '环境：' + e));
  const files = (() => { try { return fs.readdirSync(EV).filter((f) => !f.startsWith('.')).sort(); } catch (e) { return []; } })();
  const res = {
    passed: pass === IDS.length && !defects.length && !testGaps.length && !envDiag.length,
    testedCommitSha: process.env.QA_CANDIDATE_SHA || '',
    summary: `系统声音实时翻译独立测试：${IDS.length} 个场景中 ${pass} 个通过；产品缺陷 ${defects.length} 条、脚本未能完成验证 ${testGaps.length} 条、环境问题 ${envDiag.length} 条。被测地址 ${APP ? noQuery(APP) : '无'}。` + (envDiag.length ? ' ' + envDiag.slice(0, 3).join('；') : ''),
    defects, testGaps,
    evidence: [...files, ...envDiag],
    bugfixResults: [],
    scenarios,
  };
  let txt = redact(JSON.stringify(res, null, 1));
  if (Buffer.byteLength(txt) > 250000) {
    for (const s of res.scenarios) for (const c of s.checkpoints) c.observation = c.observation.slice(0, 300);
    res.defects = res.defects.map((d) => d.slice(0, 300)); res.testGaps = res.testGaps.map((d) => d.slice(0, 300));
    res.evidence = res.evidence.slice(0, 300);
    txt = redact(JSON.stringify(res));
  }
  return txt;
}
function envResult(msg) {
  for (const id of IDS) if (!R[id].cps.length) R[id].cps.push({ step: '执行', passed: false, observation: '环境：' + msg, kind: 'env' });
  ENV_ISSUES.push('环境：' + msg);
}

// ---------- 主流程 ----------
async function main() {
  const srv = await startMaterialServer();
  const pick = await pickApp();
  if (!pick.url) { envResult(pick.error); fs.writeFileSync(process.env.QA_RESULT_PATH, buildResult()); process.exit(0); }
  APP = pick.url; try { APP_ORIGIN = new URL(APP).origin; } catch (e) {}
  log('app', pick.name, noQuery(APP));
  try {
    const r = await fetch(APP, { signal: AbortSignal.timeout(20000) });
    if (r.status >= 500) throw new Error('HTTP ' + r.status);
  } catch (e) {
    envResult(`被测地址 ${noQuery(APP)}（${pick.name}）不可达：${String(e.cause && e.cause.code || e.message || e).slice(0, 160)}`);
    fs.writeFileSync(process.env.QA_RESULT_PATH, buildResult()); process.exit(0);
  }
  const groups = [['G-SYS', gSys, ['IQA-102', 'IQA-103', 'IQA-104', 'IQA-105', 'IQA-106', 'IQA-107', 'IQA-112']], ['G-MIC', gMic, ['IQA-113']], ['G-UI1', gUi1, ['IQA-120', 'IQA-101', 'IQA-108', 'IQA-110', 'IQA-122', 'IQA-119']], ['G-UI2', gUi2, ['IQA-111', 'IQA-121', 'IQA-118']], ['G-FF', gFf, ['IQA-109', 'IQA-123']]];
  const hard = setTimeout(() => { log('hard deadline'); try { fs.writeFileSync(process.env.QA_RESULT_PATH, buildResult()); } catch (e) {} process.exit(0); }, Math.max(60000, DEADLINE + 30000 - Date.now()));
  const st = await Promise.allSettled(groups.map(([n, fn], i) => fn(DISPLAYS[i]).then(() => log(n, 'done'))));
  st.forEach((r, i) => {
    if (r.status !== 'rejected') return;
    const [n, , ids] = groups[i]; const msg = String(r.reason && r.reason.message || r.reason).slice(0, 300);
    log(n, 'crashed', msg);
    const env = /Executable doesn't exist|browserType\.launch|Target page, context or browser has been closed|net::ERR_|ECONNREFUSED|ENOTFOUND|ETIMEDOUT/.test(msg);
    for (const id of ids) if (!R[id].cps.length || R[id].cps.length < 2) cp(id, `${n} 执行中断`, false, (env ? '环境：' : '脚本异常：') + msg, env ? 'env' : 'gap');
    if (env) ENV_ISSUES.push(`环境：${n} 执行中断：${msg}`);
  });
  try { await aggregate(); } catch (e) { log('aggregate failed', String(e && e.stack || e).slice(0, 500)); }
  try {
    const netSum = SHARED.nets.concat([SHARED.micMain && SHARED.micMain.net].filter(Boolean)).map((n) => ({ tag: n.tag, hosts: [...n.hosts], ws: n.ws, requests: n.reqs.slice(0, 400), console: n.console.slice(0, 200), downloads: n.downloads, wsSent: n.wsSent, wsRecv: n.wsRecv }));
    evWrite('network-summary.json', netSum);
  } catch (e) {}
  clearTimeout(hard);
  fs.writeFileSync(process.env.QA_RESULT_PATH, buildResult());
  log('result written');
  for (const b of BROWSERS) await b.close().catch(() => {});
  srv.close();
  process.exit(0);
}
main().catch((e) => {
  log('main failed', String(e && e.stack || e).slice(0, 800));
  try { envResult('测试驱动异常：' + String(e && e.message || e).slice(0, 200)); fs.writeFileSync(process.env.QA_RESULT_PATH, buildResult()); } catch (x) {}
  process.exit(0);
});
JSEOF

cd "$WORK"
log "driver start elapsed=$(( $(date +%s) - QA_T0 ))s"
rm -f "$QA_RESULT_PATH"
REM=$(( 880 - ( $(date +%s) - QA_T0 ) )); [ "$REM" -lt 60 ] && REM=60
timeout "$REM" node qa.mjs 2>>"$QA_EVIDENCE_DIR/run.log"
RC=$?
log "driver exit=$RC elapsed=$(( $(date +%s) - QA_T0 ))s"
if ! python3 -c 'import json,sys; d=json.load(open(sys.argv[1],encoding="utf-8")); assert isinstance(d.get("scenarios"),list) and len(d["scenarios"])==23' "$QA_RESULT_PATH" 2>>"$SETUP_LOG"; then
  write_env_result "测试驱动未写出有效结果（退出码 $RC，见 run.log）"
fi
exit 0
