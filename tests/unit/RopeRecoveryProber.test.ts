/**
 * U4.3 — RopeRecoveryProber unit tier (docs/specs/u4-3-breaker-recovery-probe.md §6).
 *
 * Uses the REAL PeerEndpointResolver (the one health authority) on a fake clock:
 * traffic is simulated via recordResult, probes via an injected sendProbe seam.
 * Covers: episode scoping (opens on dead, survives the limbo arm, closes only on
 * lastKnownGood reclaim), the probe-layer-owned cadence in both health states,
 * the single-in-flight CAS, real-recoveryStreak feeding (dead clears on FIRST
 * typed success; lastKnownGood reclaim ~4th success from EWMA saturation), the
 * rope-recovered breadcrumb, dry-run scheduling honesty, the reopen episode
 * brake, exhaustion → floor + ONE deduped escalation + re-arm, and the P19
 * simulated-day bounds in BOTH the all-fail and all-succeed-never-reclaim arms.
 */
import { describe, it, expect } from 'vitest';
import { PeerEndpointResolver } from '../../src/core/PeerEndpointResolver.js';
import { RopeRecoveryProber, type RopeProbeSendResult } from '../../src/core/RopeRecoveryProber.js';

const PEER = 'peer-1';
const KIND = 'tailscale' as const;
const URL_ = 'http://100.64.0.9:4040';

interface Harness {
  resolver: PeerEndpointResolver;
  prober: RopeRecoveryProber;
  clock: { t: number };
  probes: Array<{ at: number }>;
  logs: string[];
  attention: Array<{ id: string; title: string }>;
  metrics: string[];
  setProbeResult: (r: Partial<RopeProbeSendResult>) => void;
  tick: () => Promise<void>;
  /** Advance the clock in stepMs increments, ticking each step (the ~5s carrier). */
  run: (durationMs: number, stepMs?: number) => Promise<void>;
}

function boot(opts: { dryRun?: boolean; floorMs?: number; exhaustAttempts?: number; midIntervalMs?: number; maxUnreclaimedSuccesses?: number; reopenEpisodeWindowMs?: number } = {}): Harness {
  const clock = { t: 1_000_000 };
  const resolver = new PeerEndpointResolver({
    config: {
      enabled: true,
      hedgeDelayMs: 1500,
      priorityTailscale: 10,
      priorityLan: 20,
      priorityCloudflare: 30,
      tailscaleEnabled: true,
      lanSubnetGate: false,
      unhealthyAfterFailures: 3,
      endpointEvictionMs: 24 * 3_600_000,
      maxProbeBackoffMs: 300_000,
      requestTimeoutMs: 10_000,
    },
    now: () => clock.t,
  });
  const probes: Array<{ at: number }> = [];
  const logs: string[] = [];
  const attention: Array<{ id: string; title: string }> = [];
  const metrics: string[] = [];
  let result: RopeProbeSendResult = { typedSuccess: false, detail: 'refused', latencyMs: 20 };
  const prober = new RopeRecoveryProber(
    {
      resolver,
      listTargets: () => [{ machineId: PEER, kind: KIND, url: URL_ }],
      sendProbe: async () => {
        probes.push({ at: clock.t });
        return { ...result };
      },
      raiseAttention: (item) => {
        attention.push({ id: item.id, title: item.title });
      },
      recordMetric: (e) => {
        metrics.push(e);
      },
      now: () => clock.t,
      logger: (m) => logs.push(m),
    },
    {
      dryRun: opts.dryRun ?? false,
      floorMs: opts.floorMs ?? 900_000,
      exhaustAttempts: opts.exhaustAttempts ?? 20,
      reopenEpisodeWindowMs: opts.reopenEpisodeWindowMs ?? 600_000,
      midIntervalMs: opts.midIntervalMs ?? 45_000,
      maxUnreclaimedSuccesses: opts.maxUnreclaimedSuccesses ?? 20,
    },
  );
  const tick = async () => {
    prober.onTick();
    // settle the fire-and-forget probe promise chain
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
  };
  const run = async (durationMs: number, stepMs = 5_000) => {
    const end = clock.t + durationMs;
    while (clock.t < end) {
      clock.t += stepMs;
      await tick();
    }
  };
  return { resolver, prober, clock, probes, logs, attention, metrics, setProbeResult: (r) => { result = { ...result, ...r }; }, tick, run };
}

/** Drive traffic failures until the rope is dead (3 consecutive). */
function killRope(h: Harness): void {
  for (let i = 0; i < 3; i++) h.resolver.recordResult(PEER, KIND, false, 50);
}

