/**
 * Dashboard nav-reachability floor — F2 of the Dashboard UX Standard
 * (docs/specs/dashboard-ux-standard.md; Structure > Willpower).
 *
 * The dashboard grew to 25 tabs in a flat horizontal `.tab-bar` that clipped at
 * ~8 tabs on a 1280px viewport with a hidden scrollbar — the other ~17 tabs
 * (Spend, Machines, Mandates, …) were unreachable by pointer. The operator
 * reported it 2026-07-08 ("EASY to navigate"). The fix: ONE grouped dropdown menu,
 * reachable at every viewport via the always-visible `.nav-toggle`.
 *
 * This floor guarantees the fix cannot silently regress:
 *   1. EVERY registered tab (TAB_REGISTRY) has a nav button, and there are no
 *      orphan nav buttons — a new tab that forgets its nav control fails here.
 *   2. The nav is GROUPED (labeled sections), the operator-approved model (FD-1).
 *   3. The nav is reachable at ALL widths — the toggle is not mobile-only and the
 *      menu opens via `.app.nav-open` — not a fixed-width clip.
 *
 * Guarded by a population floor so a regressed matcher fails loudly, not silently.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DASHBOARD_HTML = path.resolve(__dirname, '..', '..', 'dashboard', 'index.html');

function readDashboard(): string {
  return fs.readFileSync(DASHBOARD_HTML, 'utf-8');
}

/** The `<nav ... id="tabBar"> … </nav>` markup block. */
function navMarkup(html: string): string {
  const open = html.indexOf('<nav');
  expect(open, 'dashboard/index.html must contain a <nav>').toBeGreaterThan(-1);
  const idAnchor = html.indexOf('id="tabBar"', open);
  expect(idAnchor, 'the nav must be id="tabBar"').toBeGreaterThan(-1);
  const close = html.indexOf('</nav>', idAnchor);
  expect(close, '<nav> must have a closing tag').toBeGreaterThan(idAnchor);
  return html.slice(open, close);
}

/** data-tab ids of the nav buttons. */
function navTabIds(html: string): string[] {
  const slice = navMarkup(html);
  const re = /data-tab="([a-z0-9-]+)"/g;
  const ids: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(slice)) !== null) ids.push(m[1]);
  return ids;
}

/** tab ids declared in the TAB_REGISTRY array (the source of truth for tabs). */
function registryTabIds(html: string): string[] {
  const start = html.indexOf('const TAB_REGISTRY = [');
  expect(start, 'TAB_REGISTRY must exist').toBeGreaterThan(-1);
  // The registry array closes at the first "];" after it.
  const end = html.indexOf('];', start);
  expect(end, 'TAB_REGISTRY must close').toBeGreaterThan(start);
  const slice = html.slice(start, end);
  const re = /\bid:\s*'([a-z0-9-]+)'/g;
  const ids: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(slice)) !== null) ids.push(m[1]);
  return ids;
}

describe('dashboard nav reachability floor (F2)', () => {
  it('every registered tab has a reachable nav button, and there are no orphans', () => {
    const html = readDashboard();
    const navIds = navTabIds(html);
    const regIds = registryTabIds(html);

    // Population floor: the sweep must see the known population (25 at writing).
    expect(navIds.length, 'nav buttons visible to the floor').toBeGreaterThanOrEqual(20);
    expect(regIds.length, 'registry tabs visible to the floor').toBeGreaterThanOrEqual(20);

    const navSet = new Set(navIds);
    const regSet = new Set(regIds);

    const unreachable = regIds.filter(id => !navSet.has(id));
    expect(
      unreachable,
      `Registered tabs with NO nav button (unreachable — the F2 bug): ${unreachable.join(', ')}. ` +
        `Add a <button class="tab" data-tab="ID" onclick="switchTab('ID')"> inside a .tab-group in the nav.`
    ).toEqual([]);

    const orphan = navIds.filter(id => !regSet.has(id));
    expect(
      orphan,
      `Nav buttons pointing at NO registered tab (dead controls): ${orphan.join(', ')}.`
    ).toEqual([]);
  });

  it('the nav is grouped into labeled sections (FD-1, operator-approved)', () => {
    const html = readDashboard();
    const slice = navMarkup(html);
    const groups = (slice.match(/class="tab-group"/g) || []).length;
    const labels = (slice.match(/class="tab-group-label"/g) || []).length;
    expect(groups, 'the nav must use grouped sections (.tab-group)').toBeGreaterThanOrEqual(3);
    expect(labels, 'each group must carry a visible .tab-group-label').toBeGreaterThanOrEqual(groups);
  });

  it('the nav is reachable at ALL widths (a menu, not a fixed-width clip)', () => {
    const html = readDashboard();
    // The toggle must be visible at base width (not mobile-only) — it is the
    // single entry point to the grouped menu.
    const toggleRule = html.match(/\.nav-toggle\s*\{[^}]*\}/);
    expect(toggleRule, '.nav-toggle CSS rule must exist').toBeTruthy();
    expect(
      toggleRule![0].includes('display: flex'),
      '.nav-toggle must be display:flex at base width (reachable at every viewport, not mobile-only)'
    ).toBe(true);
    // The menu opens via .app.nav-open — the reachability mechanism.
    expect(
      html.includes('.app.nav-open .tab-bar'),
      'the nav menu must open via .app.nav-open .tab-bar'
    ).toBe(true);
  });
});
