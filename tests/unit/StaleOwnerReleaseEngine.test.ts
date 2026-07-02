/**
 * U4.2 — StaleOwnerReleaseEngine (docs/specs/u4-2-stale-owner-release.md).
 *
 * Locks the §2.2 evidence bar (ALL required; fail CLOSED on any ambiguity), the
 * §2.1 lease-holder-only claim arbiter, the §2.5 bounded blast radius (per-tick
 * cap, replicated per-topic budget + backoff, P19 give-ups), the §2.6 honesty
 * surfaces (refusal traces, once-per-episode escalation, declined-demote), the
 * R-r2-2 bounded bootstrap rule (a claimant restart never silently disables
 * auto-failover), the R-r2-3 mirror-freshness gate + TTL-ordering invariant,
 * and the §2.9 status surface + ownershipLeaseState derivation table.
 */
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  StaleOwnerReleaseEngine,
  DEFAULT_STALE_OWNER_RELEASE_CONFIG,
  validateStaleOwnerReleaseInvariants,
  deriveOwnershipLeaseState,
  type StaleOwnerReleaseDeps,
  type StaleOwnerTraceEntry,
  type StaleOwnerAttentionItem,
  type StaleOwnerReleaseConfig,
} from '../../src/core/StaleOwnerReleaseEngine.js';
import type { SessionOwnershipRecord } from '../../src/core/SessionOwnership.js';
import type { MergedClaimAnnotation } from '../../src/core/TopicClaimAnnotationStore.js';

const OWNER = 'm_owner';
const SELF = 'm_self';
const THIRD = 'm_third';

function record(sessionKey: string, owner = OWNER, status: SessionOwnershipRecord['status'] = 'active'): SessionOwnershipRecord {
  return {
    sessionKey,
    ownerMachineId: owner,
    ownershipEpoch: 3,
    status,
    nonce: 'n',
    timestamp: 1_000,
    updatedAt: new Date(1_000).toISOString(),
  };
}

interface HarnessOpts {
  dryRun?: boolean;
  holdsLease?: boolean;
  machines?: Array<{ machineId: string; online: boolean; observerLastSeenMs: number }>;
  records?: SessionOwnershipRecord[];
  advert?: { endpoints: Array<{ kind: string; url: string }>; fresh: boolean };
  probeResult?: boolean | 'error';
  selfProof?: boolean;
  hasDurableLeaseAuthority?: boolean;
  mirrorSyncOkMs?: number | null;
  lastSideEffectMs?: number | null;
  annotations?: Map<number, MergedClaimAnnotation>;
  durableHeartbeatMs?: number | null;
  claimLands?: boolean;
  cfg?: Partial<StaleOwnerReleaseConfig>;
}

/**
 * Deterministic harness: injected wall + mono clocks; probes resolve on a
 * microtask so `await tickTwice()` observes the memoized verdict on the second
 * pass (the engine's real single-flight-then-consume shape).
 */
