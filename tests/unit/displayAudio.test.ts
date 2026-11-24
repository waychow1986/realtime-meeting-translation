import { describe, expect, it, vi } from 'vitest';
import { acquireMicrophone, type TrackLike } from '../../src/web/audioSource.js';
import {
  DISPLAY_OPTIONS,
  ShareError,
  classifyShareError,
  requestDisplayAudio,
  type AudioContextLike,
  type AudioNodeLike,
  type DisplayAudioDeps,
  type DisplayOptions,
} from '../../src/web/displayAudio.js';

class FakeTrack implements TrackLike {
  readonly listeners: (() => void)[] = [];
  stopped = false;
  readyState: 'live' | 'ended' = 'live';
  constructor(readonly kind: 'audio' | 'video') {}
  stop(): void {
    this.stopped = true;
  }
  addEventListener(_type: 'ended', listener: () => void): void {
    this.listeners.push(listener);
  }
  end(): void {
    this.listeners.forEach((listener) => listener());
  }
}

class FakeStream {
  getVideoTracks = vi.fn(() => this.tracks.filter((t) => t.kind === 'video'));
  constructor(readonly tracks: FakeTrack[]) {}
  getTracks(): FakeTrack[] {
    return [...this.tracks];
  }
  getAudioTracks(): FakeTrack[] {
    return this.tracks.filter((t) => t.kind === 'audio');
  }
}

class FakeNode implements AudioNodeLike {
  readonly connections: AudioNodeLike[] = [];
  disconnected = false;
  channelCount = 2;
  channelCountMode = 'max';
  channelInterpretation = 'discrete';
  constructor(
    readonly name: string,
    readonly stream?: FakeStream,
  ) {}
  connect(destination: AudioNodeLike): unknown {
    this.connections.push(destination);
    return destination;
  }
  disconnect(): void {
    this.disconnected = true;
  }
}

class FakeAnalyser extends FakeNode {
  fftSize = 2048;
  level = 0;
  getFloatTimeDomainData(array: Float32Array): void {
    array.fill(this.level);
  }
}

class FakeContext implements AudioContextLike<FakeStream> {
  readonly destination = new FakeNode('speakers');
  readonly nodes: FakeNode[] = [];
  readonly stateListeners = new Set<() => void>();
  state = 'running';
  sourceInput?: FakeStream;
  resumed = false;
  closed = false;
  createAnalyser(): FakeAnalyser {
    return this.add(new FakeAnalyser('analyser')) as FakeAnalyser;
  }
  addEventListener(_type: 'statechange', listener: () => void): void {
    this.stateListeners.add(listener);
  }
  removeEventListener(_type: 'statechange', listener: () => void): void {
    this.stateListeners.delete(listener);
  }
  setState(state: string): void {
    this.state = state;
    this.stateListeners.forEach((listener) => listener());
  }
  async resume(): Promise<void> {
    this.resumed = true;
  }
  async close(): Promise<void> {
    this.closed = true;
  }
  createMediaStreamSource(stream: FakeStream): FakeNode {
    this.sourceInput = stream;
    return this.add(new FakeNode('source'));
  }
  createGain(): FakeNode {
    return this.add(new FakeNode('gain'));
  }
  createMediaStreamDestination(): FakeNode & { stream: FakeStream } {
    return this.add(new FakeNode('mono', new FakeStream([new FakeTrack('audio')]))) as FakeNode & { stream: FakeStream };
  }
  private add(node: FakeNode): FakeNode {
    this.nodes.push(node);
    return node;
  }
}

interface Harness {
  deps: DisplayAudioDeps<FakeStream>;
  ctx: FakeContext;
  calls: DisplayOptions[];
  clock: { now: number };
}

function harness(result: () => Promise<FakeStream>): Harness {
  const ctx = new FakeContext();
  const calls: DisplayOptions[] = [];
  const clock = { now: 1000 };
  return {
    ctx,
    calls,
    clock,
    deps: {
      getDisplayMedia: (options) => {
        calls.push(options);
        return result();
      },
      createAudioContext: () => ctx,
      audioOnlyStream: (tracks) => new FakeStream(tracks as FakeTrack[]),
      now: () => clock.now,
    },
  };
}

const rejection = (name: string) => Object.assign(new Error('Permission denied by user'), { name });

