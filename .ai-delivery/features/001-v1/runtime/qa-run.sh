#!/usr/bin/env bash
# 独立测试脚本：企业实时翻译（会议中文字幕）。依据 tasks-qa.md（IQA-001～IQA-011）。
# 运行环境：平台 QA Pod，工作目录为空的临时目录；只写工作目录、QA_RESULT_PATH、QA_EVIDENCE_DIR。
set -uo pipefail

WORK="$(pwd)"
export WORK
export EVD="${QA_EVIDENCE_DIR:-$WORK/evidence}"
export RESULT_PATH="${QA_RESULT_PATH:-$WORK/qa-result.json}"
export CANDIDATE_SHA="${QA_CANDIDATE_SHA:-unknown}"
mkdir -p "$EVD" "$WORK/qa" "$WORK/raw" "$WORK/materials" "$WORK/home" "$WORK/.cache"
export HOME="$WORK/home" XDG_CACHE_HOME="$WORK/.cache" npm_config_cache="$WORK/.npm" \
  PIP_CACHE_DIR="$WORK/.pip" AZURE_CONFIG_DIR="$WORK/.azure" npm_config_update_notifier=false
START_EPOCH=$(date +%s)
export QA_START_EPOCH="$START_EPOCH"
# 15 分钟硬超时，留出余量写结果
export QA_DEADLINE=$((START_EPOCH + 830))
LOG="$EVD/qa-run.log"
: > "$LOG"
log() { echo "[$(date -u +%H:%M:%S)] $*" | tee -a "$LOG" >&2; }

# ---------------------------------------------------------------------------
# 结果写出（环境问题 / 无法执行时的兜底）
# ---------------------------------------------------------------------------
write_fallback() { # $1=kind(env|gap) $2=message
  KIND="$1" MSG="$2" python3 - <<'PY'
import json, os
kind, msg = os.environ["KIND"], os.environ["MSG"]
ids = ["IQA-%03d" % i for i in range(1, 12)]
res = {
  "passed": False,
  "testedCommitSha": os.environ.get("CANDIDATE_SHA", "unknown"),
  "summary": ("执行环境问题，未能执行验收：" if kind == "env" else "测试脚本未能完成验证：") + msg,
  "defects": [],
  "testGaps": [] if kind == "env" else ["全部场景未能执行：" + msg],
  "evidence": ["qa-run.log"],
  "bugfixResults": [],
  "scenarios": [{"id": i, "passed": False, "externalServices": [],
                 "evidence": ("环境问题：" if kind == "env" else "测试缺口：") + msg + "（见 qa-run.log）"} for i in ids],
}
with open(os.environ["RESULT_PATH"], "w", encoding="utf-8") as f:
    json.dump(res, f, ensure_ascii=False, indent=1)
PY
}

# ---------------------------------------------------------------------------
# 1. 选择候选访问地址
# ---------------------------------------------------------------------------
log "QA 开始，候选提交 $CANDIDATE_SHA"
APP_URL=""
APP_VAR=""
CANDS=$(env | grep -E '^AIDH_SERVICE_[A-Z0-9_]+_URL=' | sed 's/=.*//' | sort)
PREF=$(echo "$CANDS" | grep -E 'WEB|APP|UI|FRONT' || true)
REST=$(echo "$CANDS" | grep -vE 'WEB|APP|UI|FRONT' || true)
for v in $PREF $REST; do
  u="${!v%/}"
  [ -z "$u" ] && continue
  ct=$(curl -sS -L -m 20 -o "$WORK/raw/probe.html" -w '%{http_code} %{content_type}' "$u/" 2>>"$LOG" || true)
  log "探测 $v -> $ct"
  case "$ct" in
    2*text/html*) APP_URL="$u"; APP_VAR="$v"; break ;;
  esac
done
if [ -z "$APP_URL" ]; then
  if [ -z "$CANDS" ]; then
    log "未注入任何 AIDH_SERVICE_*_URL"
    write_fallback env "平台未注入候选访问地址（AIDH_SERVICE_*_URL）"
  else
    log "候选地址不可达或根路径未返回 HTML"
    write_fallback env "候选访问地址不可达或根路径未返回 HTML 页面（见 qa-run.log 中的探测结果）"
  fi
  exit 0
fi
export APP_URL
log "候选页面地址变量：$APP_VAR"

# ---------------------------------------------------------------------------
# 2. 写出内嵌的辅助程序
# ---------------------------------------------------------------------------
cat > "$WORK/qa/common.py" <<'PY_EOF'
"""共享：素材定义、依赖发现、凭据值收集、脱敏。"""
import os, re

SENTENCES = [
    {"id": "S1",
     "text": "Good afternoon everyone, today we are going to review the sales report for the third quarter, "
             "and after that we will discuss the marketing plan for next year in detail.",
     "ref": "大家下午好，今天我们将审阅第三季度的销售报告，之后我们将详细讨论明年的营销计划。",
     "keys": [["销售"], ["第三季度", "三季度", "第3季度", "Q3"], ["营销", "市场"], ["明年", "下一年", "来年"]],
     "anchor": ["第三季度", "三季度", "第3季度", "Q3"]},
    {"id": "S2", "text": "The new office in Singapore will open on the fifth of March.",
     "ref": "新加坡的新办公室将于三月五日开业。",
     "keys": [["新加坡"], ["3月5", "三月五", "3 月 5"], ["办公室", "办事处"]],
     "anchor": ["新加坡"]},
    {"id": "S3", "text": "Our team has twelve engineers and four designers.",
     "ref": "我们团队有十二名工程师和四名设计师。",
     "keys": [["十二", "12"], ["四", "4"], ["工程师"], ["设计师"]],
     "anchor": ["工程师"]},
    {"id": "S4", "text": "We will not cancel the project because the budget has been approved.",
     "ref": "我们不会取消这个项目，因为预算已经获批。",
     "keys": [["取消"], ["不", "没"], ["项目"], ["预算"], ["批准", "获批", "通过", "核准", "审批", "批了"]],
     "anchor": ["取消"]},
    {"id": "S5", "text": "Please send the final contract to Michael before Friday afternoon.",
     "ref": "请在周五下午之前把最终合同发给迈克尔。",
     "keys": [["合同"], ["迈克尔", "迈克", "麦克", "麦可", "Michael"], ["周五", "星期五", "礼拜五"], ["下午"]],
     "anchor": ["合同"]},
    {"id": "S6", "text": "The price of the product increased by fifteen percent last year.",
     "ref": "该产品的价格去年上涨了百分之十五。",
     "keys": [["价格", "价钱"], ["百分之十五", "15%", "15％", "15 %"], ["去年"], ["上涨", "增长", "提高", "上升", "涨"]],
     "anchor": ["百分之十五", "15%", "15％", "15 %"]},
]

SECRET_FIELD_RE = re.compile(r"(KEY|SECRET|PASSWORD|PASSWD|CONNECTION|CREDENTIAL|SAS|TOKEN)", re.I)


def deps():
    """按 AIDH_DEP_{N}_KIND 发现依赖，返回 {N: {FIELD: value}}。"""
    names = sorted({k[len("AIDH_DEP_"):-len("_KIND")] for k in os.environ
                    if k.startswith("AIDH_DEP_") and k.endswith("_KIND")}, key=len, reverse=True)
    out = {n: {} for n in names}
    for k, v in os.environ.items():
        if not k.startswith("AIDH_DEP_"):
            continue
        rest = k[len("AIDH_DEP_"):]
        for n in names:
            if rest.startswith(n + "_"):
                out[n][rest[len(n) + 1:]] = v
                break
    return out


def classify_deps(d):
    speech, model = [], []
    for n, f in d.items():
        blob = " ".join([n, f.get("KIND", ""), f.get("ENDPOINT", "")]).lower()
        if re.search(r"speech|stt|transcri|asr", blob):
            speech.append(n)
        elif re.search(r"openai|llm|model|gpt|chat|translat|foundry|aoai|inference|ai", blob):
            model.append(n)
    if not speech and len(d) == 1:
        speech = list(d)
    if not model:
        model = [n for n in d if n not in speech] or list(speech)
    return speech, model


def field(f, *pats):
    for p in pats:
        for k, v in f.items():
            if re.search(p, k, re.I) and v:
                return v
    return ""


def secret_values():
    vals = set()
    for k, v in os.environ.items():
        if not v or len(v) < 8:
            continue
        if k.startswith("AIDH_SECRET_"):
            vals.add(v)
        elif k.startswith("AIDH_DEP_") and SECRET_FIELD_RE.search(k[len("AIDH_DEP_"):]) \
                and not k.endswith(("_KIND", "_ENDPOINT", "_RESOURCE_ID", "_AUTH_MODE")):
            vals.add(v)
    return sorted(vals, key=len, reverse=True)


def redact(s):
    for v in secret_values():
        s = s.replace(v, "***")
    return s
PY_EOF

cat > "$WORK/qa/materials.py" <<'PY_EOF'
"""合成英语测试素材（piper-tts 离线合成；失败时用语音依赖的语音合成），生成三个 WAV 与 manifest.json。"""
import array, json, os, subprocess, sys, urllib.request, wave
sys.path.insert(0, os.path.dirname(__file__))
from common import SENTENCES, deps, classify_deps, field

W = os.environ["WORK"]
OUT = os.path.join(W, "materials")
PIPER = os.path.join(W, "venv", "bin", "piper")
VOICE = os.path.join(W, "voice.onnx")


def piper(text, path, scale):
    subprocess.run([PIPER, "-m", VOICE, "-f", path, "--length-scale", str(scale)], input=text.encode(),
                   check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=120)


def azure_tts(text, path, scale):
    d = deps(); sp, _ = classify_deps(d)
    for n in sp:
        f = d[n]
        key = field(f, r"^KEY$", r"API_KEY", r"KEY")
        region = field(f, r"REGION", r"LOCATION")
        if not (key and region):
            continue
        rate = "-%d%%" % int((scale - 1) * 100) if scale > 1 else "0%"
        ssml = ("<speak version='1.0' xml:lang='en-US'><voice name='en-US-JennyNeural'>"
                "<prosody rate='%s'>%s</prosody></voice></speak>" % (rate, text))
        req = urllib.request.Request("https://%s.tts.speech.microsoft.com/cognitiveservices/v1" % region,
                                     data=ssml.encode(), method="POST", headers={
                                         "Ocp-Apim-Subscription-Key": key, "Content-Type": "application/ssml+xml",
                                         "X-Microsoft-OutputFormat": "riff-24khz-16bit-mono-pcm", "User-Agent": "qa"})
        with urllib.request.urlopen(req, timeout=60) as r, open(path, "wb") as fo:
            fo.write(r.read())
        return
    raise RuntimeError("没有可用于语音合成的依赖接入信息")


def read(path):
    with wave.open(path) as w:
        assert w.getsampwidth() == 2 and w.getnchannels() == 1
        return w.getframerate(), array.array("h", w.readframes(w.getnframes()))


def speech_bounds(rate, a):
    win = rate // 50
    th = 600
    idx = [i for i in range(0, len(a) - win, win) if max(abs(x) for x in a[i:i + win]) > th]
    if not idx:
        return 0, len(a)
    return idx[0], idx[-1] + win