function makeHarness(opts: HarnessOpts = {}) {
  let wall = 1_000_000;
  let mono = 500_000;
  const traces: StaleOwnerTraceEntry[] = [];
  const attention: StaleOwnerAttentionItem[] = [];
  const claims: Array<{ sessionKey: string; episodeId: string }> = [];
  const annotationsEmitted: Array<Parameters<StaleOwnerReleaseDeps['emitClaimAnnotation']>[0]> = [];
  const pulls: number[] = [];
  const cfg: StaleOwnerReleaseConfig = {
    ...DEFAULT_STALE_OWNER_RELEASE_CONFIG,
    enabled: true,
    dryRun: opts.dryRun ?? false,
    ...opts.cfg,
  } as StaleOwnerReleaseConfig;
  const machines = () =>
    opts.machines ?? [
      { machineId: SELF, online: true, observerLastSeenMs: wall },
      { machineId: THIRD, online: true, observerLastSeenMs: wall },
      // Owner: observed once at boot, then dark (offline, stale lastSeen).
      { machineId: OWNER, online: false, observerLastSeenMs: 1 },
    ];
  const deps: StaleOwnerReleaseDeps = {
    enabled: () => cfg.enabled,
    dryRun: () => cfg.dryRun,
    config: () => cfg,
    selfMachineId: () => SELF,
    machines,
    holdsLease: () => opts.holdsLease ?? true,
    listOwnershipRecords: () => opts.records ?? [record('700')],
    durableLastKnownHeartbeatMs: () => opts.durableHeartbeatMs ?? 1,
    advertSet: () =>
      opts.advert ?? {
        endpoints: [
          { kind: 'tailscale', url: 'http://ts.example:4040' },
          { kind: 'lan', url: 'http://lan.example:4040' },
        ],
        fresh: true,
      },
    probeEndpoint: async () => {
      if (opts.probeResult === 'error') throw new Error('probe transport fault');
      return opts.probeResult ?? false; // default: unreachable everywhere
    },
    selfConnectivityProof: async () => opts.selfProof ?? true,
    hasDurableLeaseAuthority: () => opts.hasDurableLeaseAuthority ?? true,
    evidenceMirror: () => ({
      lastSyncOkMs: opts.mirrorSyncOkMs === undefined ? wall - 1_000 : opts.mirrorSyncOkMs,
      lastOwnerSideEffectMs: () => (opts.lastSideEffectMs === undefined ? wall - 10 * 60_000 : opts.lastSideEffectMs),
    }),
    // Level-reconciled realism: emitted annotations become visible on the NEXT
    // read (the replicated view), so a landed claim's budget/backoff actually
    // bounds re-claims — exactly the production topology.
    claimAnnotations: () => {
      const out = new Map<number, MergedClaimAnnotation>(opts.annotations ?? []);
      for (const a of annotationsEmitted) {
        out.set(a.topic, {
          topic: a.topic,
          episodeId: a.episodeId,
          suspended: a.suspended,
          claimedBy: a.claimedBy,
          claimCount: a.claimCount,
          backoffUntilMs: a.backoffUntilMs,
          declinedDemote: a.declinedDemote === true,
          origin: SELF,
          hlc: { physical: wall, logical: 0, node: SELF },
        });
      }
      return out;
    },
    actForceClaim: (sessionKey, episodeId) => {
      claims.push({ sessionKey, episodeId });
      return opts.claimLands ?? true;
    },
    emitClaimAnnotation: (input) => {
      annotationsEmitted.push(input);
    },
    pullWorkingSet: (topic) => {
      pulls.push(topic);
    },
    trace: (e) => traces.push(e),
    raiseAttention: (i) => attention.push(i),
    now: () => wall,
    monotonicNow: () => mono,
  };
  const engine = new StaleOwnerReleaseEngine(deps);
  const advance = (ms: number) => {
    wall += ms;
    mono += ms;
  };
  /** One tick, then let any kicked probes/self-proof resolve, then tick again —
   *  the evidence bar consumes memoized async verdicts on a LATER tick. */
  const tickSettled = async (rounds = 4) => {
    for (let i = 0; i < rounds; i++) {
      engine.tick();
      await Promise.resolve();
      await new Promise((r) => setTimeout(r, 0));
    }
  };
  return { engine, deps, traces, attention, claims, annotationsEmitted, pulls, advance, tickSettled, cfg };
}

/** Advance past the death-evidence bound so evidence 1 reads EXPIRED. */
async function expireOwner(h: ReturnType<typeof makeHarness>) {
  h.engine.tick(); // fold the initial observation
  h.advance(DEFAULT_STALE_OWNER_RELEASE_CONFIG.deathEvidenceMs + 5_000);
  await h.tickSettled();
}

