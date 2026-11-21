import type { Preferences } from './preferences.js';

/** First-run guide (FR-133): opens automatically until closed once in this browser; reopenable at any time. */
export function initGuide(
  dialog: HTMLDialogElement,
  openButton: HTMLButtonElement,
  closeButton: HTMLButtonElement,
  preferences: Preferences,
): void {
  const open = (): void => {
    if (!dialog.open) dialog.showModal();
  };
  // Closing by "知道了" or Esc both count as having seen the guide.
  dialog.addEventListener('close', () => preferences.markGuideSeen());
  closeButton.addEventListener('click', () => dialog.close());
  openButton.addEventListener('click', open);
  if (!preferences.isGuideSeen()) open();
}
