// safe-fs-allow: test file — no fs mutations.
// safe-git-allow: test file — no git calls.

/**
 * ServerSupervisor — Supervisor Respawn Guarantee (net #2, 2026-06-14, topic 13481).
 * Spec: docs/specs/SUPERVISOR-RESPAWN-GUARANTEE-SPEC.md
 *
 * The trap this closes: under sustained CPU starvation the 10s health-check
 * `setInterval` ticks arrive minutes apart. The supervisor misread each large
 * gap as a machine sleep/wake, reset `spawnedAt = now`, and so re-entered the
 * startup-grace branch where health failures are IGNORED — including the
 * unambiguous signal that the server's tmux session no longer exists. The
 * server stayed dead ~2h until a human messaged.
 *
 * The fixes (all driving the REAL extracted `runHealthTick()` / wake handler,
 * not a mirror of their logic):
 *   - Fix A: a missing server tmux session overrides startup grace — respawn
 *     fires on the very next tick regardless of any spawnedAt reset.
 *   - Fix B: a large inter-tick gap under CPU starvation is classified as a
 *     stalled event loop, NOT sleep/wake — `spawnedAt` is not reset (grace not
 *     re-armed). A real suspend (low load) still re-arms grace.
 *   - Fix C: an absolute grace ceiling (startupGraceMs × 3 from firstSpawnedAt)
 *     so repeated spawnedAt resets cannot ignore failures forever.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { ServerSupervisor } from '../../src/lifeline/ServerSupervisor.js';

function makeSup(loadRatio = 0.3, opts: Record<string, unknown> = {}): any {
  const sup: any = new ServerSupervisor({
    projectDir: '/tmp/sup-respawn-guarantee-test',
    projectName: 'sup-respawn-guarantee-test',
    port: 59997,
    loadRatioProvider: () => loadRatio,
    ...opts,
  });
  // Neutralize the request-file readers the tick calls at the end — they read
  // fs in a non-existent projectDir; no-op them so the tick is deterministic.
  vi.spyOn(sup, 'checkRestartRequest').mockImplementation(() => {});
  vi.spyOn(sup, 'checkDebugRestartRequest').mockImplementation(() => {});
  vi.spyOn(sup, 'checkSleepRequest').mockImplementation(() => {});
  vi.spyOn(sup, 'checkWakeRequest').mockImplementation(() => {});
  return sup;
}

describe('ServerSupervisor — Supervisor Respawn Guarantee', () => {
  afterEach(() => vi.restoreAllMocks());

  // ── Fix A: missing-session override ──────────────────────────────

  it('Fix A: a missing tmux session during startup grace respawns on the next tick (the 2026-06-14 trap)', async () => {
    const sup = makeSup();
    sup.spawnedAt = Date.now();        // squarely inside startup grace
    sup.firstSpawnedAt = Date.now();   // within the ceiling
    vi.spyOn(sup, 'isServerSessionAlive').mockReturnValue(false); // process is GONE
    const handle = vi.spyOn(sup, 'handleUnhealthy').mockImplementation(() => {});
    const health = vi.spyOn(sup, 'checkHealth').mockResolvedValue(false);

    await sup.runHealthTick();

    expect(handle).toHaveBeenCalledTimes(1);  // respawn authority invoked despite grace
    expect(health).not.toHaveBeenCalled();    // short-circuited before the optimistic probe
  });

  it('Fix A: a missing session during a (false) wake-transition window still respawns', async () => {
    const sup = makeSup();
    sup.spawnedAt = Date.now();
    sup.firstSpawnedAt = Date.now();
    sup.wakeTransitionUntil = Date.now() + 5 * 60_000; // pretend we just "woke"
    vi.spyOn(sup, 'isServerSessionAlive').mockReturnValue(false);
    const handle = vi.spyOn(sup, 'handleUnhealthy').mockImplementation(() => {});

    await sup.runHealthTick();

    expect(handle).toHaveBeenCalledTimes(1);
  });

  it('Fix A does NOT regress boot tolerance: an alive booting session (no 200 yet) is still given full grace', async () => {
    const sup = makeSup();
    sup.spawnedAt = Date.now();        // booting, in grace
    sup.firstSpawnedAt = Date.now();
    vi.spyOn(sup, 'isServerSessionAlive').mockReturnValue(true); // session present, booting
    vi.spyOn(sup, 'checkHealth').mockResolvedValue(false);       // not bound yet
    const evalUnhealthy = vi.spyOn(sup, 'evaluateUnhealthyServer').mockImplementation(() => {});

    await sup.runHealthTick();

    expect(evalUnhealthy).not.toHaveBeenCalled(); // failures ignored during a real boot
  });

  // ── Fix B: load-aware gap detection ──────────────────────────────

  it('Fix B: a large gap under CPU starvation does NOT reset spawnedAt (grace not re-armed)', async () => {
    const sup = makeSup(2.0); // load ratio 2.0 > 1.5 → starved
    const anchoredSpawnedAt = 12_345;
    sup.spawnedAt = anchoredSpawnedAt;
    sup.lastHealthCheckAt = Date.now() - 3 * 60_000; // gap > sleepWakeGapMs (2m)
    vi.spyOn(sup, 'isServerSessionAlive').mockReturnValue(true);
    vi.spyOn(sup, 'checkHealth').mockResolvedValue(false);
    vi.spyOn(sup, 'evaluateUnhealthyServer').mockImplementation(() => {});

    await sup.runHealthTick();

    expect(sup.spawnedAt).toBe(anchoredSpawnedAt); // NOT reset — classified as stalled loop
  });

  it('Fix B: a large gap under LOW load IS treated as sleep/wake (spawnedAt re-armed) — real suspend preserved', async () => {
    const sup = makeSup(0.4); // not starved
    sup.spawnedAt = 12_345;
    sup.lastHealthCheckAt = Date.now() - 3 * 60_000;
    vi.spyOn(sup, 'isServerSessionAlive').mockReturnValue(true);
    vi.spyOn(sup, 'checkHealth').mockResolvedValue(false);
    vi.spyOn(sup, 'evaluateUnhealthyServer').mockImplementation(() => {});

    sup.firstSpawnedAt = 1; // pretend a stale anchor from a prior never-healthy boot
    const before = Date.now();
    await sup.runHealthTick();

    expect(sup.spawnedAt).toBeGreaterThanOrEqual(before); // re-armed to ~now (genuine wake)
    // A genuine suspend/wake is a fresh episode — the Fix C ceiling re-anchors too,
    // so a long sleep can't make the wall-clock ceiling fire on the post-wake boot.
    expect(sup.firstSpawnedAt).toBeGreaterThanOrEqual(before);
  });

  it('Fix B: the SleepWakeDetector wake handler honors the same load guard', async () => {
    // Drive the REAL wake handler registered by startHealthChecks().
    const sup = makeSup(2.0); // starved
    vi.spyOn(sup, 'sleptMarkerPresent').mockReturnValue(false);
    sup.startHealthChecks();
    try {
      sup.spawnedAt = 999;
      sup.restartAttempts = 4;
      sup.sleepWakeDetector.emit('wake', { sleepDurationSeconds: 30 });
      expect(sup.spawnedAt).toBe(999);     // starved false-wake: grace NOT re-armed
      expect(sup.restartAttempts).toBe(0); // counters still reset (safe)

      // Now low load — a genuine wake DOES re-arm grace.
      (sup as any).loadRatioProvider = () => 0.4;
      sup.firstSpawnedAt = 1; // stale anchor
      const before = Date.now();
      sup.sleepWakeDetector.emit('wake', { sleepDurationSeconds: 30 });
      expect(sup.spawnedAt).toBeGreaterThanOrEqual(before);
      expect(sup.firstSpawnedAt).toBeGreaterThanOrEqual(before); // ceiling re-anchored on genuine wake
    } finally {
      sup.stopHealthChecks();
    }
  });

  // ── Fix C: absolute grace ceiling ────────────────────────────────

  it('Fix C: past the absolute grace ceiling, failures are acted on even though spawnedAt was just reset', async () => {
    const sup = makeSup();
    sup.spawnedAt = Date.now(); // would normally be "in grace"
    // firstSpawnedAt anchored beyond startupGraceMs × graceCeilingMultiplier ago.
    sup.firstSpawnedAt = Date.now() - (sup.startupGraceMs * sup.graceCeilingMultiplier + 1000);
    sup.consecutiveFailures = sup.unhealthyThreshold - 1; // one more failure hits the threshold
    vi.spyOn(sup, 'isServerSessionAlive').mockReturnValue(true); // session present but never healthy
    vi.spyOn(sup, 'checkHealth').mockResolvedValue(false);
    const evalUnhealthy = vi.spyOn(sup, 'evaluateUnhealthyServer').mockImplementation(() => {});

    await sup.runHealthTick();

    expect(evalUnhealthy).toHaveBeenCalledTimes(1); // ceiling broke the grace pin
  });

  it('Fix C: within the ceiling, an in-grace server still ignores failures (ceiling does not over-fire)', async () => {
    const sup = makeSup();
    sup.spawnedAt = Date.now();
    sup.firstSpawnedAt = Date.now(); // fresh — well within the ceiling
    sup.consecutiveFailures = sup.unhealthyThreshold - 1;
    vi.spyOn(sup, 'isServerSessionAlive').mockReturnValue(true);
    vi.spyOn(sup, 'checkHealth').mockResolvedValue(false);
    const evalUnhealthy = vi.spyOn(sup, 'evaluateUnhealthyServer').mockImplementation(() => {});

    await sup.runHealthTick();

    expect(evalUnhealthy).not.toHaveBeenCalled();
  });

  it('Fix C: firstSpawnedAt is cleared once the server goes healthy (next episode re-anchors)', async () => {
    const sup = makeSup();
    sup.spawnedAt = Date.now();
    sup.firstSpawnedAt = Date.now() - 1000;
    vi.spyOn(sup, 'isServerSessionAlive').mockReturnValue(true);
    vi.spyOn(sup, 'checkHealth').mockResolvedValue(true); // healthy → grace optimistic-probe success

    await sup.runHealthTick();

    expect(sup.firstSpawnedAt).toBe(0);
  });

  // ── Wiring integrity ─────────────────────────────────────────────

  it('Wiring: the health tick probes isServerSessionAlive() on every tick (not only in the non-grace branch)', async () => {
    const sup = makeSup();
    sup.spawnedAt = Date.now();   // in grace — the branch that previously never probed liveness
    sup.firstSpawnedAt = Date.now();
    const alive = vi.spyOn(sup, 'isServerSessionAlive').mockReturnValue(true);
    vi.spyOn(sup, 'checkHealth').mockResolvedValue(false);

    await sup.runHealthTick();

    expect(alive).toHaveBeenCalled(); // Fix A's probe runs before the grace early-return
  });
});
