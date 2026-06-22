// safe-fs-allow: test file — no fs mutations.
// safe-git-allow: test file — no git calls.

/**
 * Tests for amplifier #2 (spec §A.5): ServerSupervisor's in-flight-sync-op
 * restart-defer guard — driving the REAL `evaluateUnhealthyServer()` /
 * `deferRestartForInflightSyncOp()` (not a mirror of their logic), with the
 * cross-process marker reader injected via `inflightMarkerProvider` and the
 * gate boolean via `inflightDeferEnabled`.
 *
 * The hazard this closes: a SYNCHRONOUS tmux/tunnel op in flight on the server's
 * event loop burns ~0 CPU in the parent, so the CPU-starvation guard
 * (`deferRestartForCpuStarvation`) CANNOT see it — the supervisor would
 * force-restart a server that is merely wedged inside a SIGKILL-bounded sync
 * subprocess wait, dropping the in-flight message and looping. The marker is the
 * cross-process signal: the server mirrors an in-flight-op depth/timestamp to a
 * file on every depth transition; the supervisor reads it here and DEFERS while
 * a non-stale marker is set.
 *
 * Both-directions-safe and bounded:
 *   - marker {inFlight:true, stale:false}      → DEFER (even on a LOW load box)
 *   - marker stale / !inFlight                 → NO defer (the marker's TTL self-heal)
 *   - provider null / throws                   → fail-OPEN (no defer; restart a dead server)
 *   - inflightDeferEnabled:false               → legacy (no defer regardless)
 *   - consecutiveFailures >= starvationThreshold → hard cap (restart even if marked)
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { ServerSupervisor } from '../../src/lifeline/ServerSupervisor.js';

type Marker = { inFlight: boolean; ageMs: number; stale: boolean } | null;

const PROCESS_ALIVE_THRESHOLD = 6; // private readonly processAliveThreshold
const STARVATION_THRESHOLD = 30; // private readonly starvationRestartThreshold

/**
 * Build a supervisor with the inflight-marker amplifier wired.
 * @param opts.loadRatio       what loadRatioProvider returns (default 0.3 = NOT starved)
 * @param opts.deferEnabled    the gate boolean (inflightDeferEnabled)
 * @param opts.marker          what inflightMarkerProvider returns (or a thrower)
 */
function makeSup(opts: {
  loadRatio?: number;
  deferEnabled: boolean;
  marker: Marker | (() => Marker);
}): any {
  const markerFn = typeof opts.marker === 'function' ? opts.marker : () => opts.marker as Marker;
  const sup: any = new ServerSupervisor({
    projectDir: '/tmp/sup-inflight-test',
    projectName: 'sup-inflight-test',
    port: 59998,
    loadRatioProvider: () => opts.loadRatio ?? 0.3,
    inflightDeferEnabled: opts.deferEnabled,
    inflightMarkerProvider: markerFn,
  });
  // Spy the restart primitive evaluateUnhealthyServer drives. Process is alive
  // (so we reach the defer/restart decision rather than the dead-process branch).
  vi.spyOn(sup, 'handleUnhealthy').mockImplementation(() => {});
  vi.spyOn(sup, 'isServerSessionAlive').mockReturnValue(true);
  return sup;
}

const inFlight = (ageMs = 1500): Marker => ({ inFlight: true, ageMs, stale: false });
const staleMarker = (ageMs = 99_999): Marker => ({ inFlight: false, ageMs, stale: true });
const idle = (): Marker => ({ inFlight: false, ageMs: 0, stale: false });

