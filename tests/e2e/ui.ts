import type { Page } from '@playwright/test';

/** Rendered box of an element in CSS pixels, relative to the viewport. */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ControlBox extends Box {
  selector: string;
  /** Content wider than the element (text cut off). */
  clipped: boolean;
}

export interface LayoutProbe {
  viewport: { w: number; h: number };
  doc: { scrollWidth: number; clientWidth: number };
  controls: ControlBox[];
  header: Box;
  panel: Box;
  overflowingCaptions: number;
  scrollerOverflowX: boolean;
  captionCount: number;
}

/** The four FR-127 items first, then the remaining controls that must not overlap them. */
export const FR127_CONTROLS = ['#input-source', '#start-button', '#stop-button', '.status-box'];
const OTHER_CONTROLS = ['h1', '#caption-size', '#pip-button', '#guide-open'];

// Browser-side source text: the test tsconfig has no DOM lib.
const LAYOUT_PROBE = `(() => {
  const box = (el) => { const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; };
  const q = (selector) => document.querySelector(selector);
  const selectors = ${JSON.stringify([...FR127_CONTROLS, ...OTHER_CONTROLS])};
  const scroller = q('#caption-scroll');
  const captions = [...document.querySelectorAll('#captions li.caption')].filter((li) => li.textContent.trim());
  return {
    viewport: { w: window.innerWidth, h: window.innerHeight },
    doc: { scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth },
    controls: selectors.map((selector) => ({ selector, ...box(q(selector)), clipped: q(selector).scrollWidth > q(selector).clientWidth + 1 })),
    header: box(q('.topbar')),
    panel: box(q('#caption-panel')),
    overflowingCaptions: captions.filter((li) => li.scrollWidth > li.clientWidth + 1).length,
    scrollerOverflowX: scroller.scrollWidth > scroller.clientWidth + 1,
    captionCount: captions.length,
  };
})()`;

export function probeLayout(page: Page): Promise<LayoutProbe> {
  return page.evaluate<LayoutProbe>(LAYOUT_PROBE);
}

export function overlapArea(a: Box, b: Box): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

export function insideViewport(box: Box, viewport: { w: number; h: number }): boolean {
  return box.w > 0 && box.h > 0 && box.x >= -0.5 && box.y >= -0.5 && box.x + box.w <= viewport.w + 0.5 && box.y + box.h <= viewport.h + 0.5;
}

export interface TextStyle {
  fontSize: number;
  lineHeight: number;
  color: string;
  borderLeftStyle: string;
  after: string;
  fontStyle: string;
}

export interface CaptionStyleProbe {
  final: TextStyle | null;
  interim: TextStyle | null;
  panelBackground: string;
  /** Largest font size of any other rendered text on the page (title, controls, hints, notices). */
  maxOtherFontSize: number;
  panelArea: number;
  otherAreas: { selector: string; area: number }[];
  latestVisible: boolean;
}

const STYLE_PROBE = `(() => {
  const style = (el) => {
    if (!el) return null;
    const cs = getComputedStyle(el);
    return {
      fontSize: parseFloat(cs.fontSize),
      lineHeight: parseFloat(cs.lineHeight),
      color: cs.color,
      borderLeftStyle: cs.borderLeftStyle,
      after: getComputedStyle(el, '::after').content,
      fontStyle: cs.fontStyle,
    };
  };
  const filled = (status) => [...document.querySelectorAll('#captions li.caption[data-status="' + status + '"]')].filter((li) => li.textContent.trim());
  const captions = document.getElementById('captions');
  let maxOther = 0;
  for (const el of document.body.querySelectorAll('*')) {
    if (captions.contains(el) || el.getClientRects().length === 0) continue;
    const ownText = [...el.childNodes].some((node) => node.nodeType === Node.TEXT_NODE && node.textContent.trim());
    if (ownText && getComputedStyle(el).visibility !== 'hidden') maxOther = Math.max(maxOther, parseFloat(getComputedStyle(el).fontSize));
  }
  const area = (selector) => { const el = document.querySelector(selector); if (!el || el.getClientRects().length === 0) return 0; const r = el.getBoundingClientRect(); return r.width * r.height; };
  const scroller = document.getElementById('caption-scroll').getBoundingClientRect();
  const all = [...captions.querySelectorAll('li.caption')].filter((li) => li.textContent.trim());
  const last = all[all.length - 1];
  const lastBox = last ? last.getBoundingClientRect() : null;
  return {
    final: style(filled('final').pop()),
    interim: style(filled('interim').pop() || filled('finalizing').pop()),
    panelBackground: getComputedStyle(document.getElementById('caption-panel')).backgroundColor,
    maxOtherFontSize: maxOther,
    panelArea: area('#caption-panel'),
    otherAreas: ['.topbar', '#notice'].map((selector) => ({ selector, area: area(selector) })),
    latestVisible: !lastBox || (lastBox.bottom <= scroller.bottom + 1 && lastBox.bottom > scroller.top),
  };
})()`;

export function probeCaptionStyle(page: Page): Promise<CaptionStyleProbe> {
  return page.evaluate<CaptionStyleProbe>(STYLE_PROBE);
}

function channel(value: number): number {
  const c = value / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function luminance(color: string): number {
  const match = color.match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)/);
  if (!match) throw new Error(`unsupported colour ${color}`);
  const [r, g, b] = match.slice(1, 4).map(Number) as [number, number, number];
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG 2 contrast ratio of two opaque `rgb()` colours. */
export function contrastRatio(foreground: string, background: string): number {
  const [hi, lo] = [luminance(foreground), luminance(background)].sort((a, b) => b - a) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}
