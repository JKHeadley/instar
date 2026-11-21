// safe-fs-allow: test file — no fs mutations.
// safe-git-allow: test file — no git calls.

/**
 * ServerSupervisor — the startup-grace ceiling must not carry over from a
 * healthy run (feedback fb-6b354765-24a, Echo Laptop 2026-11-21 03:00 PST).
 *
 * The ceiling (startupGraceMs × graceCeilingMultiplier, measured from
 * `firstSpawnedAt`) bounds ONE not-yet-healthy episode across repeated
 * respawns. The bug: every healthy tick cleared `firstSpawnedAt` to 0, and the
 * very next tick re-anchored it to the long-past `spawnedAt` of the running
 * server. A server healthy for more than 3× grace therefore met its first
 * outage with the ceiling already exceeded, and because a respawn resets
 * `spawnedAt` but not `firstSpawnedAt`, every respawn in that outage got only
 * the ~60s alive-but-unresponsive allowance instead of the startup grace.
 *
 * These tests drive the REAL runHealthTick(), handleUnhealthy() and
 * spawnServer() over a simulated wall-clock timeline (fake timers). Only the
 * edges are stubbed: tmux is `/usr/bin/true`, the /health probe is a model of
 * the server, and the request-file readers are no-ops.
 */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { ServerSupervisor } from '../../src/lifeline/ServerSupervisor.js';

const TICK_MS = 10_000;
const MIN = 60_000;

interface Harness {
  sup: any;
  /** Wall-clock time of every spawnServer() call, in order. */
  spawns: number[];
  /** Advance the simulated clock by `ms`, running one health tick every 10s. */
  run(ms: number): Promise<void>;
}

/**
 * @param bootMs how long a freshly spawned server takes to answer /health 200
 * @param outageAt wall-clock time at which the running server stops answering
 *        (its tmux session stays alive — a hung process, the 03:00 case)
 */
function makeHarness(bootMs: number, outageAt: () => number): Harness {
  const sup: any = new ServerSupervisor({
    projectDir: '/tmp/sup-grace-ceiling-reanchor-test',
    projectName: 'sup-grace-ceiling-reanchor-test',
    port: 59996,
    loadRatioProvider: () => 0.3, // not starved: no CPU-starvation defer
  });
  sup.tmuxPath = '/usr/bin/true'; // every tmux call "succeeds" without touching tmux
  vi.spyOn(sup, 'checkRestartRequest').mockImplementation(() => {});
  vi.spyOn(sup, 'checkDebugRestartRequest').mockImplementation(() => {});
  vi.spyOn(sup, 'checkSleepRequest').mockImplementation(() => {});
  vi.spyOn(sup, 'checkWakeRequest').mockImplementation(() => {});
  vi.spyOn(sup, 'isLegacyPlannedRestart').mockReturnValue(false);
  vi.spyOn(sup, 'isPendingPlannedRestart').mockReturnValue(false);
  vi.spyOn(sup, 'preflightSelfHeal').mockImplementation(() => '');
  vi.spyOn(sup, 'startHealthChecks').mockImplementation(() => {}); // the test drives the ticks
  vi.spyOn(sup, 'captureCrashOutput').mockImplementation(() => {});
  vi.spyOn(sup, 'cleanupChildProcesses').mockImplementation(() => {});
  vi.spyOn(sup, 'isServerSessionAlive').mockReturnValue(true); // the process exists throughout

  const spawns: number[] = [];
  const realSpawn = sup.spawnServer.bind(sup);
  vi.spyOn(sup, 'spawnServer').mockImplementation(() => {
    spawns.push(Date.now());
    return realSpawn();
  });

  // Server model: the first process is healthy until the outage; every later
  // process becomes healthy `bootMs` after it was spawned.
  vi.spyOn(sup, 'probeHealth').mockImplementation(async () => {
    const now = Date.now();
    const last = spawns[spawns.length - 1];
    if (spawns.length <= 1) return now < outageAt() ? 'healthy' : 'down';
    return now - last >= bootMs ? 'healthy' : 'down';
  });

  return {
    sup,
    spawns,
    async run(ms: number) {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        await sup.runHealthTick();
        await vi.advanceTimersByTimeAsync(TICK_MS); // also fires the restart backoff timer
      }
    },
  };
}

