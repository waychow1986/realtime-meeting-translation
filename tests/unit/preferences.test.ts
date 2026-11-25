import { describe, expect, it } from 'vitest';
import { CAPTION_SPACINGS, createPreferences, isCaptionSpacing, type PreferenceStorage } from '../../src/web/preferences.js';

function memoryStorage(initial: Record<string, string> = {}): PreferenceStorage & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
  };
}

const throwing: PreferenceStorage = {
  getItem: () => {
    throw new Error('SecurityError');
  },
  setItem: () => {
    throw new Error('QuotaExceededError');
  },
};

describe('preferences', () => {
  it('shows the guide until it has been marked as seen, and remembers it with rtmt.guideSeen', () => {
    const storage = memoryStorage();
    const prefs = createPreferences(() => storage);
    expect(prefs.isGuideSeen()).toBe(false);
    prefs.markGuideSeen();
    expect(storage.data.get('rtmt.guideSeen')).toBe('1');
    expect(createPreferences(() => storage).isGuideSeen()).toBe(true);
  });

  it('defaults the caption size to "m" and restores a stored size', () => {
    const storage = memoryStorage();
    const prefs = createPreferences(() => storage);
    expect(prefs.captionSize()).toBe('m');
    prefs.setCaptionSize('xl');
    expect(storage.data.get('rtmt.captionSize')).toBe('xl');
    expect(createPreferences(() => storage).captionSize()).toBe('xl');
  });

  it('ignores invalid stored caption sizes', () => {
    for (const value of ['', 'xxl', 'M', '32px']) {
      expect(createPreferences(() => memoryStorage({ 'rtmt.captionSize': value })).captionSize()).toBe('m');
    }
  });

  it('defaults the caption spacing to "normal" and restores a stored spacing with rtmt.captionSpacing', () => {
    const storage = memoryStorage({ 'rtmt.captionSize': 'l' });
    const prefs = createPreferences(() => storage);
    expect(prefs.captionSpacing()).toBe('normal');
    prefs.setCaptionSpacing('loose');
    expect(storage.data.get('rtmt.captionSpacing')).toBe('loose');
    expect(createPreferences(() => storage).captionSpacing()).toBe('loose');
    prefs.setCaptionSpacing('compact');
    expect(createPreferences(() => storage).captionSpacing()).toBe('compact');
    // The caption size is stored independently and unchanged.
    expect(storage.data.get('rtmt.captionSize')).toBe('l');
    expect([...storage.data.keys()].sort()).toEqual(['rtmt.captionSize', 'rtmt.captionSpacing']);
  });

  it('ignores invalid stored caption spacings', () => {
    for (const value of ['', 'tight', 'Loose', 'NORMAL', '1.5']) {
      expect(createPreferences(() => memoryStorage({ 'rtmt.captionSpacing': value })).captionSpacing()).toBe('normal');
    }
  });

  it('accepts exactly the three caption spacings', () => {
    expect(CAPTION_SPACINGS).toEqual(['compact', 'normal', 'loose']);
    for (const value of CAPTION_SPACINGS) expect(isCaptionSpacing(value)).toBe(true);
    for (const value of ['', 'tight', 'Loose', null, undefined, 1.5]) expect(isCaptionSpacing(value)).toBe(false);
  });

  it('degrades to "always show guide, default size" when storage throws or is unavailable', () => {
    for (const source of [() => throwing, () => null, () => {
      throw new Error('access denied');
    }]) {
      const prefs = createPreferences(source);
      expect(prefs.isGuideSeen()).toBe(false);
      expect(prefs.captionSize()).toBe('m');
      expect(() => prefs.markGuideSeen()).not.toThrow();
      expect(() => prefs.setCaptionSize('l')).not.toThrow();
      expect(prefs.captionSpacing()).toBe('normal');
      expect(() => prefs.setCaptionSpacing('loose')).not.toThrow();
      expect(prefs.captionSpacing()).toBe('normal');
    }
  });
});
