import { describe, expect, it } from 'vitest';
import { detectSupport, type SupportEnvironment } from '../../src/web/support.js';

const getDisplayMedia = () => undefined;
const brands = (...names: string[]) => names.map((brand) => ({ brand, version: '131' }));

function env(navigator: SupportEnvironment['navigator'], window: object = {}): SupportEnvironment {
  return { navigator, window };
}

describe('detectSupport (TD-105)', () => {
  it.each([
    ['Chrome on Windows', brands('Not_A Brand', 'Chromium', 'Google Chrome'), 'Windows', 'windows'],
    ['Edge on macOS', brands('Chromium', 'Microsoft Edge'), 'macOS', 'macos'],
    ['Chromium on Linux', brands('Chromium'), 'Linux', 'linux'],
    ['Chrome on ChromeOS', brands('Google Chrome'), 'Chrome OS', 'other'],
  ])('supports %s', (_name, brandList, platform, expected) => {
    const info = detectSupport(
      env({ mediaDevices: { getDisplayMedia }, userAgentData: { mobile: false, platform, brands: brandList } }),
    );
    expect(info).toMatchObject({ systemAudio: 'supported', platform: expected });
  });

  it('does not support Chromium on a phone or tablet', () => {
    const info = detectSupport(
      env({ mediaDevices: { getDisplayMedia }, userAgentData: { mobile: true, platform: 'Android', brands: brands('Chromium') } }),
    );
    expect(info.systemAudio).toBe('unsupported');
  });

  it('does not support Firefox or Safari even though they offer getDisplayMedia', () => {
    const firefox = detectSupport(
      env({ mediaDevices: { getDisplayMedia }, userAgent: 'Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0' }),
    );
    expect(firefox).toMatchObject({ systemAudio: 'unsupported', platform: 'linux' });
    const safari = detectSupport(
      env({
        mediaDevices: { getDisplayMedia },
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.1 Safari/605.1.15',
      }),
    );
    expect(safari).toMatchObject({ systemAudio: 'unsupported', platform: 'macos' });
  });

  it('does not support a browser without getDisplayMedia or with an unknown brand', () => {
    expect(
      detectSupport(env({ mediaDevices: {}, userAgentData: { mobile: false, platform: 'Windows', brands: brands('Chromium') } }))
        .systemAudio,
    ).toBe('unsupported');
    expect(
      detectSupport(
        env({ mediaDevices: { getDisplayMedia }, userAgentData: { mobile: false, platform: 'Windows', brands: brands('Opera') } }),
      ).systemAudio,
    ).toBe('unsupported');
    expect(detectSupport(env({})).systemAudio).toBe('unsupported');
  });

  it('reports picture-in-picture availability from documentPictureInPicture', () => {
    expect(detectSupport(env({}, { documentPictureInPicture: {} })).pip).toBe(true);
    expect(detectSupport(env({}, {})).pip).toBe(false);
  });
});
