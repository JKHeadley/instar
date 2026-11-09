/**
 * Console navigation (docs/specs/console-makeover.md §2): every legacy tab in
 * the legacy dashboard's TAB_REGISTRY is reachable from exactly one console
 * group, as an ordinary link (no embedding). Read from the registry itself so a
 * newly added legacy tab can never go missing from the console.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GROUPS, CONSOLE_ONLY_TABS, allTabIds, legacyHref, ICONS, MERGED, NATIVE_PAGES, LEGACY_DASHBOARD, tabHref } from '../../dashboard/console/nav-model.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HTML = fs.readFileSync(path.resolve(__dirname, '../../dashboard/index.html'), 'utf-8');

function registryIds(): string[] {
  const start = HTML.indexOf('const TAB_REGISTRY = [');
  expect(start).toBeGreaterThan(-1);
  const body = HTML.slice(start, HTML.indexOf('\n    ];', start));
  return [...body.matchAll(/^\s{6}\{\s*\n?\s*id:\s*'([a-z-]+)'/gm)].map((m) => m[1]);
}

describe('console navigation', () => {
  it('covers every legacy tab exactly once', () => {
    const legacy = registryIds();
    expect(legacy.length).toBeGreaterThanOrEqual(29);
    const ids = allTabIds();
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.filter((id) => !CONSOLE_ONLY_TABS.includes(id)).sort()).toEqual([...legacy].sort());
  });

  it('no tile only says where its content moved; every merged tab still redirects to its page', () => {
    for (const t of GROUPS.flatMap((g) => [...g.tabs, ...(g.hood || [])])) expect(t.desc).not.toMatch(/^Now inside/);
    for (const id of MERGED) expect(NATIVE_PAGES[id as keyof typeof NATIVE_PAGES]).toBeTruthy();
  });

  it('has five top-level destinations for the phone bar (Home + four groups)', () => {
    expect(GROUPS).toHaveLength(4);
  });

  it('links to the legacy dashboard by ordinary URL', () => {
    expect(legacyHref('files')).toBe('/dashboard/legacy?tab=files');
    expect(legacyHref('a b')).toBe('/dashboard/legacy?tab=a%20b');
    // /dashboard itself opens the console now, so a legacy link must name the legacy page.
    expect(LEGACY_DASHBOARD).toBe('/dashboard/legacy');
  });

  it('the Phones tile opens the pairing code page (dashboard-console-default-and-pair-page §3.2)', () => {
    expect(NATIVE_PAGES.phones).toBe('/dashboard/pair');
    expect(tabHref('phones')).toBe('/dashboard/pair');
  });

  it('every tile has a plain-language description and a known icon', () => {
    for (const g of GROUPS) {
      expect(ICONS[g.icon]).toBeTruthy();
      for (const t of [...g.tabs, ...(g.hood || [])]) {
        expect(t.desc.length).toBeGreaterThan(10);
        if ('icon' in t && t.icon) expect(ICONS[t.icon as string]).toBeTruthy();
      }
    }
  });
});