def main():
    engine = sys.argv[1] if len(sys.argv) > 1 else "piper"
    synth = piper if engine == "piper" else azure_tts
    clips = {}
    rate0 = None
    for s in SENTENCES:
        scale = 1.15 if s["id"] == "S1" else 1.0
        while True:
            p = os.path.join(OUT, s["id"] + ".wav")
            synth(s["text"], p, scale)
            rate, a = read(p)
            b0, b1 = speech_bounds(rate, a)
            dur = (b1 - b0) / rate
            if s["id"] != "S1" or dur >= 9.0 or scale >= 1.6:
                break
            scale += 0.15
        if rate0 is None:
            rate0 = rate
        if rate != rate0:
            raise RuntimeError("采样率不一致")
        clips[s["id"]] = (a[b0:b1], dur)
    rate = rate0

    def build(name, order, gap_s, lead_s=0.3):
        buf = array.array("h", [0] * int(lead_s * rate))
        marks = []
        for sid in order:
            a, _ = clips[sid]
            st = len(buf)
            buf.extend(a)
            marks.append({"id": sid, "start_ms": int(st * 1000 / rate), "end_ms": int(len(buf) * 1000 / rate)})
            buf.extend([0] * int(gap_s * rate))
        path = os.path.join(OUT, name + ".wav")
        with wave.open(path, "wb") as w:
            w.setnchannels(1); w.setsampwidth(2); w.setframerate(rate); w.writeframes(buf.tobytes())
        return {"path": path, "duration_ms": int(len(buf) * 1000 / rate), "speech_end_ms": marks[-1]["end_ms"],
                "sentences": marks}

    ids = [s["id"] for s in SENTENCES]
    manifest = {
        "engine": engine, "rate": rate,
        "sentences": SENTENCES,
        "files": {"main": build("main", ids, 2.5), "stop": build("stop", ids, 2.5),
                  "short": build("short", ["S2", "S3"], 2.0)},
    }
    s1 = manifest["files"]["main"]["sentences"][0]
    if s1["end_ms"] - s1["start_ms"] < 8000:
        raise RuntimeError("S1 合成时长不足 8 秒")
    with open(os.path.join(OUT, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=1)
    pub = {"engine": engine, "sentences": [{k: s[k] for k in ("id", "text", "ref", "keys", "anchor")} for s in SENTENCES],
           "files": {k: {kk: vv for kk, vv in v.items() if kk != "path"} for k, v in manifest["files"].items()}}
    with open(os.path.join(os.environ["EVD"], "materials.json"), "w", encoding="utf-8") as f:
        json.dump(pub, f, ensure_ascii=False, indent=1)
    print("S1 时长 %.1fs，main 时长 %.1fs" % ((s1["end_ms"] - s1["start_ms"]) / 1000,
                                           manifest["files"]["main"]["duration_ms"] / 1000))


main()
PY_EOF
cat > "$WORK/qa/browser.js" <<'JS_EOF'
// 浏览器场景：IQA-001～006、010、011，并为 IQA-007～009 采集原始数据（原始数据只留在工作目录）。
'use strict';
const fs = require('fs');
const path = require('path');
const { chromium } = require(path.join(process.env.WORK, 'node_modules', 'playwright'));

const WORK = process.env.WORK, EVD = process.env.EVD, APP = process.env.APP_URL;
const RAW = path.join(WORK, 'raw');
const M = JSON.parse(fs.readFileSync(path.join(WORK, 'materials', 'manifest.json'), 'utf8'));
const DEADLINE = Number(process.env.QA_DEADLINE) * 1000;
const APP_ORIGIN = new URL(APP).origin;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => Date.now();

// ---------- 凭据值（只用于脱敏与扫描，不写入证据） ----------
const SECRET_FIELD_RE = /(KEY|SECRET|PASSWORD|PASSWD|CONNECTION|CREDENTIAL|SAS|TOKEN)/i;
const SECRETS = Object.entries(process.env)
  .filter(([k, v]) => v && v.length >= 8 && (k.startsWith('AIDH_SECRET_') ||
    (k.startsWith('AIDH_DEP_') && SECRET_FIELD_RE.test(k.slice(9)) && !/_(KIND|ENDPOINT|RESOURCE_ID|AUTH_MODE)$/.test(k))))
  .map(([, v]) => v).sort((a, b) => b.length - a.length);
function redact(s) {
  s = String(s);
  for (const v of SECRETS) s = s.split(v).join('***');
  return s;
}
function writeEvd(name, obj) {
  const txt = typeof obj === 'string' ? obj : JSON.stringify(obj, null, 1);
  fs.writeFileSync(path.join(EVD, name), redact(txt));
  return name;
}
const rawStream = fs.createWriteStream(path.join(RAW, 'network.jsonl'), { flags: 'a' });
function raw(rec) { rawStream.write(JSON.stringify(rec) + '\n'); }

// ---------- 页面内观测脚本 ----------
const INIT = `(() => {
  if (window.__qa) return;
  const qa = window.__qa = { gum: [], tracks: [], snaps: [] };
  try {
    const orig = MediaDevices.prototype.getUserMedia;
    MediaDevices.prototype.getUserMedia = function (c) {
      const rec = { t: Date.now(), constraints: JSON.stringify(c || {}).slice(0, 300) };
      qa.gum.push(rec);
      return orig.call(this, c).then((s) => {
        rec.ok = Date.now();
        for (const tr of s.getTracks()) qa.tracks.push(tr);
        return s;
      }, (e) => { rec.err = e && e.name; rec.errT = Date.now(); throw e; });
    };
  } catch (e) { qa.hookError = String(e); }
  let last = null;
  const snap = () => {
    const b = document.body; if (!b) return;
    const txt = b.innerText || '';
    if (txt !== last) { last = txt; qa.snaps.push({ t: Date.now(), text: txt }); }
  };
  qa.snap = snap;
  qa.trackStates = () => qa.tracks.map((t) => ({ kind: t.kind, readyState: t.readyState, enabled: t.enabled }));
  const start = () => {
    snap();
    new MutationObserver(snap).observe(document.documentElement, { subtree: true, childList: true, characterData: true });
    setInterval(snap, 200);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();`;

// ---------- 文本与字幕判定（假设 QA-A2、QA-A3） ----------
const CJK = /[\u3400-\u9fff]/g;
const RUN_RE = /(翻译中|正在翻译|正在识别|正在聆听|聆听中|识别中|正在收听|收听中)/;
const IDLE_RE = /(未开始|已停止|已结束|就绪|空闲|已暂停|未启动)/;
const UI_RE = /^(状态[:：]?\s*)?(未开始|已停止|已结束|就绪|空闲|翻译中|正在|聆听中|识别中|连接中|已连接|准备|等待)/;
const UI_WORDS = /(开始|停止|麦克风|权限|提示|状态|点击|允许|浏览器|说话|字幕|翻译|连接)/;
const LANG_CTRL_RE = /(语言|語言|language|英语|英文|日语|日文|韩语|法语|德语|English|Japanese|Korean|French|German)/i;
const cjkCount = (s) => (s.match(CJK) || []).length;
const lines = (t) => String(t || '').split('\n').map((s) => s.trim()).filter(Boolean);
function isUiLine(l) {
  if (cjkCount(l) < 2) return true;
  if (UI_RE.test(l) && l.length <= 24) return true;
  if (UI_WORDS.test(l) && l.length <= 14) return true;
  return false;
}
function statusOf(text) {
  const ls = lines(text).filter((l) => l.length <= 40);
  const run = ls.some((l) => RUN_RE.test(l)), idle = ls.some((l) => IDLE_RE.test(l));
  if (run && !idle) return 'running';
  if (idle && !run) return 'idle';
  if (run && idle) return 'ambiguous';
  return 'unknown';
}
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const alt = (arr) => new RegExp(arr.map(esc).join('|'));
const countRe = (re, s) => (String(s).match(new RegExp(re.source, 'g')) || []).length;
const SENT = M.sentences;

class Captions {
  // 依据页面快照计算字幕行；uiSet = 开始前已有的行 + 首次取得麦克风后 1 秒内出现的行
  constructor(snaps, baselineT, gumOkT) {
    this.snaps = snaps;
    this.ui = new Set();
    const at = (t) => { let s = null; for (const x of snaps) { if (x.t <= t) s = x; else break; } return s; };
    const b = at(baselineT); if (b) lines(b.text).forEach((l) => this.ui.add(l));
    if (gumOkT) { const g = at(gumOkT + 1000); if (g) lines(g.text).forEach((l) => this.ui.add(l)); }
    this.timeline = [];
    let prev = null;
    for (const s of snaps) {
      const caps = this.capsOf(s.text);
      const key = caps.join('\n');
      if (key !== prev) { this.timeline.push({ t: s.t, caps }); prev = key; }
    }
  }
  capsOf(text) { return lines(text).filter((l) => !this.ui.has(l) && !isUiLine(l)); }
  at(t) { let s = { t: 0, caps: [] }; for (const x of this.timeline) { if (x.t <= t) s = x; else break; } return s; }
  firstWith(pred, from = 0) { return this.timeline.find((x) => x.t >= from && pred(x.caps.join('\n'))) || null; }
  changesBetween(a, b) { return this.timeline.filter((x) => x.t > a && x.t <= b); }
}

// 把定稿字幕按唯一锚点归属到句子
function attribute(capLines) {
  const text = capLines.join('\n');
  const clauses = text.split(/(?<=[。！？!?\n])/).map((s) => s.trim()).filter(Boolean);
  const seg = SENT.map(() => []);
  let cur = -1;
  for (const c of clauses) {
    const hits = SENT.map((s, i) => (alt(s.anchor).test(c) ? i : -1)).filter((i) => i >= 0);
    if (hits.length) { cur = hits[hits.length - 1]; hits.forEach((i) => seg[i].push(c)); } else if (cur >= 0) seg[cur].push(c);
  }
  return seg.map((x) => x.join(''));
}
const norm = (s) => String(s).replace(/\s+/g, '');

// ---------- 浏览器会话 ----------
async function launch(wavName) {
  const wav = M.files[wavName].path;
  return chromium.launch({
    channel: 'chromium', headless: true,
    args: ['--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${wav}%noloop`,
      '--autoplay-policy=no-user-gesture-required'],
  });
}

class Session {
  constructor(run) { this.run = run; this.ws = []; this.reqs = []; this.console = []; this.pages = []; }
  async open(browser, { grant = true } = {}) {
    this.browser = browser;
    const vdir = path.join(WORK, 'video', this.run);
    this.ctx = await browser.newContext({ recordVideo: { dir: vdir, size: { width: 1280, height: 800 } }, viewport: { width: 1280, height: 800 }, locale: 'zh-CN' });
    if (grant) await this.ctx.grantPermissions(['microphone'], { origin: APP_ORIGIN });
    await this.ctx.addInitScript(INIT);
    this.ctx.on('request', (r) => this.onRequest(r));
    this.ctx.on('response', (r) => this.onResponse(r));
    return this.newPage();
  }
  async newPage() {
    const p = await this.ctx.newPage();
    const idx = this.pages.length; this.pages.push(p);
    p.on('console', (m) => this.console.push(`[p${idx} ${new Date().toISOString()} ${m.type()}] ${m.text().slice(0, 500)}`));
    p.on('pageerror', (e) => this.console.push(`[p${idx} pageerror] ${String(e).slice(0, 500)}`));
    p.on('websocket', (ws) => this.onWs(ws, idx));
    return p;
  }
  onRequest(r) {
    const rec = { run: this.run, t: now(), url: r.url(), method: r.method() };
    this.reqs.push(rec);
    r.allHeaders().then((h) => raw({ type: 'request', run: this.run, t: rec.t, url: rec.url, method: rec.method, headers: h, post: (r.postData() || '').slice(0, 200000) })).catch(() => {});
  }
  onResponse(r) {
    const rec = this.reqs.find((x) => x.url === r.url() && x.status === undefined);
    if (rec) rec.status = r.status();
    const ct = (r.headers()['content-type'] || '').toLowerCase();
    const textual = /(html|javascript|json|css|text\/plain|xml|ecmascript)/.test(ct) && !/event-stream/.test(ct);
    (async () => {
      const h = await r.allHeaders().catch(() => ({}));
      let body = '';
      if (textual) body = await Promise.race([r.text().catch(() => ''), sleep(10000).then(() => '')]);
      raw({ type: 'response', run: this.run, t: now(), url: r.url(), status: r.status(), headers: h, ct, body: String(body).slice(0, 5000000) });
    })().catch(() => {});
  }
  onWs(ws, idx) {
    const w = { page: idx, url: ws.url(), opened: now(), sent: [], recv: [], closed: null };
    this.ws.push(w);
    raw({ type: 'ws-open', run: this.run, t: w.opened, url: w.url });
    const frame = (dir) => (f) => {
      const p = f.payload; const isBuf = typeof p !== 'string';
      const size = isBuf ? p.length : Buffer.byteLength(p);
      (dir === 'sent' ? w.sent : w.recv).push({ t: now(), size });
      const text = isBuf ? Buffer.from(p).subarray(0, 4096).toString('latin1') : p.slice(0, 65536);
      raw({ type: 'ws-' + dir, run: this.run, t: now(), url: w.url, binary: isBuf, size, text });
    };
    ws.on('framesent', frame('sent'));
    ws.on('framereceived', frame('recv'));
    ws.on('close', () => { w.closed = now(); });
  }
  async qa(page) {
    return page.evaluate(() => { window.__qa.snap(); return { gum: window.__qa.gum, tracks: window.__qa.trackStates(), snaps: window.__qa.snaps, hookError: window.__qa.hookError || null }; });
  }
  async dumpPage(page, tag) {
    try {
      raw({ type: 'dom', run: this.run, tag, t: now(), html: await page.content() });
      const st = await page.evaluate(() => ({ local: JSON.stringify(localStorage), session: JSON.stringify(sessionStorage), cookie: document.cookie }));
      raw({ type: 'storage', run: this.run, tag, t: now(), ...st });
      raw({ type: 'cookies', run: this.run, tag, t: now(), cookies: await this.ctx.cookies() });
    } catch (e) { /* 页面已关闭 */ }
  }
  async shot(page, name) { try { await page.screenshot({ path: path.join(EVD, name), fullPage: true }); return name; } catch (e) { return null; } }
  networkSummary() {
    const strip = (u) => { try { const x = new URL(u); return x.protocol + '//' + x.host + x.pathname; } catch (e) { return '?'; } };
    return {
      requests: this.reqs.map((r) => ({ t: r.t, method: r.method, url: strip(r.url), status: r.status })),
      websockets: this.ws.map((w) => ({ page: w.page, url: strip(w.url), opened: w.opened, closed: w.closed,
        sentFrames: w.sent.length, sentBytes: w.sent.reduce((a, b) => a + b.size, 0),
        recvFrames: w.recv.length, recvBytes: w.recv.reduce((a, b) => a + b.size, 0) })),
    };
  }
  async close() {
    const videos = [];
    for (const p of this.pages) { try { const v = p.video(); await p.close(); if (v) videos.push(await v.path()); } catch (e) { /* ignore */ } }
    try { await this.ctx.close(); } catch (e) { /* ignore */ }
    try { await this.browser.close(); } catch (e) { /* ignore */ }
    const names = [];
    videos.forEach((v, i) => { try { const n = `${this.run}${videos.length > 1 ? '-p' + i : ''}.webm`; fs.copyFileSync(v, path.join(EVD, n)); names.push(n); } catch (e) { /* ignore */ } });
    writeEvd(`${this.run}-console.log`, this.console.join('\n'));
    writeEvd(`${this.run}-network.json`, this.networkSummary());
    return names;
  }
}

async function findButton(page, re) {
  for (const loc of [page.getByRole('button', { name: re }), page.locator('input[type=button],input[type=submit],[role=button],button').filter({ hasText: re })]) {
    const n = await loc.count().catch(() => 0);
    for (let i = 0; i < n; i++) {
      const b = loc.nth(i);
      if (await b.isVisible().catch(() => false) && await b.isEnabled().catch(() => false)) return b;
    }
  }
  return null;
}
const START_RE = /开始/, STOP_RE = /停止|结束/;
async function clickStart(page) { const b = await findButton(page, START_RE); if (!b) return false; await b.click(); return true; }
async function clickStop(page) { const b = await findButton(page, STOP_RE); if (!b) return false; await b.click(); return true; }
async function waitFor(fn, ms, step = 250) { const end = now() + ms; while (now() < end) { const v = await fn(); if (v) return v; await sleep(step); } return null; }
async function bodyText(page) { return page.evaluate(() => document.body ? document.body.innerText : '').catch(() => ''); }
async function gumOk(s, page) { const q = await s.qa(page); return q.gum.find((g) => g.ok) || null; }

async function uiFacts(page) {
  return page.evaluate((src) => {
    const re = new RegExp(src, 'i');
    const vis = (e) => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
    const pick = (sel) => [...document.querySelectorAll(sel)].filter(vis);
    const label = (e) => (e.innerText || e.value || e.getAttribute('aria-label') || e.getAttribute('title') || '').trim();
    return {
      selects: pick('select,[role=combobox],[role=listbox],input[type=radio],[role=radio],[role=radiogroup],datalist').map((e) => e.outerHTML.slice(0, 160)),
      langControls: pick('button,a,label,option,[role=button],[role=menuitem],[role=option],[role=tab],[role=switch],input').map(label).filter((t) => re.test(t)).slice(0, 20),
      buttons: pick('button,[role=button],input[type=button],input[type=submit]').map(label).slice(0, 30),
      actionLinks: pick('button,a,[role=button],[role=menuitem]').map(label).filter((t) => /(历史|導出|导出|下载|录音|录制|保存|记录|export|download|history|record)/i.test(t)).slice(0, 20),
      installLinks: pick('button,a,[role=button]').map(label).filter((t) => /(安装|下载客户端|扩展程序|插件|install|extension|download)/i.test(t)).slice(0, 20),
      passwordInputs: pick('input[type=password]').length,
      lang: document.documentElement.lang || '',
    };
  }, LANG_CTRL_RE.source);
}

// ---------- 结果记录 ----------
const RESULTS = { scenarios: {}, runs: {}, gaps: [] };
function scenario(id) {
  if (!RESULTS.scenarios[id]) RESULTS.scenarios[id] = { id, checkpoints: [], evidence: [] };
  return RESULTS.scenarios[id];
}
// status: pass | fail（产品缺陷） | gap（测试缺口）
function cp(id, step, status, observation) { scenario(id).checkpoints.push({ step, status, observation: redact(observation) }); }
function ev(id, ...names) { names.flat().filter(Boolean).forEach((n) => scenario(id).evidence.push(n)); }

function timelineEvidence(name, caps, t0, extra = {}) {
  return writeEvd(name, { t0, note: '时刻为页面时钟毫秒；rel 为相对 t0（getUserMedia 成功返回）的毫秒', ...extra,
    timeline: caps.timeline.map((x) => ({ t: x.t, rel: t0 ? x.t - t0 : null, caps: x.caps })) });
}

// ======================= 主运行：IQA-001～005（并为 007～009 采集） =======================
async function runMain() {
  const F = M.files.main;
  const s = new Session('iqa-main');
  const browser = await launch('main');
  RESULTS.browserVersion = browser.version();
  const page = await s.open(browser);
  const shots = [];
  const resp = await page.goto(APP, { waitUntil: 'load', timeout: 45000 });
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
  await sleep(1500);
  const tBase = now();
  shots.push(await s.shot(page, 'iqa-main-1-loaded.png'));
  const ui0 = await uiFacts(page);
  const text0 = await bodyText(page);
  const st0 = statusOf(text0);
  writeEvd('browser-info.json', { browser: 'Chromium (Playwright channel=chromium, 无头新模式)', version: browser.version(), extensions: [], profile: '全新临时配置', url: page.url(), httpStatus: resp && resp.status(), htmlLang: ui0.lang, buttons: ui0.buttons });

  // IQA-001 检查点 1：无安装/插件/登录要求
  const host = new URL(APP).host, finalHost = new URL(page.url()).host;
  const loginText = /(登录|登入|sign in|log in)/i.test(text0);
  if (finalHost !== host || ui0.passwordInputs > 0 || loginText || ui0.installLinks.length)
    cp('IQA-001', '无安装、无插件、无登录', 'fail', `最终地址主机=${finalHost}（期望 ${host}），密码框=${ui0.passwordInputs}，登录文字=${loginText}，安装/下载入口=${JSON.stringify(ui0.installLinks)}`);
  else cp('IQA-001', '无安装、无插件、无登录', 'pass', `干净 Chromium ${browser.version()} 直接打开即显示应用页面，无跳转、无密码框、无安装/下载入口`);

  const startBtn = await findButton(page, START_RE);
  const btnNames = ui0.buttons.join(' | ');
  const latinWords = (text0.match(/[A-Za-z]{2,}/g) || []).length;
  if (startBtn && cjkCount(btnNames) > 0 && cjkCount(text0) > latinWords)
    cp('IQA-001', '界面为中文', 'pass', `按钮：${btnNames}；页面汉字 ${cjkCount(text0)} 个，英文单词 ${latinWords} 个`);
  else if (!startBtn)
    cp('IQA-001', '界面为中文', 'gap', `未找到可访问名称含“开始”的按钮（依赖假设 QA-A1），按钮：${btnNames}`);
  else cp('IQA-001', '界面为中文', 'fail', `按钮：${btnNames}；页面汉字 ${cjkCount(text0)} 个，英文单词 ${latinWords} 个`);

  const langCheck = (u, when) => (u.selects.length || u.langControls.length) ? `${when}：选择控件 ${JSON.stringify(u.selects)}，语言相关控件 ${JSON.stringify(u.langControls)}` : '';
  const langIssues = [langCheck(ui0, '开始前')];

  if (!startBtn) {
    RESULTS.gaps.push('主运行：页面上找不到“开始”按钮，无法驱动翻译（依赖假设 QA-A1）');
    for (const id of ['IQA-001', 'IQA-002', 'IQA-003', 'IQA-004', 'IQA-005']) cp(id, '驱动翻译', 'gap', '找不到可访问名称含“开始”的按钮（依赖假设 QA-A1）');
    ev('IQA-001', shots, await s.close());
    return null;
  }
  const tClick = now();
  await startBtn.click();
  const g = await waitFor(() => gumOk(s, page), 20000);
  if (!g) {
    const q = await s.qa(page);
    shots.push(await s.shot(page, 'iqa-main-2-nomic.png'));
    const obs = `点击“开始”后 20 秒内页面未成功取得麦克风；getUserMedia 调用记录：${JSON.stringify(q.gum)}`;
    for (const id of ['IQA-001', 'IQA-002', 'IQA-003', 'IQA-004', 'IQA-005']) cp(id, '开始后采集麦克风', 'fail', obs);
    ev('IQA-001', shots, await s.close());
    return null;
  }
  const t0 = g.ok;
  RESULTS.runs.main = { t0, tClick, audioEnd: t0 + F.speech_end_ms };
  const stRun = await waitFor(async () => (statusOf(await bodyText(page)) === 'running' ? 'running' : null), 10000);
  await page.waitForTimeout(Math.max(0, t0 + 14000 - now()));
  shots.push(await s.shot(page, 'iqa-main-2-translating.png'));
  const ui1 = await uiFacts(page);
  langIssues.push(langCheck(ui1, '翻译中'));
  // 等素材播完 + 静音 ≥ 15 秒（实际 18 秒）
  const tFinal = t0 + F.speech_end_ms + 18000;
  while (now() < tFinal) await sleep(500);
  shots.push(await s.shot(page, 'iqa-main-3-final.png'));
  await s.dumpPage(page, 'translating');
  const tStop = now();
  const stopped = await clickStop(page);
  await sleep(3000);
  const text2 = await bodyText(page);
  const st2 = statusOf(text2);
  const ui2 = await uiFacts(page);
  langIssues.push(langCheck(ui2, '停止后'));
  shots.push(await s.shot(page, 'iqa-main-4-stopped.png'));
  await sleep(3000);
  await s.dumpPage(page, 'stopped');
  const q = await s.qa(page);
  const caps = new Captions(q.snaps, tBase, t0);
  RESULTS.runs.main.tStop = tStop;
  const videos = await s.close();
  const tl = timelineEvidence('iqa-main-timeline.json', caps, t0, { sentences: F.sentences, tClick, tStop, gum: q.gum, tracksAfterStop: q.tracks });
  const finalCaps = caps.at(tStop).caps;
  RESULTS.runs.main.finalCaps = finalCaps;
  RESULTS.runs.main.allCapLines = [...new Set(caps.timeline.flatMap((x) => x.caps))];
  RESULTS.runs.main.ws = s.ws.map((w) => ({ url: w.url, sent: w.sent.length, recv: w.recv.length }));
  const common = [tl, ...shots, ...videos, 'iqa-main-network.json', 'iqa-main-console.log'];

  // ---------- IQA-001 ----------
  const li = langIssues.filter(Boolean);
  cp('IQA-001', '无语言选择控件', li.length ? 'fail' : 'pass', li.length ? li.join('；') : '开始前、翻译中、停止后页面均无选择控件或语言相关控件');
  const stObs = `开始前=${st0}，开始后=${stRun || '未识别到翻译中'}，停止后=${st2}（依赖假设 QA-A2）`;
  if (!stopped) cp('IQA-001', '状态切换', 'gap', '找不到可访问名称含“停止/结束”的按钮（依赖假设 QA-A1）；' + stObs);
  else if (st0 === 'unknown' || st2 === 'unknown' || !stRun) {
    const bad = (st0 === 'running') || (st2 === 'running');
    cp('IQA-001', '状态切换', bad ? 'fail' : 'gap', '未能从页面文字识别全部状态；' + stObs);
  } else cp('IQA-001', '状态切换', (st0 === 'idle' && stRun === 'running' && st2 === 'idle') ? 'pass' : 'fail', stObs);
  const firstCap = caps.firstWith((t) => t.length > 0, t0);
  cp('IQA-001', '出现中文字幕', firstCap ? 'pass' : 'fail', firstCap ? `开始后 ${((firstCap.t - t0) / 1000).toFixed(1)} 秒出现首条字幕：${firstCap.caps.join(' / ').slice(0, 80)}` : '整个主运行中未识别到任何中文字幕行（依赖假设 QA-A3）');
  ev('IQA-001', common, 'browser-info.json');

  // ---------- IQA-002 ----------
  const s1 = F.sentences[0];
  const s1End = t0 + s1.end_ms;
  const pre = caps.timeline.filter((x) => x.t < s1End && x.caps.length);
  const t2 = writeEvd('iqa-002-timing.json', { s1StartRel: s1.start_ms, s1EndRel: s1.end_ms, changesBeforeEndRel: pre.map((x) => ({ rel: x.t - t0, caps: x.caps })), firstCaptionRel: firstCap ? firstCap.t - t0 : null });
  if (!firstCap) {
    cp('IQA-002', '首条字幕早于句末', 'fail', '未出现任何字幕');
  } else {
    cp('IQA-002', '首条字幕早于句末', firstCap.t < s1End ? 'pass' : 'fail', `S1 语音 ${(s1.start_ms / 1000).toFixed(1)}–${(s1.end_ms / 1000).toFixed(1)} 秒；首条字幕出现于 ${((firstCap.t - t0) / 1000).toFixed(1)} 秒`);
    const distinct = new Set(pre.map((x) => x.caps.join('\n'))).size;
    cp('IQA-002', '句中持续更新', distinct >= 2 ? 'pass' : 'fail', `S1 结束前字幕出现 ${distinct} 个不同状态（要求 ≥ 2）`);
  }
  const s1Re = alt(SENT[0].anchor), s3Re = alt(SENT[2].anchor);
  const finalSeg = attribute(finalCaps);
  const s3First = caps.firstWith((t) => s3Re.test(t), t0);
  const s1AtS3 = s3First ? attribute(s3First.caps)[0] : null;
  const s1Ok = s1Re.test(finalCaps.join('\n'));
  if (!s1Ok) cp('IQA-002', '句末定稿', 'fail', '最终字幕中没有 S1 的锚点（第三季度）');
  else if (!s3First) cp('IQA-002', '句末定稿', 'gap', 'S1 已有定稿字幕，但 S3 字幕未出现，无法判断定稿后是否不再改变');
  else cp('IQA-002', '句末定稿', norm(s1AtS3) === norm(finalSeg[0]) ? 'pass' : 'fail', `S3 字幕出现时的 S1 字幕=“${s1AtS3}”；最终=“${finalSeg[0]}”`);
  cp('IQA-002', '非整句后一次性出现', (firstCap && firstCap.t < s1End) ? 'pass' : 'fail', firstCap ? `S1 结束前已有 ${pre.length} 次字幕变化` : '无字幕');
  ev('IQA-002', t2, common);

  // ---------- IQA-003 ----------
  cp('IQA-003', '全过程无语言选择', li.length ? 'fail' : 'pass', li.length ? li.join('；') : '开始前、翻译中、停止后均无语言选择');
  cp('IQA-003', '无需额外操作', 'pass', '测试只点击了“开始”和“停止”，未做任何设置');
  const all = finalCaps.join('\n');
  const missing = SENT.filter((x) => !alt(x.anchor).test(all)).map((x) => x.id);
  cp('IQA-003', '每句产生中文字幕', missing.length ? 'fail' : 'pass', missing.length ? `以下句子没有对应字幕：${missing.join('、')}` : 'S1～S6 均有对应中文字幕');
  ev('IQA-003', common);

  // ---------- IQA-004 ----------
  const cmp = SENT.map((x, i) => {
    const seg = finalSeg[i];
    const hit = x.keys.map((k) => ({ key: k.join('/'), ok: alt(k).test(seg) }));
    const nonSpace = seg.replace(/[\s，。！？、,.!?：:；;“”"'%％0-9]/g, '');
    const latin = (nonSpace.replace(/Michael|Q3/gi, '').match(/[A-Za-z]/g) || []).length;
    const ratio = nonSpace.length ? cjkCount(nonSpace) / (cjkCount(nonSpace) + latin) : 0;
    return { id: x.id, ref: x.ref, caption: seg, cjkRatio: Number(ratio.toFixed(2)), keys: hit, meaningOk: seg.length > 0 && hit.every((h) => h.ok) };
  });
  const bodyEnglish = [];
  for (const x of SENT) {
    const w = x.text.replace(/[^A-Za-z' ]/g, ' ').split(/\s+/).filter(Boolean);
    for (let i = 0; i + 4 <= w.length; i++) {
      const re = new RegExp(w.slice(i, i + 4).map(esc).join('\\s+'), 'i');
      if (q.snaps.some((sn) => re.test(sn.text))) { bodyEnglish.push(`${x.id}: ${w.slice(i, i + 4).join(' ')}`); break; }
    }
  }
  const c4 = writeEvd('iqa-004-comparison.json', { method: '关键要素全部命中判定含义一致（依赖假设 QA-A6）', finalCaptions: finalCaps, perSentence: cmp, englishOriginalSeen: bodyEnglish });
  const nonCn = cmp.filter((c) => c.caption && c.cjkRatio < 0.7).map((c) => `${c.id}(${c.cjkRatio})`);
  const empty = cmp.filter((c) => !c.caption).map((c) => c.id);
  cp('IQA-004', '每句定稿字幕为中文', (nonCn.length || empty.length) ? 'fail' : 'pass', (nonCn.length || empty.length) ? `非中文：${nonCn.join('、') || '无'}；无字幕：${empty.join('、') || '无'}` : '6 句定稿字幕汉字占比均 ≥ 70%');
  cp('IQA-004', '不显示英语原文', bodyEnglish.length ? 'fail' : 'pass', bodyEnglish.length ? `页面出现英语原文片段：${bodyEnglish.join('；')}` : '整个过程页面未出现任何素材原文的连续 4 个英语单词');
  const bad = cmp.filter((c) => !c.meaningOk).map((c) => `${c.id} 缺少 ${c.keys.filter((k) => !k.ok).map((k) => k.key).join('，') || '字幕'}（字幕：“${c.caption}”）`);
  cp('IQA-004', '逐句含义一致', bad.length ? 'fail' : 'pass', bad.length ? bad.join('；') : '6 句定稿字幕的关键要素（主语/对象、数字、时间、否定）全部与参考译文一致');
  ev('IQA-004', c4, common);

  // ---------- IQA-005 ----------
  const counts = SENT.map((x) => countRe(alt(x.anchor), all));
  const firstPos = SENT.map((x) => { const m = alt(x.anchor).exec(all); return m ? m.index : -1; });
  const ordered = firstPos.every((p, i) => p >= 0 && (i === 0 || p > firstPos[i - 1]));
  const stable = [];
  for (let i = 0; i + 2 < SENT.length; i++) {
    const later = caps.firstWith((t) => alt(SENT[i + 2].anchor).test(t), t0);
    if (later) { const segThen = attribute(later.caps)[i]; stable.push({ id: SENT[i].id, ok: norm(segThen) === norm(finalSeg[i]), then: segThen, final: finalSeg[i] }); }
  }
  const quiet = caps.changesBetween(t0 + F.speech_end_ms + 6000, tStop);
  const al = writeEvd('iqa-005-alignment.json', { finalCaptionLines: finalCaps, anchorCounts: SENT.map((x, i) => ({ id: x.id, anchor: x.anchor.join('/'), count: counts[i], firstPos: firstPos[i] })), stability: stable, silenceWindowRel: [F.speech_end_ms + 6000, tStop - t0], changesInSilence: quiet.map((x) => ({ rel: x.t - t0, caps: x.caps })) });
  const miss = SENT.filter((x, i) => counts[i] === 0).map((x) => x.id);
  cp('IQA-005', '不遗漏', miss.length ? 'fail' : 'pass', miss.length ? `缺少：${miss.join('、')}` : '6 句均有定稿字幕');
  const dup = SENT.map((x, i) => (counts[i] > 1 ? `${x.id}×${counts[i]}` : null)).filter(Boolean);
  cp('IQA-005', '不重复', dup.length ? 'fail' : 'pass', dup.length ? `重复：${dup.join('、')}` : '每句锚点恰好出现 1 次');
  cp('IQA-005', '顺序', ordered ? 'pass' : 'fail', `锚点首次位置：${firstPos.join(', ')}`);
  if (finalCaps.length > 1) cp('IQA-005', '条数', finalCaps.length === SENT.length ? 'pass' : 'fail', `定稿字幕行 ${finalCaps.length} 条，素材 ${SENT.length} 句：${finalCaps.map((l) => l.slice(0, 20)).join(' | ')}`);
  else cp('IQA-005', '条数', miss.length || dup.length ? 'fail' : 'pass', `字幕在同一行内连续排版（${finalCaps.length} 行），按锚点计数判定（依赖假设 QA-A3）`);
  const unstable = stable.filter((x) => !x.ok);
  if (!stable.length) cp('IQA-005', '定稿不变', 'gap', '后续句子字幕未出现，无法判断');
  else cp('IQA-005', '定稿不变', unstable.length ? 'fail' : 'pass', unstable.length ? unstable.map((x) => `${x.id}：此前“${x.then}”→最终“${x.final}”`).join('；') : `S1～S${stable.length} 的定稿字幕在其后第 2 句出现后未再改变`);
  cp('IQA-005', '静音无新字幕', quiet.length ? 'fail' : 'pass', quiet.length ? `素材结束 6 秒后的静音段内字幕变化 ${quiet.length} 次` : `素材结束后 ${((tStop - t0 - F.speech_end_ms) / 1000 - 6).toFixed(0)} 秒静音段内字幕无变化`);
  ev('IQA-005', al, common);
  return true;
}

// 开始翻译并等待取得麦克风；返回 { t0 } 或 null
async function startAndWait(s, page, id, label) {
  const before = (await s.qa(page)).gum.length;
  if (!(await clickStart(page))) { cp(id, label, 'gap', '找不到可访问名称含“开始”的按钮（依赖假设 QA-A1）'); return null; }
  const g = await waitFor(async () => { const q = await s.qa(page); return q.gum.slice(before).find((x) => x.ok) || null; }, 20000);
  if (!g) { const q = await s.qa(page); cp(id, label, 'fail', `点击“开始”后 20 秒内未成功取得麦克风：${JSON.stringify(q.gum.slice(before))}`); return null; }
  return { t0: g.ok };
}

// ======================= 停止运行：IQA-006 =======================
async function runStop() {
  const id = 'IQA-006';
  const F = M.files.stop;
  const s = new Session('iqa-006');
  const page = await s.open(await launch('stop'));
  const shots = [];
  await page.goto(APP, { waitUntil: 'load', timeout: 45000 });
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
  await sleep(1500);
  const tBase = now();
  const r = await startAndWait(s, page, id, '开始翻译');
  if (!r) { ev(id, await s.close()); return; }
  const t0 = r.t0;
  const s2 = F.sentences[1];
  const tMid = t0 + Math.round((s2.start_ms + s2.end_ms) / 2);
  while (now() < tMid) await sleep(100);
  shots.push(await s.shot(page, 'iqa-006-1-before-stop.png'));
  const tStop = now();
  const stopped = await clickStop(page);
  if (!stopped) { cp(id, '停止', 'gap', '找不到可访问名称含“停止/结束”的按钮（依赖假设 QA-A1）'); ev(id, shots, await s.close()); return; }
  const ended = await waitFor(async () => { const q = await s.qa(page); return q.tracks.length && q.tracks.every((t) => t.readyState === 'ended') ? q.tracks : null; }, 2000, 100);
  const tEnded = now();
  const st = statusOf(await bodyText(page));
  const st2s = await waitFor(async () => (statusOf(await bodyText(page)) === 'idle' ? 'idle' : null), Math.max(0, tStop + 2000 - now()), 100) || statusOf(await bodyText(page));
  shots.push(await s.shot(page, 'iqa-006-2-stopped.png'));
  const tWaitEnd = tStop + 32000;
  while (now() < tWaitEnd) await sleep(500);
  shots.push(await s.shot(page, 'iqa-006-3-after-32s.png'));
  const qMid = await s.qa(page);
  const capsMid = new Captions(qMid.snaps, tBase, t0);
  const tRestart = now();
  // 再次开始
  const r2 = await startAndWait(s, page, id, '再次开始');
  let restart = null;
  if (r2) {
    const stRun = await waitFor(async () => (statusOf(await bodyText(page)) === 'running' ? 'running' : null), 10000);
    const oldCaps = capsMid.at(tWaitEnd).caps;
    const oldJoined = norm(oldCaps.join('\n'));
    const s1Re = alt(SENT[0].anchor);
    const found = await waitFor(async () => {
      const q = await s.qa(page);
      const c = new Captions(q.snaps, tBase, t0);
      const cur = c.at(now()).caps;
      const joined = norm(cur.join('\n'));
      const tail = joined.startsWith(oldJoined) ? joined.slice(oldJoined.length) : null;
      if (tail !== null && s1Re.test(tail)) return { cur, ok: true };
      if (tail === null && s1Re.test(joined.replace(oldJoined, ''))) return { cur, ok: false, why: '原有字幕被修改、清除或新字幕未位于其后' };
      return null;
    }, 40000, 500);
    restart = { stRun, found };
    shots.push(await s.shot(page, 'iqa-006-4-restarted.png'));
    await clickStop(page);
    await sleep(1500);
  }
  const q = await s.qa(page);
  await s.dumpPage(page, 'final');
  const caps = new Captions(q.snaps, tBase, t0);
  // 停止后实时连接发送帧
  const big = [];
  s.ws.forEach((w) => w.sent.forEach((f) => { if (f.t > tStop + 2000 && f.t < tRestart && f.size > 1024) big.push({ url: w.url.split('?')[0], t: f.t - tStop, size: f.size }); }));
  const gumAfter = q.gum.filter((g) => g.t > tStop && g.t < tRestart);
  const videos = await s.close();
  const tl = timelineEvidence('iqa-006-timeline.json', caps, t0, { sentences: F.sentences, tStopRel: tStop - t0, tRestartRel: tRestart - t0, tracksEndedRel: ended ? tEnded - t0 : null, gum: q.gum,
    sentFramesAfterStop: s.ws.map((w) => ({ url: w.url.split('?')[0], frames: w.sent.filter((f) => f.t > tStop + 2000 && f.t < tRestart).map((f) => ({ rel: f.t - tStop, size: f.size })) })) });
  const preStop = caps.at(tStop).caps;
  cp(id, '停止前已有字幕', preStop.length ? 'pass' : 'fail', preStop.length ? `停止时字幕：${preStop.join(' / ').slice(0, 120)}` : '停止前（S2 播放到一半时）页面没有任何字幕');
  const stOk = st2s === 'idle';
  cp(id, '停止后麦克风释放与状态', ended && stOk ? 'pass' : (ended && (st2s === 'unknown' || st2s === 'ambiguous') ? 'gap' : 'fail'),
    `停止后 2 秒内轨道状态：${ended ? '全部 ended（' + (tEnded - tStop) + ' 毫秒）' : JSON.stringify(q.tracks)}；状态=${st2s}（依赖假设 QA-A2、QA-A4）`);
  cp(id, '停止后不再发送音频', big.length || gumAfter.length ? 'fail' : 'pass', big.length || gumAfter.length ? `停止 2 秒后发送了 ${big.length} 个 >1KB 的帧，新的 getUserMedia 调用 ${gumAfter.length} 次` : `停止 2 秒后至再次开始前（${((tRestart - tStop) / 1000).toFixed(0)} 秒），无 >1KB 发送帧、无新的 getUserMedia 调用；期间虚拟麦克风仍在送入英语语音`);
  const chg = caps.changesBetween(tStop + 1000, Math.min(tStop + 32000, tRestart));
  cp(id, '停止后不再出字幕（含未定稿句）', chg.length ? 'fail' : 'pass', chg.length ? `停止后 1～32 秒内字幕变化 ${chg.length} 次：${chg.map((x) => `+${((x.t - tStop) / 1000).toFixed(1)}s ${x.caps.join(' / ').slice(-60)}`).join('；')}` : '停止后 1～32 秒字幕区域无任何新增或修改');
  const s1Seg = attribute(preStop)[0];
  const after = norm(caps.at(Math.min(tStop + 32000, tRestart)).caps.join('\n'));
  cp(id, '停止前字幕保留', !s1Seg ? 'fail' : (after.includes(norm(s1Seg)) ? 'pass' : 'fail'), s1Seg ? `S1 定稿字幕“${s1Seg}”${after.includes(norm(s1Seg)) ? '停止后仍在' : '停止后不在页面上'}` : '停止前没有含 S1 锚点的定稿字幕');
  if (!r2) { /* startAndWait 已记录 */ } else if (!restart.found) cp(id, '再次开始', 'fail', `再次开始后 40 秒内未出现位于原有字幕之后的新 S1 字幕；状态=${restart.stRun || '未识别到翻译中'}`);
  else cp(id, '再次开始', restart.found.ok && restart.stRun === 'running' ? 'pass' : (restart.found.ok ? 'gap' : 'fail'), `状态=${restart.stRun || '未识别到翻译中（依赖假设 QA-A2）'}；${restart.found.ok ? '原有字幕保持不变，新 S1 字幕位于其后' : restart.found.why}`);
  ev(id, tl, shots, videos, 'iqa-006-network.json', 'iqa-006-console.log');
}

// ======================= 拒绝权限运行：IQA-010 =======================
async function runDeny() {
  const id = 'IQA-010';
  const s = new Session('iqa-010');
  const page = await s.open(await launch('short'), { grant: false });
  const shots = [];
  await page.goto(APP, { waitUntil: 'load', timeout: 45000 });
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
  await sleep(1500);
  const tBase = now();
  const baseLines = new Set(lines(await bodyText(page)));
  if (!(await clickStart(page))) { cp(id, '拒绝时提示', 'gap', '找不到可访问名称含“开始”的按钮（依赖假设 QA-A1）'); ev(id, await s.close()); return; }
  await sleep(5000);
  shots.push(await s.shot(page, 'iqa-010-1-denied.png'));
  const text = await bodyText(page);
  const q1 = await s.qa(page);
  const newLines = lines(text).filter((l) => !baseLines.has(l));
  const msg = newLines.filter((l) => /麦克风/.test(l) && /(权限|拒绝|允许|无法|不可用)/.test(l));
  const msgAny = lines(text).filter((l) => /麦克风/.test(l) && /(权限|拒绝|允许|无法|不可用)/.test(l));
  const st = statusOf(text);
  const capLike = newLines.filter((l) => !/(麦克风|权限)/.test(l) && !isUiLine(l));
  const gumErr = q1.gum.map((g) => g.err || (g.ok ? 'ok' : 'pending'));
  const okMsg = msg.length || msgAny.length;
  cp(id, '拒绝时提示', okMsg && st !== 'running' && !capLike.length ? 'pass' : 'fail',
    `getUserMedia 结果：${JSON.stringify(gumErr)}；麦克风提示：${JSON.stringify(msg.length ? msg : msgAny)}；状态=${st}；疑似字幕行：${JSON.stringify(capLike)}`);
  const azureRe = /(azure\.com|microsoft\.com|windows\.net|https?:\/\/)/i;
  const leak = (msg.length ? msg : newLines).filter((l) => azureRe.test(l) || redact(l) !== l || SENT.some((x) => l.includes(x.text.split(' ').slice(0, 4).join(' '))));
  cp(id, '提示不含凭据与内部地址', leak.length ? 'fail' : 'pass', leak.length ? `提示含服务地址/凭据/客户内容：${leak.length} 行` : '拒绝后的新增页面文字不含服务地址、凭据或客户内容');
  await s.ctx.grantPermissions(['microphone'], { origin: APP_ORIGIN });
  const r = await startAndWait(s, page, id, '恢复');
  if (r) {
    const stRun = await waitFor(async () => (statusOf(await bodyText(page)) === 'running' ? 'running' : null), 10000);
    const capOk = await waitFor(async () => { const q = await s.qa(page); const c = new Captions(q.snaps, tBase, r.t0); const cur = c.at(now()).caps.filter((l) => !/(麦克风|权限)/.test(l)); return cur.some((l) => alt(SENT[1].anchor).test(l) || alt(SENT[2].anchor).test(l)) ? cur : null; }, 40000, 500);
    shots.push(await s.shot(page, 'iqa-010-2-recovered.png'));
    cp(id, '恢复', capOk && stRun === 'running' ? 'pass' : (capOk ? 'gap' : 'fail'), `授予权限后再次开始：状态=${stRun || '未识别到翻译中（依赖假设 QA-A2）'}；字幕=${capOk ? capOk.join(' / ').slice(0, 100) : '40 秒内未出现'}`);
    await clickStop(page);
    await sleep(1000);
  }
  const q = await s.qa(page);
  const caps = new Captions(q.snaps, tBase, null);
  const videos = await s.close();
  ev(id, timelineEvidence('iqa-010-timeline.json', caps, r ? r.t0 : null, { gum: q.gum }), shots, videos, 'iqa-010-console.log');
}

// ======================= 刷新与多页面运行：IQA-011 =======================
async function runRefresh() {
  const id = 'IQA-011';
  const s = new Session('iqa-011');
  const A = await s.open(await launch('short'));
  const shots = [];
  await A.goto(APP, { waitUntil: 'load', timeout: 45000 });
  await A.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
  await sleep(1500);
  const tBase = now();
  const baseLines = new Set(lines(await bodyText(A)));
  const links = [...(await uiFacts(A)).actionLinks];
  const r = await startAndWait(s, A, id, '页面 A 已有字幕');
  if (!r) { ev(id, await s.close()); return; }
  const capsA = await waitFor(async () => { const q = await s.qa(A); const c = new Captions(q.snaps, tBase, r.t0); const cur = c.at(now()).caps; return cur.some((l) => alt(SENT[1].anchor).test(l)) ? cur : null; }, 40000, 500);
  await sleep(3000);
  const qA = await s.qa(A);
  const finalA = new Captions(qA.snaps, tBase, r.t0).at(now()).caps;
  links.push(...(await uiFacts(A)).actionLinks);
  shots.push(await s.shot(A, 'iqa-011-1-pageA.png'));
  cp(id, '页面 A 已有字幕', capsA ? 'pass' : 'fail', capsA ? `页面 A 字幕：${finalA.join(' / ').slice(0, 100)}` : '页面 A 开始后 40 秒内未出现字幕');
  const B = await s.newPage();
  await B.goto(APP, { waitUntil: 'load', timeout: 45000 });
  await sleep(8000);
  shots.push(await s.shot(B, 'iqa-011-2-pageB.png'));
  const textB = await bodyText(B);
  links.push(...(await uiFacts(B)).actionLinks);
  const inB = finalA.filter((l) => textB.includes(l));
  if (!capsA) cp(id, '页面互不可见', 'gap', '页面 A 无字幕，无法判断');
  else cp(id, '页面互不可见', inB.length ? 'fail' : 'pass', inB.length ? `页面 B 显示了页面 A 的字幕：${inB.join(' / ').slice(0, 100)}` : `页面 B 打开 8 秒，未显示页面 A 的任何 ${finalA.length} 条字幕行`);
  const tReload = now();
  await A.reload({ waitUntil: 'load', timeout: 45000 });
  await sleep(8000);
  shots.push(await s.shot(A, 'iqa-011-3-pageA-reloaded.png'));
  const textA2 = await bodyText(A);
  const qA2 = await s.qa(A);
  const kept = finalA.filter((l) => textA2.includes(l));
  const newCap = lines(textA2).filter((l) => !baseLines.has(l) && !isUiLine(l));
  const stA2 = statusOf(textA2);
  const bad = kept.length || newCap.length || qA2.gum.length || stA2 === 'running';
  cp(id, '刷新后清空', bad ? 'fail' : (stA2 === 'idle' ? 'pass' : 'gap'),
    `刷新后：保留的旧字幕 ${kept.length} 条；新出现的非界面文字 ${JSON.stringify(newCap).slice(0, 120)}；getUserMedia 调用 ${qA2.gum.length} 次；状态=${stA2}（依赖假设 QA-A2）`);
  links.push(...(await uiFacts(A)).actionLinks);
  const ul = [...new Set(links)];
  cp(id, '无历史/导出/下载/录音入口', ul.length ? 'fail' : 'pass', ul.length ? `发现入口：${ul.join('、')}` : '页面 A（开始前、翻译中、刷新后）与页面 B 均无历史、导出、下载、录音、保存入口');
  const caps = new Captions(qA.snaps, tBase, r.t0);
  await s.dumpPage(A, 'reloaded');
  const videos = await s.close();
  ev(id, timelineEvidence('iqa-011-timeline.json', caps, r.t0, { tReloadRel: tReload - r.t0, pageBText: redact(textB).slice(0, 2000), pageAReloadedText: redact(textA2).slice(0, 2000) }), shots, videos, 'iqa-011-console.log');
}

// ======================= 驱动 =======================
const RUNS = [
  { name: 'main', ids: ['IQA-001', 'IQA-002', 'IQA-003', 'IQA-004', 'IQA-005'], need: 150, fn: runMain },
  { name: 'stop', ids: ['IQA-006'], need: 140, fn: runStop },
  { name: 'deny', ids: ['IQA-010'], need: 90, fn: runDeny },
  { name: 'refresh', ids: ['IQA-011'], need: 100, fn: runRefresh },
];
const RESERVE = 100; // 留给服务侧检查与汇总的秒数

(async () => {
  for (const r of RUNS) {
    const left = (DEADLINE - now()) / 1000;
    if (left < r.need + RESERVE) {
      const msg = `剩余时间 ${left.toFixed(0)} 秒不足以执行该浏览器运行（需要约 ${r.need} 秒），未执行`;
      r.ids.forEach((id) => cp(id, '执行', 'gap', msg));
      RESULTS.gaps.push(`${r.name} 运行：${msg}`);
      continue;
    }
    const t = now();
    try {
      await r.fn();
    } catch (e) {
      const msg = `${r.name} 运行异常：${String(e && e.message || e).split('\n')[0].slice(0, 300)}`;
      console.error(redact(msg));
      r.ids.forEach((id) => cp(id, '执行', 'gap', msg));
    }
    RESULTS.runs[r.name] = Object.assign(RESULTS.runs[r.name] || {}, { started: t, ended: now() });
  }
  await new Promise((res) => rawStream.end(res));
  fs.writeFileSync(path.join(WORK, 'browser-results.json'), JSON.stringify(RESULTS, null, 1));
  process.exit(0);
})();
JS_EOF
cat > "$WORK/qa/services.py" <<'PY_EOF'
"""服务侧检查：IQA-007（真实服务与配置）、IQA-008（浏览器无长期凭据）、IQA-009（服务端日志无客户内容）。"""
import json, os, re, sys, time, urllib.error, urllib.parse, urllib.request
sys.path.insert(0, os.path.dirname(__file__))
from common import SENTENCES, deps, classify_deps, field, secret_values, redact

W, EVD = os.environ["WORK"], os.environ["EVD"]
DEADLINE = int(os.environ["QA_DEADLINE"])
APP = os.environ["APP_URL"].rstrip("/")
APP_HOST = urllib.parse.urlparse(APP).hostname or ""
AZ_RE = re.compile(r"(\.cognitiveservices\.azure\.com|\.api\.cognitive\.microsoft\.com|\.services\.ai\.azure\.com|"
                   r"\.openai\.azure\.com|\.speech\.microsoft\.com|\.cognitive\.microsoft\.com)$", re.I)
BR = {}
try:
    BR = json.load(open(os.path.join(W, "browser-results.json"), encoding="utf-8"))
except Exception:
    pass
OUT = {"scenarios": {}, "notes": []}
LOGF = open(os.path.join(EVD, "services-trace.log"), "a", encoding="utf-8")


def log(*a):
    LOGF.write(redact(" ".join(str(x) for x in a)) + "\n"); LOGF.flush()


def cp(sid, step, status, obs):
    OUT["scenarios"].setdefault(sid, {"id": sid, "checkpoints": [], "evidence": []})["checkpoints"].append(
        {"step": step, "status": status, "observation": redact(obs)})


def ev(sid, *names):
    OUT["scenarios"].setdefault(sid, {"id": sid, "checkpoints": [], "evidence": []})["evidence"].extend(names)


def write_evd(name, obj):
    with open(os.path.join(EVD, name), "w", encoding="utf-8") as f:
        f.write(redact(json.dumps(obj, ensure_ascii=False, indent=1)))
    return name


def http(method, url, headers=None, body=None, timeout=30, form=None):
    """返回 (status, headers, text)；不抛异常。"""
    data = None
    h = dict(headers or {})
    if form is not None:
        data = urllib.parse.urlencode(form).encode(); h.setdefault("Content-Type", "application/x-www-form-urlencoded")
    elif body is not None:
        data = json.dumps(body).encode() if not isinstance(body, (bytes, str)) else (body.encode() if isinstance(body, str) else body)
        h.setdefault("Content-Type", "application/json")
    req = urllib.request.Request(url, data=data, method=method, headers=h)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, dict(r.headers), r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        try:
            t = e.read().decode("utf-8", "replace")
        except Exception:
            t = ""
        return e.code, dict(e.headers or {}), t
    except Exception as e:
        return 0, {}, "%s: %s" % (type(e).__name__, e)


_TOK = {}


def aad(scope):
    """QA Pod 工作负载身份（联合令牌）换取访问令牌。"""
    if scope in _TOK:
        return _TOK[scope]
    tf, cid, tid = (os.environ.get(k) for k in ("AZURE_FEDERATED_TOKEN_FILE", "AZURE_CLIENT_ID", "AZURE_TENANT_ID"))
    tok = None
    if tf and cid and tid and os.path.exists(tf):
        host = (os.environ.get("AZURE_AUTHORITY_HOST") or "https://login.microsoftonline.com/").rstrip("/")
        st, _, txt = http("POST", "%s/%s/oauth2/v2.0/token" % (host, tid), form={
            "client_id": cid, "scope": scope, "grant_type": "client_credentials",
            "client_assertion_type": "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
            "client_assertion": open(tf).read().strip()})
        if st == 200:
            tok = json.loads(txt).get("access_token")
        log("aad", scope, st)
    _TOK[scope] = tok
    return tok


def arm(method, path, body=None, api=None, timeout=40):
    t = aad("https://management.azure.com/.default")
    if not t:
        return 0, None
    url = path if path.startswith("http") else "https://management.azure.com" + path
    if api:
        url += ("&" if "?" in url else "?") + "api-version=" + api
    st, _, txt = http(method, url, {"Authorization": "Bearer " + t}, body, timeout)
    log("arm", method, url.split("?")[0], st)
    try:
        return st, json.loads(txt) if txt else None
    except Exception:
        return st, None


def iso(ms):
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(ms / 1000))


def raw_records():
    p = os.path.join(W, "raw", "network.jsonl")
    if not os.path.exists(p):
        return []
    out = []
    with open(p, encoding="utf-8", errors="replace") as f:
        for line in f:
            try:
                out.append(json.loads(line))
            except Exception:
                pass
    return out


RAW = raw_records()
D = deps()
SPEECH, MODEL = classify_deps(D)
log("deps", {n: sorted(f) for n, f in D.items()}, "speech", SPEECH, "model", MODEL)
SECRETS = secret_values()


# ======================= IQA-008 =======================
def iqa008():
    sid = "IQA-008"
    key_hdr = re.compile(r"^(ocp-apim-subscription-key|api-key|subscription-key|x-api-key)$", re.I)
    key_q = re.compile(r"[?&](subscription-key|api-key|key|code|sig)=([^&#\s]{8,})", re.I)
    conn = re.compile(r"(AccountKey|SharedAccessKey)=[A-Za-z0-9+/=]{16,}")
    newkey = re.compile(r"\b[A-Za-z0-9]{52}JQQJ9[A-Za-z0-9]{2}AC[A-Za-z0-9]{3}\b|\b[A-Za-z0-9]{52}JQQJ9[A-Za-z0-9]{27}\b")
    oldkey_ctx = re.compile(r"(subscription[-_ ]?key|api[-_ ]?key|speech[-_ ]?key|apikey)[\"'\s:=]+[\"']?([0-9a-f]{32}|[A-Za-z0-9]{84})\b", re.I)
    counts = {"knownSecretValues": 0, "keyHeaders": 0, "keyQueryParams": 0, "connectionStrings": 0, "azureKeyPatterns": 0, "keyAssignments": 0}
    where = {}
    scope = {"requests": 0, "responses": 0, "responseBodies": 0, "wsOpen": 0, "wsTextFrames": 0, "wsBinaryFrames": 0, "dom": 0, "storage": 0, "cookies": 0}

    def hit(kind, url, n=1):
        counts[kind] += n
        u = (url or "").split("?")[0]
        where.setdefault(kind, [])
        if u not in where[kind] and len(where[kind]) < 20:
            where[kind].append(u)

    for r in RAW:
        t = r.get("type", "")
        url = r.get("url", "")
        blobs = []
        if t == "request":
            scope["requests"] += 1
            for k, v in (r.get("headers") or {}).items():
                if key_hdr.match(k) and v:
                    hit("keyHeaders", url)
            blobs += [url, json.dumps(r.get("headers") or {}), r.get("post") or ""]
        elif t == "response":
            scope["responses"] += 1
            if r.get("body"):
                scope["responseBodies"] += 1
            blobs += [json.dumps(r.get("headers") or {}), r.get("body") or ""]
        elif t == "ws-open":
            scope["wsOpen"] += 1; blobs.append(url)
        elif t in ("ws-sent", "ws-recv"):
            scope["wsBinaryFrames" if r.get("binary") else "wsTextFrames"] += 1; blobs.append(r.get("text") or "")
        elif t == "dom":
            scope["dom"] += 1; blobs.append(r.get("html") or "")
        elif t == "storage":
            scope["storage"] += 1; blobs += [r.get("local") or "", r.get("session") or "", r.get("cookie") or ""]
        elif t == "cookies":
            scope["cookies"] += 1; blobs.append(json.dumps(r.get("cookies") or []))
        for b in blobs:
            if not b:
                continue
            for s in SECRETS:
                if s in b:
                    hit("knownSecretValues", url)
            if t in ("request", "ws-open"):
                for m in key_q.finditer(url):
                    if m.group(1).lower() != "sig" or "AccountKey" in b:
                        hit("keyQueryParams", url)
            if conn.search(b):
                hit("connectionStrings", url)
            if newkey.search(b):
                hit("azureKeyPatterns", url)
            if oldkey_ctx.search(b):
                hit("keyAssignments", url)
    total = sum(counts.values())
    name = write_evd("iqa-008-scan.json", {
        "assumption": "QA-A9", "knownSecretValuesCompared": len(SECRETS),
        "scope": scope, "hits": counts, "hitLocations": where,
        "note": "只记录命中数量与位置（不含查询串），不记录任何值"})
    if scope["requests"] == 0:
        cp(sid, "扫描", "gap", "未采集到浏览器网络数据（浏览器运行未执行），无法扫描")
    else:
        extra = "" if SECRETS else "；平台未注入依赖密钥字段，只做特征扫描（依赖以平台身份认证或无密钥）"
        cp(sid, "长期凭据命中数为 0", "fail" if total else "pass",
           "扫描 %d 个请求、%d 个响应（%d 个正文）、%d 个实时连接（文本帧 %d、二进制帧 %d）、%d 份 DOM、%d 份存储：命中 %s%s"
           % (scope["requests"], scope["responses"], scope["responseBodies"], scope["wsOpen"], scope["wsTextFrames"],
              scope["wsBinaryFrames"], scope["dom"], scope["storage"],
              "；".join("%s=%d" % (k, v) for k, v in counts.items() if v) or "0", extra))
    ev(sid, name)


# ======================= IQA-007 =======================
LID_RE = re.compile(r"(languageId|LanguageDetection|PrimaryLanguage|lidEnabled|autoDetect|DetectContinuous|DetectAtAudioStart|"
                    r"language[_ -]?detect|auto[_ -]?detect|languageIdentification)", re.I)


def dep_info(n):
    f = D[n]
    ep = field(f, r"^ENDPOINT$", r"ENDPOINT", r"_URL$", r"^URL$", r"HOST")
    rid = field(f, r"RESOURCE_ID")
    return {"name": n, "kind": f.get("KIND", ""), "endpoint": ep.rstrip("/"),
            "host": (urllib.parse.urlparse(ep).hostname or "") if ep else "",
            "resourceId": rid, "account": rid.split("/deployments/")[0] if rid else "",
            "region": field(f, r"REGION", r"LOCATION"),
            "deployment": field(f, r"DEPLOYMENT", r"^MODEL$", r"MODEL_NAME", r"MODEL"),
            "key": field(f, r"^KEY$", r"API_KEY", r"PRIMARY_KEY", r"KEY"), "authMode": f.get("AUTH_MODE", "")}


def auth_headers(info):
    if info["key"]:
        return {"api-key": info["key"], "Ocp-Apim-Subscription-Key": info["key"]}, "key"
    t = aad("https://cognitiveservices.azure.com/.default")
    return ({"Authorization": "Bearer " + t}, "aad") if t else ({}, "none")


def ws_records():
    """浏览器可见的实时连接：按连接地址聚合。"""
    conns = {}
    for r in RAW:
        if r.get("type") not in ("ws-open", "ws-sent", "ws-recv"):
            continue
        u = r.get("url", "")
        c = conns.setdefault(u, {"host": urllib.parse.urlparse(u).hostname or "", "path": urllib.parse.urlparse(u).path,
                                 "query": urllib.parse.urlparse(u).query, "sent": [], "recv": [], "runs": set()})
        c["runs"].add(r.get("run"))
        if r["type"] == "ws-sent":
            c["sent"].append(r.get("text") or "")
        elif r["type"] == "ws-recv":
            c["recv"].append(r.get("text") or "")
    return conns


def diag_endpoints():
    out = []
    for p in ("/api/health", "/health", "/healthz", "/api/config", "/api/diagnostics", "/api/info"):
        st, h, txt = http("GET", APP + p, timeout=15)
        ct = (h.get("Content-Type") or h.get("content-type") or "")
        if st == 200 and "html" not in ct.lower():
            out.append({"path": p, "status": st, "text": txt[:20000]})
        else:
            out.append({"path": p, "status": st, "text": ""})
    return out


def metric_defs(rid):
    st, js = arm("GET", rid + "/providers/Microsoft.Insights/metricDefinitions", api="2018-01-01")
    if st != 200 or not js:
        return st, []
    return st, [m["name"]["value"] for m in js.get("value", [])]


def metric_totals(rid, names, start_ms, end_ms):
    if not names:
        return 0, {}
    q = "metricnames=%s&timespan=%s/%s&interval=PT1M&aggregation=Total,Count" % (
        urllib.parse.quote(",".join(names[:20])), iso(start_ms), iso(end_ms))
    st, js = arm("GET", rid + "/providers/Microsoft.Insights/metrics?" + q, api="2018-01-01")
    out = {}
    if st == 200 and js:
        for m in js.get("value", []):
            tot = 0.0
            for ts in m.get("timeseries", []):
                for d in ts.get("data", []):
                    tot += float(d.get("total") or 0)
            out[m["name"]["value"]] = tot
    return st, out


def chat(info, extra, api_label):
    """直接调用模型部署做一次翻译；返回记录（不含正文以外的敏感信息）。"""
    h, mode = auth_headers(info)
    ep, dep = info["endpoint"], info["deployment"]
    msgs = [{"role": "system", "content": "把用户给出的英文翻译成简体中文，只输出译文。"},
            {"role": "user", "content": SENTENCES[1]["text"]}]
    tries = []
    if dep:
        tries.append(("deployments", "%s/openai/deployments/%s/chat/completions?api-version=2025-04-01-preview" % (ep, dep), {}))
    tries.append(("v1", "%s/openai/v1/chat/completions" % ep, {"model": dep} if dep else {}))
    tries.append(("models", "%s/models/chat/completions?api-version=2024-05-01-preview" % ep, {"model": dep} if dep else {}))
    rec = {"label": api_label, "auth": mode, "attempts": []}
    for name, url, mb in tries:
        body = dict(messages=msgs, max_completion_tokens=400, **mb, **extra)
        st, _, txt = http("POST", url, h, body, timeout=25)
        a = {"api": name, "status": st}
        if st == 200:
            try:
                js = json.loads(txt)
                u = js.get("usage") or {}
                det = u.get("completion_tokens_details") or {}
                out = ((js.get("choices") or [{}])[0].get("message") or {}).get("content") or ""
                a.update(model=js.get("model"), reasoningTokens=det.get("reasoning_tokens"),
                         completionTokens=u.get("completion_tokens"), outputIsChinese=len(re.findall(r"[\u4e00-\u9fff]", out)) >= 4)
            except Exception as e:
                a["parseError"] = str(e)[:100]
            rec["attempts"].append(a); rec["ok"] = a
            return rec
        a["error"] = redact(txt[:300])
        rec["attempts"].append(a)
    rec["ok"] = None
    return rec


def speech_access(info):
    h, mode = auth_headers(info)
    urls = []
    if info["host"] and re.search(r"cognitiveservices\.azure\.com$|services\.ai\.azure\.com$", info["host"]):
        urls.append(info["endpoint"].split("/", 3)[0] + "//" + info["host"] + "/sts/v1.0/issueToken")
    if info["region"]:
        urls.append("https://%s.api.cognitive.microsoft.com/sts/v1.0/issueToken" % info["region"])
    res = []
    for u in urls:
        st, _, _ = http("POST", u, {k: v for k, v in h.items() if k != "api-key"}, b"", timeout=30)
        res.append({"url": u.split("?")[0], "auth": mode, "status": st})
        if st == 200:
            return True, res
    if info["account"]:
        st, js = arm("GET", info["account"], api="2024-10-01")
        res.append({"arm": "resource", "status": st, "kind": (js or {}).get("kind"), "type": (js or {}).get("type")})
        if st == 200:
            return True, res
    return False, res


def arm_models(account):
    st, js = arm("GET", account + "/deployments", api="2024-10-01")
    deps_ = [{"name": d.get("name"), "model": ((d.get("properties") or {}).get("model") or {}).get("name"),
              "version": ((d.get("properties") or {}).get("model") or {}).get("version")} for d in (js or {}).get("value", [])] if st == 200 else None
    st2, js2 = arm("GET", account + "/models", api="2024-10-01")
    avail = sorted({(m.get("model") or m).get("name", "") for m in (js2 or {}).get("value", [])}) if st2 == 200 else None
    return {"deploymentsStatus": st, "deployments": deps_, "modelsStatus": st2,
            "solAvailable": (any(re.search(r"gpt-sol-6\.1", x or "", re.I) for x in avail) if avail is not None else None),
            "modelCount": len(avail) if avail is not None else None}


def br_cp(sid, step):
    for c in ((BR.get("scenarios") or {}).get(sid) or {}).get("checkpoints", []):
        if c["step"] == step:
            return c["status"]
    return None


# ======================= IQA-009 日志获取 =======================
def find_app_resources():
    st, js = arm("GET", "/subscriptions", api="2022-12-01")
    subs = [s["subscriptionId"] for s in (js or {}).get("value", [])] if st == 200 else []
    if not subs:
        return st, []
    q = ("resources | where type in~ ('microsoft.app/containerapps','microsoft.web/sites') "
         "| where tostring(properties) contains '%s' | project id, name, type, location, "
         "envId=tostring(properties.managedEnvironmentId), envId2=tostring(properties.environmentId), "
         "es=tostring(properties.eventStreamEndpoint), rev=tostring(properties.latestRevisionName)" % APP_HOST.replace("'", ""))
    st, js = arm("POST", "/providers/Microsoft.ResourceGraph/resources", {"subscriptions": subs, "query": q}, api="2021-03-01")
    return st, (js or {}).get("data", []) if st == 200 else []


def la_logs(res, start_ms, end_ms):
    env = res.get("envId") or res.get("envId2")
    if not env:
        return {"source": "log-analytics", "status": "no-environment"}, []
    st, js = arm("GET", env, api="2024-03-01")
    cid = (((js or {}).get("properties") or {}).get("appLogsConfiguration") or {}).get("logAnalyticsConfiguration", {}) or {}
    cid = cid.get("customerId") if isinstance(cid, dict) else None
    if not cid:
        return {"source": "log-analytics", "status": "environment-%s-no-workspace" % st}, []
    tok = aad("https://api.loganalytics.io/.default")
    if not tok:
        return {"source": "log-analytics", "status": "no-token"}, []
    kql = ("union isfuzzy=true ContainerAppConsoleLogs_CL, ContainerAppConsoleLogs, ContainerAppSystemLogs_CL, ContainerAppSystemLogs "
           "| where TimeGenerated between (datetime(%s) .. datetime(%s)) "
           "| extend N = tostring(column_ifexists('ContainerAppName_s', column_ifexists('ContainerAppName', ''))) "
           "| where N =~ '%s' "
           "| extend L = tostring(column_ifexists('Log_s', column_ifexists('Log', ''))) "
           "| project TimeGenerated, L | order by TimeGenerated asc | take 20000") % (iso(start_ms), iso(end_ms), res["name"])
    st, _, txt = http("POST", "https://api.loganalytics.io/v1/workspaces/%s/query" % cid,
                      {"Authorization": "Bearer " + tok}, {"query": kql}, timeout=60)
    log("la", st, txt[:200] if st != 200 else "")
    if st != 200:
        return {"source": "log-analytics", "status": st}, []
    rows = []
    for t in json.loads(txt).get("tables", []):
        rows += [(r[0], r[1]) for r in t.get("rows", [])]
    last = max((r[0] for r in rows), default=None)
    return {"source": "log-analytics", "status": 200, "rows": len(rows), "lastTime": last}, [r[1] for r in rows]


def logstream(res):
    es = res.get("es") or ""
    if "/subscriptions/" not in es:
        return {"source": "logstream", "status": "no-endpoint"}, []
    st, js = arm("POST", res["id"] + "/getAuthtoken", api="2024-03-01")
    tok = (js or {}).get("properties", {}).get("token") if st == 200 else None
    if not tok:
        return {"source": "logstream", "status": "authtoken-%s" % st}, []
    base = es[:es.index("/subscriptions/")]
    p = res["id"].split("/")
    sub, rg = p[2], p[4]
    lines_ = []
    stat = []
    st, js = arm("GET", res["id"] + "/revisions", api="2024-03-01")
    revs = [r["name"] for r in (js or {}).get("value", []) if (r.get("properties") or {}).get("active")] if st == 200 else []
    for rev in revs[:3]:
        st, js = arm("GET", "%s/revisions/%s/replicas" % (res["id"], rev), api="2024-03-01")
        for rep in (js or {}).get("value", [])[:5]:
            for c in ((rep.get("properties") or {}).get("containers") or [])[:4]:
                url = "%s/subscriptions/%s/resourceGroups/%s/containerApps/%s/revisions/%s/replicas/%s/containers/%s/logstream?tailLines=300&follow=false" % (
                    base, sub, rg, res["name"], rev, rep["name"], c["name"])
                s2, _, txt = http("GET", url, {"Authorization": "Bearer " + tok}, timeout=40)
                stat.append(s2)
                if s2 == 200:
                    lines_ += txt.splitlines()
    return {"source": "logstream", "status": stat or "no-replicas", "lines": len(lines_)}, lines_


def kudu_logs(res):
    tok = aad("https://management.azure.com/.default")
    st, js = arm("GET", res["id"], api="2023-12-01")
    scm = [h["name"] for h in ((js or {}).get("properties") or {}).get("hostNameSslStates", []) if h.get("hostType") == "Repository"]
    if not scm:
        return {"source": "kudu", "status": "no-scm-%s" % st}, []
    s2, _, txt = http("GET", "https://%s/api/logs/docker" % scm[0], {"Authorization": "Bearer " + tok}, timeout=40)
    out = []
    if s2 == 200:
        for f in json.loads(txt)[:10]:
            s3, _, t3 = http("GET", f.get("href", ""), {"Authorization": "Bearer " + tok}, timeout=40)
            if s3 == 200:
                out += t3.splitlines()[-5000:]
    return {"source": "kudu", "status": s2, "lines": len(out)}, out


def env_log_urls():
    out, lines_ = [], []
    for k, v in os.environ.items():
        if re.search(r"_LOGS?_URL$", k) and v.startswith("https://"):
            st, _, txt = http("GET", v, timeout=40)
            if st in (401, 403):
                t = aad("https://management.azure.com/.default")
                if t:
                    st, _, txt = http("GET", v, {"Authorization": "Bearer " + t}, timeout=40)
            out.append({"source": "env:" + k, "status": st})
            if st == 200:
                lines_ += txt.splitlines()
    return out, lines_


def needles():
    eng = []
    for s in SENTENCES:
        w = re.sub(r"[^A-Za-z' ]", " ", s["text"]).split()
        eng += [" ".join(w[i:i + 5]).lower() for i in range(0, max(1, len(w) - 4))]
    cn = set()
    for line in ((BR.get("runs") or {}).get("main") or {}).get("allCapLines") or []:
        t = re.sub(r"\s+", "", line)
        for i in range(0, len(t) - 7):
            seg = t[i:i + 8]
            if all("\u3400" <= ch <= "\u9fff" for ch in seg):
                cn.add(seg)
    return eng, sorted(cn)


def search_logs(lines_):
    eng, cn = needles()
    hits = {"englishSource": 0, "chineseCaptions": 0, "secrets": 0}
    for raw_line in lines_:
        line = raw_line or ""
        variants = [line]
        if "\\u" in line:
            try:
                variants.append(line.encode("utf-8").decode("unicode_escape"))
            except Exception:
                pass
        low = " ".join(re.sub(r"[^A-Za-z' ]", " ", " ".join(variants)).lower().split())
        if any(n in low for n in eng):
            hits["englishSource"] += 1
        joined = re.sub(r"\s+", "", " ".join(variants))
        if any(n in joined for n in cn):
            hits["chineseCaptions"] += 1
        if any(s in line for s in SECRETS):
            hits["secrets"] += 1
    return hits, len(eng), len(cn)


# ======================= 编排 =======================
def run_window():
    runs = BR.get("runs") or {}
    st = [v.get("started") for v in runs.values() if v.get("started")]
    en = [v.get("ended") for v in runs.values() if v.get("ended")]
    return (min(st), max(en)) if st and en else (None, None)


def main():
    t_services = int(time.time() * 1000)
    iqa008()
    w0, w1 = run_window()
    infos = {n: dep_info(n) for n in D}
    sp = [infos[n] for n in SPEECH]
    md = [infos[n] for n in MODEL]
    conns = ws_records()
    diags = diag_endpoints()
    diag_text = "\n".join(d["text"] for d in diags)

    # ---- 指标与日志轮询（在任何直接调用之前读取，避免把测试自身的调用算进去） ----
    accounts = sorted({i["account"] for i in sp + md if i["account"]})
    defs, mvals = {}, {}
    SP_M = re.compile(r"(Audio|Speech|Transcri|Recogni)", re.I)
    MD_M = re.compile(r"(Token|ModelRequests|InferenceRequest)", re.I)
    for a in accounts:
        st, names = metric_defs(a)
        defs[a] = {"status": st, "speech": [n for n in names if SP_M.search(n) and not re.search(r"Synth|TextToSpeech|Voice", n, re.I)],
                   "model": [n for n in names if MD_M.search(n)]}
    log_src, log_lines, log_res = [], [], None
    s_env, l_env = env_log_urls()
    log_src += s_env; log_lines += l_env
    st_find, apps = find_app_resources()
    log_src.append({"source": "resource-graph", "status": st_find, "matched": [a.get("type") for a in apps]})
    if w0 and apps:
        for a in apps:
            if a["type"].lower() == "microsoft.web/sites":
                s, l = kudu_logs(a); log_src.append(s); log_lines += l
            else:
                s, l = logstream(a); log_src.append(s); log_lines += l
    la_lines, la_info = [], None
    while True:
        speech_total = model_total = 0.0
        if w0:
            for a in accounts:
                names = defs[a]["speech"] + defs[a]["model"]
                st, vals = metric_totals(a, names, w0 - 60000, min(w1 + 60000, t_services))
                mvals[a] = {"status": st, "values": vals}
                speech_total += sum(v for k, v in vals.items() if k in defs[a]["speech"])
                model_total += sum(v for k, v in vals.items() if k in defs[a]["model"])
        if w0:
            for a in apps:
                if a["type"].lower() == "microsoft.app/containerapps":
                    la_info, la_lines = la_logs(a, w0 - 120000, int(time.time() * 1000))
        la_done = la_info is not None and la_info.get("status") == 200 and la_info.get("lastTime") and \
            la_info["lastTime"] >= iso((BR.get("runs") or {}).get("main", {}).get("ended", w1 or 0))
        metrics_done = (speech_total > 0 and model_total > 0) or not accounts
        if (metrics_done and (la_done or not apps)) or time.time() > DEADLINE - 110 or not w0:
            break
        time.sleep(30)
    if la_info:
        log_src.append(la_info); log_lines += la_lines

    # ---- 直接调用（指标读取之后） ----
    sp_access = {i["name"]: speech_access(i) for i in sp}
    chats = {}
    for i in md:
        if i["endpoint"]:
            chats[i["name"]] = {"plain": chat(i, {}, "未指定 reasoning 参数"),
                                "none": chat(i, {"reasoning_effort": "none"}, "reasoning_effort=none")}
    armm = {i["name"]: arm_models(i["account"]) for i in md if i["account"]}

    # ---- IQA-007 ----
    sid = "IQA-007"
    azure_ws = {u: c for u, c in conns.items() if AZ_RE.search(c["host"])}
    model_http = [r for r in RAW if r.get("type") == "request" and AZ_RE.search(urllib.parse.urlparse(r.get("url", "")).hostname or "")
                  and re.search(r"(chat/completions|/responses)", r.get("url", ""))]
    hyp = sum(1 for c in azure_ws.values() for t in c["recv"] if re.search(r"speech\.hypothesis|\"Text\"\s*:", t) and "hypothesis" in t.lower())
    lid_ws = sum(1 for c in azure_ws.values() for t in c["sent"] + c["recv"] + [c["query"]] if LID_RE.search(t))
    fixed_lang = [c["query"] for c in azure_ws.values() if re.search(r"(^|&)language=[a-z]{2}-[A-Z]{2}", c["query"]) and not LID_RE.search(c["query"])]
    diag_lid = bool(LID_RE.search(diag_text))
    diag_reason_off = bool(re.search(r"reasoning[^\n]{0,40}(none|off|disabled|false|minimal)", diag_text, re.I))
    evidence = {
        "assumption": "QA-A7", "window": [iso(w0) if w0 else None, iso(w1) if w1 else None],
        "dependencies": {n: {k: v for k, v in i.items() if k not in ("key",)} | {"hasKey": bool(i["key"])} for n, i in infos.items()},
        "speechDeps": SPEECH, "modelDeps": MODEL,
        "browserRealtimeConnections": [{"host": c["host"], "path": c["path"], "azure": bool(AZ_RE.search(c["host"])),
                                        "sentFrames": len(c["sent"]), "recvFrames": len(c["recv"]), "runs": sorted(x for x in c["runs"] if x)} for c in conns.values()],
        "browserHypothesisMessages": hyp, "browserLidMarkers": lid_ws, "fixedLanguageQueries": len(fixed_lang),
        "browserModelRequests": len(model_http),
        "diagnostics": [{"path": d["path"], "status": d["status"], "lid": bool(LID_RE.search(d["text"])),
                         "reasoningOff": bool(re.search(r"reasoning[^\n]{0,40}(none|off|disabled|false|minimal)", d["text"], re.I)),
                         "mentionsGptSol61": bool(re.search(r"gpt-sol-6\.1", d["text"], re.I))} for d in diags],
        "metricDefinitions": defs, "metrics": mvals, "speechAccess": sp_access, "modelCalls": chats, "armModels": armm,
    }
    ev(sid, write_evd("iqa-007-services.json", evidence))
    # 1 真实依赖
    if not D:
        cp(sid, "真实依赖", "gap", "平台未注入任何依赖接入信息（AIDH_DEP_*），无法确认依赖为真实 Azure 服务")
    else:
        notaz = [i["name"] for i in sp + md if i["host"] and not AZ_RE.search(i["host"])]
        sp_ok = [n for n, (ok, _) in sp_access.items() if ok]
        md_ok = [n for n, c in chats.items() if c["plain"]["ok"] or c["none"]["ok"]]
        if notaz:
            cp(sid, "真实依赖", "fail", "依赖地址不是 Azure 服务域名：%s" % ", ".join(notaz))
        elif sp_ok and md_ok:
            cp(sid, "真实依赖", "pass", "语音依赖 %s 可访问（Azure 域名），模型依赖 %s 翻译调用成功" % (",".join(sp_ok), ",".join(md_ok)))
        else:
            cp(sid, "真实依赖", "gap", "依赖为 Azure 域名，但未能用注入的接入信息访问：语音可访问=%s，模型可调用=%s（见 iqa-007-services.json）" % (sp_ok or "无", md_ok or "无"))
    # 2 实时识别
    sp_metric = sum(v for a in mvals.values() for k, v in a.get("values", {}).items() if any(k in defs[x]["speech"] for x in defs))
    streaming = br_cp("IQA-002", "首条字幕早于句末")
    if hyp or sp_metric > 0:
        src = ("浏览器可见语音连接中间结果 %d 条" % hyp) if hyp else ("语音资源时间窗内指标合计 %.0f" % sp_metric)
        if streaming == "fail":
            cp(sid, "实时（流式）识别", "fail", src + "；但 IQA-002 显示字幕并非随发言流式出现")
        else:
            cp(sid, "实时（流式）识别", "pass" if streaming == "pass" else "gap", src + "；IQA-002 首条字幕早于句末=%s" % streaming)
    else:
        cp(sid, "实时（流式）识别", "gap", "未取得服务侧流式识别证据：浏览器未直连 Azure 语音实时连接，语音资源指标不可读或为 0（依赖假设 QA-A7）")
    # 3 语言自动识别
    if fixed_lang and not lid_ws and not diag_lid:
        cp(sid, "语言自动识别", "fail", "浏览器可见的语音连接预先指定了识别语言（language=xx-XX），且无语言识别配置")
    elif lid_ws or diag_lid:
        no_sel = br_cp("IQA-003", "全过程无语言选择")
        cp(sid, "语言自动识别", "pass" if no_sel == "pass" else ("fail" if no_sel == "fail" else "gap"),
           "语言识别标记：浏览器语音连接 %d 处，诊断接口=%s；IQA-003 无语言选择=%s" % (lid_ws, diag_lid, no_sel))
    else:
        cp(sid, "语言自动识别", "gap", "未取得语言自动识别的服务侧证据（浏览器未直连语音服务且诊断接口未声明；依赖假设 QA-A7）")
    # 4 大模型翻译
    md_metric = sum(v for a in mvals.values() for k, v in a.get("values", {}).items() if any(k in defs[x]["model"] for x in defs))
    if model_http or md_metric > 0:
        cp(sid, "大模型完成翻译", "pass", ("浏览器可见模型请求 %d 个" % len(model_http)) if model_http else ("模型资源时间窗内令牌/请求指标合计 %.0f（读取于测试直接调用之前）" % md_metric))
    else:
        cp(sid, "大模型完成翻译", "gap", "未取得候选调用大模型的服务侧证据（指标不可读或为 0；依赖假设 QA-A7）")
    # 5 模型与 reasoning
    names, sol_avail, rt_plain, none_ok, none_fail = set(), None, [], False, False
    for n, c in chats.items():
        for k in ("plain", "none"):
            if c[k]["ok"] and c[k]["ok"].get("model"):
                names.add(c[k]["ok"]["model"])
        if c["plain"]["ok"]:
            rt_plain.append(c["plain"]["ok"].get("reasoningTokens"))
        if c["none"]["ok"]:
            none_ok = True
        elif any(a.get("status") == 400 for a in c["none"]["attempts"]):
            none_fail = True
    for n, a in armm.items():
        for d in a.get("deployments") or []:
            if d["name"] == infos[n]["deployment"] and d.get("model"):
                names.add(d["model"])
        if a.get("solAvailable") is not None:
            sol_avail = a["solAvailable"]
    is_sol = any(re.search(r"gpt-sol-6\.1", x or "", re.I) for x in names)
    model_obs = "模型=%s" % (",".join(sorted(names)) or "未知")
    if not names:
        m_status = "gap"
    elif is_sol:
        m_status = "pass"
    elif sol_avail is True:
        m_status, model_obs = "fail", model_obs + "；测试环境中 gpt-sol-6.1 可用却未使用"
    elif sol_avail is False:
        m_status, model_obs = "pass", model_obs + "；测试环境模型目录中无 gpt-sol-6.1（替代模型，A-05）"
    else:
        m_status, model_obs = "gap", model_obs + "；无法确认 gpt-sol-6.1 在测试环境是否可用"
    if rt_plain and all(x == 0 for x in rt_plain):
        r_status, r_obs = "pass", "直接调用部署不产生推理令牌（reasoning_tokens=0）"
    elif diag_reason_off:
        r_status, r_obs = "pass", "候选诊断接口声明 reasoning 关闭"
    elif none_fail and not none_ok and rt_plain and any((x or 0) > 0 for x in rt_plain):
        r_status, r_obs = "fail", "部署默认产生推理令牌且不接受 reasoning_effort=none"
    else:
        r_status, r_obs = "gap", "无法从外部确认候选调用时关闭 reasoning（默认 reasoning_tokens=%s；reasoning_effort=none 调用%s）" % (rt_plain, "成功" if none_ok else "未成功")
    st5 = "fail" if "fail" in (m_status, r_status) else ("gap" if "gap" in (m_status, r_status) else "pass")
    cp(sid, "模型与 reasoning", st5, model_obs + "；" + r_obs)

    # ---- IQA-009 ----
    sid = "IQA-009"
    ok_src = [s for s in log_src if s.get("source") != "resource-graph" and
              (s.get("status") == 200 or (isinstance(s.get("status"), list) and 200 in s["status"]))]
    hits, ne, nc = search_logs(log_lines)
    ev(sid, write_evd("iqa-009-logs.json", {"assumption": "QA-A8", "window": [iso(w0 - 120000) if w0 else None, iso(int(time.time() * 1000))],
                                             "sources": log_src, "lines": len(log_lines), "needles": {"english5gram": ne, "chinese8": nc, "secrets": len(SECRETS)},
                                             "hits": hits}))
    if not w0:
        cp(sid, "日志检索", "gap", "浏览器运行未执行，没有可检索的时间窗")
    elif not ok_src:
        cp(sid, "日志检索", "gap", "未能获取候选服务端日志（依赖假设 QA-A8）：%s" % json.dumps([{k: v for k, v in s.items() if k in ("source", "status")} for s in log_src], ensure_ascii=False))
    elif sum(hits.values()):
        cp(sid, "日志检索", "fail", "服务端日志命中：英语原文 %d 行、中文译文 %d 行、secret %d 行（共检索 %d 行）" % (hits["englishSource"], hits["chineseCaptions"], hits["secrets"], len(log_lines)))
    elif nc == 0:
        cp(sid, "日志检索", "gap", "已检索 %d 行日志无英语原文与 secret 命中，但主运行没有中文定稿字幕可用于检索" % len(log_lines))
    elif not log_lines and not any(s.get("source") == "logstream" for s in ok_src):
        cp(sid, "日志检索", "gap", "日志来源可访问但时间窗内为 0 行（可能尚未入库）")
    else:
        cp(sid, "日志检索", "pass", "检索来源 %s 共 %d 行：英语原文、中文译文、secret 命中均为 0" % (",".join(s["source"] for s in ok_src), len(log_lines)))

    with open(os.path.join(W, "services-results.json"), "w", encoding="utf-8") as f:
        json.dump(OUT, f, ensure_ascii=False, indent=1)


try:
    main()
except Exception as e:
    import traceback
    log(traceback.format_exc())
    for s in ("IQA-007", "IQA-008", "IQA-009"):
        if s not in OUT["scenarios"]:
            cp(s, "执行", "gap", "服务侧检查异常：%s" % redact(str(e))[:200])
    with open(os.path.join(W, "services-results.json"), "w", encoding="utf-8") as f:
        json.dump(OUT, f, ensure_ascii=False, indent=1)
PY_EOF
cat > "$WORK/qa/assemble.py" <<'PY_EOF'
"""汇总浏览器与服务侧结果，写出 QA 结果 JSON。"""
import json, os, sys
sys.path.insert(0, os.path.dirname(__file__))
from common import deps, redact

W, EVD = os.environ["WORK"], os.environ["EVD"]
IDS = ["IQA-%03d" % i for i in range(1, 12)]
TITLES = {"IQA-001": "打开即用", "IQA-002": "流式字幕时序", "IQA-003": "无需选择语言", "IQA-004": "中文且含义一致",
          "IQA-005": "多句顺序不重不漏", "IQA-006": "停止后不再采集与出字幕", "IQA-007": "真实服务与配置",
          "IQA-008": "浏览器无长期凭据", "IQA-009": "服务端日志无客户内容", "IQA-010": "麦克风不可用",
          "IQA-011": "刷新不保留、页面互不可见"}


def load(name):
    try:
        return json.load(open(os.path.join(W, name), encoding="utf-8"))
    except Exception:
        return {}


br, sv = load("browser-results.json"), load("services-results.json")
stages = [s for s in os.environ.get("QA_STAGE_ERRORS", "").split("|") if s]
merged = {}
for src in (br.get("scenarios") or {}, sv.get("scenarios") or {}):
    for k, v in src.items():
        m = merged.setdefault(k, {"checkpoints": [], "evidence": []})
        m["checkpoints"] += v.get("checkpoints", []); m["evidence"] += v.get("evidence", [])
dep_names = sorted(n.lower() for n in deps())
uses_services = {"IQA-001", "IQA-002", "IQA-003", "IQA-004", "IQA-005", "IQA-006", "IQA-007", "IQA-009", "IQA-010", "IQA-011"}
defects, gaps, scenarios = [], list(br.get("gaps") or []), []
for sid in IDS:
    m = merged.get(sid) or {"checkpoints": [], "evidence": []}
    cps = m["checkpoints"]
    if not cps:
        cps = [{"step": "执行", "status": "gap", "observation": "该场景未执行（%s）" % ("；".join(stages) or "前序阶段失败")}]
    passed = all(c["status"] == "pass" for c in cps)
    for i, c in enumerate(cps, 1):
        line = "%s %s 检查点%d（%s）：%s" % (sid, TITLES[sid], i, c["step"], c["observation"])
        if c["status"] == "fail":
            defects.append(line[:600])
        elif c["status"] == "gap":
            gaps.append(line[:600])
    evid = sorted(dict.fromkeys(e for e in m["evidence"] if e))
    fails = [c for c in cps if c["status"] != "pass"]
    note = "通过：%d 个检查点全部通过" % len(cps) if passed else "未通过：%s" % "；".join("%s=%s" % (c["step"], "失败" if c["status"] == "fail" else "无法验证") for c in fails)
    scenarios.append({
        "id": sid, "passed": passed,
        "externalServices": dep_names if sid in uses_services else [],
        "checkpoints": [{"step": "%d %s" % (i, c["step"]), "passed": c["status"] == "pass",
                         "observation": ("" if c["status"] != "gap" else "[无法验证] ") + c["observation"]} for i, c in enumerate(cps, 1)],
        "evidence": redact("%s；证据文件：%s" % (note, "、".join(evid) if evid else "qa-run.log")),
    })
npass = sum(1 for s in scenarios if s["passed"])
res = {
    "passed": npass == len(IDS) and not defects and not gaps,
    "testedCommitSha": os.environ.get("CANDIDATE_SHA", "unknown"),
    "summary": redact("独立测试 %d/%d 个场景通过；产品缺陷 %d 条，无法验证（测试缺口）%d 条。依据 tasks-qa.md，带“依赖假设”的判定见各检查点观察。" % (npass, len(IDS), len(defects), len(gaps))),
    "defects": [redact(d) for d in defects],
    "testGaps": [redact(g) for g in gaps],
    "evidence": sorted(f for f in os.listdir(EVD) if os.path.isfile(os.path.join(EVD, f))),
    "bugfixResults": [],
    "scenarios": scenarios,
}
txt = json.dumps(res, ensure_ascii=False, indent=1)
while len(txt.encode()) > 250000:
    for s in res["scenarios"]:
        for c in s.get("checkpoints", []):
            c["observation"] = c["observation"][:max(60, len(c["observation"]) // 2)]
    res["defects"] = [d[:200] for d in res["defects"]]; res["testGaps"] = [g[:200] for g in res["testGaps"]]
    res["evidence"] = res["evidence"][:200]
    txt = json.dumps(res, ensure_ascii=False, indent=1)
with open(os.environ["RESULT_PATH"], "w", encoding="utf-8") as f:
    f.write(txt)
print(res["summary"])
PY_EOF
# ---------------------------------------------------------------------------
# 3. 准备工具：Playwright Chromium、piper 语音合成
# ---------------------------------------------------------------------------
STAGE_ERRORS=""
cd "$WORK" || exit 0
log "安装 Playwright"
if ! npm i --silent --no-audit --no-fund playwright@1.65.1 >>"$LOG" 2>&1; then
  log "npm 安装 Playwright 失败"
  write_fallback env "无法安装浏览器自动化工具 Playwright（npm 失败，见 qa-run.log）"
  exit 0
fi
if ! node -e "const {chromium}=require('$WORK/node_modules/playwright');const p=chromium.executablePath();process.exit(require('fs').existsSync(p)?0:1)" 2>>"$LOG"; then
  export PLAYWRIGHT_BROWSERS_PATH="$WORK/pw"
  log "安装 Chromium 到工作目录"
  npx --yes playwright install chromium >>"$LOG" 2>&1 || true
fi
if ! node -e "const {chromium}=require('$WORK/node_modules/playwright');process.exit(require('fs').existsSync(chromium.executablePath())?0:1)" 2>>"$LOG"; then
  write_fallback env "Chromium 浏览器不可用（预装与下载均失败，见 qa-run.log）"
  exit 0
fi

log "准备 piper 语音合成"
PIPER_OK=0
VOICE_BASE="https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/en/en_US/lessac/medium/en_US-lessac-medium.onnx"
if python3 -m venv "$WORK/venv" >>"$LOG" 2>&1 && "$WORK/venv/bin/pip" install -q piper-tts >>"$LOG" 2>&1 \
   && curl -sSfL -m 180 -o "$WORK/voice.onnx" "$VOICE_BASE" 2>>"$LOG" \
   && curl -sSfL -m 60 -o "$WORK/voice.onnx.json" "$VOICE_BASE.json" 2>>"$LOG"; then
  PIPER_OK=1
fi

log "合成测试素材"
MAT_OK=0
if [ "$PIPER_OK" = 1 ] && timeout 240 python3 "$WORK/qa/materials.py" >>"$LOG" 2>&1; then
  MAT_OK=1
elif timeout 180 python3 "$WORK/qa/materials.py" azure >>"$LOG" 2>&1; then
  MAT_OK=1
fi
if [ "$MAT_OK" != 1 ]; then
  write_fallback gap "无法合成英语测试语音素材（piper 与语音服务合成均失败，见 qa-run.log）"
  exit 0
fi

# ---------------------------------------------------------------------------
# 4. 浏览器运行、服务侧检查、汇总
# ---------------------------------------------------------------------------
REMAIN=$((QA_DEADLINE - $(date +%s)))
log "浏览器运行（剩余 ${REMAIN}s）"
if ! timeout $((REMAIN > 60 ? REMAIN - 40 : 20)) node "$WORK/qa/browser.js" >>"$WORK/browser.out" 2>&1; then
  STAGE_ERRORS="${STAGE_ERRORS}浏览器运行异常退出|"
fi
python3 - "$WORK/browser.out" >>"$LOG" 2>&1 <<'PY' || true
import sys, os
sys.path.insert(0, os.path.join(os.environ["WORK"], "qa"))
from common import redact
print(redact(open(sys.argv[1], encoding="utf-8", errors="replace").read())[-20000:])
PY

REMAIN=$((QA_DEADLINE + 50 - $(date +%s)))
log "服务侧检查（剩余 ${REMAIN}s）"
if ! timeout $((REMAIN > 30 ? REMAIN : 30)) python3 "$WORK/qa/services.py" >>"$LOG" 2>&1; then
  STAGE_ERRORS="${STAGE_ERRORS}服务侧检查异常退出|"
fi

export QA_STAGE_ERRORS="$STAGE_ERRORS"
if ! python3 "$WORK/qa/assemble.py" >>"$LOG" 2>&1; then
  write_fallback gap "结果汇总失败（见 qa-run.log）"
fi
log "QA 结束，用时 $(( $(date +%s) - START_EPOCH ))s"
exit 0
