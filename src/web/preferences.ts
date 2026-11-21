/** Interface preferences kept in localStorage (TD-113). Never stores caption content. */
export type CaptionSize = 's' | 'm' | 'l' | 'xl';

export const CAPTION_SIZES: readonly CaptionSize[] = ['s', 'm', 'l', 'xl'];
export const DEFAULT_CAPTION_SIZE: CaptionSize = 'm';

const GUIDE_SEEN_KEY = 'rtmt.guideSeen';
const CAPTION_SIZE_KEY = 'rtmt.captionSize';

export interface PreferenceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface Preferences {
  isGuideSeen(): boolean;
  markGuideSeen(): void;
  captionSize(): CaptionSize;
  setCaptionSize(size: CaptionSize): void;
}

export function isCaptionSize(value: unknown): value is CaptionSize {
  return typeof value === 'string' && (CAPTION_SIZES as readonly string[]).includes(value);
}

/** Storage failures (disabled storage, quota, privacy mode) degrade to "show guide, default size". */
export function createPreferences(storage: () => PreferenceStorage | null | undefined): Preferences {
  const read = (key: string): string | null => {
    try {
      return storage()?.getItem(key) ?? null;
    } catch {
      return null;
    }
  };
  const write = (key: string, value: string): void => {
    try {
      storage()?.setItem(key, value);
    } catch {
      // preference is optional
    }
  };
  return {
    isGuideSeen: () => read(GUIDE_SEEN_KEY) === '1',
    markGuideSeen: () => write(GUIDE_SEEN_KEY, '1'),
    captionSize: () => {
      const stored = read(CAPTION_SIZE_KEY);
      return isCaptionSize(stored) ? stored : DEFAULT_CAPTION_SIZE;
    },
    setCaptionSize: (size) => write(CAPTION_SIZE_KEY, size),
  };
}