describe('RopeRecoveryProber — episode scoping (R-r2-2 / R-r3-1)', () => {
  it('opens an episode when the rope goes dead and fires the first probe immediately', async () => {
    const h = boot();
    await h.tick();
    expect(h.prober.episodeOpen(PEER, KIND)).toBe(false);
    expect(h.probes).toHaveLength(0);
    killRope(h);
    await h.tick();
    expect(h.prober.episodeOpen(PEER, KIND)).toBe(true);
    expect(h.probes).toHaveLength(1);
  });

  it('LIMBO arm: a fail-after-partial-recovery (recoveryStreak 0, consecutiveFailures 1, not lastKnownGood) STAYS probed', async () => {
    const h = boot({ midIntervalMs: 45_000 });
    killRope(h);
    h.setProbeResult({ typedSuccess: true });
    await h.tick(); // first success — dead clears (consecutiveFailures → 0)
    expect(h.resolver.healthOf(PEER, KIND)!.consecutiveFailures).toBe(0);
    expect(h.resolver.healthOf(PEER, KIND)!.recoveryStreak).toBe(1);
    // Now ONE probe failure: recoveryStreak → 0, consecutiveFailures → 1 (< dead
    // threshold) — the round-3 limbo state where a dead-only selector strands.
    h.setProbeResult({ typedSuccess: false });
    h.clock.t += 45_000;
    await h.tick();
    const rec = h.resolver.healthOf(PEER, KIND)!;
    expect(rec.recoveryStreak).toBe(0);
    expect(rec.consecutiveFailures).toBe(1);
    expect(rec.lastKnownGood).toBe(false);
    // The episode is still open and the rope is still probed.
    expect(h.prober.episodeOpen(PEER, KIND)).toBe(true);
    const before = h.probes.length;
    h.setProbeResult({ typedSuccess: true });
    await h.run(60_000); // backoff after 1 failure = 10s — well inside a minute
    expect(h.probes.length).toBeGreaterThan(before);
  });

  it('closes the episode ONLY on lastKnownGood reclaim (~4th success from EWMA saturation — R-r2-3)', async () => {
    const h = boot({ midIntervalMs: 10_000 });
    // Saturate the EWMA fail-rate with sustained traffic failures.
    for (let i = 0; i < 20; i++) h.resolver.recordResult(PEER, KIND, false, 50);
    h.setProbeResult({ typedSuccess: true, latencyMs: 20 });
    await h.tick(); // success #1 — dead clears...
    expect(h.resolver.healthOf(PEER, KIND)!.consecutiveFailures).toBe(0);
    expect(h.prober.episodeOpen(PEER, KIND)).toBe(true); // ...but the episode stays open
    let successes = 1;
    while (h.prober.episodeOpen(PEER, KIND) && successes < 10) {
      h.clock.t += 10_000;
      await h.tick();
      successes = h.probes.length;
    }
    // lastKnownGood needs recoveryStreak >= 3 AND ewmaFailRate <= 0.25:
    // from saturation 0.997 → 0.70 → 0.49 → 0.34 → 0.24 — the 4th success.
    expect(h.resolver.healthOf(PEER, KIND)!.lastKnownGood).toBe(true);
    expect(successes).toBe(4);
    expect(h.prober.episodeOpen(PEER, KIND)).toBe(false);
  });

  it('emits the rope-recovered breadcrumb when the dead flag clears (keyed on dead-clear, not reclaim)', async () => {
    const h = boot();
    killRope(h);
    h.setProbeResult({ typedSuccess: true });
    await h.tick(); // probe success clears dead
    await h.tick(); // next scan observes dead→clear
    expect(h.logs.some((l) => l.includes('rope-recovered'))).toBe(true);
    expect(h.metrics).toContain('rope-recovered');
  });
});

