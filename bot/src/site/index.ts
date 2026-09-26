// Loads the X site definition (x.json) and the in-page functions (x.inpage.js), and builds the one
// expression shape both drivers evaluate in the page. Nothing else in the bot knows X's markup.
import fs from 'node:fs';
import path from 'node:path';
import type { SiteBundle, SiteConfig } from '../drivers/types.js';

export const SITE: SiteConfig = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'x.json'), 'utf8'));

// Read as text, never imported: see the header of x.inpage.js for why.
export const INPAGE_SRC: string = fs.readFileSync(path.join(import.meta.dirname, 'x.inpage.js'), 'utf8');

/**
 * A JavaScript expression that runs in-page function `name` and evaluates to its result as a JSON
 * string (the caller JSON.parses it). The Python sidecar builds exactly the same string.
 */
export function inPageExpr(name: string, extra: Record<string, unknown> = {}, site: SiteConfig = SITE): string {
  const ctx = { sel: site.sel, text: site.text, guard: site.guard, ...extra };
  return `JSON.stringify((${INPAGE_SRC})[${JSON.stringify(name)}](${JSON.stringify(ctx)}))`;
}

/** What the browser-use driver ships to the sidecar on open. Tests override `homeUrl`. */
export function siteBundle(overrides: Partial<SiteConfig> = {}): SiteBundle {
  return { site: { ...SITE, ...overrides }, inpage: INPAGE_SRC };
}
