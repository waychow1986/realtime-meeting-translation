import { describe, expect, it } from 'vitest';
import { createPreferences, type PreferenceStorage } from '../../src/web/preferences.js';

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

  it('degrades to "always show guide, default size" when storage throws or is unavailable', () => {
    for (const source of [() => throwing, () => null, () => {
      throw new Error('access denied');
    }]) {
      const prefs = createPreferences(source);
      expect(prefs.isGuideSeen()).toBe(false);
      expect(prefs.captionSize()).toBe('m');
      expect(() => prefs.markGuideSeen()).not.toThrow();
      expect(() => prefs.setCaptionSize('l')).not.toThrow();
    }
  });
});
