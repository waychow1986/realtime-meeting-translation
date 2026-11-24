// 测试素材：经 speech 依赖 test 实例的语音合成（TTS）生成英语语音，再在本地拼接成各段 WAV。
// 凭据只从环境变量读取，不写入任何文件或日志。
import fs from 'node:fs';
import path from 'node:path';

const SR = 16000;

export const SENTENCES = [
  'Good morning everyone, thank you for joining the quarterly planning meeting today.',
  'Let us start with a quick review of the sales results from the last three months.',
  'Our revenue in the European market grew by twelve percent compared with last year.',
  'The new customer support portal reduced the average response time to under two hours.',
  'Next, I would like to discuss the product roadmap for the second half of the year.',
  'The engineering team plans to release the mobile application in early September.',
  'We also need to hire two more designers to support the marketing campaign.',
  'Please send your budget proposals to the finance department by next Friday.',
  'The training program for new employees will begin on the first Monday of next month.',
  'Our main competitor has lowered its prices, so we should review our pricing strategy.',
  'I suggest that we schedule a workshop with the regional managers next week.',
  'Customer feedback shows that delivery speed is the most important factor for them.',
  'We will open a new warehouse near the airport to shorten delivery times.',
  'The security audit found no critical issues, but a few settings must be updated.',
  'Before we finish, does anyone have questions about the action items for this quarter?',
  'Thank you all for your hard work, and let us meet again at the same time next month.',
];

function speechConfig() {
  const key = process.env.AIDH_DEP_SPEECH_KEY;
  let host = process.env.AIDH_DEP_SPEECH_TTS_HOST;
  const region = process.env.AIDH_DEP_SPEECH_REGION;
  if (!host && region) host = `${region}.tts.speech.microsoft.com`;
  if (!key || !host) throw new Error('missing AIDH_DEP_SPEECH_KEY or AIDH_DEP_SPEECH_TTS_HOST');
  host = host.replace(/^https?:\/\//, '').replace(/:443$/, '');
  return { key, host };
}

async function synthesize(text) {
  const { key, host } = speechConfig();
  const ssml = `<speak version="1.0" xml:lang="en-US"><voice name="en-US-JennyNeural">${text}</voice></speak>`;
  for (let attempt = 1; attempt <= 4; attempt++) {
    const res = await fetch(`https://${host}/cognitiveservices/v1`, {
      method: 'POST',
      headers: {
        'Ocp-Apim-Subscription-Key': key,
        'Content-Type': 'application/ssml+xml',
        'X-Microsoft-OutputFormat': 'raw-16khz-16bit-mono-pcm',
        'User-Agent': 'rtmt-independent-test',
      },
      body: ssml,
    });
    if (res.ok) {
      const buf = Buffer.from(await res.arrayBuffer());
      const out = new Float32Array(buf.length / 2);
      for (let i = 0; i < out.length; i++) out[i] = buf.readInt16LE(i * 2) / 32768;
      return out;
    }
    if (attempt === 4) throw new Error(`tts failed: HTTP ${res.status}`);
    await new Promise((r) => setTimeout(r, 1500 * attempt));
  }
}

const silence = (sec) => new Float32Array(Math.round(sec * SR));

function concat(parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Float32Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

// 持续的背景声：低频哼声 + 少量噪声，RMS 约 0.05（约 -26 dBFS），明显高于静音。
function addBed(samples) {
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff - 0.5; };
  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const t = i / SR;
    const bed = 0.05 * Math.sin(2 * Math.PI * 150 * t) + 0.04 * Math.sin(2 * Math.PI * 233 * t) + 0.02 * rnd();
    out[i] = Math.max(-1, Math.min(1, samples[i] + bed));
  }
  return out;
}

function toWav(samples) {
  const data = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    data.writeInt16LE(Math.round(v * 32767), i * 2);
  }
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(SR, 24); h.writeUInt32LE(SR * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

// 生成素材：speech.wav（普通语音段，句间 1.2 s 正常停顿）、voiced.wav（持续有声段，句间 0.3 s 且叠加背景声）。
export async function buildMaterials(dir, log = () => {}) {
  fs.mkdirSync(dir, { recursive: true });
  const speechPath = path.join(dir, 'speech.wav');
  const voicedPath = path.join(dir, 'voiced.wav');
  if (fs.existsSync(speechPath) && fs.existsSync(voicedPath)) return { speechPath, voicedPath };
  const clips = [];
  for (const s of SENTENCES) clips.push(await synthesize(s));
  log(`tts: synthesized ${clips.length} sentences`);
  const speechParts = [silence(0.5)];
  for (const c of clips) { speechParts.push(c, silence(1.2)); }
  fs.writeFileSync(speechPath, toWav(concat(speechParts)));
  const voicedParts = [];
  for (const c of clips) { voicedParts.push(c, silence(0.3)); }
  fs.writeFileSync(voicedPath, toWav(addBed(concat(voicedParts))));
  return { speechPath, voicedPath };
}