describe('ServerSupervisor — in-flight-sync-op restart-defer (amplifier #2)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('DEFERS the restart when the marker is in-flight + not stale even with a LOW load ratio (the core fix)', () => {
    // Low load (0.3 << 1.5) — the CPU-starvation guard would NOT defer here. The
    // marker is the ONLY reason the restart is held off (the ~0-CPU block the CPU
    // guard cannot see).
    const sup = makeSup({ loadRatio: 0.3, deferEnabled: true, marker: inFlight() });
    sup.consecutiveFailures = PROCESS_ALIVE_THRESHOLD;
    sup.evaluateUnhealthyServer();
    expect(sup.handleUnhealthy).not.toHaveBeenCalled();
  });

  it('the direct deferRestartForInflightSyncOp() returns true for an in-flight non-stale marker under the cap', () => {
    const sup = makeSup({ deferEnabled: true, marker: inFlight() });
    sup.consecutiveFailures = PROCESS_ALIVE_THRESHOLD;
    expect(sup.deferRestartForInflightSyncOp()).toBe(true);
    expect(sup.inflightDeferCount).toBe(1); // observability counter bumped
  });

  it('does NOT defer once consecutiveFailures reaches the starvation hard cap (restart a genuinely-hung server)', () => {
    const sup = makeSup({ loadRatio: 0.3, deferEnabled: true, marker: inFlight() });
    sup.consecutiveFailures = STARVATION_THRESHOLD; // hard cap — even a live marker can't hold it off
    // Direct predicate: false at the cap.
    expect(sup.deferRestartForInflightSyncOp()).toBe(false);
    // And the wired path restarts (load is low so the CPU guard also won't defer).
    sup.consecutiveFailures = STARVATION_THRESHOLD;
    sup.evaluateUnhealthyServer();
    expect(sup.handleUnhealthy).toHaveBeenCalledTimes(1);
  });

  it('a STALE marker does NOT defer (the marker TTL self-heal) — restart proceeds', () => {
    const sup = makeSup({ loadRatio: 0.3, deferEnabled: true, marker: staleMarker() });
    sup.consecutiveFailures = PROCESS_ALIVE_THRESHOLD;
    expect(sup.deferRestartForInflightSyncOp()).toBe(false);
    sup.consecutiveFailures = PROCESS_ALIVE_THRESHOLD;
    sup.evaluateUnhealthyServer();
    expect(sup.handleUnhealthy).toHaveBeenCalledTimes(1);
  });

  it('a NOT-in-flight (idle) marker does NOT defer — restart proceeds', () => {
    const sup = makeSup({ loadRatio: 0.3, deferEnabled: true, marker: idle() });
    sup.consecutiveFailures = PROCESS_ALIVE_THRESHOLD;
    expect(sup.deferRestartForInflightSyncOp()).toBe(false);
    sup.evaluateUnhealthyServer();
    expect(sup.handleUnhealthy).toHaveBeenCalledTimes(1);
  });

  it('a NULL marker read fails OPEN (no defer) — restart proceeds', () => {
    const sup = makeSup({ loadRatio: 0.3, deferEnabled: true, marker: null });
    sup.consecutiveFailures = PROCESS_ALIVE_THRESHOLD;
    expect(sup.deferRestartForInflightSyncOp()).toBe(false);
    sup.evaluateUnhealthyServer();
    expect(sup.handleUnhealthy).toHaveBeenCalledTimes(1);
  });

  it('a THROWING marker provider fails OPEN (no defer) — restart proceeds, never wedged on an unreadable marker', () => {
    const sup = makeSup({
      loadRatio: 0.3,
      deferEnabled: true,
      marker: () => {
        throw new Error('mirror file unreadable');
      },
    });
    sup.consecutiveFailures = PROCESS_ALIVE_THRESHOLD;
    expect(sup.deferRestartForInflightSyncOp()).toBe(false);
    sup.evaluateUnhealthyServer();
    expect(sup.handleUnhealthy).toHaveBeenCalledTimes(1);
  });

  it('flag OFF (inflightDeferEnabled:false) → never defers regardless of an in-flight marker', () => {
    const sup = makeSup({ loadRatio: 0.3, deferEnabled: false, marker: inFlight() });
    sup.consecutiveFailures = PROCESS_ALIVE_THRESHOLD;
    expect(sup.deferRestartForInflightSyncOp()).toBe(false);
    sup.evaluateUnhealthyServer();
    expect(sup.handleUnhealthy).toHaveBeenCalledTimes(1); // legacy behavior — restarts
  });

  it('does NOT even consult the marker provider when the flag is OFF (legacy fast-return)', () => {
    const provider = vi.fn(() => inFlight());
    const sup: any = new ServerSupervisor({
      projectDir: '/tmp/sup-inflight-test',
      projectName: 'sup-inflight-test',
      port: 59997,
      loadRatioProvider: () => 0.3,
      inflightDeferEnabled: false,
      inflightMarkerProvider: provider,
    });
    sup.consecutiveFailures = PROCESS_ALIVE_THRESHOLD;
    expect(sup.deferRestartForInflightSyncOp()).toBe(false);
    expect(provider).not.toHaveBeenCalled(); // the gate short-circuits before the read
  });

  it('deferRestartForCpuStarvation() STILL runs its side effect when the marker defers (the || did NOT skip the LEFT operand)', () => {
    // The `||` order is load-bearing: deferRestartForCpuStarvation() mutates the
    // windowed-load bookkeeping (lastSustainedLoadRatio) on EVERY call. Even when
    // the marker is the reason for the defer, the CPU-side bookkeeping MUST have
    // run — otherwise the starvation log/threshold would freeze. We prove it by
    // asserting lastSustainedLoadRatio picked up the injected (low) load sample.
    const sup = makeSup({ loadRatio: 0.42, deferEnabled: true, marker: inFlight() });
    expect(sup.lastSustainedLoadRatio).toBe(0); // untouched before the tick
    sup.consecutiveFailures = PROCESS_ALIVE_THRESHOLD;
    sup.evaluateUnhealthyServer();
    expect(sup.handleUnhealthy).not.toHaveBeenCalled(); // deferred via the marker
    expect(sup.lastSustainedLoadRatio).toBe(0.42); // ...but the CPU side-effect STILL ran
  });

  it('REGRESSION: both guards false + threshold reached + not starved → the restart proceeds normally', () => {
    // Gate on, but the marker is idle and the box is not starved — neither defer
    // fires, so the alive-but-unresponsive server is restarted as it would be
    // without the amplifier at all.
    const sup = makeSup({ loadRatio: 0.3, deferEnabled: true, marker: idle() });
    sup.consecutiveFailures = PROCESS_ALIVE_THRESHOLD;
    sup.evaluateUnhealthyServer();
    expect(sup.handleUnhealthy).toHaveBeenCalledTimes(1);
  });

  it('restarts IMMEDIATELY when the process is genuinely dead, regardless of an in-flight marker', () => {
    const sup = makeSup({ loadRatio: 0.3, deferEnabled: true, marker: inFlight() });
    (sup.isServerSessionAlive as any).mockReturnValue(false); // process gone
    sup.consecutiveFailures = PROCESS_ALIVE_THRESHOLD;
    sup.evaluateUnhealthyServer();
    expect(sup.handleUnhealthy).toHaveBeenCalledTimes(1);
  });

  it('does NOT restart below the alive-but-unresponsive threshold even with no defer at all', () => {
    const sup = makeSup({ loadRatio: 0.3, deferEnabled: true, marker: idle() });
    sup.consecutiveFailures = 3; // < processAliveThreshold (6)
    sup.evaluateUnhealthyServer();
    expect(sup.handleUnhealthy).not.toHaveBeenCalled();
  });

  it('the default (unconfigured) supervisor has the inflight defer OFF — pure legacy', () => {
    const sup: any = new ServerSupervisor({
      projectDir: '/tmp/sup-inflight-test',
      projectName: 'sup-inflight-test',
      port: 59996,
      loadRatioProvider: () => 0.3,
      // inflightDeferEnabled + inflightMarkerProvider omitted entirely
    });
    vi.spyOn(sup, 'handleUnhealthy').mockImplementation(() => {});
    vi.spyOn(sup, 'isServerSessionAlive').mockReturnValue(true);
    sup.consecutiveFailures = PROCESS_ALIVE_THRESHOLD;
    expect(sup.deferRestartForInflightSyncOp()).toBe(false);
    sup.evaluateUnhealthyServer();
    expect(sup.handleUnhealthy).toHaveBeenCalledTimes(1);
  });
});

describe('ServerSupervisor — inflight-marker amplifier WIRED into the unhealthy decision', () => {
  const fs = require('node:fs') as typeof import('node:fs');
  const path = require('node:path') as typeof import('node:path');
  const src = fs.readFileSync(path.join(process.cwd(), 'src/lifeline/ServerSupervisor.ts'), 'utf-8');

  it('evaluateUnhealthyServer consults the inflight-marker defer (after the CPU defer in a || chain)', () => {
    expect(src).toContain('deferRestartForInflightSyncOp()');
    // The CPU defer must be the LEFT operand (its side effect must always run).
    expect(src).toMatch(/deferRestartForCpuStarvation\(\)\s*\|\|\s*this\.deferRestartForInflightSyncOp\(\)/);
  });

  it('the inflight defer reads the cross-process marker via the injected provider, bounded by the same hard cap', () => {
    expect(src).toContain('this.inflightMarkerProvider()');
    expect(src).toMatch(/inflightDeferEnabled[\s\S]{0,80}return false/); // gate-off legacy fast-return
    expect(src).toMatch(/starvationRestartThreshold\) return false/); // SAME hard cap as the CPU defer
  });
});
