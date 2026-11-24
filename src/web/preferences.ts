/** Interface preferences kept in localStorage (TD-113). Never stores caption content. */
export type CaptionSize = 's' | 'm' | 'l' | 'xl';

export const CAPTION_SIZES: readonly CaptionSize[] = ['s', 'm', 'l', 'xl'];
export const DEFAULT_CAPTION_SIZE: CaptionSize = 'm';

/** Caption line spacing (TD-801): 紧凑 / 标准 / 宽松. "normal" equals the spacing before it became adjustable. */
export type CaptionSpacing = 'compact' | 'normal' | 'loose';

export const CAPTION_SPACINGS: readonly CaptionSpacing[] = ['compact', 'normal', 'loose'];
export const DEFAULT_CAPTION_SPACING: CaptionSpacing = 'normal';

const GUIDE_SEEN_KEY = 'rtmt.guideSeen';
const CAPTION_SIZE_KEY = 'rtmt.captionSize';
const CAPTION_SPACING_KEY = 'rtmt.captionSpacing';

export interface PreferenceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface Preferences {
  isGuideSeen(): boolean;
  markGuideSeen(): void;
  captionSize(): CaptionSize;
  setCaptionSize(size: CaptionSize): void;
  captionSpacing(): CaptionSpacing;
  setCaptionSpacing(spacing: CaptionSpacing): void;
}

export function isCaptionSize(value: unknown): value is CaptionSize {
  return typeof value === 'string' && (CAPTION_SIZES as readonly string[]).includes(value);
}

export function isCaptionSpacing(value: unknown): value is CaptionSpacing {
  return typeof value === 'string' && (CAPTION_SPACINGS as readonly string[]).includes(value);
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
    captionSpacing: () => {
      const stored = read(CAPTION_SPACING_KEY);
      return isCaptionSpacing(stored) ? stored : DEFAULT_CAPTION_SPACING;
    },
    setCaptionSpacing: (spacing) => write(CAPTION_SPACING_KEY, spacing),
  };
}