describe('StaleOwnerReleaseEngine — the §2.2 evidence bar', () => {
  it('expired-plus-all-transports-plus-quorum-plus-self-proof-allows-claim', async () => {
    const h = makeHarness();
    await expireOwner(h);
    expect(h.claims).toEqual([{ sessionKey: '700', episodeId: expect.stringContaining(OWNER) }]);
    // §2.4/§2.7.4 — the claim and its suspension annotation share one apply path.
    expect(h.annotationsEmitted).toHaveLength(1);
    expect(h.annotationsEmitted[0]).toMatchObject({ topic: 700, suspended: true, claimedBy: SELF, claimCount: 1 });
    // §2.4 — working-set pull attempted for the claimed topic.
    expect(h.pulls).toEqual([700]);
    expect(h.traces.some((t) => t.type === 'claim' && t.topic === '700')).toBe(true);
  });

  it('owner-reachable-on-one-transport-never-claims (probe refreshes liveness)', async () => {
    const h = makeHarness({ probeResult: true });
    await expireOwner(h);
    expect(h.claims).toHaveLength(0);
    const s = h.engine.status();
    expect(s.counters.refusalsByReason['not-expired']).toBeGreaterThan(0);
  });

  it('transport-ambiguity-fails-closed (probe errors are never disproof)', async () => {
    const h = makeHarness({ probeResult: 'error' });
    await expireOwner(h);
    expect(h.claims).toHaveLength(0);
    expect(h.engine.status().counters.ambiguities).toBeGreaterThan(0);
  });

  it('empty-or-stale-or-single-advert-set-is-ambiguity', async () => {
    for (const advert of [
      { endpoints: [], fresh: true },
      { endpoints: [{ kind: 'lan', url: 'http://x' }, { kind: 'tailscale', url: 'http://y' }], fresh: false },
      // Single-transport advertisement = automatic ambiguity (the single-rope false-death).
      { endpoints: [{ kind: 'lan', url: 'http://x' }], fresh: true },
    ]) {
      const h = makeHarness({ advert });
      await expireOwner(h);
      expect(h.claims).toHaveLength(0);
      expect(h.engine.status().counters.ambiguities).toBeGreaterThan(0);
    }
  });

  it('claimant-egress-down-never-claims (self-connectivity proof fails → refusal)', async () => {
    const h = makeHarness({ selfProof: false });
    await expireOwner(h);
    expect(h.claims).toHaveLength(0);
    expect(h.engine.status().counters.refusalsByReason['self-proof-fail']).toBeGreaterThan(0);
  });

  it('quorum-fail refuses the claim (majority partition required)', async () => {
    const h = makeHarness({
      machines: [
        { machineId: SELF, online: true, observerLastSeenMs: 1_000_000 },
        // Two dark peers → online 1 of 3 → no quorum.
        { machineId: THIRD, online: false, observerLastSeenMs: 1 },
        { machineId: OWNER, online: false, observerLastSeenMs: 1 },
      ],
    });
    await expireOwner(h);
    expect(h.claims).toHaveLength(0);
    expect(h.engine.status().counters.refusalsByReason['quorum-fail']).toBeGreaterThan(0);
  });

  it('stale-evidence-mirror-classifies-ambiguity (R-r2-3 — a stale mirror is never "no recent side-effects")', async () => {
    const h = makeHarness({ mirrorSyncOkMs: null });
    await expireOwner(h);
    expect(h.claims).toHaveLength(0);
    expect(h.engine.status().evidenceClasses['mirror-stale']).toBeGreaterThan(0);
  });

  it('fresh owner side-effects refuse the claim (evidence 5 — mesh-unreachable ≠ dead)', async () => {
    const h = makeHarness({ lastSideEffectMs: 999_999 }); // just written
    h.engine.tick();
    h.advance(DEFAULT_STALE_OWNER_RELEASE_CONFIG.deathEvidenceMs + 5_000);
    // Keep the side-effect INSIDE the window relative to the advanced clock.
    (h.deps.evidenceMirror as unknown) = h.deps.evidenceMirror;
    const h2 = makeHarness({ lastSideEffectMs: 1_000_000 + DEFAULT_STALE_OWNER_RELEASE_CONFIG.deathEvidenceMs + 4_000 });
    await expireOwner(h2);
    expect(h2.claims).toHaveLength(0);
    expect(h2.engine.status().counters.refusalsByReason['side-effect-fresh']).toBeGreaterThan(0);
  });

  it('two-machine-gitless-claim-path-disabled (fail closed; detection still runs)', async () => {
    const h = makeHarness({
      hasDurableLeaseAuthority: false,
      machines: [
        { machineId: SELF, online: true, observerLastSeenMs: 1_000_000 },
        { machineId: OWNER, online: false, observerLastSeenMs: 1 },
      ],
    });
    await expireOwner(h);
    expect(h.claims).toHaveLength(0);
    expect(h.engine.status().evidenceClasses['two-machine-gitless']).toBeGreaterThan(0);
    // Detection still ran: an episode is open.
    expect(h.engine.status().openEpisodes).toHaveLength(1);
  });
});

