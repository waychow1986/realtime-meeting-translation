import { CaptionPipeline } from './captionPipeline.js';
import { DomCaptionView } from './captionView.js';
import { initGuide } from './guide.js';
import { MESSAGES, STATE_LABELS, type AppState } from './messages.js';
import { createPreferences, isCaptionSize, type CaptionSize } from './preferences.js';
import {
  MicrophoneError,
  createRecognitionSession,
  fetchSpeechToken,
  openMicrophone,
  type RecognitionSession,
} from './recognition.js';
import { requestTranslation } from './translateClient.js';
import { STATE_ICONS, controlsFor, isNearBottom } from './uiState.js';

const TOKEN_RETRY_MS = 30_000;

interface Run {
  epoch: number;
  stream?: MediaStream;
  session?: RecognitionSession;
  refreshTimer?: ReturnType<typeof setTimeout>;
  tokenAbort: AbortController;
}

function requireElement<T extends HTMLElement>(id: string, type: { new (): T }): T {
  const element = document.getElementById(id);
  if (!(element instanceof type)) throw new Error(`missing #${id}`);
  return element;
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
  const preferences = createPreferences(() => window.localStorage);

  let state: AppState = 'idle';
  let run: Run | null = null;

  const setState = (next: AppState): void => {
    state = next;
    statusLabel.textContent = STATE_LABELS[next];
    statusIndicator.textContent = STATE_ICONS[next];
    document.body.dataset.state = next;
    const controls = controlsFor(next);
    startButton.disabled = !controls.startEnabled;
    stopButton.disabled = !controls.stopEnabled;
    for (const radio of sourceRadios) {
      radio.disabled = !controls.sourceEnabled || radio.dataset.unavailable === 'true';
    }
  };

  const showNotice = (text: string | null, kind: 'error' | 'info' = 'error'): void => {
    notice.textContent = text ?? '';
    notice.dataset.kind = kind;
    notice.hidden = text === null;
  };

  const captionView = new DomCaptionView(captions, captionScroll, jumpLatest);

  const applyCaptionSize = (size: CaptionSize): void => {
    const follow = isNearBottom(captionScroll);
    captionPanel.dataset.captionSize = size;
    for (const radio of sizeRadios) radio.checked = radio.value === size;
    if (follow) captionView.scrollToEnd();
  };

  const selectSource = (): void => {
    const selected = sourceRadios.find((radio) => radio.checked)?.value;
    document.body.dataset.source = selected === 'system' ? 'system' : 'microphone';
  };

  const stopRun = (reason: 'user' | 'error' | 'unload'): void => {
    const current = run;
    if (!current) return;
    run = null;
    pipeline.endRun();
    current.stream?.getTracks().forEach((track) => track.stop());
    current.tokenAbort.abort();
    if (current.refreshTimer !== undefined) clearTimeout(current.refreshTimer);
    setState(reason === 'error' ? 'error' : 'stopped');
    if (reason === 'error') showNotice(MESSAGES.interrupted);
    void current.session?.dispose();
  };

  const pipeline = new CaptionPipeline({
    view: captionView,
    translate: requestTranslation,
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

  const start = async (): Promise<void> => {
    if (!controlsFor(state).startEnabled) return;
    showNotice(null);
    setState('starting');
    const current: Run = { epoch: pipeline.beginRun(), tokenAbort: new AbortController() };
    run = current;

    try {
      current.stream = await openMicrophone();
    } catch (error) {
      if (run !== current) return;
      run = null;
      pipeline.endRun();
      setState('error');
      const kind = error instanceof MicrophoneError ? error.kind : 'unavailable';
      showNotice(
        kind === 'denied'
          ? MESSAGES.micDenied
          : kind === 'not-found'
            ? MESSAGES.micNotFound
            : kind === 'unsupported'
              ? MESSAGES.unsupported
              : MESSAGES.micUnavailable,
      );
      return;
    }
    if (run !== current) {
      current.stream.getTracks().forEach((track) => track.stop());
      return;
    }

    try {
      const token = await fetchSpeechToken(current.tokenAbort.signal);
      if (run !== current) return;
      const epoch = current.epoch;
      current.session = createRecognitionSession(current.stream, token, {
        onRecognizing: (text, language) => pipeline.handleRecognizing(epoch, text, language),
        onRecognized: (text, language) => pipeline.handleRecognized(epoch, text, language),
        onFailure: (errorCode) => {
          if (run !== current) return;
          console.debug('speech recognition stopped', errorCode);
          stopRun('error');
        },
      });
      await current.session.start();
      if (run !== current) return;
      setState('running');
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