describe('RopeRecoveryProber — probe-layer cadence (R-r3-2)', () => {
  it('mid-recovery cadence is midIntervalMs, never the ~5s carrier tick', async () => {
    const h = boot({ midIntervalMs: 45_000 });
    killRope(h);
    h.setProbeResult({ typedSuccess: true });
    await h.tick(); // 1st probe clears dead — now mid-recovery
    const before = h.probes.length;
    // 40s of 5s carrier ticks — under the 45s mid-recovery interval: NO new probe.
    await h.run(40_000);
    expect(h.probes.length).toBe(before);
    await h.run(10_000); // crosses 45s
    expect(h.probes.length).toBe(before + 1);
  });

  it('slow-but-alive: after maxUnreclaimedSuccesses successes without reclaim → floor cadence + escalate-once', async () => {
    const h = boot({ midIntervalMs: 10_000, maxUnreclaimedSuccesses: 3, floorMs: 900_000 });
    killRope(h);
    // Successes whose LATENCY keeps the rope demoted (ewmaLatency > timeout/2 = 5000).
    h.setProbeResult({ typedSuccess: true, latencyMs: 9_000 });
    await h.tick();
    await h.run(30_000, 10_000); // successes 2..4 at the 10s mid-recovery cadence
    expect(h.attention.filter((a) => a.id.startsWith('rope-probe-slow-alive')).length).toBe(1);
    expect(h.metrics).toContain('slow-alive-floor');
    const at = h.probes.length;
    await h.run(600_000, 10_000); // 10 min < floor 15 min → no probe
    expect(h.probes.length).toBe(at);
    await h.run(400_000, 10_000); // crosses the floor
    expect(h.probes.length).toBe(at + 1);
    // still exactly ONE escalation
    expect(h.attention.filter((a) => a.id.startsWith('rope-probe-slow-alive')).length).toBe(1);
  });

  it('single-in-flight CAS: a slow probe blocks a second dial for the same (peer,kind)', async () => {
    const clock = { t: 1_000_000 };
    const resolver = new PeerEndpointResolver({
      config: {
        enabled: true, hedgeDelayMs: 1500, priorityTailscale: 10, priorityLan: 20,
        priorityCloudflare: 30, tailscaleEnabled: true, lanSubnetGate: false,
        unhealthyAfterFailures: 3, endpointEvictionMs: 3_600_000, maxProbeBackoffMs: 300_000,
        requestTimeoutMs: 10_000,
      },
      now: () => clock.t,
    });
    let inFlightResolve: ((r: RopeProbeSendResult) => void) | null = null;
    let sent = 0;
    const prober = new RopeRecoveryProber(
      {
        resolver,
        listTargets: () => [{ machineId: PEER, kind: KIND, url: URL_ }],
        sendProbe: () =>
          new Promise<RopeProbeSendResult>((resolve) => {
            sent += 1;
            inFlightResolve = resolve;
          }),
        now: () => clock.t,
      },
      { dryRun: false, floorMs: 900_000, exhaustAttempts: 20, reopenEpisodeWindowMs: 600_000, midIntervalMs: 45_000, maxUnreclaimedSuccesses: 20 },
    );
    for (let i = 0; i < 3; i++) resolver.recordResult(PEER, KIND, false, 50);
    prober.onTick();
    expect(sent).toBe(1);
    expect(prober.isInFlight(PEER, KIND)).toBe(true);
    // Hours pass; ticks keep coming; the probe is still in flight → no second dial.
    clock.t += 3_600_000;
    prober.onTick();
    prober.onTick();
    expect(sent).toBe(1);
    inFlightResolve!({ typedSuccess: true, detail: 'ok', latencyMs: 5 });
    await new Promise((r) => setImmediate(r));
    expect(prober.isInFlight(PEER, KIND)).toBe(false);
  });
});

describe('RopeRecoveryProber — dry-run honesty (R-r2-4)', () => {
  it('sends real probes but NEVER mutates the HealthRecord; would-close logged from the shadow streak', async () => {
    const h = boot({ dryRun: true, midIntervalMs: 45_000 });
    killRope(h);
    const before = { ...h.resolver.healthOf(PEER, KIND)! };
    h.setProbeResult({ typedSuccess: true });
    await h.tick();
    expect(h.probes.length).toBe(1); // a REAL probe was sent
    const after = h.resolver.healthOf(PEER, KIND)!;
    expect(after.consecutiveFailures).toBe(before.consecutiveFailures); // untouched
    expect(after.recoveryStreak).toBe(before.recoveryStreak);
    expect(h.logs.some((l) => l.includes('would-close'))).toBe(true);
    expect(h.metrics).toContain('dry-run-would-close');
    expect(h.metrics).toContain('dry-run-would-probe');
  });

  it('dry-run scheduling still enforces backoff + the P19 floor — no every-tick probing', async () => {
    const h = boot({ dryRun: true, exhaustAttempts: 3, floorMs: 900_000 });
    killRope(h);
    h.setProbeResult({ typedSuccess: false });
    // A simulated day of 5s ticks against a permanently-refusing rope: with the
    // HealthRecord never probe-mutated, the probe-layer lastProbeAt gate is the
    // ONLY brake — the bound must still hold.
    await h.run(24 * 3_600_000, 5_000);
    // ramp (5s,10s,20s → exhaustion at 3 fails) + ~96 floor probes/day
    expect(h.probes.length).toBeLessThan(120);
    expect(h.probes.length).toBeGreaterThan(80);
  });

  it('dry-run SUCCEEDING rope rides the mid-recovery cadence then the floor (bounded in the all-succeed arm)', async () => {
    const h = boot({ dryRun: true, midIntervalMs: 45_000, maxUnreclaimedSuccesses: 20, floorMs: 900_000 });
    killRope(h);
    h.setProbeResult({ typedSuccess: true });
    await h.run(24 * 3_600_000, 5_000);
    // 20 successes at 45s (15 min ramp) then ~96/day at the floor — never ~17k.
    expect(h.probes.length).toBeLessThan(130);
    expect(h.probes.length).toBeGreaterThan(80);
  });
});

