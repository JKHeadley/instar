/**
 * WS4.2 — per-machine empty-state strip (MULTI-MACHINE-SEAMLESSNESS-SPEC, F7).
 *
 * 2026-06-12 live incident (topic 13481): after the pool-tile status filter
 * shipped, an idle Mac Mini rendered as NOTHING in the sessions view —
 * indistinguishable from a broken or unreachable machine, and the operator
 * read it as a regression. The sessions view must render an explicit state
 * row per pool machine with no session tiles: "online — no active sessions"
 * vs "not reachable — last seen <t>".
 *
 * Inspects the HTML/JS at rest (no browser), following the
 * dashboard-poolTileStatusFilter.test.ts pattern.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(__dirname, '..', '..', 'dashboard', 'index.html'), 'utf-8');

describe('dashboard sessions view — per-machine empty-state strip (WS4.2)', () => {
  it('keeps a pool machine inventory gated to enabled pools with 2+ machines (single-machine strict no-op)', () => {
    const gate = html.match(/poolMachinesView\s*=\s*\(pool && pool\.enabled[^;]+;/);
    expect(gate, 'poolMachinesView gate not found — WS4.2 strip restructured? update this test').toBeTruthy();
    expect(gate![0]).toContain('pool.machines.length >= 2');
  });

  it('renders both honest states: online-but-idle and not-reachable-with-last-seen', () => {
    expect(html).toContain('online — no active sessions');
    expect(html).toContain('not reachable — last seen');
  });

  it('renders the strip even when there are zero sessions anywhere (the empty branch)', () => {
    // The early-return empty branch must call the strip renderer before returning,
    // otherwise an all-idle pool regresses to the F7 blank view.
    const emptyBranch = html.match(/if \(all\.length === 0\) \{[\s\S]{0,600}?return;\s*\}/);
    expect(emptyBranch, 'renderSessionList empty branch not found').toBeTruthy();
    expect(emptyBranch![0]).toContain('renderMachineStatusStrip(');
  });

  it('clears prior strip rows on every render (no duplicate accumulation)', () => {
    expect(html).toMatch(/querySelectorAll\('\.machine-status-row'\)\.forEach\(el => el\.remove\(\)\)/);
  });

  it('a machine that has session tiles gets no redundant status row', () => {
    const fn = html.match(/function renderMachineStatusStrip\([\s\S]+?\n    \}/);
    expect(fn, 'renderMachineStatusStrip not found').toBeTruthy();
    expect(fn![0]).toContain('continue');
    expect(fn![0]).toContain('busy.has(');
  });

  it('escapes machine-provided strings (nickname/status) before injecting into the DOM', () => {
    const fn = html.match(/function renderMachineStatusStrip\([\s\S]+?\n    \}/)![0];
    expect(fn).toContain('escapeHtml(label)');
    expect(fn).toContain('escapeHtml(info.text)');
  });
});
