// Picks the browser layer. Each driver is imported only when chosen, so running with Playwright
// never loads the browser-use proxy (and vice versa).
import type { Config, DriverChoice } from '../config.js';
import type { FeedDriver } from './types.js';

export const DRIVERS: DriverChoice[] = ['playwright', 'browser-use'];

export async function createDriver(name: DriverChoice, cfg: Config): Promise<FeedDriver> {
  switch (name) {
    case 'playwright': {
      const { PlaywrightDriver } = await import('./playwright.js');
      return new PlaywrightDriver({ ...cfg.playwright, smoothScroll: cfg.run.smoothScroll });
    }
    case 'browser-use': {
      const { default: createBrowserUseDriver } = await import('./browser-use.js');
      return createBrowserUseDriver({ ...cfg.browserUse, smoothScroll: cfg.run.smoothScroll });
    }
    default:
      throw new Error(`unknown driver "${name as string}" (expected ${DRIVERS.join(' or ')})`);
  }
}