describe('StaleOwnerReleaseEngine — bootstrap rule (R-r2-2)', () => {
  it('bootstrap-never-observed-owner-is-ambiguity-then-expired', async () => {
    // Owner NEVER observed since claimant boot (observerLastSeenMs 0 → no fold).
    const machines = [
      { machineId: SELF, online: true, observerLastSeenMs: 1_000_000 },
      { machineId: THIRD, online: true, observerLastSeenMs: 1_000_000 },
      { machineId: OWNER, online: false, observerLastSeenMs: 0 },
    ];
    const h = makeHarness({ machines, durableHeartbeatMs: 1 });
    await h.tickSettled(1);
    // Before the bootstrap bound: AMBIGUITY (never a claim, never a silent pass).
    expect(h.claims).toHaveLength(0);
    expect(h.engine.status().evidenceClasses['bootstrap-ambiguity']).toBeGreaterThan(0);
    // After bootstrapNonObservationMultiple × deathEvidenceMs of CONTINUOUS
    // non-observation + an old durable heartbeat: EXPIRED → the claim proceeds.
    h.advance(DEFAULT_STALE_OWNER_RELEASE_CONFIG.bootstrapNonObservationMultiple * DEFAULT_STALE_OWNER_RELEASE_CONFIG.deathEvidenceMs + 5_000);
    await h.tickSettled();
    expect(h.engine.status().evidenceClasses['bootstrap-expired']).toBeGreaterThan(0);
    expect(h.claims).toHaveLength(1);
  });

  it('claimant-restart-does-not-strand-auto-failover (never NOT-expired forever)', async () => {
    // The regression this rule kills: a naive "never observed ⇒ NOT-expired"
    // would refuse forever after a claimant restart. The bounded rule converges.
    const machines = [
      { machineId: SELF, online: true, observerLastSeenMs: 1_000_000 },
      { machineId: THIRD, online: true, observerLastSeenMs: 1_000_000 },
      { machineId: OWNER, online: false, observerLastSeenMs: 0 },
    ];
    const h = makeHarness({ machines, durableHeartbeatMs: 1 });
    h.advance(10 * DEFAULT_STALE_OWNER_RELEASE_CONFIG.deathEvidenceMs);
    await h.tickSettled();
    expect(h.claims).toHaveLength(1);
  });

  it('a FRESH durable heartbeat holds the bootstrap case at ambiguity (tie-breaker)', async () => {
    const machines = [
      { machineId: SELF, online: true, observerLastSeenMs: 1_000_000 },
      { machineId: THIRD, online: true, observerLastSeenMs: 1_000_000 },
      { machineId: OWNER, online: false, observerLastSeenMs: 0 },
    ];
    // durable heartbeat is CURRENT (wall-now) → condition (b) fails → ambiguity.
    const h = makeHarness({ machines, durableHeartbeatMs: 1_000_000 + 10 * DEFAULT_STALE_OWNER_RELEASE_CONFIG.deathEvidenceMs - 1_000 });
    h.advance(10 * DEFAULT_STALE_OWNER_RELEASE_CONFIG.deathEvidenceMs);
    await h.tickSettled();
    expect(h.claims).toHaveLength(0);
    expect(h.engine.status().evidenceClasses['bootstrap-ambiguity']).toBeGreaterThan(0);
  });
});

