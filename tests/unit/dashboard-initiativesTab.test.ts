/**
 * Smoke tests for the Initiatives dashboard tab.
 *
 * These tests inspect the HTML/JS at rest (no browser execution).
 * They verify the XSS-safe invariants and the tab wiring match the
 * PR Pipeline pattern: textContent only, no innerHTML, tab registered,
 * panel present, loader function defined.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HTML = fs.readFileSync(path.resolve(__dirname, '../../dashboard/index.html'), 'utf-8');

describe('dashboard: Initiatives tab', () => {
  it('has an Initiatives tab button wired to switchTab', () => {
    expect(HTML).toContain('data-tab="initiatives"');
    expect(HTML).toContain(`switchTab('initiatives')`);
  });

  it('has an initiativesPanel that renders through the shared glance component (Phase 4)', () => {
    expect(HTML).toContain('id="initiativesPanel"');
    expect(HTML).toMatch(/id="initiativesGlance"[^>]*class="glance-root"/);
  });

  it('registers the initiatives tab in TAB_REGISTRY', () => {
    expect(HTML).toMatch(/id:\s*'initiatives'[\s\S]{0,120}panels:\s*\['initiativesPanel'\]/);
  });

  it('calls loadInitiatives on activation', () => {
    expect(HTML).toContain(`loadInitiatives === 'function'`);
    expect(HTML).toContain('loadInitiatives()');
  });

  it('defines async function loadInitiatives', () => {
    expect(HTML).toMatch(/async function loadInitiatives\(\)/);
  });

  it('fetches both /initiatives and /initiatives/digest', () => {
    const fn = HTML.slice(HTML.indexOf('async function loadInitiatives()'));
    expect(fn).toContain(`'/initiatives'`);
    expect(fn).toContain(`'/initiatives/digest'`);
  });

  it('does not use innerHTML inside loadInitiatives (XSS invariant)', () => {
    const start = HTML.indexOf('async function loadInitiatives()');
    // Find the end of the function — the next top-level function definition.
    const rest = HTML.slice(start + 1);
    const nextFn = rest.search(/\n\s*(async )?function \w+\(/);
    const body = rest.slice(0, nextFn);
    // Permitted usages: empty-state text set via textContent, DOM mutation.
    // Forbidden: any innerHTML assignment.
    expect(body).not.toMatch(/\.innerHTML\s*=/);
  });

  it('builds its glance via the shared component and keeps the status filter (Phase 4)', () => {
    const start = HTML.indexOf('async function loadInitiatives()');
    const body = HTML.slice(start, start + 2000);
    // Phase 4: the phase pills + digest-reason tags moved into glance.js
    // (buildInitiativesGlance / initiativeRecordNode, covered by the glance tests);
    // the loader now feeds items + digest to the shared component. The status
    // filter is preserved (behavior untouched).
    expect(body).toContain('initiativesGlanceSpec');
    expect(body).toContain('renderGlance');
    expect(body).toContain('initiativesFilter');
  });

  it('the glance component (glance.js) carries the plain-word status + digest-reason mapping', () => {
    const glance = fs.readFileSync(path.resolve(__dirname, '../../dashboard/glance.js'), 'utf-8');
    // The digest reasons are humanized to plain words at the glance/record layer.
    for (const reason of ['needs-user', 'next-check-due', 'ready-to-advance', 'stale']) {
      expect(glance, `${reason} handled in glance.js`).toContain(`'${reason}'`);
    }
    expect(glance).toContain('INITIATIVE_STATUS_WORD');
  });
});
