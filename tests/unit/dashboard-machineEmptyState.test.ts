/**
 * WS4.2 — per-machine empty-state strip (MULTI-MACHINE-SEAMLESSNESS-SPEC, F7).
 *
 * 2026-06-12 live incident (topic 13481): after the pool-tile status filter
 * shipped, an idle Mac Mini rendered as NOTHING in the sessions view —
 * indistinguishable from a broken or unreachable machine, and the operator
 * read it as a regression. The sessions view must render an explicit state
 * row per pool machine with no session tiles, with THREE honest states:
 * "online — no active sessions" / "offline since <t>" / "unreachable (last
 * seen <t>)". The states are computed SERVER-SIDE in pool.machines[].emptyState
 * (the pooled sessions response) and the dashboard just styles + prints them.
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
  it('sources the machine inventory from the pooled SESSIONS response (pool.machines), not a separate /pool round-trip', () => {
    const gate = html.match(/poolMachinesView\s*=\s*\(j\.pool && j\.pool\.enabled[^;]+;/);
    expect(gate, 'poolMachinesView gate not found — WS4.2 strip restructured? update this test').toBeTruthy();
    expect(gate![0]).toContain('j.pool.machines.length >= 2'); // single-machine strict no-op
  });

  it('renders all three honest states server-side (online-idle / offline / unreachable)', () => {
    // The phrases are authored in the server-side classifier (poolEmptyState.ts)
    // and flow through pool.machines[].emptyState.text — the dashboard prints
    // info.text verbatim. Assert the classifier source carries all three.
    const classifier = fs.readFileSync(
      path.join(__dirname, '..', '..', 'src', 'server', 'poolEmptyState.ts'),
      'utf-8',
    );
    expect(classifier).toContain('online — no active sessions');
    expect(classifier).toContain('offline since ');
    expect(classifier).toContain('unreachable (last seen ');
  });

  it('styles online calmly and offline/unreachable as offline (red)', () => {
    const fn = html.match(/function machineStatusInfo\([\s\S]+?\n    \}/);
    expect(fn, 'machineStatusInfo not found').toBeTruthy();
    expect(fn![0]).toContain("es.kind === 'online' ? 'online' : 'offline'");
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

  it('a machine that has session tiles (sessionCount > 0) gets no redundant status row', () => {
    const fn = html.match(/function renderMachineStatusStrip\([\s\S]+?\n    \}/);
    expect(fn, 'renderMachineStatusStrip not found').toBeTruthy();
    expect(fn![0]).toContain('m.sessionCount > 0');
    expect(fn![0]).toContain('continue');
  });

  it('escapes machine-provided strings (nickname/status) before injecting into the DOM', () => {
    const fn = html.match(/function renderMachineStatusStrip\([\s\S]+?\n    \}/)![0];
    expect(fn).toContain('escapeHtml(label)');
    expect(fn).toContain('escapeHtml(info.text)');
  });

  it('never fabricates an "online" state when the server omitted an empty-state', () => {
    // Defense-in-depth: a 0-session machine with no server emptyState must read
    // honestly ("state unknown"), never default to a reassuring "online".
    const fn = html.match(/function machineStatusInfo\([\s\S]+?\n    \}/)![0];
    expect(fn).toContain('state unknown');
  });
});
