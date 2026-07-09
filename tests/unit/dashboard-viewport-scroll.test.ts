/**
 * Dashboard viewport smoke — F4 of the Dashboard UX Standard
 * (docs/specs/dashboard-ux-standard.md; FD-2).
 *
 * F4: `document.body` must never scroll horizontally at any supported viewport
 * (1280 / 768 / 390px). The audit (2026-07-08) found panels overflowing the
 * viewport's right edge at 390px so the whole page scrolled sideways on a phone.
 *
 * This is the ONE floor that needs a real layout engine (scrollWidth is a
 * rendered measurement jsdom cannot produce). Per FD-2 it is a BROWSER-GATED
 * check: it renders the dashboard in a real browser when one is available, and
 * SKIPS HONESTLY (never a false green) when no browser is present — the CI
 * browser job supplies the browser; the ordinary unit run skips it.
 *
 * The structural half of F4 (grid children carry `min-width: 0` so a wide child
 * cannot blow out the row) is enforced statically below and always runs.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DASHBOARD_HTML = path.resolve(__dirname, '..', '..', 'dashboard', 'index.html');

/** Try to load a browser driver; return null (→ skip) when none is installed. */
async function loadBrowser(): Promise<{ launch: () => Promise<any> } | null> {
  for (const mod of ['playwright', 'playwright-core', 'puppeteer']) {
    try {
      const m: any = await import(mod);
      if (mod.startsWith('playwright')) return { launch: () => m.chromium.launch() };
      return { launch: () => m.launch() };
    } catch {
      /* not installed — try the next */
    }
  }
  return null;
}

const VIEWPORTS = [
  { name: 'desktop', width: 1280, height: 860 },
  { name: 'tablet', width: 768, height: 900 },
  { name: 'phone', width: 390, height: 844 },
];

describe('dashboard viewport smoke floor (F4)', () => {
  // Structural half — always runs, no browser needed.
  it('every grid-child panel container carries min-width:0 (no wide-child row blowout)', () => {
    const html = fs.readFileSync(DASHBOARD_HTML, 'utf-8');
    // Each of these classes is a direct .app grid child (grid-column: 1 / -1);
    // without min-width:0 a wide descendant forces the row wider than the
    // viewport and the body scrolls sideways.
    const GRID_CHILD_CONTAINERS = [
      'tab-panel',
      'files-container',
      'jobs-container',
      'systems-container',
      'features-container',
    ];
    const missing: string[] = [];
    for (const cls of GRID_CHILD_CONTAINERS) {
      const re = new RegExp(`\\.${cls}\\s*\\{([^}]*)\\}`);
      const m = html.match(re);
      if (!m || !/min-width:\s*0/.test(m[1])) missing.push(cls);
    }
    expect(
      missing,
      `Grid-child panel containers missing min-width:0 (F4 — they can blow out the row): ${missing.join(', ')}`
    ).toEqual([]);
  });

  // Rendered half — browser-gated, skips honestly when no browser is present.
  it('body never scrolls horizontally at 1280/768/390 (browser-gated)', async (ctx) => {
    const driver = await loadBrowser();
    if (!driver) {
      ctx.skip(); // FD-2: no browser here — the CI browser job runs this. Never a false green.
      return;
    }
    const browser = await driver.launch();
    try {
      const page = await browser.newPage();
      await page.goto(pathToFileURL(DASHBOARD_HTML).href);
      for (const vp of VIEWPORTS) {
        await page.setViewportSize({ width: vp.width, height: vp.height });
        const overflow = await page.evaluate(
          () => document.body.scrollWidth - document.documentElement.clientWidth
        );
        expect(
          overflow,
          `body scrolls horizontally at ${vp.name} (${vp.width}px): scrollWidth exceeds viewport by ${overflow}px`
        ).toBeLessThanOrEqual(1); // 1px tolerance for sub-pixel rounding
      }
    } finally {
      await browser.close();
    }
  });
});