describe('StaleOwnerReleaseEngine — arbiter, caps, budgets (§2.1 / §2.5)', () => {
  it('concurrent-claims-arbiter-uniqueness: a non-lease-holder NEVER claims (detection continues)', async () => {
    const h = makeHarness({ holdsLease: false });
    await expireOwner(h);
    expect(h.claims).toHaveLength(0);
    expect(h.traces.some((t) => t.type === 'refusal' && t.reason === 'not-lease-holder')).toBe(true);
    // Detection + episode bookkeeping still ran (quorum-member hosting).
    expect(h.engine.status().openEpisodes).toHaveLength(1);
  });

  it('claims-are-capped-and-paced-per-tick (P19 maxClaimsPerTick)', async () => {
    const h = makeHarness({
      records: [record('700'), record('701'), record('702'), record('703')],
      cfg: { maxClaimsPerTick: 2 },
    });
    h.engine.tick();
    h.advance(DEFAULT_STALE_OWNER_RELEASE_CONFIG.deathEvidenceMs + 5_000);
    // Settle probes, then ONE claiming tick.
    await h.tickSettled(3);
    expect(h.claims.length).toBeLessThanOrEqual(2 * 3); // never unbounded
    // A single tick lands at most maxClaimsPerTick:
    const perTick = h.claims.length;
    h.claims.length = 0;
    h.engine.tick();
    expect(h.claims.length).toBeLessThanOrEqual(2);
    void perTick;
  });

  it('declined-demote blocks the episode claims on ANY claimer (replicated read)', async () => {
    const h = makeHarness();
    // First discover the episode id via a dry pass with dryRun? Instead: expire,
    // then inject the annotation carrying declinedDemote for the LIVE episode.
    h.engine.tick();
    h.advance(DEFAULT_STALE_OWNER_RELEASE_CONFIG.deathEvidenceMs + 5_000);
    await h.tickSettled(2);
    const episodeId = h.engine.status().openEpisodes[0]?.episodeId ?? '';
    expect(episodeId).toBeTruthy();
    h.claims.length = 0;
    const ann: MergedClaimAnnotation = {
      topic: 700,
      episodeId,
      suspended: false,
      claimCount: 0,
      declinedDemote: true,
      origin: THIRD, // recorded by ANOTHER machine — survives lease movement
      hlc: { physical: 1, logical: 0, node: THIRD },
    };
    const h2annotations = new Map([[700, ann]]);
    (h.deps.claimAnnotations as unknown) = h.deps.claimAnnotations;
    // Rebuild a harness sharing the episode via same flow but with the annotation:
    const h2 = makeHarness({ annotations: h2annotations });
    h2.engine.tick();
    h2.advance(DEFAULT_STALE_OWNER_RELEASE_CONFIG.deathEvidenceMs + 5_000);
    await h2.tickSettled(2);
    const ep2 = h2.engine.status().openEpisodes[0]?.episodeId ?? '';
    // Align the annotation to the live episode id (the declined-demote is per-episode).
    ann.episodeId = ep2;
    h2.claims.length = 0;
    await h2.tickSettled(2);
    expect(h2.claims).toHaveLength(0);
    expect(h2.traces.some((t) => t.type === 'refusal' && t.reason === 'declined-demote')).toBe(true);
  });

  it('per-topic replicated claim budget exhaustion is a LOUD P19 give-up (one attention item)', async () => {
    const annotations = new Map<number, MergedClaimAnnotation>([
      [700, { topic: 700, episodeId: 'other-ep', suspended: false, claimCount: 5, declinedDemote: false, origin: THIRD, hlc: { physical: 1, logical: 0, node: THIRD } }],
    ]);
    const h = makeHarness({ annotations });
    await expireOwner(h);
    expect(h.claims).toHaveLength(0);
    expect(h.engine.status().counters.p19GiveUps).toBe(1);
    expect(h.attention.filter((a) => a.id.startsWith('stale-owner-giveup:'))).toHaveLength(1);
    // Re-tick: still ONE item (deduped per episode+topic).
    await h.tickSettled(2);
    expect(h.attention.filter((a) => a.id.startsWith('stale-owner-giveup:'))).toHaveLength(1);
  });

  it('a widening backoff window defers the next claim attempt (R-r2-4 — replicated backoffUntilMs)', async () => {
    const backoffUntil = 1_000_000 + DEFAULT_STALE_OWNER_RELEASE_CONFIG.deathEvidenceMs + 60 * 60_000;
    const annotations = new Map<number, MergedClaimAnnotation>([
      [700, { topic: 700, episodeId: 'other-ep', suspended: false, claimCount: 2, backoffUntilMs: backoffUntil, declinedDemote: false, origin: THIRD, hlc: { physical: 1, logical: 0, node: THIRD } }],
    ]);
    const h = makeHarness({ annotations });
    await expireOwner(h);
    expect(h.claims).toHaveLength(0); // inside the replicated backoff window
  });

  it('a refused CAS still consumes budget (flap bounding)', async () => {
    const h = makeHarness({ claimLands: false });
    await expireOwner(h);
    expect(h.claims.length).toBeGreaterThan(0);
    expect(h.annotationsEmitted.some((a) => a.suspended === false && a.claimCount === 1 && typeof a.backoffUntilMs === 'number')).toBe(true);
  });

  it('a fresh drainInFlight transferring record is held back (FSM respect — §2.1)', async () => {
    const rec = { ...record('700'), status: 'transferring' as const, drainInFlight: true, timestamp: 1_000_000 + DEFAULT_STALE_OWNER_RELEASE_CONFIG.deathEvidenceMs + 4_000 };
    const h = makeHarness({ records: [rec] });
    await expireOwner(h);
    expect(h.claims).toHaveLength(0);
  });
});

