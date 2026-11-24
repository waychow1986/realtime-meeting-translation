import { CaptionPipeline } from './captionPipeline.js';
import { DomCaptionView } from './captionView.js';
import { initGuide } from './guide.js';
import type { InputSource } from '../shared/contracts.js';
import { acquireMicrophone, type AcquiredAudio } from './audioSource.js';
import { ShareError, requestDisplayAudio, type AudioContextLike, type DisplayAudioDeps } from './displayAudio.js';
import { MESSAGES, STATE_LABELS, shareNoAudioMessage, type AppState } from './messages.js';
import { MirroredCaptionView } from './mirroredCaptionView.js';
import { CaptionWindow } from './pip.js';
import { createPreferences, isCaptionSize, type CaptionSize } from './preferences.js';
import {
  MicrophoneError,
  createRecognitionSession,
  fetchSpeechToken,
  openMicrophone,
  type RecognitionSession,
} from './recognition.js';
import { StallWatchdog } from './stallWatchdog.js';
import { detectSupport } from './support.js';
import { renderSupportMatrix } from './supportMatrix.js';
import { requestTranslation, withInputSource } from './translateClient.js';
import { STATE_ICONS, controlsFor, isNearBottom } from './uiState.js';

const TOKEN_RETRY_MS = 30_000;

type StopReason = 'user' | 'share-ended' | 'error' | 'stalled' | 'unload';

interface Run {
  epoch: number;
  /** Locked when the run starts (FR-103). */
  source: InputSource;
  audio?: AcquiredAudio<MediaStream>;
  session?: RecognitionSession;
  refreshTimer?: ReturnType<typeof setTimeout>;
  tokenAbort: AbortController;
  /** System audio only: detects that recognition silently stopped (IR-003, TD-702). */
  watchdog?: StallWatchdog;
}

function requireElement<T extends HTMLElement>(id: string, type: { new (): T }): T {
  const element = document.getElementById(id);
  if (!(element instanceof type)) throw new Error(`missing #${id}`);
  return element;
}

const displayAudioDeps: DisplayAudioDeps<MediaStream> = {
  // The extra options (systemAudio, monitorTypeSurfaces, …) are not in every DOM lib version yet.
  getDisplayMedia: (options) => navigator.mediaDevices.getDisplayMedia(options as DisplayMediaStreamOptions),
  createAudioContext: (): AudioContextLike<MediaStream> => new AudioContext(),
  audioOnlyStream: (tracks) => new MediaStream(tracks as MediaStreamTrack[]),
  now: () => performance.now(),
};

function microphoneMessage(error: unknown): string {
  const kind = error instanceof MicrophoneError ? error.kind : 'unavailable';
  if (kind === 'denied') return MESSAGES.micDenied;
  if (kind === 'not-found') return MESSAGES.micNotFound;
  if (kind === 'unsupported') return MESSAGES.unsupported;
  return MESSAGES.micUnavailable;
}

