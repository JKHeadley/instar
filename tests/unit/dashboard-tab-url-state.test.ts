/**
 * #1442 — the selected dashboard tab must survive a page refresh.
 *
 * Before this, updateFileUrl() wrote `?tab=` ONLY for Files and deleted it for every
 * other tab, and handleDeepLink() honored only `tab === 'files'` — so any refresh
 * dumped the operator back on Sessions. This test extracts the SHIPPED updateUrlState
 * + handleDeepLink from dashboard/index.html and runs them in jsdom with injected
 * globals, proving the actual behavior (not a source grep):
 *   - updateUrlState records the tab for every non-default tab, and round-trips
 *     through handleDeepLink back to a switchTab() of that tab,
 *   - an unknown/removed ?tab= value falls through to the default (no switchTab, no
 *     throw), and existing ?tab=files&path=… links still work.
 */
// @ts-nocheck — exercises inline browser JS extracted from index.html.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.resolve(__dirname, '..', '..', 'dashboard', 'index.html'), 'utf-8');

/** Pull a top-level (4-space-indented) `function name() { … }` verbatim from index.html. */
function extract(name: string): string {
  const re = new RegExp(`    function ${name}\\(\\) \\{[\\s\\S]*?\\n    \\}`);
  const m = html.match(re);
  if (!m) throw new Error(`could not extract ${name}() from index.html — did it move/rename?`);
  return m[0];
}

const SRC = extract('updateUrlState') + '\n' + extract('handleDeepLink');

interface Harness {
  updateUrlState: () => void;
  handleDeepLink: () => void;
  search: () => string;
  switched: string[];
}

function harness(opts: {
  query?: string;
  currentTab?: string;
  currentFilePath?: string;
  activeSession?: string | null;
  registry?: string[];
} = {}): Harness {
  const registry = opts.registry ?? ['sessions', 'files', 'commitments', 'blockers', 'machines', 'systems', 'spend', 'subscriptions'];
  const dom = new JSDOM('<!doctype html>', { url: `https://dash.example/dashboard${opts.query ?? ''}` });
  const win = dom.window;
  const switched: string[] = [];
  const switchTab = (t: string) => { switched.push(t); };
  const TAB_REGISTRY = registry.map((id) => ({ id }));
  // no-op timer so waitForTree/waitForSessions don't recurse or leak timers.
  const noopTimeout = () => 0 as unknown;

  const factory = new Function(
    'window', 'history', 'TAB_REGISTRY', 'switchTab', 'openFile', 'selectSession', 'setTimeout',
    'currentTab', 'currentFilePath', 'activeSession', 'expandedDirs', 'fileTreeLoaded', 'sessions',
    `${SRC}\n return { updateUrlState, handleDeepLink };`,
  );
  const api = factory(
    win, win.history, TAB_REGISTRY, switchTab, () => {}, () => {}, noopTimeout,
    opts.currentTab ?? 'sessions', opts.currentFilePath ?? '', opts.activeSession ?? null,
    new Set(), false, [],
  );
  return { ...api, search: () => win.location.search, switched };
}

describe('#1442 updateUrlState — records the active tab for every tab', () => {
  it('a non-default tab writes ?tab=<id>', () => {
    const h = harness({ currentTab: 'commitments' });
    h.updateUrlState();
    expect(h.search()).toContain('tab=commitments');
  });

  it('the default Sessions tab keeps a bare URL (no ?tab=)', () => {
    const h = harness({ currentTab: 'sessions', query: '?tab=blockers' });
    h.updateUrlState();
    expect(h.search()).not.toContain('tab=');
  });

  it('Files still writes ?tab=files&path=… (existing deep links preserved)', () => {
    const h = harness({ currentTab: 'files', currentFilePath: '.claude/CLAUDE.md' });
    h.updateUrlState();
    expect(h.search()).toContain('tab=files');
    expect(h.search()).toContain('path=.claude');
  });

  it('switching away from Files clears the stale path', () => {
    const h = harness({ currentTab: 'machines', currentFilePath: '.claude/CLAUDE.md', query: '?tab=files&path=.claude%2FCLAUDE.md' });
    h.updateUrlState();
    expect(h.search()).toContain('tab=machines');
    expect(h.search()).not.toContain('path=');
  });
});

describe('#1442 handleDeepLink — restores any registered tab', () => {
  it('?tab=blockers switches to Blockers', () => {
    const h = harness({ query: '?tab=blockers' });
    h.handleDeepLink();
    expect(h.switched).toContain('blockers');
  });

  it('?tab=subscriptions switches to Subscriptions (an accreted-scope tab)', () => {
    const h = harness({ query: '?tab=subscriptions' });
    h.handleDeepLink();
    expect(h.switched).toContain('subscriptions');
  });

  it('an unknown/removed ?tab= value falls through to the default — no switchTab, no throw', () => {
    const h = harness({ query: '?tab=deleted-old-tab' });
    expect(() => h.handleDeepLink()).not.toThrow();
    expect(h.switched).toEqual([]);
  });

  it('?tab=files still routes to Files (byte-for-byte compatible)', () => {
    const h = harness({ query: '?tab=files&path=.claude%2FCLAUDE.md' });
    h.handleDeepLink();
    expect(h.switched).toContain('files');
  });

  it('no ?tab= leaves the default tab untouched', () => {
    const h = harness({ query: '' });
    h.handleDeepLink();
    expect(h.switched).toEqual([]);
  });
});

describe('#1442 round-trip — write then read restores the same tab', () => {
  for (const tab of ['commitments', 'blockers', 'machines', 'systems', 'spend', 'subscriptions']) {
    it(`${tab}: updateUrlState → handleDeepLink returns to ${tab}`, () => {
      // write the URL as if the operator were on <tab>
      const w = harness({ currentTab: tab });
      w.updateUrlState();
      const query = w.search();
      expect(query).toContain(`tab=${tab}`);
      // a fresh load (refresh) reads that URL back
      const r = harness({ query });
      r.handleDeepLink();
      expect(r.switched).toContain(tab);
    });
  }
});
