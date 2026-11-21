export type Platform = 'windows' | 'macos' | 'linux' | 'other';

export interface SupportInfo {
  systemAudio: 'supported' | 'unsupported';
  platform: Platform;
  pip: boolean;
}

interface UserAgentDataLike {
  mobile?: boolean;
  platform?: string;
  brands?: readonly { brand: string }[];
}

/** The parts of `navigator` and `window` the capability detection reads (TD-105). */
export interface SupportEnvironment {
  navigator: {
    mediaDevices?: { getDisplayMedia?: unknown };
    userAgentData?: UserAgentDataLike;
    userAgent?: string;
  };
  window: object;
}

const CHROMIUM_BRANDS = ['Chromium', 'Google Chrome', 'Microsoft Edge'];

function platformOf(nav: SupportEnvironment['navigator']): Platform {
  const name = nav.userAgentData?.platform ?? nav.userAgent ?? '';
  if (/windows|win32|win64/i.test(name)) return 'windows';
  if (/mac/i.test(name)) return 'macos';
  if (/linux/i.test(name) && !/android|cros/i.test(name)) return 'linux';
  return 'other';
}

/**
 * Only Chromium-based desktop browsers hand out tab/system audio with a shared surface, so system audio is
 * detected by engine (User-Agent Client Hints exist only there) rather than by calling getDisplayMedia,
 * which would open the share dialog (TD-105).
 */
export function detectSupport(env: SupportEnvironment): SupportInfo {
  const nav = env.navigator;
  const uaData = nav.userAgentData;
  const chromium =
    typeof nav.mediaDevices?.getDisplayMedia === 'function' &&
    uaData !== undefined &&
    uaData.mobile === false &&
    (uaData.brands ?? []).some((entry) => CHROMIUM_BRANDS.includes(entry.brand));
  return {
    systemAudio: chromium ? 'supported' : 'unsupported',
    platform: platformOf(nav),
    pip: 'documentPictureInPicture' in env.window,
  };
}