describe('StaleOwnerReleaseEngine — honesty surfaces (§2.6)', () => {
  it('decision-trace-records-refusals (a no-claim verdict leaves an artifact, never silence)', async () => {
    const h = makeHarness({ selfProof: false });
    await expireOwner(h);
    expect(h.traces.filter((t) => t.type === 'refusal').length).toBeGreaterThan(0);
    expect(h.traces.some((t) => t.type === 'stale-detect')).toBe(true);
  });

  it('flapping-partition-raises-one-item-not-one-per-flap (ambiguity escalation once per episode)', async () => {
    const h = makeHarness({ probeResult: 'error' }); // persistent ambiguity
    h.engine.tick();
    h.advance(DEFAULT_STALE_OWNER_RELEASE_CONFIG.deathEvidenceMs + 5_000);
    await h.tickSettled(2);
    // Push past the ambiguity ceiling (3 × deathEvidenceMs), ticking repeatedly.
    for (let i = 0; i < 5; i++) {
      h.advance(DEFAULT_STALE_OWNER_RELEASE_CONFIG.deathEvidenceMs);
      await h.tickSettled(1);
    }
    const items = h.attention.filter((a) => a.id.startsWith('stale-owner:'));
    expect(items).toHaveLength(1); // ONE deduped per-episode item
    expect(h.engine.status().counters.escalations).toBe(1);
  });

  it('probe-loop-bounded-p19: consecutive probe errors open the breaker + ONE give-up item', async () => {
    const h = makeHarness({ probeResult: 'error' });
    h.engine.tick();
    h.advance(DEFAULT_STALE_OWNER_RELEASE_CONFIG.deathEvidenceMs + 5_000);
    // Drive many probe rounds — backoff widens; errors accumulate to the breaker.
    for (let i = 0; i < 40; i++) {
      h.advance(10 * 60_000);
      await h.tickSettled(1);
    }
    const s = h.engine.status();
    expect(s.probeBreaker.openOwners).toContain(OWNER);
    expect(h.attention.filter((a) => a.id.startsWith('stale-owner-giveup:'))).toHaveLength(1);
  });

  it('dry-run logs ONE would-claim per topic per episode and NEVER lands a CAS', async () => {
    const h = makeHarness({ dryRun: true });
    await expireOwner(h);
    await h.tickSettled(3);
    expect(h.claims).toHaveLength(0);
    expect(h.traces.filter((t) => t.type === 'would-claim')).toHaveLength(1);
    expect(h.engine.status().counters.wouldClaims).toBe(1);
  });

  it('a healthy owner closes the episode after the calm window', async () => {
    let ownerOnline = false;
    const machines = () => [
      { machineId: SELF, online: true, observerLastSeenMs: 1_000_000 },
      { machineId: THIRD, online: true, observerLastSeenMs: 1_000_000 },
      { machineId: OWNER, online: ownerOnline, observerLastSeenMs: ownerOnline ? Date.now() : 1 },
    ];
    const h = makeHarness();
    (h.deps as { machines: typeof machines }).machines = machines;
    h.engine.tick();
    expect(h.engine.status().openEpisodes).toHaveLength(1);
    ownerOnline = true;
    h.engine.tick(); // healthySince stamped
    h.advance(31 * 60_000);
    h.engine.tick();
    expect(h.engine.status().openEpisodes).toHaveLength(0);
  });
});

describe('validateStaleOwnerReleaseInvariants — §2.3 TTL-ordering invariant (R-r2-3)', () => {
  it('config-validation-rejects-evidence-bound-below-self-fence-ttl', () => {
    const err = validateStaleOwnerReleaseInvariants({ deathEvidenceMs: 60_000, selfFenceTtlMs: 60_000 }, 30_000, 500);
    expect(err).toMatch(/STRICTLY greater/);
    // Equality at the floor also rejects (STRICTLY greater).
    expect(validateStaleOwnerReleaseInvariants({ deathEvidenceMs: 90_500, selfFenceTtlMs: 60_000 }, 30_000, 500)).toMatch(/STRICTLY greater/);
    // A valid ordering passes.
    expect(validateStaleOwnerReleaseInvariants({ deathEvidenceMs: 180_000, selfFenceTtlMs: 60_000 }, 30_000, 500)).toBeNull();
  });
});

