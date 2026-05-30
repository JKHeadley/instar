// safe-fs-allow: test file — no fs mutations.
// safe-git-allow: test file — no git calls.

/**
 * Tests for ServerSupervisor's CPU-starvation restart guard — driving the REAL
 * `evaluateUnhealthyServer()` method (not a mirror of its logic), with the load
 * source injected via `loadRatioProvider` and the process-alive / restart
 * primitives spied.
 *
 * The bug this closes (2026-05-29 restart-loop incident): under CPU starvation
 * the live server can't answer /health, so the supervisor declared it
 * "unresponsive" and restarted it every ~60s — but a fresh server is starved
 * too, so it just dropped the user's in-flight message and looped. The guard
 * DEFERS the restart while starved (up to a hard cap), instead of bouncing a
 * server that would recover on its own once load eases.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { ServerSupervisor } from '../../src/lifeline/ServerSupervisor.js';

function makeSup(loadRatio: number): any {
  const sup: any = new ServerSupervisor({
    projectDir: '/tmp/sup-test',
    projectName: 'sup-test',
    port: 59999,
    loadRatioProvider: () => loadRatio,
  });
  // Spy the two primitives evaluateUnhealthyServer drives.
  vi.spyOn(sup, 'handleUnhealthy').mockImplementation(() => {});
  return sup;
}

describe('ServerSupervisor — CPU-starvation restart guard', () => {
  afterEach(() => vi.restoreAllMocks());

  const PROCESS_ALIVE_THRESHOLD = 6;     // private readonly in the class
  const STARVATION_THRESHOLD = 30;       // private readonly in the class

  it('DEFERS restart when alive + unresponsive AND the box is CPU-starved', () => {
    const sup = makeSup(2.0); // load ratio 2.0 > 1.5 → starved
    vi.spyOn(sup, 'isServerSessionAlive').mockReturnValue(true);
    sup.consecutiveFailures = PROCESS_ALIVE_THRESHOLD; // threshold reached
    sup.evaluateUnhealthyServer();
    expect(sup.handleUnhealthy).not.toHaveBeenCalled();
  });

  it('RESTARTS when alive + unresponsive and NOT starved', () => {
    const sup = makeSup(0.5); // not starved
    vi.spyOn(sup, 'isServerSessionAlive').mockReturnValue(true);
    sup.consecutiveFailures = PROCESS_ALIVE_THRESHOLD;
    sup.evaluateUnhealthyServer();
    expect(sup.handleUnhealthy).toHaveBeenCalledTimes(1);
  });

  it('FORCE-restarts past the hard cap even while starved (guards against a genuinely-hung server)', () => {
    const sup = makeSup(2.0); // starved
    vi.spyOn(sup, 'isServerSessionAlive').mockReturnValue(true);
    sup.consecutiveFailures = STARVATION_THRESHOLD; // hard cap reached
    sup.evaluateUnhealthyServer();
    expect(sup.handleUnhealthy).toHaveBeenCalledTimes(1);
  });

  it('restarts IMMEDIATELY when the process is dead, regardless of load', () => {
    const sup = makeSup(2.0); // starved, but...
    vi.spyOn(sup, 'isServerSessionAlive').mockReturnValue(false); // ...process gone
    sup.consecutiveFailures = PROCESS_ALIVE_THRESHOLD;
    sup.evaluateUnhealthyServer();
    expect(sup.handleUnhealthy).toHaveBeenCalledTimes(1);
  });

  it('does NOT restart below the alive-but-unresponsive threshold even when not starved', () => {
    const sup = makeSup(0.5);
    vi.spyOn(sup, 'isServerSessionAlive').mockReturnValue(true);
    sup.consecutiveFailures = 3; // < processAliveThreshold (6)
    sup.evaluateUnhealthyServer();
    expect(sup.handleUnhealthy).not.toHaveBeenCalled();
  });

  it('a starved-then-eased server restarts once load drops (defer is not permanent)', () => {
    const sup = makeSup(2.0); // starts starved
    vi.spyOn(sup, 'isServerSessionAlive').mockReturnValue(true);
    sup.consecutiveFailures = PROCESS_ALIVE_THRESHOLD;
    sup.evaluateUnhealthyServer();
    expect(sup.handleUnhealthy).not.toHaveBeenCalled(); // deferred while starved
    // Load eases — provider now reports a healthy ratio.
    (sup as any).loadRatioProvider = () => 0.4;
    sup.consecutiveFailures = PROCESS_ALIVE_THRESHOLD + 1;
    sup.evaluateUnhealthyServer();
    expect(sup.handleUnhealthy).toHaveBeenCalledTimes(1);
  });
});

describe('ServerSupervisor — CPU-starvation guard WIRED into the health loop', () => {
  const fs = require('node:fs') as typeof import('node:fs');
  const path = require('node:path') as typeof import('node:path');
  const src = fs.readFileSync(path.join(process.cwd(), 'src/lifeline/ServerSupervisor.ts'), 'utf-8');

  it('the health-check loop routes unhealthy decisions through evaluateUnhealthyServer', () => {
    // Both failure paths (unhealthy /health + thrown check) must call it.
    const calls = (src.match(/this\.evaluateUnhealthyServer\(\)/g) || []).length;
    expect(calls).toBeGreaterThanOrEqual(2);
  });
  it('evaluateUnhealthyServer consults the CPU-starvation defer', () => {
    expect(src).toContain('deferRestartForCpuStarvation()');
  });
});
