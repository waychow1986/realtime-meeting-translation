import type { TranscriptEntry } from './captionTranscript.js';

const LINE_BREAKS = /\r\n|[\r\n\u2028\u2029]/g;

function two(value: number): string {
  return String(value).padStart(2, '0');
}

function localDate(date: Date, separator: string): string {
  return [String(date.getFullYear()).padStart(4, '0'), two(date.getMonth() + 1), two(date.getDate())].join(separator);
}

/** Local 24-hour clock; the fraction of a second is dropped, not rounded (FR-012). */
function localTime(date: Date, separator: string): string {
  return [two(date.getHours()), two(date.getMinutes()), two(date.getSeconds())].join(separator);
}

/**
 * The export file text (TD-903): `导出日期：YYYY-MM-DD`, a blank line, then one `HH:MM:SS 字幕文字` line per caption in
 * page order. A caption that became final after a later one is written with the earliest final time among the
 * captions after it, so the times never go backwards (D-1, TD-911).
 */
export function formatExport(entries: readonly TranscriptEntry[], exportedAt: Date): string {
  const ordered = [...entries].sort((a, b) => a.id - b.id);
  const shown = new Array<number>(ordered.length);
  for (let i = ordered.length - 1; i >= 0; i -= 1) {
    const own = ordered[i]!.finalizedAt;
    shown[i] = i === ordered.length - 1 ? own : Math.min(own, shown[i + 1]!);
  }
  const lines = ordered.map(
    (entry, i) => `${localTime(new Date(shown[i]!), ':')} ${entry.text.replace(LINE_BREAKS, ' ')}`,
  );
  return [`导出日期：${localDate(exportedAt, '-')}`, '', ...lines].map((line) => `${line}\n`).join('');
}

export function exportFileName(exportedAt: Date): string {
  return `字幕-${localDate(exportedAt, '')}-${localTime(exportedAt, '')}.txt`;
}
