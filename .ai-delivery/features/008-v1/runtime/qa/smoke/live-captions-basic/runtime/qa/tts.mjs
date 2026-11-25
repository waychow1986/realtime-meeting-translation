// Synthesizes the English test speech (WAV, 16 kHz mono PCM) with the speech dependency's test instance.
// The key is only sent as a request header; it is never printed or written to disk.
import { writeFileSync, existsSync, statSync } from 'node:fs';

const SENTENCES = [
  'Good morning everyone, thank you for joining the quarterly planning meeting of the product team today.',
  'Thank you.',
  'Let us begin.',
  'First, we will review the sales results of the last three months and discuss why the numbers in the northern region were lower than we expected.',
  'After that, the engineering team will explain the new release schedule and the main risks that could delay the launch of the mobile application.',
  'Finally, we need to agree on the budget for the marketing campaign and decide who will be responsible for each part of the work before next Friday.',
];

function escapeXml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export async function synthesize(outPath) {
  if (existsSync(outPath) && statSync(outPath).size > 100000) return outPath;
  const host = process.env.AIDH_DEP_SPEECH_TTS_HOST;
  const key = process.env.AIDH_DEP_SPEECH_KEY;
  if (!host || !key) throw new Error('speech dependency variables (AIDH_DEP_SPEECH_TTS_HOST / AIDH_DEP_SPEECH_KEY) are missing');
  const base = /^https?:\/\//.test(host) ? host : `https://${host}`;
  const body = SENTENCES.map((s) => `${escapeXml(s)}<break time="1300ms"/>`).join('');
  const ssml = `<speak version="1.0" xml:lang="en-US" xmlns="http://www.w3.org/2001/10/synthesis"><voice name="en-US-GuyNeural"><prosody rate="-5%">${body}</prosody><break time="1500ms"/></voice></speak>`;
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(`${base.replace(/\/$/, '')}/cognitiveservices/v1`, {
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
      if (buf.length < 100000) throw new Error(`TTS audio too short (${buf.length} bytes)`);
      writeFileSync(outPath, buf);
      return outPath;
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 3000 * attempt));
    }
  }
  throw lastErr;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  synthesize(process.argv[2] || 'speech.wav').then((p) => console.log('wrote', p, statSync(p).size, 'bytes'));
}
