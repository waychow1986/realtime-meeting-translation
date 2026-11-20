import { knownSecretValues } from './env.js';

export interface SecretHit {
  /** Name of the matched rule or environment variable — never the secret value. */
  rule: string;
  location: string;
}

const PATTERNS: { rule: string; pattern: RegExp }[] = [
  { rule: 'connection-string-account-key', pattern: /AccountKey=[A-Za-z0-9+/=]{20,}/ },
  { rule: 'connection-string-shared-access-key', pattern: /SharedAccessKey=[A-Za-z0-9+/=]{20,}/ },
  { rule: 'subscription-key-assignment', pattern: /Ocp-Apim-Subscription-Key["']?\s*[:=]\s*["']?[A-Za-z0-9]{32,}/i },
  { rule: 'api-key-assignment', pattern: /["']api-key["']\s*[:=]\s*["'][A-Za-z0-9]{32,}/i },
];

/** Scans text for the injected dependency credentials (raw / base64 / url-encoded) and credential patterns. */
export class SecretScanner {
  private readonly needles: { rule: string; value: string }[];
  readonly hits: SecretHit[] = [];
  scannedItems = 0;

  constructor() {
    this.needles = knownSecretValues().flatMap(({ name, value }) => [
      { rule: name, value },
      { rule: `${name}(base64)`, value: Buffer.from(value).toString('base64') },
      ...(encodeURIComponent(value) !== value ? [{ rule: `${name}(urlencoded)`, value: encodeURIComponent(value) }] : []),
    ]);
    if (this.needles.length === 0) throw new Error('no credential values available to scan for');
  }

  scan(location: string, content: string | Buffer | undefined | null): void {
    if (content === undefined || content === null) return;
    const text = typeof content === 'string' ? content : content.toString('latin1');
    this.scannedItems += 1;
    for (const needle of this.needles) {
      if (text.includes(needle.value)) this.hits.push({ rule: needle.rule, location });
    }
    for (const { rule, pattern } of PATTERNS) {
      if (pattern.test(text)) this.hits.push({ rule, location });
    }
  }
}