describe('classifyShareError (TD-111)', () => {
  it('separates a dialog the user cancelled from a share blocked before any dialog appeared', () => {
    expect(classifyShareError(rejection('NotAllowedError'), 2100)).toBe('share-cancelled');
    expect(classifyShareError(rejection('NotAllowedError'), 400)).toBe('share-cancelled');
    expect(classifyShareError(rejection('NotAllowedError'), 120)).toBe('share-blocked');
  });

  it.each(['NotFoundError', 'NotReadableError', 'AbortError', 'InvalidStateError', 'TypeError'])(
    'treats %s as a generic share failure',
    (name) => expect(classifyShareError(rejection(name), 3000)).toBe('share-failed'),
  );

  it('treats non-error values as a generic share failure', () => {
    expect(classifyShareError(undefined, 3000)).toBe('share-failed');
    expect(classifyShareError('NotAllowedError', 3000)).toBe('share-failed');
  });
});

describe('DISPLAY_OPTIONS (TD-102, TD-116)', () => {
  it('asks for tab/system audio without suppressing local playback or speech processing', () => {
    expect(DISPLAY_OPTIONS.audio).toEqual({
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      suppressLocalAudioPlayback: false,
    });
    expect(DISPLAY_OPTIONS).toMatchObject({ systemAudio: 'include', selfBrowserSurface: 'exclude', preferCurrentTab: false });
  });
});

describe('requestDisplayAudio', () => {
  it('opens the share dialog synchronously with the audio context resumed in the same click (TD-102, TD-106)', () => {
    const h = harness(() => new Promise(() => undefined));
    void requestDisplayAudio(h.deps, () => undefined);
    expect(h.calls).toEqual([DISPLAY_OPTIONS]);
    expect(h.ctx.resumed).toBe(true);
  });

  it('downmixes only the audio tracks to one channel and never connects to the speakers (TD-106, TD-116)', async () => {
    const audio = new FakeTrack('audio');
    const video = new FakeTrack('video');
    const shared = new FakeStream([video, audio]);
    const h = harness(async () => shared);
    const acquired = await requestDisplayAudio(h.deps, () => undefined);

    expect(h.ctx.sourceInput?.getTracks()).toEqual([audio]);
    expect(shared.getVideoTracks).not.toHaveBeenCalled();
    const [source, gain, mono, analyser] = h.ctx.nodes as [FakeNode, FakeNode, FakeNode, FakeNode];
    expect(source.connections).toEqual([gain]);
    // The stall monitor's analyser (TD-703) is a bypass tap: it never feeds any output.
    expect(gain.connections).toEqual([mono, analyser]);
    expect(analyser.connections).toEqual([]);
    expect({ count: gain.channelCount, mode: gain.channelCountMode, interpretation: gain.channelInterpretation }).toEqual({
      count: 1,
      mode: 'explicit',
      interpretation: 'speakers',
    });
    expect(mono.channelCount).toBe(1);
    expect(h.ctx.nodes.flatMap((node) => node.connections)).not.toContain(h.ctx.destination);
    expect(acquired.stream).toBe(mono.stream);
    expect(video.stopped || audio.stopped).toBe(false);
  });

  it('release stops every shared track, disconnects and closes the context, and is idempotent', async () => {
    const tracks = [new FakeTrack('video'), new FakeTrack('audio')];
    const h = harness(async () => new FakeStream(tracks));
    const onEnded = vi.fn();
    const acquired = await requestDisplayAudio(h.deps, onEnded);
    acquired.release();
    acquired.release();
    expect(tracks.every((t) => t.stopped)).toBe(true);
    expect(h.ctx.nodes.filter((node) => node.name !== 'mono').every((node) => node.disconnected)).toBe(true);
    expect(h.ctx.closed).toBe(true);
    tracks[1]?.end();
    expect(onEnded).not.toHaveBeenCalled();
  });

  it('reports share-ended when any shared track ends (TD-107)', async () => {
    const tracks = [new FakeTrack('video'), new FakeTrack('audio')];
    const h = harness(async () => new FakeStream(tracks));
    const onEnded = vi.fn();
    await requestDisplayAudio(h.deps, onEnded);
    tracks[0]?.end();
    expect(onEnded).toHaveBeenCalledTimes(1);
  });

  it('rejects a share without audio as share-no-audio and ends that share at once (FR-122)', async () => {
    const video = new FakeTrack('video');
    const h = harness(async () => new FakeStream([video]));
    const onEnded = vi.fn();
    const error = await requestDisplayAudio(h.deps, onEnded).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ShareError);
    expect((error as ShareError).kind).toBe('share-no-audio');
    expect(video.stopped).toBe(true);
    expect(video.listeners).toEqual([]);
    expect(h.ctx.closed).toBe(true);
    expect(h.ctx.nodes).toEqual([]);
  });

  it('classifies a rejected dialog by how long it was open and closes the context', async () => {
    const h = harness(() => {
      h.clock.now += 2000;
      return Promise.reject(rejection('NotAllowedError'));
    });
    await expect(requestDisplayAudio(h.deps, () => undefined)).rejects.toMatchObject({ kind: 'share-cancelled' });
    expect(h.ctx.closed).toBe(true);

    const blocked = harness(() => Promise.reject(rejection('NotAllowedError')));
    await expect(requestDisplayAudio(blocked.deps, () => undefined)).rejects.toMatchObject({ kind: 'share-blocked' });

    const failed = harness(() => {
      throw rejection('TypeError');
    });
    await expect(requestDisplayAudio(failed.deps, () => undefined)).rejects.toMatchObject({ kind: 'share-failed' });
    expect(failed.ctx.closed).toBe(true);
  });
});

