import type { CaptionView, SegmentStatus } from './captionPipeline.js';

/**
 * Writes every caption change to the main page view and, while the caption window is open, to its view as well
 * (TD-104): one pipeline, two DOMs, same order, same task. The main view is always written first; a failing
 * window view is dropped so the main page keeps updating (FR-138).
 */
export class MirroredCaptionView implements CaptionView {
  private second: CaptionView | null = null;

  constructor(private readonly main: CaptionView) {}

  attach(view: CaptionView): void {
    this.second = view;
  }

  detach(view: CaptionView): void {
    if (this.second === view) this.second = null;
  }

  append(id: number): void {
    this.main.append(id);
    this.mirror((view) => view.append(id));
  }

  setText(id: number, text: string): void {
    this.main.setText(id, text);
    this.mirror((view) => view.setText(id, text));
  }

  setStatus(id: number, status: SegmentStatus): void {
    this.main.setStatus(id, status);
    this.mirror((view) => view.setStatus(id, status));
  }

  remove(id: number): void {
    this.main.remove(id);
    this.mirror((view) => view.remove(id));
  }

  private mirror(write: (view: CaptionView) => void): void {
    const view = this.second;
    if (!view) return;
    try {
      write(view);
    } catch {
      this.detach(view);
    }
  }
}
