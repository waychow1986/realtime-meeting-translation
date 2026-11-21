import type { Platform } from './support.js';

export interface SupportRow {
  /** Platform this row describes for highlighting the visitor's own row; `null` for rows that are never highlighted. */
  platform: Platform | null;
  browser: string;
  level: '支持' | '部分支持' | '不支持';
  tab: string;
  window: string;
  screen: string;
}

const NONE = '采集不到声音';
const TAB_ONLY = '只有该标签页的声音';

/** Browser / OS × share choice (design "支持列表", A-07). Only the Linux · Chromium tab row is measured in CI (IQA-102). */
export const SUPPORT_ROWS: readonly SupportRow[] = [
  {
    platform: 'windows',
    browser: 'Windows · Chrome / Edge 最新版',
    level: '支持',
    tab: TAB_ONLY,
    window: NONE,
    screen: '电脑播放的全部声音，包括会议软件和本地播放器（需打开“同时分享系统音频”）',
  },
  {
    platform: 'macos',
    browser: 'macOS · Chrome / Edge 最新版',
    level: '部分支持',
    tab: TAB_ONLY,
    window: NONE,
    screen: '取决于系统与浏览器版本：弹窗中出现分享系统音频的选项时可采集电脑播放的全部声音，否则采集不到声音',
  },
  {
    platform: 'linux',
    browser: 'Linux · Chrome / Edge 最新版',
    level: '部分支持',
    tab: TAB_ONLY,
    window: NONE,
    screen: '通常采集不到声音',
  },
  { platform: null, browser: 'Firefox（Windows / macOS / Linux）', level: '不支持', tab: NONE, window: NONE, screen: NONE },
  { platform: null, browser: 'Safari（macOS）', level: '不支持', tab: NONE, window: NONE, screen: NONE },
  { platform: null, browser: '手机和平板上的浏览器', level: '不支持', tab: '—', window: '—', screen: '—' },
];

const LEVEL_CLASS: Record<SupportRow['level'], string> = { 支持: 'full', 部分支持: 'partial', 不支持: 'none' };

/**
 * Fills `tbody` with the rows. The visitor's row is marked `data-current` only when this browser can capture
 * system audio, since otherwise the visitor is on one of the unsupported rows.
 */
export function renderSupportMatrix(tbody: HTMLTableSectionElement, current: Platform | null): void {
  const doc = tbody.ownerDocument;
  tbody.replaceChildren(
    ...SUPPORT_ROWS.map((row) => {
      const tr = doc.createElement('tr');
      const browser = doc.createElement('th');
      browser.scope = 'row';
      browser.textContent = row.browser;
      tr.append(browser);
      for (const [text, className] of [
        [row.level, `level level-${LEVEL_CLASS[row.level]}`],
        [row.tab, ''],
        [row.window, ''],
        [row.screen, ''],
      ] as const) {
        const td = doc.createElement('td');
        td.textContent = text;
        if (className) td.className = className;
        tr.append(td);
      }
      if (current !== null && row.platform === current) {
        tr.dataset.current = 'true';
        browser.append(doc.createElement('br'), Object.assign(doc.createElement('small'), { textContent: '（当前使用）' }));
      }
      return tr;
    }),
  );
}