describe('RopeRecoveryProber — exhaustion + P19 (Eternal-Sentinel exemption)', () => {
  it('exhaustion → floor cadence + ONE deduped escalation; re-arm on success', async () => {
    const h = boot({ exhaustAttempts: 3, floorMs: 900_000 });
    killRope(h);
    h.setProbeResult({ typedSuccess: false });
    await h.run(120_000); // 5s,10s,20s backoff → 3 failures inside 2 min
    expect(h.metrics).toContain('exhaustion-trip');
    expect(h.attention.filter((a) => a.id.startsWith('rope-probe-exhausted')).length).toBe(1);
    // Probing CONTINUES at the floor (never a hard stop).
    const at = h.probes.length;
    await h.run(2 * 900_000);
    expect(h.probes.length).toBe(at + 2);
    // Still ONE escalation (deduped per episode).
    expect(h.attention.filter((a) => a.id.startsWith('rope-probe-exhausted')).length).toBe(1);
    // Re-arm: a success clears exhaustion and the normal cadence resumes.
    h.setProbeResult({ typedSuccess: true });
    await h.run(900_000);
    expect(h.resolver.healthOf(PEER, KIND)!.consecutiveFailures).toBe(0);
    const view = h.prober.view().find((r) => r.peer === PEER && r.kind === KIND)!;
    expect(view.state).not.toBe('exhausted');
  });

  it('P19 sustained failure: a permanently-refusing rope stays under the declared bound over a simulated day (live mode)', async () => {
    const h = boot({ exhaustAttempts: 20, floorMs: 900_000 });
    killRope(h);
    h.setProbeResult({ typedSuccess: false });
    await h.run(24 * 3_600_000, 5_000);
    // Worst case ≈ exponential ramp to exhaustion (20 attempts) + ~96 floor
    // probes/day — the spec's honestly-stated cost bound.
    expect(h.probes.length).toBeLessThan(130);
  });
});

describe('RopeRecoveryProber — reopen episode brake', () => {
  it('a close→re-death inside the reopen window seeds a WIDENED backoff (overrides isProbeDue)', async () => {
    const h = boot({ midIntervalMs: 5_000, reopenEpisodeWindowMs: 600_000 });
    // Episode 1: kill, then recover to full lastKnownGood reclaim via probes.
    for (let i = 0; i < 3; i++) h.resolver.recordResult(PEER, KIND, false, 50);
    h.setProbeResult({ typedSuccess: true, latencyMs: 10 });
    // Run until the episode closes (reclaim).
    await h.run(120_000, 5_000);
    expect(h.prober.episodeOpen(PEER, KIND)).toBe(false);
    const episode1Probes = h.probes.length;
    expect(episode1Probes).toBeGreaterThan(0);

    // Re-death INSIDE the window (traffic failures) → braked reopen.
    for (let i = 0; i < 3; i++) h.resolver.recordResult(PEER, KIND, false, 50);
    h.setProbeResult({ typedSuccess: false });
    const at = h.probes.length;
    await h.tick();
    expect(h.prober.episodeOpen(PEER, KIND)).toBe(true);
    expect(h.logs.some((l) => l.includes('reopen brake'))).toBe(true);
    // The resolver's own isProbeDue would say "due" every ~5s after the fresh
    // failures — but the probe layer's widened backoff wins: the braked episode's
    // FIRST probe is deferred by the widened interval (no immediate re-dial), and
    // 5s later it is still not due.
    expect(h.probes.length).toBe(at);
    await h.run(5_000);
    expect(h.probes.length).toBe(at); // widened — NOT re-probed at base cadence
    await h.run(10_000);
    expect(h.probes.length).toBe(at + 1); // fires once the widened window elapses
  });
});

describe('RopeRecoveryProber — /health view rows', () => {
  it('serves state/lastProbeAt/nextProbeDueAt per (peer,kind) with no URLs', async () => {
    const h = boot();
    killRope(h);
    await h.tick();
    const rows = h.prober.view();
    const row = rows.find((r) => r.peer === PEER && r.kind === KIND)!;
    expect(row.state).toBe('dead');
    expect(row.consecutiveFailures).toBeGreaterThanOrEqual(3);
    expect(row.lastProbeAt).not.toBeNull();
    expect(row.nextProbeDueAt).toBeGreaterThan(row.lastProbeAt!);
    expect(JSON.stringify(row)).not.toContain('http');
  });
});
