import { LANGUAGE_CODE_PATTERN, MAX_TRANSLATION_TEXT_LENGTH, type TranslationRequest } from '../shared/contracts.js';
import type { TranslateFailureReason, TranslateFn, TranslateOutcome } from './translateClient.js';

export type SegmentStatus = 'interim' | 'finalizing' | 'final' | 'interrupted' | 'dropped';

/** Rendering port. Implementations must only ever render the translated (Chinese) text. */
export interface CaptionView {
  append(id: number): void;
  setText(id: number, text: string): void;
  setStatus(id: number, status: SegmentStatus): void;
  remove(id: number): void;
}

interface CaptionSegment {
  id: number;
  runEpoch: number;
  /** Latest recognized text; kept in memory only to request translations, never rendered. */
  sourceText: string;
  sourceLanguage?: string;
  status: SegmentStatus;
  shownText: string;
  inflight?: AbortController;
}

export interface CaptionPipelineDeps {
  view: CaptionView;
  translate: TranslateFn;
  /** Called once when translation is considered unavailable (E-2). */
  onTranslationUnavailable: () => void;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

const RETRYABLE: ReadonlySet<TranslateFailureReason> = new Set([
  'upstream_throttled',
  'upstream_unavailable',
  'timeout',
  'network',
  'rate_limited',
  'http_error',
]);
const NOT_COUNTED: ReadonlySet<TranslateFailureReason> = new Set(['upstream_rejected', 'invalid_request']);
const MAX_CONSECUTIVE_FAILURES = 3;
const RETRY_DELAY_MS = 1000;
const MAX_RETRY_AFTER_MS = 2000;

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

/**
 * Caption segment state machine (design: 数据流 / 识别与翻译 / 停止). Pure logic with injected
 * rendering and translation so it can be unit tested without a browser.
 */
export class CaptionPipeline {
  private readonly segments = new Map<number, CaptionSegment>();
  private seq = 0;
  private epochCounter = 0;
  private activeEpoch: number | null = null;
  private current: CaptionSegment | undefined;
  private failedSegments = 0;
  private networkFailures = 0;
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;

  constructor(private readonly deps: CaptionPipelineDeps) {
    this.sleep = deps.sleep ?? defaultSleep;
  }

  beginRun(): number {
    this.epochCounter += 1;
    this.activeEpoch = this.epochCounter;
    this.current = undefined;
    this.failedSegments = 0;
    this.networkFailures = 0;
    for (const seg of this.segments.values()) {
      if (seg.status === 'interim' || seg.status === 'finalizing') {
        seg.status = 'interrupted';
        this.deps.view.setStatus(seg.id, 'interrupted');
      }
    }
    return this.activeEpoch;
  }

  /** Synchronously invalidates the run: nothing from the old epoch may touch the captions afterwards. */
  endRun(): void {
    this.activeEpoch = null;
    this.current = undefined;
    for (const seg of this.segments.values()) {
      seg.inflight?.abort();
      seg.inflight = undefined;
    }
  }

  handleRecognizing(epoch: number, text: string, language: string | undefined): void {
    if (epoch !== this.activeEpoch) return;
    const seg = this.current ?? this.createSegment(epoch);
    seg.sourceText = text;
    seg.sourceLanguage = normalizeLanguage(language) ?? seg.sourceLanguage;
  }

  handleRecognized(epoch: number, text: string, language: string | undefined): void {
    if (epoch !== this.activeEpoch) return;
    const seg = this.current ?? this.createSegment(epoch);
    this.current = undefined;
    seg.inflight?.abort();
    seg.inflight = undefined;
    const finalText = text.trim();
    if (!finalText) {
      this.dropSegment(seg);
      return;
    }
    seg.sourceText = finalText.slice(0, MAX_TRANSLATION_TEXT_LENGTH);
    seg.sourceLanguage = normalizeLanguage(language) ?? seg.sourceLanguage;
    seg.status = 'finalizing';
    this.deps.view.setStatus(seg.id, 'finalizing');
    void this.finalize(seg);
  }

  private createSegment(epoch: number): CaptionSegment {
    this.seq += 1;
    const seg: CaptionSegment = { id: this.seq, runEpoch: epoch, sourceText: '', status: 'interim', shownText: '' };
    this.segments.set(seg.id, seg);
    this.current = seg;
    this.deps.view.append(seg.id);
    return seg;
  }

  private isLive(seg: CaptionSegment): boolean {
    return seg.runEpoch === this.activeEpoch && this.segments.has(seg.id);
  }

  private show(seg: CaptionSegment, text: string): void {
    if (seg.status === 'final' || !this.isLive(seg)) return;
    seg.shownText = text;
    this.deps.view.setText(seg.id, text);
  }

  private dropSegment(seg: CaptionSegment): void {
    seg.status = 'dropped';
    seg.inflight?.abort();
    this.segments.delete(seg.id);
    this.deps.view.remove(seg.id);
  }

  private async attempt(seg: CaptionSegment): Promise<TranslateOutcome> {
    const controller = new AbortController();
    seg.inflight = controller;
    let buffer = '';
    const request: TranslationRequest = { kind: 'final', text: seg.sourceText };
    if (seg.sourceLanguage) request.sourceLanguage = seg.sourceLanguage;
    const outcome = await this.deps.translate(request, {
      signal: controller.signal,
      onDelta: (delta) => {
        if (controller.signal.aborted) return;
        buffer += delta;
        this.show(seg, buffer);
      },
    });
    if (seg.inflight === controller) seg.inflight = undefined;
    if (outcome.ok && !buffer.trim()) return { ok: false, reason: 'upstream_unavailable' };
    return outcome;
  }

  private async finalize(seg: CaptionSegment): Promise<void> {
    let outcome = await this.attempt(seg);
    if (!this.isLive(seg)) return;
    this.trackNetwork(outcome);

    if (!outcome.ok && RETRYABLE.has(outcome.reason)) {
      this.show(seg, '');
      const delay =
        outcome.reason === 'rate_limited' && outcome.retryAfterSeconds !== undefined
          ? Math.min(outcome.retryAfterSeconds * 1000, MAX_RETRY_AFTER_MS)
          : RETRY_DELAY_MS;
      const waitController = new AbortController();
      seg.inflight = waitController;
      await this.sleep(delay, waitController.signal);
      if (!this.isLive(seg) || waitController.signal.aborted) return;
      seg.inflight = undefined;
      outcome = await this.attempt(seg);
      if (!this.isLive(seg)) return;
      this.trackNetwork(outcome);
    }

    if (outcome.ok) {
      seg.status = 'final';
      this.deps.view.setStatus(seg.id, 'final');
      this.failedSegments = 0;
      return;
    }
    if (outcome.reason === 'aborted') return;

    this.dropSegment(seg);
    if (!NOT_COUNTED.has(outcome.reason)) this.failedSegments += 1;
    this.checkAvailability();
  }

  private trackNetwork(outcome: TranslateOutcome): void {
    if (outcome.ok) this.networkFailures = 0;
    else if (outcome.reason === 'network') this.networkFailures += 1;
    this.checkAvailability();
  }

  private checkAvailability(): void {
    if (this.activeEpoch === null) return;
    if (this.failedSegments >= MAX_CONSECUTIVE_FAILURES || this.networkFailures >= MAX_CONSECUTIVE_FAILURES) {
      this.endRun();
      this.deps.onTranslationUnavailable();
    }
  }
}

function normalizeLanguage(language: string | undefined): string | undefined {
  return language && LANGUAGE_CODE_PATTERN.test(language) ? language : undefined;
}
