import { CaptionPipeline } from './captionPipeline.js';
import { DomCaptionView } from './captionView.js';
import { MESSAGES, STATE_LABELS, type AppState } from './messages.js';
import {
  MicrophoneError,
  createRecognitionSession,
  fetchSpeechToken,
  openMicrophone,
  type RecognitionSession,
} from './recognition.js';
import { requestTranslation } from './translateClient.js';

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
  const notice = requireElement('notice', HTMLElement);
  const captions = requireElement('captions', HTMLOListElement);

  let state: AppState = 'idle';
  let run: Run | null = null;

  const setState = (next: AppState): void => {
    state = next;
    statusLabel.textContent = STATE_LABELS[next];
    document.body.dataset.state = next;
    startButton.disabled = next === 'starting' || next === 'running';
    stopButton.disabled = !(next === 'starting' || next === 'running');
  };

  const showNotice = (text: string | null): void => {
    notice.textContent = text ?? '';
    notice.hidden = text === null;
  };

  const stopRun = (reason: 'user' | 'error' | 'unload'): void => {
    const current = run;
    if (!current) return;
    run = null;
    pipeline.endRun();
    current.stream?.getTracks().forEach((track) => track.stop());
    current.tokenAbort.abort();
    if (current.refreshTimer !== undefined) clearTimeout(current.refreshTimer);
    setState('stopped');
    if (reason === 'error') showNotice(MESSAGES.interrupted);
    void current.session?.dispose();
  };

  const pipeline = new CaptionPipeline({
    view: new DomCaptionView(captions),
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
    if (state === 'starting' || state === 'running') return;
    const previous = state;
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
      setState(previous);
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
  setState('idle');
  showNotice(null);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
