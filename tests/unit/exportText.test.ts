import { describe, expect, it } from 'vitest';
import type { TranscriptEntry } from '../../src/web/captionTranscript.js';
import { exportFileName, formatExport } from '../../src/web/exportText.js';

/** Local wall-clock time (the result does not depend on the process time zone). */
function at(hours: number, minutes: number, seconds: number, ms = 0, day = 25): number {
  return new Date(2026, 10, day, hours, minutes, seconds, ms).getTime();
}

function entry(id: number, text: string, finalizedAt: number): TranscriptEntry {
  return { id, text, finalizedAt };
}

const EXPORTED_AT = new Date(2026, 10, 25, 16, 2, 10);

function lines(text: string): string[] {
  return text.split('\n');
}

describe('formatExport', () => {
  it('writes the export date once, a blank line, then one "HH:MM:SS text" line per caption, each ending in \\n', () => {
    const text = formatExport(
      [entry(1, '我们下午三点开始讨论预算。', at(14, 5, 32)), entry(2, '下一项是人员安排。', at(14, 5, 40))],
      EXPORTED_AT,
    );
    expect(text).toBe('导出日期：2026-11-25\n\n14:05:32 我们下午三点开始讨论预算。\n14:05:40 下一项是人员安排。\n');
  });

  it('uses the local clock, 24-hour, two digits per field', () => {
    const text = formatExport(
      [entry(1, '早', at(9, 5, 7)), entry(2, '晚', at(23, 59, 59))],
      new Date(2026, 0, 3, 23, 59, 59, 500),
    );
    expect(lines(text)).toEqual(['导出日期：2026-01-03', '', '09:05:07 早', '23:59:59 晚', '']);
  });

  it('drops the fraction of a second instead of rounding', () => {
    const text = formatExport([entry(1, '一', at(14, 5, 32, 999))], EXPORTED_AT);
    expect(lines(text)[2]).toBe('14:05:32 一');
  });

  it('across midnight writes only the export date (once) and time of day on each line', () => {
    const text = formatExport(
      [entry(1, '午夜前', at(23, 59, 58)), entry(2, '午夜后', at(0, 0, 5, 0, 26))],
      new Date(2026, 10, 26, 0, 1, 0),
    );
    expect(lines(text)).toEqual(['导出日期：2026-11-26', '', '23:59:58 午夜前', '00:00:05 午夜后', '']);
    expect(text.match(/导出日期/g)).toHaveLength(1);
  });

  it('keeps the exact caption text and writes each line break inside a caption as one space', () => {
    const text = formatExport(
      [entry(1, '第一行\r\n第二行\n第三行\r第四行\u2028第五行\u2029第六行', at(10, 0, 0)), entry(2, '含😀的字幕', at(10, 0, 1))],
      EXPORTED_AT,
    );
    expect(lines(text).slice(2)).toEqual(['10:00:00 第一行 第二行 第三行 第四行 第五行 第六行', '10:00:01 含😀的字幕', '']);
  });

  it('orders lines by caption id (page order), not by input order', () => {
    const text = formatExport([entry(3, '三', at(10, 0, 3)), entry(1, '一', at(10, 0, 1)), entry(2, '二', at(10, 0, 2))], EXPORTED_AT);
    expect(lines(text).slice(2, 5)).toEqual(['10:00:01 一', '10:00:02 二', '10:00:03 三']);
  });

  describe('captions that became final out of page order (D-1 / TD-911)', () => {
    it('a single overtaken caption takes the earliest final time among the captions after it', () => {
      const text = formatExport(
        [entry(1, '一', at(14, 5, 41)), entry(2, '二', at(14, 5, 38)), entry(3, '三', at(14, 5, 45))],
        EXPORTED_AT,
      );
      expect(lines(text).slice(2, 5)).toEqual(['14:05:38 一', '14:05:38 二', '14:05:45 三']);
    });

    it('several consecutive overtaken captions all take the earliest later final time; others keep their own', () => {
      const text = formatExport(
        [
          entry(1, '一', at(10, 0, 20)),
          entry(2, '二', at(10, 0, 21)),
          entry(3, '三', at(10, 0, 12)),
          entry(4, '四', at(10, 0, 25)),
        ],
        EXPORTED_AT,
      );
      expect(lines(text).slice(2, 6)).toEqual(['10:00:12 一', '10:00:12 二', '10:00:12 三', '10:00:25 四']);
    });

    it('millisecond reversal within the same second stays in that second', () => {
      const text = formatExport([entry(1, '一', at(14, 5, 32, 900)), entry(2, '二', at(14, 5, 32, 100))], EXPORTED_AT);
      expect(lines(text).slice(2, 4)).toEqual(['14:05:32 一', '14:05:32 二']);
    });

    it('when the last caption became final first, every earlier line takes its time', () => {
      const text = formatExport(
        [entry(1, '一', at(10, 0, 10)), entry(2, '二', at(10, 0, 12)), entry(3, '三', at(10, 0, 5))],
        EXPORTED_AT,
      );
      expect(lines(text).slice(2, 5)).toEqual(['10:00:05 一', '10:00:05 二', '10:00:05 三']);
    });

    it('a caption that was not overtaken keeps its own final time', () => {
      const text = formatExport(
        [entry(1, '一', at(10, 0, 1)), entry(2, '二', at(10, 0, 9)), entry(3, '三', at(10, 0, 4)), entry(4, '四', at(10, 0, 8))],
        EXPORTED_AT,
      );
      expect(lines(text).slice(2, 6)).toEqual(['10:00:01 一', '10:00:04 二', '10:00:04 三', '10:00:08 四']);
    });
  });
});

describe('exportFileName', () => {
  it('is 字幕-YYYYMMDD-HHMMSS.txt in local time', () => {
    expect(exportFileName(new Date(2026, 10, 25, 16, 2, 10, 999))).toBe('字幕-20261125-160210.txt');
    expect(exportFileName(new Date(2026, 0, 3, 9, 5, 7))).toBe('字幕-20260103-090507.txt');
  });
});
