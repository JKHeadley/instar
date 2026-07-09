/**
 * Dashboard tab-purpose floor — F3 of the Dashboard UX Standard
 * (docs/specs/dashboard-ux-standard.md; Structure > Willpower).
 *
 * The audit (2026-07-08) found tab panels shipping with NO plain-language
 * purpose line — a non-expert opening the tab could not tell what it was for.
 * F3 requires every registered tab to carry one muted, self-explanatory
 * sentence near its top. This floor guarantees a NEW tab cannot ship without
 * one: it maps every TAB_REGISTRY tab to its panel markup and fails, naming the
 * tab, if none of its panels contains a recognized purpose-line element.
 *
 * Recognized purpose-line classes (the dashboard's established conventions;
 * F7 will later consolidate these into one shared vocabulary):
 *   - `tab-purpose`       — the F3 canonical class
 *   - `ph-intro`          — the Process-Health design-system intro (ph-root tabs)
 *   - `features-subtitle` — Features tab subtitle
 *   - `dropzone-subtitle` — Send-Content tab subtitle
 *
 * Guarded by a population floor so a regressed matcher fails loudly, not silently.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DASHBOARD_HTML = path.resolve(__dirname, '..', '..', 'dashboard', 'index.html');

const PURPOSE_CLASS_RE =
  /class="[^"]*\b(?:tab-purpose|ph-intro|features-subtitle|dropzone-subtitle)\b[^"]*"/;

/**
 * Tabs that legitimately need NO purpose line. Adding here requires a written
 * justification — the default is that every tab carries one.
 */
const PURPOSE_EXEMPT: Record<string, string> = {
  // No exemptions: every registered tab carries a purpose line.
};

function readDashboard(): string {
  return fs.readFileSync(DASHBOARD_HTML, 'utf-8');
}

/** [{id, panels:[...]}] parsed from the TAB_REGISTRY source-of-truth array. */
function tabRegistry(html: string): Array<{ id: string; panels: string[] }> {
  const start = html.indexOf('const TAB_REGISTRY = [');
  expect(start, 'TAB_REGISTRY must exist').toBeGreaterThan(-1);
  const end = html.indexOf('\n    ];', start);
  expect(end, 'TAB_REGISTRY must close').toBeGreaterThan(start);
  const slice = html.slice(start, end);
  const entries: Array<{ id: string; panels: string[] }> = [];
  const entryRe = /\bid:\s*'([a-z0-9-]+)',\s*\n\s*panels:\s*\[([^\]]*)\]/g;
  let m: RegExpExecArray | null;
  while ((m = entryRe.exec(slice)) !== null) {
    const panels = m[2]
      .split(',')
      .map(s => s.trim().replace(/^'|'$/g, ''))
      .filter(Boolean);
    entries.push({ id: m[1], panels });
  }
  return entries;
}

/** Index of every panel element's opening tag, for bounding a panel's segment. */
function panelOpenIndex(html: string, panelId: string): number {
  return html.indexOf(`id="${panelId}"`);
}

describe('dashboard tab-purpose floor (F3)', () => {
  it('every registered tab carries a plain-language purpose line', () => {
    const html = readDashboard();
    const registry = tabRegistry(html);

    // Population floor: the sweep must see the known population (25 at writing).
    expect(registry.length, 'TAB_REGISTRY tabs visible to the floor').toBeGreaterThanOrEqual(20);

    // All panel-open indices, sorted — used to bound each panel's markup segment
    // so a match cannot bleed in from the following panel.
    const allOpens = registry
      .flatMap(t => t.panels)
      .map(p => panelOpenIndex(html, p))
      .filter(i => i >= 0)
      .sort((a, b) => a - b);

    function segmentFor(panelId: string): string | null {
      const open = panelOpenIndex(html, panelId);
      if (open < 0) return null;
      const next = allOpens.find(i => i > open);
      return html.slice(open, next ?? open + 4000);
    }

    const missing: string[] = [];
    for (const tab of registry) {
      if (tab.id in PURPOSE_EXEMPT) continue;
      const hasPurpose = tab.panels.some(p => {
        const seg = segmentFor(p);
        return seg != null && PURPOSE_CLASS_RE.test(seg);
      });
      if (!hasPurpose) missing.push(tab.id);
    }

    expect(
      missing,
      `Tabs with NO plain-language purpose line (the F3 bug): ${missing.join(', ')}. ` +
        `Add a <div class="tab-purpose">one plain sentence saying what this tab is for</div> ` +
        `near the top of the tab's panel.`
    ).toEqual([]);
  });

  it('the tab-purpose class is defined in CSS', () => {
    const html = readDashboard();
    expect(
      /\.tab-purpose\s*\{/.test(html),
      'a .tab-purpose CSS rule must exist (muted, readable purpose line)'
    ).toBe(true);
  });
});
