import type { BrowserContext, Page } from '@playwright/test';

/** Origin of the material player page; served by Playwright routing, never by the app server. */
export const PLAYER_ORIGIN = 'http://rtmt-player.test';

/**
 * Title the share picker matches with `--auto-select-tab-capture-source-by-title` (ASCII only, TD-108).
 * One per Playwright worker so parallel workers never share each other's tab.
 */
export function playerTitle(workerIndex: number): string {
  return `RTMT-player-${workerIndex}`;
}

export interface PlayerState {
  muted: boolean;
  volume: number;
  paused: boolean;
  currentTime: number;
  /** Epoch ms of the first `playing` event: time zero of the material (sentence timings are relative to it). */
  playingAt: number | null;
}

function playerHtml(title: string): string {
  return `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8" /><title>${title}</title></head>
  <body>
    <h1>${title}</h1>
    <audio id="material" src="${PLAYER_ORIGIN}/material.wav" preload="auto" controls></audio>
    <script>
      const audio = document.getElementById('material');
      let playingAt = null;
      audio.addEventListener('playing', () => { if (playingAt === null) playingAt = Date.now(); });
      window.__play = () => audio.play().then(() => true);
      window.__playerState = () => ({
        muted: audio.muted,
        volume: audio.volume,
        paused: audio.paused,
        currentTime: audio.currentTime,
        playingAt,
      });
    </script>
  </body>
</html>`;
}

/** Serves the player page and the material WAV for one browser context. */
export async function routePlayer(context: BrowserContext, title: string, wav: () => Promise<Buffer>): Promise<void> {
  await context.route(`${PLAYER_ORIGIN}/**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/material.wav') {
      await route.fulfill({ status: 200, contentType: 'audio/wav', body: await wav() });
      return;
    }
    await route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: playerHtml(title) });
  });
}

/** Opens the player in a new tab of the context and waits until its audio can play. */
export async function openPlayer(context: BrowserContext): Promise<Page> {
  const page = await context.newPage();
  await page.goto(`${PLAYER_ORIGIN}/`);
  await page.waitForFunction('document.getElementById("material").readyState >= 3');
  return page;
}

/** Starts playback from the beginning and returns the epoch ms at which the material started playing. */
export async function playMaterial(player: Page): Promise<number> {
  await player.evaluate('window.__play()');
  await player.waitForFunction('window.__playerState().playingAt !== null');
  return (await playerState(player)).playingAt as number;
}

export function playerState(player: Page): Promise<PlayerState> {
  return player.evaluate<PlayerState>('window.__playerState()');
}
