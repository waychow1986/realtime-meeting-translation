// Synthesizes the English test sentences (WAV, 16 kHz mono PCM) with the speech dependency's test instance.
// The key is only sent as a request header; it is never printed or written to disk.
import { writeFileSync, readFileSync, existsSync, statSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

// key: a distinctive lower-case word used to recognize the sentence in translation requests.
export const SENTENCES = {
  s1: { key: 'planning', text: 'Good morning everyone, welcome to the weekly planning meeting.' },
  s2: { key: 'budget', text: 'The marketing budget for next quarter is twenty thousand dollars.' },
  s3: { key: 'mobile', text: 'Our engineering team will release the new mobile application in March.' },
  s4: { key: 'reports', text: 'Please send your weekly reports to the project manager before Friday.' },
  s5: { key: 'survey', text: 'The customer survey shows that most users like the new design.' },
  s6: { key: 'hire', text: 'We need to hire three more engineers for the data platform team.' },
  s7: { key: 'training', text: 'The training session for new employees will start next Monday morning.' },
  s8: { key: 'sales', text: 'Let us review the sales numbers from the northern region.' },
  s9: { key: 'office', text: 'The office will be closed on the first day of next month.' },
  s10: { key: 'holiday', text: 'Thank you all for your hard work during the busy holiday season.' },
  s11: { key: 'supplier', text: 'Our biggest risk is the delay in the supplier contract.' },
  s12: { key: 'security', text: 'The security audit found two small problems in the login system.' },
};

function escapeXml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function synthOne(text, outPath) {
  const host = process.env.AIDH_DEP_SPEECH_TTS_HOST;
  const key = process.env.AIDH_DEP_SPEECH_KEY;
  if (!host || !key) throw new Error('speech dependency variables (AIDH_DEP_SPEECH_TTS_HOST / AIDH_DEP_SPEECH_KEY) are missing');
  const base = (/^https?:\/\//.test(host) ? host : `https://${host}`).replace(/\/$/, '');
  const ssml = `<speak version="1.0" xml:lang="en-US" xmlns="http://www.w3.org/2001/10/synthesis"><voice name="en-US-GuyNeural"><break time="300ms"/>${escapeXml(text)}<break time="300ms"/></voice></speak>`;
  let lastErr;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(`${base}/cognitiveservices/v1`, {
        method: 'POST',
        headers: {
          'Ocp-Apim-Subscription-Key': key,
          'Content-Type': 'application/ssml+xml',
          'X-Microsoft-OutputFormat': 'riff-16khz-16bit-mono-pcm',
          'User-Agent': 'rtmt-independent-test',
        },
        body: ssml,
      });
      if (!res.ok) throw new Error(`TTS HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 30000) throw new Error(`TTS audio too short (${buf.length} bytes)`);
      writeFileSync(outPath, buf);
      return;
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
  throw lastErr;
}

// Returns { id: { key, text, b64, seconds } } for all sentences.
export async function synthesizeAll(dir, ids = null) {
  mkdirSync(dir, { recursive: true });
  const out = {};
  for (const [id, s] of Object.entries(SENTENCES)) {
    if (ids && !ids.includes(id)) continue;
    const p = join(dir, `${id}.wav`);
    if (!(existsSync(p) && statSync(p).size > 30000)) await synthOne(s.text, p);
    const buf = readFileSync(p);
    // 16 kHz, 16-bit mono PCM: 32000 bytes per second (44-byte header)
    out[id] = { ...s, b64: buf.toString('base64'), seconds: (buf.length - 44) / 32000 };
  }
  return out;
}