describe('ServerSupervisor — the startup-grace ceiling starts fresh after a healthy run', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    vi.setSystemTime(new Date('2026-11-21T08:00:00Z'));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('a server healthy for 40 minutes gets the full startup allowance on its next respawn (the 03:00 Laptop case)', async () => {
    const start = Date.now();
    const h = makeHarness(150_000, () => start + 40 * MIN); // the slowest boot seen that night: 150s
    h.sup.spawnServer();                                       // the original boot
    await h.run(40 * MIN);                                     // healthy for 40 minutes (> 3× grace)
    expect(h.sup.isRunning).toBe(true);

    await h.run(15 * MIN);                                     // outage, respawn, slow boot

    const respawns = h.spawns.slice(1);
    // One respawn to recover from the hung process, then the 150s boot is
    // allowed to finish. Before the fix every respawn was killed after ~60s.
    expect(respawns).toHaveLength(1);
    expect(h.sup.lastHealthy).toBeGreaterThanOrEqual(respawns[0] + 150_000);
    expect(h.sup.isRunning).toBe(true);
  });

  it('the first failed check after a long healthy run does not anchor the ceiling at the old spawn', async () => {
    const start = Date.now();
    const h = makeHarness(30_000, () => start + 35 * MIN);
    h.sup.spawnServer();
    await h.run(35 * MIN);   // healthy for 35 minutes
    await h.run(TICK_MS);    // exactly one failed health check, no respawn yet
    expect(h.spawns).toEqual([start]);
    expect(h.sup.consecutiveFailures).toBe(1);
    // No respawn has happened, so no unhealthy-boot episode is open yet.
    expect(h.sup.firstSpawnedAt).toBe(0);
  });

  it('a respawned server that never becomes healthy is still bounded by the ceiling across respawns', async () => {
    const start = Date.now();
    const h = makeHarness(Number.POSITIVE_INFINITY, () => start + 40 * MIN); // the new boots never answer
    h.sup.spawnServer();
    await h.run(40 * MIN);
    await h.run(60 * MIN);

    const respawns = h.spawns.slice(1);
    expect(respawns.length).toBeGreaterThanOrEqual(3);
    const grace = h.sup.startupGraceMs;
    const ceiling = grace * h.sup.graceCeilingMultiplier;
    // The first respawn gets the full grace (not ~60s).
    expect(respawns[1] - respawns[0]).toBeGreaterThanOrEqual(grace);
    // The episode is anchored at its first respawn and every later respawn
    // keeps that anchor, so the ceiling measures the whole unhealthy episode.
    const anchor = respawns[0];
    // Once the ceiling has passed, a respawn's failures are acted on before its
    // own grace window would have ended: the ceiling clipped it.
    const clipped = respawns.findIndex((t, i) => i > 0 && t - respawns[i - 1] < grace);
    expect(clipped).toBeGreaterThan(0);
    expect(respawns[clipped]).toBeGreaterThanOrEqual(anchor + ceiling);
    expect(respawns[clipped]).toBeLessThan(anchor + ceiling + 2 * MIN);
  });

  it('within one unhealthy episode the anchor is not moved by a later respawn', async () => {
    const start = Date.now();
    const h = makeHarness(Number.POSITIVE_INFINITY, () => start + 40 * MIN);
    h.sup.spawnServer();
    await h.run(40 * MIN);
    await h.run(25 * MIN); // through the first respawn and well into the second
    const respawns = h.spawns.slice(1);
    expect(respawns.length).toBeGreaterThanOrEqual(2);
    expect(h.sup.firstSpawnedAt).toBe(respawns[0]);
  });
});
