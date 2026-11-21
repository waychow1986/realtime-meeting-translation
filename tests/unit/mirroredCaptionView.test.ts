import { describe, expect, it } from 'vitest';
import type { CaptionView, SegmentStatus } from '../../src/web/captionPipeline.js';
import { MirroredCaptionView } from '../../src/web/mirroredCaptionView.js';

type Call = [string, string, ...unknown[]];

class RecordingView implements CaptionView {
  constructor(
    private readonly name: string,
    private readonly calls: Call[],
  ) {}
  append(id: number): void {
    this.calls.push([this.name, 'append', id]);
  }
  setText(id: number, text: string): void {
    this.calls.push([this.name, 'setText', id, text]);
  }
  setStatus(id: number, status: SegmentStatus): void {
    this.calls.push([this.name, 'setStatus', id, status]);
  }
  remove(id: number): void {
    this.calls.push([this.name, 'remove', id]);
  }
}

function drive(view: CaptionView): void {
  view.append(1);
  view.setText(1, '你好');
  view.setStatus(1, 'final');
  view.remove(1);
}

describe('MirroredCaptionView', () => {
  it('without a second view only writes the main view', () => {
    const calls: Call[] = [];
    drive(new MirroredCaptionView(new RecordingView('main', calls)));
    expect(calls.map((call) => call[0])).toEqual(['main', 'main', 'main', 'main']);
  });

  it('writes every change to the main view first, then to the attached view, with the same arguments', () => {
    const calls: Call[] = [];
    const view = new MirroredCaptionView(new RecordingView('main', calls));
    view.attach(new RecordingView('pip', calls));
    drive(view);
    expect(calls).toEqual([
      ['main', 'append', 1],
      ['pip', 'append', 1],
      ['main', 'setText', 1, '你好'],
      ['pip', 'setText', 1, '你好'],
      ['main', 'setStatus', 1, 'final'],
      ['pip', 'setStatus', 1, 'final'],
      ['main', 'remove', 1],
      ['pip', 'remove', 1],
    ]);
  });

  it('stops writing to a detached view while the main view keeps updating', () => {
    const calls: Call[] = [];
    const view = new MirroredCaptionView(new RecordingView('main', calls));
    const pip = new RecordingView('pip', calls);
    view.attach(pip);
    view.append(1);
    view.detach(pip);
    view.setText(1, '继续');
    expect(calls).toEqual([
      ['main', 'append', 1],
      ['pip', 'append', 1],
      ['main', 'setText', 1, '继续'],
    ]);
  });

  it('ignores detaching a view that is no longer attached (a newer window replaced it)', () => {
    const calls: Call[] = [];
    const view = new MirroredCaptionView(new RecordingView('main', calls));
    const old = new RecordingView('old', calls);
    const current = new RecordingView('new', calls);
    view.attach(old);
    view.attach(current);
    view.detach(old);
    view.append(2);
    expect(calls).toEqual([
      ['main', 'append', 2],
      ['new', 'append', 2],
    ]);
  });

  it('a failing second view never disturbs the main view', () => {
    const calls: Call[] = [];
    const view = new MirroredCaptionView(new RecordingView('main', calls));
    view.attach({
      append: () => {
        throw new Error('window closed');
      },
      setText: () => undefined,
      setStatus: () => undefined,
      remove: () => undefined,
    });
    expect(() => view.append(3)).not.toThrow();
    view.setText(3, '仍然更新');
    expect(calls).toEqual([
      ['main', 'append', 3],
      ['main', 'setText', 3, '仍然更新'],
    ]);
  });
});
