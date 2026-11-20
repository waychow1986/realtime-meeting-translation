import type { CaptionView, SegmentStatus } from './captionPipeline.js';

/** DOM rendering of caption segments. Text is written via textContent only (no HTML injection). */
export class DomCaptionView implements CaptionView {
  private readonly nodes = new Map<number, HTMLLIElement>();

  constructor(private readonly list: HTMLOListElement) {}

  append(id: number): void {
    const item = document.createElement('li');
    item.className = 'caption';
    item.dataset.status = 'interim';
    this.nodes.set(id, item);
    this.list.appendChild(item);
  }

  setText(id: number, text: string): void {
    const item = this.nodes.get(id);
    if (!item) return;
    item.textContent = text;
    this.scrollToEnd();
  }

  setStatus(id: number, status: SegmentStatus): void {
    const item = this.nodes.get(id);
    if (item) item.dataset.status = status;
  }

  remove(id: number): void {
    this.nodes.get(id)?.remove();
    this.nodes.delete(id);
  }

  private scrollToEnd(): void {
    const container = this.list.parentElement;
    if (container) container.scrollTop = container.scrollHeight;
  }
}
