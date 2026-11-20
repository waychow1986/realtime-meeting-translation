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
  /** Version of the last partial request sent / of the partial text currently shown (TD-006). */
  partialRev: number;
  shownRev: number;
  /** In-flight final translation (or its retry wait). */
  inflight?: AbortController;
  /** In-flight partial translation; at most one per segment (TD-006). */
  partialInflight?: AbortController;
  lastPartialAt?: number;
  /** Source text whose partial translation succeeded last; unchanged text is not re-sent. */
  partialSource?: string;
  cancelPartialTimer?: () => void;
}

export interface CaptionPipelineDeps {
  view: CaptionView;
  translate: TranslateFn;
  /** Called once when translation is considered unavailable (E-2). */
  onTranslationUnavailable: () => void;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Clock and timer used by the partial throttle; injectable for tests. */
  now?: () => number;
  schedule?: (fn: () => void, ms: number) => () => void;
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
export const PARTIAL_INTERVAL_MS = 500;

function defaultSchedule(fn: () => void, ms: number): () => void {
  const timer = setTimeout(fn, ms);
  return () => clearTimeout(timer);
}

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
  private readonly now: () => number;
  private readonly schedule: (fn: () => void, ms: number) => () => void;

  constructor(private readonly deps: CaptionPipelineDeps) {
    this.sleep = deps.sleep ?? defaultSleep;
    this.now = deps.now ?? Date.now;
    this.schedule = deps.schedule ?? defaultSchedule;
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
      this.release(seg);
    }
    return this.activeEpoch;
  }

  /** Synchronously invalidates the run: nothing from the old epoch may touch the captions afterwards. */
  endRun(): void {
    this.activeEpoch = null;
    this.current = undefined;
    for (const seg of this.segments.values()) {
      this.stopPartials(seg);
      seg.inflight?.abort();
      seg.inflight = undefined;
    }
  }

  handleRecognizing(epoch: number, text: string, language: string | undefined): void {
    if (epoch !== this.activeEpoch) return;
    const seg = this.current ?? this.createSegment(epoch);
    seg.sourceText = text.slice(0, MAX_TRANSLATION_TEXT_LENGTH);
    seg.sourceLanguage = normalizeLanguage(language) ?? seg.sourceLanguage;
    this.maybeSendPartial(seg);
  }

  handleRecognized(epoch: number, text: string, language: string | undefined): void {
    if (epoch !== this.activeEpoch) return;
    const seg = this.current ?? this.createSegment(epoch);
    this.current = undefined;
    this.stopPartials(seg);
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
    const seg: CaptionSegment = {
      id: this.seq,
      runEpoch: epoch,
      sourceText: '',
      status: 'interim',
      shownText: '',
      partialRev: 0,
      shownRev: 0,
    };
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
    this.stopPartials(seg);
    this.release(seg);
    this.deps.view.remove(seg.id);
  }

  /** Forgets a segment that can no longer change, including its source text (kept in memory only while needed). */
  private release(seg: CaptionSegment): void {
    seg.sourceText = '';
    seg.partialSource = undefined;
    this.segments.delete(seg.id);
  }

  private stopPartials(seg: CaptionSegment): void {
    seg.cancelPartialTimer?.();
    seg.cancelPartialTimer = undefined;
    seg.partialInflight?.abort();
    seg.partialInflight = undefined;
  }

  /** TD-006: single flight per segment, latest text wins, at most one send per PARTIAL_INTERVAL_MS. */
  private maybeSendPartial(seg: CaptionSegment): void {
    if (seg.status !== 'interim' || !this.isLive(seg) || seg.partialInflight || seg.cancelPartialTimer) return;
    if (!seg.sourceText.trim() || seg.sourceText === seg.partialSource) return;
    const wait = seg.lastPartialAt === undefined ? 0 : seg.lastPartialAt + PARTIAL_INTERVAL_MS - this.now();
    if (wait <= 0) {
      void this.sendPartial(seg);
      return;
    }
    seg.cancelPartialTimer = this.schedule(() => {
      seg.cancelPartialTimer = undefined;
      this.maybeSendPartial(seg);
    }, wait);
  }

  private async sendPartial(seg: CaptionSegment): Promise<void> {
    const controller = new AbortController();
    seg.partialInflight = controller;
    seg.lastPartialAt = this.now();
    seg.partialRev += 1;
    const rev = seg.partialRev;
    const text = seg.sourceText;
    let buffer = '';
    const request: TranslationRequest = { kind: 'partial', text };
    if (seg.sourceLanguage) request.sourceLanguage = seg.sourceLanguage;
    const outcome = await this.deps.translate(request, {
      signal: controller.signal,
      onDelta: (delta) => {
        if (controller.signal.aborted) return;
        buffer += delta;
        // Avoid flicker: a newer revision replaces the caption only once it is at least as long.
        if (rev === seg.shownRev || (rev > seg.shownRev && buffer.length >= seg.shownText.length)) {
          this.showInterim(seg, rev, buffer);
        }
      },
    });
    if (seg.partialInflight !== controller || controller.signal.aborted) return;
    seg.partialInflight = undefined;
    if (seg.status !== 'interim' || !this.isLive(seg)) return;
    // Failures and rate limits are silent and not counted (TD-010); the next tick retries with the latest text.
    if (outcome.ok && buffer.trim()) {
      if (rev >= seg.shownRev) this.showInterim(seg, rev, buffer);
      seg.partialSource = text;
    }
    this.maybeSendPartial(seg);
  }

  private showInterim(seg: CaptionSegment, rev: number, text: string): void {
    if (seg.status !== 'interim' || !this.isLive(seg)) return;
    seg.shownRev = rev;
    this.show(seg, text);
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
      this.release(seg);
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