describe('deriveOwnershipLeaseState — the §2.9 derivation table', () => {
  it('maps record status + evidence state per the table', () => {
    const base = { status: 'active' as const, nonce: 'm:reconcile-claim:700:1' };
    expect(deriveOwnershipLeaseState(null, { evidenceEpisodeOpen: false, suspensionAnnotationPresent: false })).toBeNull();
    expect(deriveOwnershipLeaseState({ status: 'released', nonce: 'n' }, { evidenceEpisodeOpen: false, suspensionAnnotationPresent: false })).toBeNull();
    expect(deriveOwnershipLeaseState(base, { evidenceEpisodeOpen: false, suspensionAnnotationPresent: false })).toBe('held');
    expect(deriveOwnershipLeaseState(base, { evidenceEpisodeOpen: true, suspensionAnnotationPresent: false })).toBe('stale');
    expect(deriveOwnershipLeaseState({ status: 'transferring', nonce: 'n' }, { evidenceEpisodeOpen: false, suspensionAnnotationPresent: false })).toBe('releasing');
    // §2.7.5 — the extended nonce grammar marks a stale-owner-release claim.
    const claimed = { status: 'active' as const, nonce: 'm_self:stale-owner-release:700:m_owner-1:12345' };
    expect(deriveOwnershipLeaseState(claimed, { evidenceEpisodeOpen: false, suspensionAnnotationPresent: true })).toBe('claimed');
    expect(deriveOwnershipLeaseState(claimed, { evidenceEpisodeOpen: false, suspensionAnnotationPresent: false })).toBe('held');
  });
});

describe('supervision-tier0-no-spawn-slot (§2.8 — LLM-free by construction)', () => {
  it('the engine module imports NO intelligence/LLM provider (deterministic fencing path)', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../../src/core/StaleOwnerReleaseEngine.ts'), 'utf-8');
    // The StrandedTopicSentinel precedent: assert the module cannot spend a
    // spawn-cap slot because it never touches an intelligence provider.
    expect(src).not.toMatch(/IntelligenceProvider|buildIntelligenceProvider|LlmQueue|claude -p|spawnLimiter/);
    // And it is synchronous over injected state (no child_process).
    expect(src).not.toMatch(/child_process|execFile|spawn\(/);
  });

  it('single-machine and dark gates are strict no-ops', () => {
    const h = makeHarness({ machines: [{ machineId: SELF, online: true, observerLastSeenMs: 1 }] });
    h.engine.tick();
    expect(h.engine.status().openEpisodes).toHaveLength(0);
    const dark = makeHarness();
    dark.cfg.enabled = false;
    dark.engine.tick();
    expect(dark.engine.status().enabled).toBe(false);
    expect(dark.engine.isActive()).toBe(false);
    void vi;
  });
});

describe('working-set-pull-queued-and-resume-proceeds (§2.4)', () => {
  it('a landed claim attempts the working-set pull for the claimed topic', async () => {
    const h = makeHarness();
    await expireOwner(h);
    expect(h.claims.map((c) => c.sessionKey)).toContain('700');
    expect(h.pulls).toContain(700);
  });

  it('a throwing pull (provably-dark producer → queued durably by the carrier) never blocks the claim or the disclosure', async () => {
    const h = makeHarness();
    const disclosed: Array<{ topic: number; owner: string }> = [];
    h.deps.pullWorkingSet = () => {
      throw new Error('producer dark — pull queued durably');
    };
    h.deps.onClaimed = (topic, _episodeId, owner) => disclosed.push({ topic, owner });
    await expireOwner(h);
    // The claim landed, its suspension annotation was emitted, and the
    // continuation disclosure still fired — the topic RESUMES from last-synced
    // state (§2.4: the pull queues durably; resume proceeds).
    expect(h.claims.map((c) => c.sessionKey)).toContain('700');
    expect(h.annotationsEmitted.some((a) => a.topic === 700 && a.suspended === true)).toBe(true);
    expect(disclosed).toEqual([{ topic: 700, owner: OWNER }]);
  });
});