function init(): void {
  const startButton = requireElement('start-button', HTMLButtonElement);
  const stopButton = requireElement('stop-button', HTMLButtonElement);
  const statusLabel = requireElement('status', HTMLElement);
  const statusIndicator = requireElement('status-indicator', HTMLElement);
  const notice = requireElement('notice', HTMLElement);
  const captions = requireElement('captions', HTMLOListElement);
  const captionPanel = requireElement('caption-panel', HTMLElement);
  const captionScroll = requireElement('caption-scroll', HTMLElement);
  const jumpLatest = requireElement('jump-latest', HTMLButtonElement);
  const sourceRadios = [...document.querySelectorAll<HTMLInputElement>('input[name="input-source"]')];
  const sizeRadios = [...document.querySelectorAll<HTMLInputElement>('input[name="caption-size"]')];
  const systemPanel = requireElement('system-panel', HTMLElement);
  const systemUnsupported = requireElement('system-unsupported', HTMLElement);
  const systemDetails = requireElement('system-details', HTMLDetailsElement);
  const preferences = createPreferences(() => window.localStorage);
  const support = detectSupport({ navigator, window });

  renderSupportMatrix(
    requireElement('support-matrix-body', HTMLTableSectionElement),
    support.systemAudio === 'supported' ? support.platform : null,
  );
  systemUnsupported.textContent = MESSAGES.systemUnsupported;

  let state: AppState = 'idle';
  let selectedSource: InputSource = 'microphone';
  let run: Run | null = null;

  const blockedBySupport = (): boolean => selectedSource === 'system' && support.systemAudio === 'unsupported';

  const captionView = new DomCaptionView(captions, captionScroll, jumpLatest);
  const mirroredView = new MirroredCaptionView(captionView);
  const captionWindow = new CaptionWindow(
    {
      button: requireElement('pip-button', HTMLButtonElement),
      unsupported: requireElement('pip-unsupported', HTMLElement),
      captions,
    },
    mirroredView,
  );

  const setState = (next: AppState): void => {
    state = next;
    statusLabel.textContent = STATE_LABELS[next];
    statusIndicator.textContent = STATE_ICONS[next];
    document.body.dataset.state = next;
    const controls = controlsFor(next);
    startButton.disabled = !controls.startEnabled || blockedBySupport();
    stopButton.disabled = !controls.stopEnabled;
    for (const radio of sourceRadios) radio.disabled = !controls.sourceEnabled;
    captionWindow.setState(next);
    // The instructions fold away while listening so the captions get the room (can be expanded at any time), and
    // are expanded again whenever not listening: not started, stopped, error or a failed share.
    if (next === 'running') systemDetails.open = false;
    else if (next !== 'starting') systemDetails.open = true;
  };

  const showNotice = (text: string | null, kind: 'error' | 'info' = 'error'): void => {
    notice.textContent = text ?? '';
    notice.dataset.kind = kind;
    notice.hidden = text === null;
  };

  const applyCaptionSize = (size: CaptionSize): void => {
    const follow = isNearBottom(captionScroll);
    captionPanel.dataset.captionSize = size;
    captionWindow.setCaptionSize(size);
    for (const radio of sizeRadios) radio.checked = radio.value === size;
    if (follow) captionView.scrollToEnd();
  };

  const selectSource = (): void => {
    const selected = sourceRadios.find((radio) => radio.checked)?.value;
    selectedSource = selected === 'system' ? 'system' : 'microphone';
    document.body.dataset.source = selectedSource;
    systemPanel.hidden = selectedSource !== 'system';
    systemUnsupported.hidden = !blockedBySupport();
    startButton.disabled = !controlsFor(state).startEnabled || blockedBySupport();
  };

  const stopRun = (reason: StopReason): void => {
    const current = run;
    if (!current) return;
    run = null;
    current.watchdog?.stop();
    pipeline.endRun();
    current.audio?.release();
    current.tokenAbort.abort();
    if (current.refreshTimer !== undefined) clearTimeout(current.refreshTimer);
    setState(reason === 'error' || reason === 'stalled' ? 'error' : 'stopped');
    if (reason === 'error') showNotice(MESSAGES.interrupted);
    else if (reason === 'stalled') showNotice(MESSAGES.stalled);
    else if (reason === 'share-ended') showNotice(MESSAGES.shareEnded, 'info');
    void current.session?.dispose();
  };

  const failStart = (current: Run, message: string): void => {
    if (run !== current) return;
    run = null;
    pipeline.endRun();
    setState('error');
    showNotice(message);
  };

  const pipeline = new CaptionPipeline({
    view: mirroredView,
    translate: withInputSource(() => run?.source ?? selectedSource, requestTranslation),
    onTranslationUnavailable: () => stopRun('error'),
  });

  const scheduleTokenRefresh = (current: Run, delayMs: number): void => {
    current.refreshTimer = setTimeout(() => {
      if (run !== current) return;
      fetchSpeechToken(current.tokenAbort.signal)
        .then((token) => {
          if (run !== current) return;
          current.session?.updateToken(token.token);
          scheduleTokenRefresh(current, token.refreshAfterSeconds * 1000);
        })
        .catch(() => {
          if (run === current) scheduleTokenRefresh(current, TOKEN_RETRY_MS);
        });
    }, delayMs);
  };

  const shareMessage = (error: ShareError): string => {
    switch (error.kind) {
      case 'share-cancelled':
        return MESSAGES.shareCancelled;
      case 'share-blocked':
        return MESSAGES.shareBlocked;
      case 'share-no-audio':
        return shareNoAudioMessage(support.platform);
      default:
        return MESSAGES.shareFailed;
    }
  };

  /**
   * Everything up to the getDisplayMedia call runs synchronously inside the click handler so the share dialog
   * and the AudioContext still have the user activation (TD-102, TD-106). Only the chosen source is opened (FR-104).
   */
  const start = async (): Promise<void> => {
    if (!controlsFor(state).startEnabled || blockedBySupport()) return;
    showNotice(null);
    setState('starting');
    const current: Run = { epoch: pipeline.beginRun(), source: selectedSource, tokenAbort: new AbortController() };
    run = current;

    const acquiring =
      current.source === 'system'
        ? requestDisplayAudio(displayAudioDeps, () => {
            if (run === current) stopRun('share-ended');
          })
        : acquireMicrophone(openMicrophone);
    let audio: AcquiredAudio<MediaStream>;
    try {
      audio = await acquiring;
    } catch (error) {
      failStart(current, error instanceof ShareError ? shareMessage(error) : microphoneMessage(error));
      return;
    }
    if (run !== current) {
      audio.release();
      return;
    }
    current.audio = audio;

    try {
      const token = await fetchSpeechToken(current.tokenAbort.signal);
      if (run !== current) return;
      const epoch = current.epoch;
      const noteResult = (text: string): void => {
        if (run === current && text.trim() !== '') current.watchdog?.noteResult();
      };
      current.session = createRecognitionSession(audio.stream, token, {
        onRecognizing: (text, language) => {
          noteResult(text);
          pipeline.handleRecognizing(epoch, text, language);
        },
        onRecognized: (text, language) => {
          noteResult(text);
          pipeline.handleRecognized(epoch, text, language);
        },
        onFailure: (errorCode) => {
          if (run !== current) return;
          console.debug('speech recognition stopped', errorCode);
          stopRun('error');
        },
        onSessionEnded: (cause) => {
          if (run !== current) return;
          if (current.watchdog) {
            current.watchdog.noteSessionEnded();
          } else if (cause === 'session_stopped') {
            // Microphone runs (and a system run not yet listening) keep the previous behaviour.
            console.debug('speech recognition stopped', cause);
            stopRun('error');
          }
        },
      });
      await current.session.start();
      if (run !== current) return;
      setState('running');
      if (current.source === 'system' && audio.monitor) {
        current.watchdog = new StallWatchdog({
          monitor: audio.monitor,
          onStall: (cause) => {
            if (run !== current) return;
            console.debug('speech recognition stalled', cause);
            stopRun('stalled');
          },
        });
        current.watchdog.start();
      }
      scheduleTokenRefresh(current, token.refreshAfterSeconds * 1000);
    } catch (error) {
      if (run !== current) return;
      console.debug('start failed', error instanceof Error ? error.name : 'unknown');
      stopRun('error');
    }
  };

  startButton.addEventListener('click', () => void start());
  stopButton.addEventListener('click', () => stopRun('user'));
  window.addEventListener('pagehide', () => stopRun('unload'));
  for (const radio of sourceRadios) radio.addEventListener('change', selectSource);
  for (const radio of sizeRadios) {
    radio.addEventListener('change', () => {
      if (!radio.checked || !isCaptionSize(radio.value)) return;
      applyCaptionSize(radio.value);
      preferences.setCaptionSize(radio.value);
    });
  }
  // Input source is not restored from storage: every load starts with the microphone (FR-102).
  const microphone = sourceRadios.find((radio) => radio.value === 'microphone');
  if (microphone) microphone.checked = true;
  selectSource();
  applyCaptionSize(preferences.captionSize());
  setState('idle');
  showNotice(null);
  initGuide(
    requireElement('guide', HTMLDialogElement),
    requireElement('guide-open', HTMLButtonElement),
    requireElement('guide-close', HTMLButtonElement),
    preferences,
  );
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
