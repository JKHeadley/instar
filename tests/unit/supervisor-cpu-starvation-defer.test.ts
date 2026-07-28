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

  it('a starved-then-SUSTAINEDLY-eased server restarts once load stays down for the window (defer is not permanent)', () => {
    // Sustained semantics: after load eases it takes a full window of low
    // samples to flush the earlier high reading before a restart is authorized.
    const sup = makeSup(2.0); // starts starved
    vi.spyOn(sup, 'isServerSessionAlive').mockReturnValue(true);
    let cf = PROCESS_ALIVE_THRESHOLD;
    sup.consecutiveFailures = cf;
    sup.evaluateUnhealthyServer();
    expect(sup.handleUnhealthy).not.toHaveBeenCalled(); // deferred while starved
    // Load eases — but the window still holds the earlier high sample, so the
    // FIRST eased tick must NOT restart (this is the 2026-06-17 dip-loop fix).
    (sup as any).loadRatioProvider = () => 0.4;
    cf += 1;
    sup.consecutiveFailures = cf;
    sup.evaluateUnhealthyServer();
    expect(sup.handleUnhealthy).not.toHaveBeenCalled();
    // Drive enough eased ticks to flush the window (loadSampleWindow = 6); once
    // load has genuinely stayed down across the window it restarts — defer is
    // not permanent.
    for (let i = 0; i < 6; i++) {
      cf += 1;
      sup.consecutiveFailures = cf;
      sup.evaluateUnhealthyServer();
    }
    expect(sup.handleUnhealthy).toHaveBeenCalled();
  });

  it('a momentary load DIP does NOT restart a sustainedly-starved server (the 2026-06-17 loop)', () => {
    // The exact failure: load oscillates around the threshold; a single 1-min
    // dip below the line must not authorize a restart while the box has been
    // starved across the window.
    const ratios = [2.0, 1.8, 2.1, 1.4 /* the dip, < 1.5 */, 1.9];
    let idx = 0;
    const sup = makeSup(2.0);
    (sup as any).loadRatioProvider = () => ratios[Math.min(idx, ratios.length - 1)];
    vi.spyOn(sup, 'isServerSessionAlive').mockReturnValue(true);
    let cf = PROCESS_ALIVE_THRESHOLD;
    for (idx = 0; idx < ratios.length; idx++) {
      sup.consecutiveFailures = cf++;
      sup.evaluateUnhealthyServer();
    }
    // Despite the dip at idx 3, the windowed max stayed > 1.5 the whole time.
    expect(sup.handleUnhealthy).not.toHaveBeenCalled();
  });

  it('the sustained window is dropped when the failure streak resets (no stale over-defer)', () => {
    // Episode 1: starved, defers and accumulates a high sample.
    const sup = makeSup(2.0);
    vi.spyOn(sup, 'isServerSessionAlive').mockReturnValue(true);
    sup.consecutiveFailures = PROCESS_ALIVE_THRESHOLD;
    sup.evaluateUnhealthyServer();
    expect(sup.handleUnhealthy).not.toHaveBeenCalled();
    // Server recovers — the streak resets to 0 (done by the health loop).
    sup.consecutiveFailures = 0;
    // Episode 2: a genuinely-hung server on a now-IDLE box. The stale high
    // sample from episode 1 must NOT keep deferring — load is low now.
    (sup as any).loadRatioProvider = () => 0.3;
    sup.consecutiveFailures = PROCESS_ALIVE_THRESHOLD;
    sup.evaluateUnhealthyServer();
    expect(sup.handleUnhealthy).toHaveBeenCalledTimes(1); // restarts promptly
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
