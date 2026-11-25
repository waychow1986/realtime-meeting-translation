import { describe, expect, it } from 'vitest';
import type { CaptionView, SegmentStatus } from '../../src/web/captionPipeline.js';
import { CaptionTranscript } from '../../src/web/captionTranscript.js';

type Call = [string, ...unknown[]];

class RecordingView implements CaptionView {
  readonly calls: Call[] = [];
  append(id: number): void {
    this.calls.push(['append', id]);
  }
  setText(id: number, text: string): void {
    this.calls.push(['setText', id, text]);
  }
  setNotice(id: number, text: string): void {
    this.calls.push(['setNotice', id, text]);
  }
  setStatus(id: number, status: SegmentStatus): void {
    this.calls.push(['setStatus', id, status]);
  }
  remove(id: number): void {
    this.calls.push(['remove', id]);
  }
}

function clock(start: number): { now: () => number; set: (value: number) => void } {
  let value = start;
  return { now: () => value, set: (next) => (value = next) };
}

describe('CaptionTranscript', () => {
  it('forwards every call to the inner view unchanged and in order', () => {
    const inner = new RecordingView();
    const transcript = new CaptionTranscript(inner, () => 0);
    transcript.append(1);
    transcript.setText(1, '你好');
    transcript.setStatus(1, 'finalizing');
    transcript.setNotice(1, '（此句未能翻译成中文）');
    transcript.setStatus(1, 'final');
    transcript.remove(1);
    expect(inner.calls).toEqual([
      ['append', 1],
      ['setText', 1, '你好'],
      ['setStatus', 1, 'finalizing'],
      ['setNotice', 1, '（此句未能翻译成中文）'],
      ['setStatus', 1, 'final'],
      ['remove', 1],
    ]);
  });

  it('records a Chinese final caption with the exact page text and the time it became final', () => {
    const time = clock(1000);
    const transcript = new CaptionTranscript(new RecordingView(), time.now);
    transcript.append(1);
    transcript.setText(1, '我们下午三点');
    time.set(2000);
    transcript.setText(1, '我们下午三点开始讨论预算。');
    transcript.setStatus(1, 'finalizing');
    expect(transcript.count()).toBe(0);
    time.set(3500);
    transcript.setStatus(1, 'final');
    expect(transcript.entries()).toEqual([{ id: 1, text: '我们下午三点开始讨论预算。', finalizedAt: 3500 }]);
    expect(transcript.count()).toBe(1);
  });

  it('does not record interim, interrupted, removed or notice entries', () => {
    const transcript = new CaptionTranscript(new RecordingView(), () => 0);
    transcript.append(1);
    transcript.setText(1, '临时字幕');
    transcript.append(2);
    transcript.setText(2, '被中断的字幕');
    transcript.setStatus(2, 'interrupted');
    transcript.append(3);
    transcript.setText(3, '被删除的字幕');
    transcript.remove(3);
    transcript.append(4);
    transcript.setText(4, '안녕하세요');
    transcript.setNotice(4, '（此句未能翻译成中文）');
    transcript.setStatus(4, 'final');
    transcript.append(5);
    transcript.setStatus(5, 'final');
    expect(transcript.count()).toBe(0);
    expect(transcript.entries()).toEqual([]);
  });

  it('keeps entries in page (id) order even when they become final out of order, and records each id once', () => {
    const time = clock(0);
    const transcript = new CaptionTranscript(new RecordingView(), time.now);
    transcript.append(1);
    transcript.append(2);
    transcript.setText(1, '第一句');
    transcript.setText(2, '第二句');
    time.set(200);
    transcript.setStatus(2, 'final');
    time.set(900);
    transcript.setStatus(1, 'final');
    transcript.setStatus(1, 'final');
    expect(transcript.entries()).toEqual([
      { id: 1, text: '第一句', finalizedAt: 900 },
      { id: 2, text: '第二句', finalizedAt: 200 },
    ]);
  });

  it('notifies listeners once per new final entry, after the inner view shows it as final', () => {
    const inner = new RecordingView();
    const transcript = new CaptionTranscript(inner, () => 0);
    const seen: Array<[number, Call | undefined]> = [];
    transcript.onChange(() => seen.push([transcript.count(), inner.calls.at(-1)]));
    transcript.append(1);
    transcript.setText(1, '一');
    transcript.setStatus(1, 'finalizing');
    transcript.setStatus(1, 'final');
    transcript.append(2);
    transcript.setNotice(2, '（此句未能翻译成中文）');
    transcript.setStatus(2, 'final');
    expect(seen).toEqual([[1, ['setStatus', 1, 'final']]]);
  });

  it('returns a copy so callers cannot change the record, and is not cleared by reading', () => {
    const transcript = new CaptionTranscript(new RecordingView(), () => 5);
    transcript.append(1);
    transcript.setText(1, '一');
    transcript.setStatus(1, 'final');
    const first = transcript.entries() as Array<{ id: number; text: string; finalizedAt: number }>;
    first.pop();
    expect(transcript.entries()).toHaveLength(1);
  });
});
