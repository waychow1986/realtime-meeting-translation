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
} as const;