describe('AudioChainMonitor of a system-audio share (TD-703)', () => {
  async function shared() {
    const h = harness(async () => new FakeStream([new FakeTrack('video'), new FakeTrack('audio')]));
    const acquired = await requestDisplayAudio(h.deps, () => undefined);
    const analyser = h.ctx.nodes.find((node) => node.name === 'analyser') as FakeAnalyser;
    const mono = h.ctx.nodes.find((node) => node.name === 'mono') as FakeNode;
    return { h, acquired, monitor: acquired.monitor!, analyser, monoTrack: mono.stream!.tracks[0]! };
  }

  it('reads the level over a ~0.7 s window of the mixed audio', async () => {
    const { analyser } = await shared();
    expect(analyser.fftSize).toBe(32768);
  });

  it.each([
    [0, false],
    [0.001, false], // −60 dBFS
    [0.01, true], // −40 dBFS
  ])('isVoiced at RMS %s is %s (threshold −50 dBFS)', async (level, voiced) => {
    const { monitor, analyser } = await shared();
    analyser.level = level;
    expect(monitor.isVoiced()).toBe(voiced);
  });

  it('health is ok only while the context runs and the mixed output track is live', async () => {
    const { h, monitor, monoTrack } = await shared();
    expect(monitor.health()).toBe('ok');
    h.ctx.state = 'suspended';
    expect(monitor.health()).toBe('broken');
    h.ctx.state = 'running';
    monoTrack.readyState = 'ended';
    expect(monitor.health()).toBe('broken');
  });

  it('onChange reports context state changes until unsubscribed or released', async () => {
    const { h, acquired, monitor } = await shared();
    const first = vi.fn();
    const second = vi.fn();
    const unsubscribe = monitor.onChange(first);
    monitor.onChange(second);
    h.ctx.setState('suspended');
    expect(first).toHaveBeenCalledTimes(1);
    unsubscribe();
    h.ctx.setState('running');
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(2);
    acquired.release();
    h.ctx.setState('closed');
    expect(second).toHaveBeenCalledTimes(2);
    expect(h.ctx.stateListeners.size).toBe(0);
  });

  it('a microphone input has no monitor', async () => {
    const acquired = await acquireMicrophone(async () => new FakeStream([new FakeTrack('audio')]));
    expect(acquired.monitor).toBeUndefined();
  });
});

describe('acquireMicrophone (TD-101)', () => {
  it('hands the microphone stream through unchanged and releases its tracks once', async () => {
    const track = new FakeTrack('audio');
    const stop = vi.spyOn(track, 'stop');
    const stream = new FakeStream([track]);
    const acquired = await acquireMicrophone(async () => stream);
    expect(acquired.stream).toBe(stream);
    acquired.release();
    acquired.release();
    expect(stop).toHaveBeenCalledTimes(1);
  });
});
