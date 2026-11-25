import type { CaptionView, SegmentStatus } from './captionPipeline.js';

/** One Chinese final caption, as shown on the page. */
export interface TranscriptEntry {
  /** Same as the segment id / DOM data-segment-id; ascending order is page order. */
  id: number;
  /** The very string written to the page. */
  text: string;
  /** When the caption became final on the page (Date.now() milliseconds). */
  finalizedAt: number;
}

/**
 * Wraps the caption view and remembers the Chinese final captions of this page, in memory only (TD-901, TD-908).
 * Every call is forwarded first, then recorded, so listeners run after the page already shows the caption as final.
 * Notice entries ("（此句未能翻译成中文）"), removed and interrupted entries are never recorded (TD-902).
 */
export class CaptionTranscript implements CaptionView {
  private readonly pending = new Map<number, { text: string; notice: boolean }>();
  private readonly records: TranscriptEntry[] = [];
  private readonly listeners: Array<() => void> = [];

  constructor(
    private readonly inner: CaptionView,
    private readonly now: () => number = Date.now,
  ) {}

  entries(): readonly TranscriptEntry[] {
    return this.records.map((entry) => ({ ...entry }));
  }

  count(): number {
    return this.records.length;
  }

  onChange(listener: () => void): void {
    this.listeners.push(listener);
  }

  append(id: number): void {
    this.inner.append(id);
    this.pending.set(id, { text: '', notice: false });
  }

  setText(id: number, text: string): void {
    this.inner.setText(id, text);
    const item = this.pending.get(id);
    if (item) item.text = text;
  }

  setNotice(id: number, text: string): void {
    this.inner.setNotice(id, text);
    const item = this.pending.get(id);
    if (item) item.notice = true;
  }

  setStatus(id: number, status: SegmentStatus): void {
    this.inner.setStatus(id, status);
    if (status !== 'final') return;
    const item = this.pending.get(id);
    if (!item) return;
    this.pending.delete(id);
    if (item.notice || item.text === '') return;
    const entry: TranscriptEntry = { id, text: item.text, finalizedAt: this.now() };
    let index = this.records.length;
    while (index > 0 && this.records[index - 1]!.id > id) index -= 1;
    this.records.splice(index, 0, entry);
    for (const listener of this.listeners) listener();
  }

  remove(id: number): void {
    this.inner.remove(id);
    this.pending.delete(id);
  }
}
