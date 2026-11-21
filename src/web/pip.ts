import { DomCaptionView } from './captionView.js';
import { MESSAGES, STATE_LABELS, type AppState } from './messages.js';
import type { MirroredCaptionView } from './mirroredCaptionView.js';
import { STATE_ICONS } from './uiState.js';

/** Document Picture-in-Picture is not in every DOM lib version yet. */
interface DocumentPictureInPicture {
  requestWindow(options?: { width?: number; height?: number }): Promise<Window>;
  readonly window: Window | null;
}

declare global {
  interface Window {
    documentPictureInPicture?: DocumentPictureInPicture;
  }
}

const WINDOW_SIZE = { width: 560, height: 260 };

export interface CaptionWindowElements {
  button: HTMLButtonElement;
  unsupported: HTMLElement;
  /** Main page caption list, cloned into the window when it opens. */
  captions: HTMLOListElement;
}

interface OpenWindow {
  win: Window;
  view: DomCaptionView;
  status: HTMLElement;
  indicator: HTMLElement;
}

/**
 * Floating caption window (TD-104, FR-136～FR-140): a same-origin Document PiP document holding the status and a
 * second DomCaptionView fed by the shared MirroredCaptionView. No media elements are placed in it (FR-108).
 */
export class CaptionWindow {
  private current: OpenWindow | null = null;
  private opening = false;
  private state: AppState = 'idle';
  private captionSize = 'm';

  constructor(
    private readonly elements: CaptionWindowElements,
    private readonly mirror: MirroredCaptionView,
  ) {
    const supported = window.documentPictureInPicture !== undefined;
    elements.unsupported.textContent = MESSAGES.pipUnsupported;
    elements.unsupported.hidden = supported;
    elements.button.disabled = !supported;
    elements.button.textContent = MESSAGES.pipOpen;
    if (supported) elements.button.addEventListener('click', () => this.toggle());
  }

  setState(state: AppState): void {
    this.state = state;
    if (this.current) this.renderState(this.current);
  }

  setCaptionSize(size: string): void {
    this.captionSize = size;
    if (this.current) this.current.win.document.body.dataset.captionSize = size;
  }

  private toggle(): void {
    if (this.current) this.close();
    else void this.open();
  }

  /** requestWindow is called synchronously inside the click handler so it still has the user activation. */
  private async open(): Promise<void> {
    const api = window.documentPictureInPicture;
    if (!api || this.opening) return;
    this.opening = true;
    let win: Window;
    try {
      win = await api.requestWindow(WINDOW_SIZE);
    } catch (error) {
      console.debug('caption window not opened', error instanceof Error ? error.name : 'unknown');
      return;
    } finally {
      this.opening = false;
    }
    this.current = this.build(win);
    this.elements.button.textContent = MESSAGES.pipClose;
    this.elements.button.setAttribute('aria-pressed', 'true');
  }

  private close(): void {
    const current = this.current;
    if (!current) return;
    this.detach(current);
    current.win.close();
  }

  private detach(current: OpenWindow): void {
    if (this.current !== current) return;
    this.mirror.detach(current.view);
    this.current = null;
    this.elements.button.textContent = MESSAGES.pipOpen;
    this.elements.button.setAttribute('aria-pressed', 'false');
  }

  private build(win: Window): OpenWindow {
    const doc = win.document;
    doc.documentElement.lang = 'zh-CN';
    doc.title = MESSAGES.pipTitle;
    const stylesheet = doc.createElement('link');
    stylesheet.rel = 'stylesheet';
    stylesheet.href = `${location.origin}/styles.css`;
    doc.head.append(stylesheet);

    const body = doc.body;
    body.className = 'pip';
    body.dataset.captionSize = this.captionSize;
    const bar = doc.createElement('header');
    bar.className = 'pip-bar status-box';
    const indicator = doc.createElement('span');
    indicator.className = 'status-indicator';
    indicator.setAttribute('aria-hidden', 'true');
    const status = doc.createElement('strong');
    status.id = 'pip-status';
    status.setAttribute('role', 'status');
    bar.append(indicator, status);
    const scroller = doc.createElement('div');
    scroller.className = 'pip-scroll';
    const list = doc.createElement('ol');
    list.id = 'pip-captions';
    list.className = 'captions';
    list.setAttribute('aria-live', 'polite');
    for (const item of this.elements.captions.children) list.append(doc.importNode(item, true));
    scroller.append(list);
    body.replaceChildren(bar, scroller);

    const view = new DomCaptionView(list, scroller, undefined, true);
    const current: OpenWindow = { win, view, status, indicator };
    this.renderState(current);
    this.mirror.attach(view);
    view.scrollToEnd();
    win.addEventListener('pagehide', () => this.detach(current), { once: true });
    return current;
  }

  private renderState(current: OpenWindow): void {
    current.status.textContent = STATE_LABELS[this.state];
    current.indicator.textContent = STATE_ICONS[this.state];
    current.win.document.body.dataset.state = this.state;
  }
}
