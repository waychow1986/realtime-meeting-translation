import type { CaptionView, SegmentStatus } from './captionPipeline.js';
import { isNearBottom } from './uiState.js';

/**
 * DOM rendering of caption segments. Text is written via textContent only (no HTML injection).
 * The scroll container follows new content only while the reader is at (or near) the bottom; when they have
 * scrolled up to read earlier captions, a "jump to latest" button appears instead (FR-130).
 */
export class DomCaptionView implements CaptionView {
  private readonly nodes = new Map<number, HTMLLIElement>();

  constructor(
    private readonly list: HTMLOListElement,
    private readonly scroller: HTMLElement,
    private readonly jumpButton?: HTMLButtonElement,
    /** The caption window has no "jump to latest" button: it always shows the newest caption (TD-104). */
    private readonly alwaysFollow = false,
  ) {
    // Items already in the list (cloned from the main page into the caption window) are tracked by segment id.
    for (const item of list.querySelectorAll<HTMLLIElement>('li.caption[data-segment-id]')) {
      this.nodes.set(Number(item.dataset.segmentId), item);
    }
    scroller.addEventListener('scroll', () => {
      if (this.jumpButton && isNearBottom(scroller)) this.jumpButton.hidden = true;
    });
    jumpButton?.addEventListener('click', () => this.scrollToEnd());
  }

  append(id: number): void {
    const item = this.list.ownerDocument.createElement('li');
    item.className = 'caption';
    item.dataset.status = 'interim';
    item.dataset.segmentId = String(id);
    this.update(() => {
      this.nodes.set(id, item);
      this.list.appendChild(item);
    });
  }

  setText(id: number, text: string): void {
    const item = this.nodes.get(id);
    if (!item) return;
    this.update(() => {
      item.textContent = text;
    });
  }

  /** A notice entry (TD-309): same list item, marked with data-kind so it is styled apart from translations. */
  setNotice(id: number, text: string): void {
    const item = this.nodes.get(id);
    if (!item) return;
    this.update(() => {
      item.textContent = text;
      item.dataset.kind = 'notice';
    });
  }

  setStatus(id: number, status: SegmentStatus): void {
    const item = this.nodes.get(id);
    if (!item) return;
    this.update(() => {
      item.dataset.status = status;
    });
  }

  remove(id: number): void {
    this.nodes.get(id)?.remove();
    this.nodes.delete(id);
  }

  scrollToEnd(): void {
    this.scroller.scrollTop = this.scroller.scrollHeight;
    if (this.jumpButton) this.jumpButton.hidden = true;
  }

  private update(change: () => void): void {
    const follow = this.alwaysFollow || isNearBottom(this.scroller);
    change();
    if (follow) this.scrollToEnd();
    else if (this.jumpButton) this.jumpButton.hidden = false;
  }
}
