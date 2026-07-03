/**
 * MachineCoherenceSentinel — C₁ evaluator core (machine-coherence-guard
 * §3.3/§3.4/§7): config resolution through the dev-agent gate (#1001
 * anti-mechanism, dry-run first), the single-machine strict no-op gate, the
 * per-tick classification pass over the pool view, the §3.4 election over
 * live-guard candidates, fail-toward-silence, and the §6 status snapshot.
 */
import { describe, it, expect } from 'vitest';
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
    expect(st.counters).toEqual({ ticks: 1, errors: 0 });
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
    expect(st.counters).toEqual({ ticks: 1, errors: 1 });
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
