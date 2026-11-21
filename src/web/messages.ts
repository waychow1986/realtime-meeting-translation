import type { Platform } from './support.js';

export type AppState = 'idle' | 'starting' | 'running' | 'stopped' | 'error';

/** Status names (FR-128, TD-110). Each state also has its own colour and icon in styles.css. */
export const STATE_LABELS: Record<AppState, string> = {
  idle: '未开始',
  starting: '正在启动…',
  running: '正在听',
  stopped: '已停止',
  error: '出错',
};

export const MESSAGES = {
  micDenied: '无法使用麦克风：权限被拒绝。请在浏览器中允许本页面使用麦克风后，再次点击“开始”。',
  micNotFound: '无法使用麦克风：未检测到可用的麦克风设备。请接入麦克风后，再次点击“开始”。',
  micUnavailable: '无法使用麦克风：麦克风当前不可用。请检查设备后，再次点击“开始”。',
  interrupted: '翻译已中断，请稍后重新开始。',
  unsupported: '当前浏览器不支持麦克风采集，请使用最新版的桌面浏览器打开本页面。',
  shareCancelled:
    '未开始翻译：没有选择共享内容，或共享授权被拒绝。请再次点击“开始”，在弹窗中选择标签页或整个屏幕，打开共享音频后点击“分享”。',
  shareBlocked:
    '未开始翻译：浏览器或系统阻止了共享。请点击地址栏左侧的站点设置图标，检查是否允许本页面共享屏幕；macOS 用户还需在“系统设置 → 隐私与安全性 → 屏幕与系统录音”中允许当前浏览器，然后再次点击“开始”。',
  shareFailed: '无法开始共享，请重试；如仍失败，请改为共享正在播放的标签页。',
  shareEnded: '共享已结束，翻译已停止。如需继续，请点击“开始”并重新选择共享内容。',
  systemUnsupported:
    '当前浏览器不支持采集系统声音。请使用 Windows 或 macOS 上最新版的 Chrome 或 Edge 打开本页面；也可以改选“麦克风”。',
  pipUnsupported: '当前浏览器不支持悬浮字幕小窗。请使用 Windows 或 macOS 上最新版的 Chrome 或 Edge。',
} as const;

const SHARE_NO_AUDIO_PREFIX = '所选的共享内容没有包含声音，无法翻译。';
const SHARE_NO_AUDIO_RETRY = '然后再次点击“开始”。';

/** E-103: names the share choices that do carry audio on the user's platform. */
export function shareNoAudioMessage(platform: Platform): string {
  const tab = '选择“标签页”并选中正在播放的标签页，保持“同时分享标签页中的音频”处于打开状态';
  const advice =
    platform === 'windows' || platform === 'other'
      ? `请${tab}；或选择“整个屏幕”并打开“同时分享系统音频”，`
      : `请${tab}（在当前系统上共享窗口或整个屏幕通常采集不到声音），`;
  return SHARE_NO_AUDIO_PREFIX + advice + SHARE_NO_AUDIO_RETRY;
}
