/**
 * MachineCoherenceSentinel — C₁ evaluator core (machine-coherence-guard
 * §3.3/§3.4/§7): config resolution through the dev-agent gate (#1001
 * anti-mechanism, dry-run first), the single-machine strict no-op gate, the
 * per-tick classification pass over the pool view, the §3.4 election over
 * live-guard candidates, fail-toward-silence, and the §6 status snapshot.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import {
  MachineCoherenceSentinel,
  resolveMachineCoherenceConfig,
  selfPostureOf,
  type MachineCoherenceSentinelDeps,
} from '../../src/monitoring/MachineCoherenceSentinel.js';
import type { MachineCapacity } from '../../src/core/types.js';

const NOW = 1_751_500_000_000;

function cap(machineId: string, over: Partial<MachineCapacity> = {}): MachineCapacity {
  return {
    machineId,
    online: true,
    clockSkewStatus: 'ok',
    ...over,
  } as MachineCapacity;
}

function freshAdvert(guard: 'live' | 'dry-run' | 'dark') {
  return {
    coherenceAdvert: {
      instarVersion: '1.3.729',
      protocolVersion: 1,
      manifestHash: 'e'.repeat(64),
      guard,
      beatSeq: 1,
      flags: { developmentAgent: 'true' },
    },
    coherenceAdvertReceivedAt: new Date(NOW - 10_000).toISOString(),
  };
}

function makeSentinel(opts: {
  capacities: MachineCapacity[];
  self?: string | null;
  holder?: string | null;
  config?: Record<string, unknown>;
  listCapacities?: MachineCoherenceSentinelDeps['listCapacities'];
}) {
  const cfg = resolveMachineCoherenceConfig(opts.config ?? { developmentAgent: true, monitoring: { machineCoherence: { dryRun: false } } });
  return new MachineCoherenceSentinel(
    {
      listCapacities: opts.listCapacities ?? (() => opts.capacities),
      selfMachineId: () => (opts.self === undefined ? 'm_self' : opts.self),
      leaseHolderMachineId: () => opts.holder ?? null,
      now: () => NOW,
    },
    cfg,
  );
}

describe('resolveMachineCoherenceConfig (§7 — the dev-gate + dry-run-first ladder)', () => {
  it('resolves LIVE on a dev agent with no block (enabled OMITTED → gate decides) and dryRun defaults TRUE', () => {
    const cfg = resolveMachineCoherenceConfig({ developmentAgent: true });
    expect(cfg.enabled).toBe(true);
    expect(cfg.dryRun).toBe(true); // dry-run FIRST even on dev
    expect(selfPostureOf(cfg)).toBe('dry-run');
  });

  it('resolves DARK on the fleet (no developmentAgent, no block)', () => {
    const cfg = resolveMachineCoherenceConfig({});
    expect(cfg.enabled).toBe(false);
    expect(selfPostureOf(cfg)).toBe('dark');
  });

  it('an explicit enabled value always wins over the gate (both directions)', () => {
    expect(resolveMachineCoherenceConfig({ monitoring: { machineCoherence: { enabled: true } } }).enabled).toBe(true);
    expect(resolveMachineCoherenceConfig({ developmentAgent: true, monitoring: { machineCoherence: { enabled: false } } }).enabled).toBe(false);
  });

  it('ships the spec §7 defaults in code and honors overrides', () => {
    const d = resolveMachineCoherenceConfig({});
    expect(d.flagConfirmTicks).toBe(2);
    expect(d.versionSkewGraceMs).toBe(2_700_000);
    expect(d.advertStaleMs).toBe(300_000);
    expect(d.warmupTicks).toBe(4);
    expect(d.raiserTakeoverTicks).toBe(10);
    expect(d.maxEpisodeItemsPerDay).toBe(3);
    expect(d.episodeAppendBudget).toBe(6);
    expect(d.fixVerifyTicks).toBe(10);
    const o = resolveMachineCoherenceConfig({ monitoring: { machineCoherence: { flagConfirmTicks: 5, advertStaleMs: 60_000 } } });
    expect(o.flagConfirmTicks).toBe(5);
    expect(o.advertStaleMs).toBe(60_000);
  });
});

describe('MachineCoherenceSentinel.tick — gates + classification + election', () => {
  it('single machine online: strict no-op — empty verdict, no raiser, machinesCompared reports 1 (self always comparable)', () => {
    const s = makeSentinel({ capacities: [cap('m_self', freshAdvert('live'))] });
    s.tick();
    const st = s.status();
    expect(st.machinesRegisteredOnline).toBe(1);
    expect(st.machinesCompared).toBe(1);
    expect(st.raiser.machineId).toBeNull();
    expect(st.counters).toEqual({ ticks: 1, skewsConfirmed: 0, confirmedRows: 0, pendingRows: 0, errors: 0 });
  });

  it('offline machines never enter the comparison (§3.3 scope: offline is a liveness problem with existing owners)', () => {
    const s = makeSentinel({
      capacities: [cap('m_self', freshAdvert('live')), cap('m_peer', { online: false, ...freshAdvert('live') })],
    });
    s.tick();
    expect(s.status().machinesRegisteredOnline).toBe(1);
    expect(s.status().machinesCompared).toBe(1); // short-circuited below 2
  });

  it('classifies every online machine and counts each class (M11 universe honesty)', () => {
    const s = makeSentinel({
      capacities: [
        cap('m_self', freshAdvert('live')),
        cap('m_fresh', freshAdvert('live')),
        cap('m_old', {}), // advert-less → unknown
        cap('m_stale', { ...freshAdvert('live'), coherenceAdvertReceivedAt: new Date(NOW - 600_000).toISOString() }),
        cap('m_bad', { coherenceAdvertRejected: { atMs: NOW, reason: 'flag-value-format' } }),
      ],
    });
    s.tick();
    const st = s.status();
    expect(st.machinesRegisteredOnline).toBe(5);
    expect(st.peerClassifications).toEqual({ compared: 2, unknown: 1, advertStale: 1, advertRejected: 1 });
    expect(st.machinesCompared).toBe(2);
  });

  it('elects the lease holder when it is a live candidate; standby computes the SAME raiser (shared inputs)', () => {
    const mk = (self: string) =>
      makeSentinel({
        capacities: [cap('m_a', freshAdvert('live')), cap('m_b', freshAdvert('live'))],
        self,
        holder: 'm_b',
        // Both machines run live (dryRun:false) so both are candidates.
      });
    const a = mk('m_a');
    const b = mk('m_b');
    a.tick();
    b.tick();
    expect(a.status().raiser).toEqual({ machineId: 'm_b', isSelf: false, candidates: ['m_a', 'm_b'] });
    expect(b.status().raiser.machineId).toBe('m_b');
    expect(b.status().raiser.isSelf).toBe(true);
  });

  it('a dry-run SELF is not a candidate (its posture comes from LOCAL config, not its possibly-stale advert echo)', () => {
    const s = makeSentinel({
      capacities: [cap('m_self', freshAdvert('live')), cap('m_peer', freshAdvert('live'))],
      config: { developmentAgent: true }, // dryRun defaults TRUE → self posture dry-run
      holder: 'm_self',
    });
    s.tick();
    const st = s.status();
    expect(st.raiser.candidates).toEqual(['m_peer']);
    expect(st.raiser.machineId).toBe('m_peer'); // holder not a candidate → lowest live candidate
    expect(st.raiser.isSelf).toBe(false);
  });

  it('a dry-run/dark PEER is not a candidate (§3.4 — dry-run records locally, never raises)', () => {
    const s = makeSentinel({
      capacities: [cap('m_self', freshAdvert('live')), cap('m_dry', freshAdvert('dry-run')), cap('m_dark', {})],
      holder: null,
    });
    s.tick();
    expect(s.status().raiser.candidates).toEqual(['m_self']);
    expect(s.status().raiser.machineId).toBe('m_self');
  });

  it('fails toward silence: a throwing pool view increments the error counter and emits nothing (§3.3)', () => {
    const s = makeSentinel({
      capacities: [],
      listCapacities: () => {
        throw new Error('registry unreadable');
      },
    });
    s.tick();
    const st = s.status();
    expect(st.counters).toEqual({ ticks: 1, skewsConfirmed: 0, confirmedRows: 0, pendingRows: 0, errors: 1 });
    expect(st.raiser.machineId).toBeNull();
  });

  it('inWarmup reflects the N8 post-boot window (warmupTicks default 4)', () => {
    const s = makeSentinel({ capacities: [cap('m_self', freshAdvert('live'))] });
    expect(s.inWarmup()).toBe(true);
    for (let i = 0; i < 4; i++) s.tick();
    expect(s.inWarmup()).toBe(false);
  });

  it('openEpisode is null until the Session-B episode machinery lands (the snapshot never fabricates one)', () => {
    const s = makeSentinel({ capacities: [cap('m_self', freshAdvert('live')), cap('m_peer', freshAdvert('live'))] });
    s.tick();
    expect(s.status().openEpisode).toBeNull();
  });
});

describe('MachineCoherenceSentinel — §3.3 confirmation engine (R2-L3 consecutive rule + M6 suppression)', () => {
  // A sentinel whose clock we advance tick-by-tick. `capacities(clock)` receives
  // the CURRENT clock so fixtures can stamp fresh advert receipts (a frozen
  // receipt would age past advertStaleMs when the clock advances minutes).
  function mkAdvancing(capacities: (clock: number) => MachineCapacity[], config?: Record<string, unknown>) {
    let clock = NOW;
    const cfg = resolveMachineCoherenceConfig(config ?? { developmentAgent: true, monitoring: { machineCoherence: { dryRun: false } } });
    const s = new MachineCoherenceSentinel(
      { listCapacities: () => capacities(clock), selfMachineId: () => 'm_self', leaseHolderMachineId: () => null, now: () => clock },
      cfg,
    );
    return { s, tickAt: (ms: number) => { clock += ms; s.tick(); } };
  }

  // Build a fresh (receipt = clock-1s) advert-carrying capacity.
  function fresh(machineId: string, clock: number, over: { version?: string; protocol?: number; hash?: string; flags?: Record<string, string> } = {}): MachineCapacity {
    return cap(machineId, {
      coherenceAdvert: {
        instarVersion: over.version ?? '1.3.729',
        protocolVersion: over.protocol ?? 1,
        manifestHash: over.hash ?? 'e'.repeat(64),
        guard: 'live',
        beatSeq: 1,
        flags: over.flags ?? { developmentAgent: 'true' },
      },
      coherenceAdvertReceivedAt: new Date(clock - 1_000).toISOString(),
    });
  }

  it('a flag skew confirms only after flagConfirmTicks CONSECUTIVE ticks (default 2)', () => {
    const { s, tickAt } = mkAdvancing((c) => [fresh('m_self', c), fresh('m_peer', c, { flags: { developmentAgent: 'false' } })]);
    tickAt(0);
    expect(s.status().counters.pendingRows).toBe(1);
    expect(s.status().counters.confirmedRows).toBe(0);
    tickAt(30_000);
    expect(s.status().counters.confirmedRows).toBe(1);
    expect(s.status().counters.skewsConfirmed).toBe(1);
  });

  it('R2-L3: a row that vanishes for a tick resets — one flapping reading never accumulates to confirmation', () => {
    let peerFlag = 'false';
    const { s, tickAt } = mkAdvancing((c) => [fresh('m_self', c), fresh('m_peer', c, { flags: { developmentAgent: peerFlag } })]);
    tickAt(0);            // skew present (tick 1)
    peerFlag = 'true';   // pair equalizes → row vanishes
    tickAt(30_000);
    expect(s.status().counters.confirmedRows).toBe(0);
    expect(s.status().counters.pendingRows).toBe(0);
    peerFlag = 'false';  // skew reappears — starts fresh at 1, not confirmed yet
    tickAt(30_000);
    expect(s.status().counters.confirmedRows).toBe(0);
    expect(s.status().counters.pendingRows).toBe(1);
  });

  it('M6: a flag row is suppressed while a version skew is present, then confirms once versions agree', () => {
    let peerVersion = '1.4.0';
    const { s, tickAt } = mkAdvancing((c) => [fresh('m_self', c), fresh('m_peer', c, { version: peerVersion, flags: { developmentAgent: 'false' } })]);
    tickAt(0);
    tickAt(30_000);
    // No FLAG row confirms while a version skew stands (M6 suppression); the
    // major-minor version row itself confirms normally in 2 ticks.
    expect(s.confirmedSkewRows().find((r) => r.dimension === 'flag')).toBeUndefined();
    expect(s.confirmedSkewRows().some((r) => r.dimension === 'version')).toBe(true);
    // Versions agree → the residual flag skew confirms normally over 2 ticks.
    peerVersion = '1.3.729';
    tickAt(30_000);
    tickAt(30_000);
    expect(s.confirmedSkewRows().some((r) => r.dimension === 'flag' && r.key === 'developmentAgent')).toBe(true);
  });

  it('patch-only version skew confirms on the grace CLOCK, not tick count (default 45 min)', () => {
    const { s, tickAt } = mkAdvancing((c) => [fresh('m_self', c), fresh('m_peer', c, { version: '1.3.730' })]);
    tickAt(0);
    tickAt(30_000); // 2 ticks — but patch-only does NOT confirm on tick count
    expect(s.confirmedSkewRows().find((r) => r.dimension === 'version')).toBeUndefined();
    tickAt(2_700_000); // cross the 45-min grace window (advert receipts stay fresh via the clock)
    expect(s.confirmedSkewRows().some((r) => r.dimension === 'version')).toBe(true);
  });

  it('dropping below 2 online members clears the confirmation engine', () => {
    let peerOnline = true;
    const { s, tickAt } = mkAdvancing((c) => peerOnline ? [fresh('m_self', c), fresh('m_peer', c, { flags: { developmentAgent: 'false' } })] : [fresh('m_self', c)]);
    tickAt(0);
    expect(s.status().counters.pendingRows).toBe(1);
    peerOnline = false; // peer goes offline
    tickAt(30_000);
    expect(s.status().counters.pendingRows).toBe(0);
    expect(s.status().counters.confirmedRows).toBe(0);
  });
});

describe('MachineCoherenceSentinel — episode machinery wiring (C₁b-iii-b4)', () => {
  const tmpDirs: string[] = [];
  afterEach(() => { for (const d of tmpDirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/unit/MachineCoherenceSentinel.test.ts' }); });

  function withStateDir() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-sentinel-'));
    tmpDirs.push(root);
    return path.join(root, '.instar'); // stateDir convention (<agent>/.instar)
  }

  function skewCap(machineId: string, dev: 'true' | 'false') {
    return cap(machineId, {
      coherenceAdvert: { instarVersion: '1.3.729', protocolVersion: 1, manifestHash: 'e'.repeat(64), guard: 'live', beatSeq: 1, flags: { developmentAgent: dev } },
      coherenceAdvertReceivedAt: new Date(NOW - 5_000).toISOString(),
    });
  }

  it('with a stateDir + live raiser, a confirmed skew drives the EpisodeManager and drainPendingEffects returns a real raise', () => {
    const stateDir = withStateDir();
    let clock = NOW;
    const cfg = resolveMachineCoherenceConfig({ developmentAgent: true, monitoring: { machineCoherence: { dryRun: false, warmupTicks: 0, flagConfirmTicks: 1 } } });
    const s = new MachineCoherenceSentinel(
      {
        listCapacities: () => [skewCap('m_self', 'true'), skewCap('m_peer', 'false')],
        selfMachineId: () => 'm_self',
        leaseHolderMachineId: () => 'm_self',
        now: () => clock,
        stateDir: () => stateDir,
        nicknameOf: (m) => (m === 'm_self' ? 'the laptop' : 'the mini'),
      },
      cfg,
    );
    s.tick();          // confirm (flagConfirmTicks:1) + reconcile → open + raise
    const effects = s.drainPendingEffects();
    expect(effects.find((e) => e.kind === 'raise')).toBeDefined();
    expect(s.status().openEpisode).not.toBeNull();
    expect(s.status().episodeCounters?.itemsRaised).toBe(1);
    // Draining clears the queue.
    expect(s.drainPendingEffects()).toEqual([]);
  });

  it('without a stateDir, the sentinel runs classification only — no episode, empty drain', () => {
    const s = makeSentinel({ capacities: [cap('m_self', freshAdvert('live')), cap('m_peer', freshAdvert('live'))] });
    s.tick();
    expect(s.status().openEpisode).toBeNull();
    expect(s.drainPendingEffects()).toEqual([]);
  });
});

describe('MachineCoherenceSentinel.guardStatus — the C₁b-i GuardRegistry runtime getter (§6)', () => {
  it('returns a GuardRuntimeStatus-shaped object (enabled boolean, dryRun boolean, lastTickAt number)', () => {
    const s = makeSentinel({ capacities: [cap('m_self', freshAdvert('live'))], config: { developmentAgent: true, monitoring: { machineCoherence: { dryRun: false } } } });
    const g = s.guardStatus();
    expect(typeof g.enabled).toBe('boolean');
    expect(typeof g.dryRun).toBe('boolean');
    expect(typeof g.lastTickAt).toBe('number');
    expect(g.enabled).toBe(true);
    expect(g.dryRun).toBe(false);
  });

  it('lastTickAt is 0 before the first tick (constructed-but-never-ticking reads on-stale, never "on"), and advances after a tick', () => {
    const s = makeSentinel({ capacities: [cap('m_self', freshAdvert('live')), cap('m_peer', freshAdvert('live'))] });
    expect(s.guardStatus().lastTickAt).toBe(0);
    s.tick();
    expect(s.guardStatus().lastTickAt).toBe(NOW); // the injected clock
  });

  it('mirrors the resolved dev-gate posture: dry-run-first on a dev agent, dark posture reflected in enabled', () => {
    const dev = makeSentinel({ capacities: [cap('m_self', freshAdvert('live'))], config: { developmentAgent: true } });
    expect(dev.guardStatus()).toMatchObject({ enabled: true, dryRun: true }); // dry-run FIRST even on dev
    const fleet = makeSentinel({ capacities: [cap('m_self', freshAdvert('live'))], config: {} });
    expect(fleet.guardStatus().enabled).toBe(false); // dark on the fleet
  });
});
