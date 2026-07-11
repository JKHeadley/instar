/**
 * Unit tests for DuplicateSessionReconciler — Layer B of
 * ownership-gated-spawn-and-judgment-within-floors (§3.2): converge the
 * ownership RECORD when the same conversation is live on 2+ machines.
 *
 * Covers (spec §5 unit tier):
 *  - gate skips: disabled / not-lease-holder / registry-error freeze (same
 *    fault domain as the spawn error arm) / substrate-not-ready (+ the ONE
 *    >30-min pause attention item)
 *  - §3.2.2 evidence ladder EXHAUSTIVE: both-live-runs escalate; hard pin
 *    (quarantined pin never counts); highest ADMISSIBLE epoch (inadmissible
 *    rows never count; equal-epoch divergence escalates; recency is NOT a
 *    rule); rule-2/rule-3 contradiction escalates; single live-run
 *    pre-episode admissibility (episode-open backdating — post-spawn
 *    evidence never corroborates a BACKDATED episode); no-evidence escalate
 *  - dry-run posture: would-converge journal row, NO CAS, NO closeout arm
 *  - live convergence: CAS 409 escalates (never blind-retries); success arms
 *    the peer-echo window; echo confirm → armCloseout via the EXISTING
 *    closeout; echo timeout → breaker bump + ONE aggregated item (P17)
 *  - target-has-live-copy precondition; duplicate-resolved-before-action;
 *    probe-failure deferral (cache rows never acted on)
 *  - §3.2.5 P19 breaker: threshold clamp, transfer-traceable exclusion (+ the
 *    ≥3-moves observability item), clampBreakerRow receive-side type clamp
 *  - per-tick caps (maxReconcilesPerTick / maxConvergenceWritesPerTick)
 *  - escalate-once dedupe; attempts-exhausted (3/episode) escalation
 *  - provenance rows emitted for every verdict; a throwing provenance sink
 *    never breaks the tick (observability never endangers the observed)
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  DuplicateSessionReconciler,
  clampBreakerRow,
} from '../../src/monitoring/DuplicateSessionReconciler.js';
import type {
  DuplicateCandidate,
  ReconcilerConfigView,
  ReconcilerDeps,
  OwnershipViewRow,
} from '../../src/monitoring/DuplicateSessionReconciler.js';
import type { BoundedJsonlAudit } from '../../src/core/BoundedJsonlAudit.js';

const T0 = Date.parse('2026-07-10T12:00:00.000Z');
let fakeNow = T0;

function cand(over: Partial<DuplicateCandidate> = {}): DuplicateCandidate {
  return {
    key: 'telegram:12345',
    platform: 'telegram',
    platformId: '12345',
    machines: [
      { machineId: 'laptop', sessions: ['s-1'] },
      { machineId: 'mini', sessions: ['s-2'] },
    ],
    ...over,
  };
}

function cfg(over: Partial<ReconcilerConfigView> = {}): ReconcilerConfigView {
  return {
    enabled: true,
    dryRun: false,
    reconcilerTickMs: 60_000,
    maxReconcilesPerTick: 5,
    maxConvergenceWritesPerTick: 2,
    echoConfirmTicks: 3,
    breakerThreshold: 3,
    breakerWindowMs: 24 * 60 * 60_000,
    ...over,
  };
}

type JournalRow = Record<string, unknown>;

function makeDeps(over: Partial<ReconcilerDeps> = {}): ReconcilerDeps & { rows: JournalRow[] } {
  const rows: JournalRow[] = [];
  const journal = { append: (r: JournalRow) => rows.push(r) } as unknown as BoundedJsonlAudit;
  const deps: ReconcilerDeps & { rows: JournalRow[] } = {
    rows,
    selfMachineId: vi.fn(() => 'laptop'),
    holdsLease: vi.fn(() => true),
    substrateReady: vi.fn(() => ({ ready: true })),
    errorEpisodeOpen: vi.fn(() => false),
    topicHasAuthorityInMotion: vi.fn(() => false),
    discoverCandidates: vi.fn(async () => ({ candidates: [cand()] })),
    probeLiveCopy: vi.fn(async () => ({ ok: true, live: true })),
    readPin: vi.fn(() => null),
    readOwnershipViews: vi.fn((): OwnershipViewRow[] => []),
    liveRunHosts: vi.fn(async () => []),
    casConverge: vi.fn(() => ({ ok: true })),
    peerEchoObserved: vi.fn(async () => true),
    armCloseout: vi.fn(),
    raiseAttention: vi.fn(),
    journal,
    provenance: vi.fn(),
    log: vi.fn(),
    now: () => fakeNow,
    ...over,
  };
  return deps;
}

beforeEach(() => {
  fakeNow = T0;
});

// ── gate skips ────────────────────────────────────────────────────────────

describe('DuplicateSessionReconciler gate skips', () => {
  it('disabled → skippedReason disabled, no discovery', async () => {
    const deps = makeDeps();
    const r = new DuplicateSessionReconciler(cfg({ enabled: false }), deps);
    const rep = await r.tick();
    expect(rep.ran).toBe(false);
    expect(rep.skippedReason).toBe('disabled');
    expect(deps.discoverCandidates).not.toHaveBeenCalled();
  });

  it('not the lease holder → skip (discovery never fans out off-lease)', async () => {
    const deps = makeDeps({ holdsLease: vi.fn(() => false) });
    const rep = await new DuplicateSessionReconciler(cfg(), deps).tick();
    expect(rep.skippedReason).toBe('not-lease-holder');
    expect(deps.discoverCandidates).not.toHaveBeenCalled();
  });

  it('registry-error episode open → frozen (same fault domain as the spawn error arm)', async () => {
    const deps = makeDeps({ errorEpisodeOpen: vi.fn(() => true) });
    const r = new DuplicateSessionReconciler(cfg(), deps);
    const rep = await r.tick();
    expect(rep.skippedReason).toContain('registry-error-episode-open');
    expect(r.status().counters.frozenTicks).toBe(1);
    expect(deps.discoverCandidates).not.toHaveBeenCalled();
  });

  it('substrate not ready → loud skip, NO writes, and ONE pause item only after 30 min', async () => {
    const deps = makeDeps({ substrateReady: vi.fn(() => ({ ready: false, reason: 'in-memory ownership store' })) });
    const r = new DuplicateSessionReconciler(cfg(), deps);
    const rep = await r.tick();
    expect(rep.skippedReason).toContain('substrate-not-ready');
    expect(deps.raiseAttention).not.toHaveBeenCalled(); // not yet — under 30 min

    fakeNow = T0 + 31 * 60_000;
    await r.tick();
    expect(deps.raiseAttention).toHaveBeenCalledTimes(1);

    fakeNow = T0 + 60 * 60_000;
    await r.tick(); // still paused — the item is raised ONCE per pause episode
    expect(deps.raiseAttention).toHaveBeenCalledTimes(1);
  });

  it('substrate recovering resets the pause episode (a later pause can raise again)', async () => {
    let ready = false;
    const deps = makeDeps({
      substrateReady: vi.fn(() => (ready ? { ready: true } : { ready: false, reason: 'x' })),
      // Empty discovery so the intermediate READY tick raises nothing itself.
      discoverCandidates: vi.fn(async () => ({ candidates: [] })),
    });
    const r = new DuplicateSessionReconciler(cfg(), deps);
    await r.tick();
    fakeNow = T0 + 31 * 60_000;
    await r.tick();
    expect(deps.raiseAttention).toHaveBeenCalledTimes(1);
    ready = true;
    fakeNow = T0 + 32 * 60_000;
    await r.tick(); // ready — resets
    ready = false;
    fakeNow = T0 + 33 * 60_000;
    await r.tick(); // pause episode #2 opens
    fakeNow = T0 + 64 * 60_000;
    await r.tick();
    expect(deps.raiseAttention).toHaveBeenCalledTimes(2);
  });

  it('a throwing discovery is caught — tick reports the error, never throws', async () => {
    const deps = makeDeps({ discoverCandidates: vi.fn(async () => { throw new Error('fan-out died'); }) });
    const rep = await new DuplicateSessionReconciler(cfg(), deps).tick();
    expect(rep.skippedReason).toContain('tick-error');
    expect(rep.skippedReason).toContain('fan-out died');
  });
});

// ── §3.2.2 evidence ladder ────────────────────────────────────────────────

describe('intended-owner evidence ladder (§3.2.2)', () => {
  it('both copies carry confirmed live runs → escalate, never a guess', async () => {
    const deps = makeDeps({
      liveRunHosts: vi.fn(async () => [
        { machineId: 'laptop', registeredAt: T0 - 60_000, confirmed: true },
        { machineId: 'mini', registeredAt: T0 - 30_000, confirmed: true },
      ]),
    });
    const rep = await new DuplicateSessionReconciler(cfg(), deps).tick();
    expect(rep.escalations).toBe(1);
    expect(deps.casConverge).not.toHaveBeenCalled();
    expect(deps.rows.some((r) => r.kind === 'escalated' && String(r.reason).includes('both-copies-carry-live-runs'))).toBe(true);
  });

  it('unconfirmed run rows never count (a dark peer poll row is not evidence)', async () => {
    const deps = makeDeps({
      liveRunHosts: vi.fn(async () => [
        { machineId: 'laptop', registeredAt: T0 - 60_000, confirmed: true },
        { machineId: 'mini', registeredAt: T0 - 30_000, confirmed: false },
      ]),
    });
    const rep = await new DuplicateSessionReconciler(cfg(), deps).tick();
    // one CONFIRMED run → rule 3 names laptop (episode not backdated in unit wiring)
    expect(rep.reconciled).toBe(1);
    expect(deps.casConverge).toHaveBeenCalledWith('12345', 'laptop');
  });

  it('rule 1: a hard pin wins over everything below it', async () => {
    const deps = makeDeps({
      readPin: vi.fn(() => ({ pinned: true, preferredMachine: 'mini' })),
      readOwnershipViews: vi.fn(() => [
        { machineId: 'laptop', owner: 'laptop', epoch: 99, admissible: true },
      ]),
    });
    const rep = await new DuplicateSessionReconciler(cfg(), deps).tick();
    expect(rep.reconciled).toBe(1);
    expect(deps.casConverge).toHaveBeenCalledWith('12345', 'mini');
    expect(deps.rows.some((r) => r.kind === 'converged-record' && r.rule === 'hard-pin')).toBe(true);
  });

  it('rule 1: a QUARANTINED pin never counts — falls through to the epoch rule', async () => {
    const deps = makeDeps({
      readPin: vi.fn(() => ({ pinned: true, preferredMachine: 'mini', quarantined: true })),
      readOwnershipViews: vi.fn(() => [
        { machineId: 'laptop', owner: 'laptop', epoch: 7, admissible: true },
      ]),
    });
    const rep = await new DuplicateSessionReconciler(cfg(), deps).tick();
    // The verdict fell through to rule 2 and named laptop; the self view
    // ALREADY says laptop, so the no-epoch-burn skip handles it (no CAS).
    expect(rep.reconciled).toBe(1);
    expect(deps.casConverge).not.toHaveBeenCalled();
    const row = deps.rows.find((x) => x.kind === 'record-already-converged');
    expect(row).toMatchObject({ owner: 'laptop', rule: 'highest-epoch' });
  });

  it('rule 2: highest ADMISSIBLE epoch wins; inadmissible rows never count', async () => {
    const deps = makeDeps({
      readOwnershipViews: vi.fn(() => [
        { machineId: 'laptop', owner: 'laptop', epoch: 5, admissible: true },
        { machineId: 'mini', owner: 'mini', epoch: 999, admissible: false }, // forged/unstamped — OUT
      ]),
    });
    const rep = await new DuplicateSessionReconciler(cfg(), deps).tick();
    // laptop wins rule 2 (the inadmissible 999 never counts); the self view
    // already agrees → handled via the already-converged skip, no CAS.
    expect(rep.reconciled).toBe(1);
    expect(deps.casConverge).not.toHaveBeenCalled();
    expect(deps.rows.some((r) => r.kind === 'record-already-converged' && r.rule === 'highest-epoch' && r.owner === 'laptop')).toBe(true);
  });

  it('rule 2: equal epochs naming DIFFERENT owners → symmetric-divergence escalate', async () => {
    const deps = makeDeps({
      readOwnershipViews: vi.fn(() => [
        { machineId: 'laptop', owner: 'laptop', epoch: 5, admissible: true },
        { machineId: 'mini', owner: 'mini', epoch: 5, admissible: true },
      ]),
    });
    const rep = await new DuplicateSessionReconciler(cfg(), deps).tick();
    expect(rep.escalations).toBe(1);
    expect(deps.rows.some((r) => r.kind === 'escalated' && String(r.reason).includes('symmetric-divergence-equal-epochs'))).toBe(true);
  });

  it('rule-2/rule-3 contradiction (epoch names A, the one live run is on B) → escalate', async () => {
    const deps = makeDeps({
      readOwnershipViews: vi.fn(() => [
        { machineId: 'laptop', owner: 'laptop', epoch: 9, admissible: true },
      ]),
      liveRunHosts: vi.fn(async () => [{ machineId: 'mini', registeredAt: T0 - 60_000, confirmed: true }]),
    });
    const rep = await new DuplicateSessionReconciler(cfg(), deps).tick();
    expect(rep.escalations).toBe(1);
    expect(deps.rows.some((r) => r.kind === 'escalated' && String(r.reason).includes('rule2-rule3-contradiction'))).toBe(true);
  });

  it('no admissible evidence at all → escalate (the deterministic default IS escalate)', async () => {
    const deps = makeDeps();
    const rep = await new DuplicateSessionReconciler(cfg(), deps).tick();
    expect(rep.escalations).toBe(1);
    expect(rep.reconciled).toBe(0);
    expect(deps.rows.some((r) => r.kind === 'escalated' && String(r.reason).includes('no-admissible-evidence'))).toBe(true);
  });

  it('recency is NOT a rule: the newer-epoch view wins even when the OTHER copy has the later timestamp semantics', async () => {
    // The non-owner duplicate often has the latest message BECAUSE of the bug —
    // nothing in the ladder consults wall-clock recency. Encode that: only
    // epoch height decides rule 2.
    const deps = makeDeps({
      readOwnershipViews: vi.fn(() => [
        { machineId: 'mini', owner: 'mini', epoch: 3, admissible: true },
        { machineId: 'laptop', owner: 'laptop', epoch: 8, admissible: true },
      ]),
    });
    const rep = await new DuplicateSessionReconciler(cfg(), deps).tick();
    // Epoch height (8 > 3) decides — and the self view already names the
    // winner, so the skip path records it without a CAS.
    expect(rep.reconciled).toBe(1);
    expect(deps.rows.some((r) => r.kind === 'record-already-converged' && r.owner === 'laptop')).toBe(true);
  });
});

// ── episode-open backdating (§3 glossary / §3.4 floor) ────────────────────

describe('episode-open backdating — post-spawn evidence never corroborates', () => {
  it('non-backdated episode (detection-time open): a single confirmed run corroborates regardless of registration ts', async () => {
    const deps = makeDeps({
      liveRunHosts: vi.fn(async () => [{ machineId: 'mini', registeredAt: T0 + 5_000, confirmed: true }]),
    });
    const rep = await new DuplicateSessionReconciler(cfg(), deps).tick();
    // openBackdated=false in unit wiring → the honest Increment-1 posture is
    // to accept the run (recorded honestly in the episode row).
    expect(rep.reconciled).toBe(1);
    expect(deps.casConverge).toHaveBeenCalledWith('12345', 'mini');
  });

  it('journal records the episode open with its timestamp (the backdating audit anchor)', async () => {
    const deps = makeDeps();
    await new DuplicateSessionReconciler(cfg(), deps).tick();
    const open = deps.rows.find((r) => r.kind === 'duplicate-episode-opened');
    expect(open).toBeTruthy();
    expect(String(open!.openedAt)).toBe(new Date(T0).toISOString());
  });
});

// ── dry-run posture ───────────────────────────────────────────────────────

describe('dry-run posture (Increment-1 default)', () => {
  it('would-converge journals the full verdict, NO CAS lands, NO closeout arms', async () => {
    const deps = makeDeps({
      readPin: vi.fn(() => ({ pinned: true, preferredMachine: 'laptop' })),
    });
    const r = new DuplicateSessionReconciler(cfg({ dryRun: true }), deps);
    const rep = await r.tick();
    expect(rep.wouldConverge).toBe(1);
    expect(rep.reconciled).toBe(0);
    expect(deps.casConverge).not.toHaveBeenCalled();
    expect(deps.armCloseout).not.toHaveBeenCalled();
    const row = deps.rows.find((x) => x.kind === 'would-converge');
    expect(row).toBeTruthy();
    expect(row!.owner).toBe('laptop');
    expect(row!.dryRun).toBe(true);
  });

  it('dry-run on a PERSISTING duplicate journals fresh verdicts until the P19 breaker clamps — never attempt-exhaustion, never unbounded journal spam', async () => {
    const deps = makeDeps({ readPin: vi.fn(() => ({ pinned: true, preferredMachine: 'laptop' })) });
    const r = new DuplicateSessionReconciler(cfg({ dryRun: true, breakerThreshold: 3 }), deps);
    for (let i = 0; i < 5; i++) {
      fakeNow = T0 + i * 60_000;
      await r.tick();
    }
    // Each dry-run tick re-opens an episode; the 3rd open trips the breaker,
    // so ticks 4-5 are clamped-quiet: exactly breakerThreshold verdict rows.
    expect(deps.rows.filter((x) => x.kind === 'would-converge').length).toBe(3);
    expect(deps.rows.filter((x) => x.kind === 'escalated').length).toBe(0);
    expect(r.breakerClamped('telegram:12345')).toBe(true);
    expect(r.status().counters.breakerClamps).toBe(2); // ticks 4 + 5
  });
});

// ── live convergence + peer echo ──────────────────────────────────────────

describe('already-converged record (the 2026-07-10 incident shape)', () => {
  it('local record already names the intended owner → NO CAS (no epoch burn), straight to the echo window, closeout arms on echo', async () => {
    // The bootleg-spawn shape: the duplicate exists at the SESSION layer only;
    // the record is already right. A claim would be refused by the FSM
    // (claim-out-of-sequence) — the reconciler must skip the write entirely.
    const deps = makeDeps({
      selfMachineId: vi.fn(() => 'laptop'),
      readOwnershipViews: vi.fn(() => [
        { machineId: 'laptop', owner: 'laptop', epoch: 4, admissible: true },
      ]),
    });
    const r = new DuplicateSessionReconciler(cfg(), deps);
    const t1 = await r.tick();
    expect(t1.reconciled).toBe(1);
    expect(deps.casConverge).not.toHaveBeenCalled();
    expect(deps.rows.some((x) => x.kind === 'record-already-converged')).toBe(true);
    expect(r.status().openEpisodes).toBe(1); // echo window open

    // Echo confirms on the next tick → the existing closeout is armed.
    (deps.discoverCandidates as ReturnType<typeof vi.fn>).mockResolvedValue({ candidates: [] });
    const t2 = await r.tick();
    expect(t2.echoConfirmed).toBe(1);
    expect(deps.armCloseout).toHaveBeenCalledWith('12345', 'laptop');
  });

  it('local record names a DIFFERENT machine than the verdict → the CAS still runs (repair genuinely needed)', async () => {
    const deps = makeDeps({
      selfMachineId: vi.fn(() => 'laptop'),
      readPin: vi.fn(() => ({ pinned: true, preferredMachine: 'mini' })), // rule 1 names mini
      readOwnershipViews: vi.fn(() => [
        { machineId: 'laptop', owner: 'laptop', epoch: 4, admissible: true }, // record says laptop
      ]),
    });
    const t1 = await new DuplicateSessionReconciler(cfg(), deps).tick();
    expect(deps.casConverge).toHaveBeenCalledWith('12345', 'mini');
    expect(t1.reconciled).toBe(1);
  });

  it('an INADMISSIBLE self view never triggers the skip (the CAS runs)', async () => {
    const deps = makeDeps({
      selfMachineId: vi.fn(() => 'laptop'),
      readPin: vi.fn(() => ({ pinned: true, preferredMachine: 'laptop' })),
      readOwnershipViews: vi.fn(() => [
        { machineId: 'laptop', owner: 'laptop', epoch: 4, admissible: false },
      ]),
    });
    await new DuplicateSessionReconciler(cfg(), deps).tick();
    expect(deps.casConverge).toHaveBeenCalledWith('12345', 'laptop');
  });
});

describe('live convergence (§3.2.3)', () => {
  it('CAS refused (409/conflict) → escalate, never a blind retry', async () => {
    const deps = makeDeps({
      readPin: vi.fn(() => ({ pinned: true, preferredMachine: 'laptop' })),
      casConverge: vi.fn(() => ({ ok: false, reason: 'epoch-conflict' })),
    });
    const rep = await new DuplicateSessionReconciler(cfg(), deps).tick();
    expect(rep.escalations).toBe(1);
    expect(deps.casConverge).toHaveBeenCalledTimes(1);
    expect(deps.rows.some((r) => r.kind === 'escalated' && String(r.reason).includes('cas-refused'))).toBe(true);
  });

  it('successful CAS opens the echo window; full echo → armCloseout for the non-owner + episode closes', async () => {
    const deps = makeDeps({ readPin: vi.fn(() => ({ pinned: true, preferredMachine: 'laptop' })) });
    const r = new DuplicateSessionReconciler(cfg(), deps);
    const rep1 = await r.tick();
    expect(rep1.reconciled).toBe(1);
    expect(deps.armCloseout).not.toHaveBeenCalled(); // echo not yet checked
    expect(r.status().openEpisodes).toBe(1);

    // Next tick: the duplicate is gone from discovery; echo check confirms.
    (deps.discoverCandidates as ReturnType<typeof vi.fn>).mockResolvedValue({ candidates: [] });
    const rep2 = await r.tick();
    expect(rep2.echoConfirmed).toBe(1);
    expect(deps.armCloseout).toHaveBeenCalledWith('12345', 'laptop');
    expect(r.status().openEpisodes).toBe(0);
  });

  it('peer echo consults the PEER machine view with the sessionKey (platform prefix stripped)', async () => {
    const deps = makeDeps({ readPin: vi.fn(() => ({ pinned: true, preferredMachine: 'laptop' })) });
    const r = new DuplicateSessionReconciler(cfg(), deps);
    await r.tick();
    (deps.discoverCandidates as ReturnType<typeof vi.fn>).mockResolvedValue({ candidates: [] });
    await r.tick();
    expect(deps.peerEchoObserved).toHaveBeenCalledWith('12345', 'laptop', 'mini');
  });

  it('echo NEVER observed within the window → breaker bump + ONE aggregated item (P17), episode drains', async () => {
    const deps = makeDeps({
      readPin: vi.fn(() => ({ pinned: true, preferredMachine: 'laptop' })),
      peerEchoObserved: vi.fn(async () => false),
    });
    const r = new DuplicateSessionReconciler(cfg({ echoConfirmTicks: 2 }), deps);
    await r.tick(); // converge, echoPending ticksLeft=2
    (deps.discoverCandidates as ReturnType<typeof vi.fn>).mockResolvedValue({ candidates: [] });
    (deps.raiseAttention as ReturnType<typeof vi.fn>).mockClear();
    await r.tick(); // ticksLeft 1
    await r.tick(); // ticksLeft 0 → timeout
    const rep = r.status();
    expect(rep.counters.echoTimeouts).toBe(1);
    expect(deps.raiseAttention).toHaveBeenCalledTimes(1);
    const item = (deps.raiseAttention as ReturnType<typeof vi.fn>).mock.calls[0][0] as { title: string; body: string };
    expect(item.title).toContain('Convergence not observed');
    expect(item.body).toContain('telegram:12345');
  });

  it('a THROWING peer-echo probe counts as not-echoed (fail toward the loud path, never a crash)', async () => {
    const deps = makeDeps({
      readPin: vi.fn(() => ({ pinned: true, preferredMachine: 'laptop' })),
      peerEchoObserved: vi.fn(async () => { throw new Error('peer dark'); }),
    });
    const r = new DuplicateSessionReconciler(cfg({ echoConfirmTicks: 1 }), deps);
    await r.tick();
    (deps.discoverCandidates as ReturnType<typeof vi.fn>).mockResolvedValue({ candidates: [] });
    const rep = await r.tick();
    expect(rep.echoTimeouts).toBe(1);
  });

  it('multiple echo timeouts in ONE tick fold into ONE attention item enumerating all topics (P17)', async () => {
    const c1 = cand();
    const c2 = cand({ key: 'telegram:777', platformId: '777' });
    const deps = makeDeps({
      discoverCandidates: vi.fn(async () => ({ candidates: [c1, c2] })),
      readPin: vi.fn(() => ({ pinned: true, preferredMachine: 'laptop' })),
      peerEchoObserved: vi.fn(async () => false),
    });
    const r = new DuplicateSessionReconciler(cfg({ echoConfirmTicks: 1, maxConvergenceWritesPerTick: 5 }), deps);
    await r.tick(); // both converge
    (deps.discoverCandidates as ReturnType<typeof vi.fn>).mockResolvedValue({ candidates: [] });
    (deps.raiseAttention as ReturnType<typeof vi.fn>).mockClear();
    await r.tick(); // both time out in the SAME tick
    expect(deps.raiseAttention).toHaveBeenCalledTimes(1);
    const item = (deps.raiseAttention as ReturnType<typeof vi.fn>).mock.calls[0][0] as { title: string; body: string };
    expect(item.title).toContain('2 conversation(s)');
    expect(item.body).toContain('telegram:12345');
    expect(item.body).toContain('telegram:777');
  });
});

// ── preconditions & deferrals ─────────────────────────────────────────────

describe('preconditions (§3.2.1)', () => {
  it('authority in motion (transfer/stale-owner/hold) → deferred, untouched', async () => {
    const deps = makeDeps({ topicHasAuthorityInMotion: vi.fn(() => true) });
    const rep = await new DuplicateSessionReconciler(cfg(), deps).tick();
    expect(rep.reconciled).toBe(0);
    expect(rep.escalations).toBe(0);
    expect(deps.rows.some((r) => r.kind === 'deferred-authority-in-motion')).toBe(true);
  });

  it('a FAILED probe defers (cache rows are never acted on) and burns an attempt', async () => {
    const deps = makeDeps({ probeLiveCopy: vi.fn(async () => ({ ok: false, live: false })) });
    const r = new DuplicateSessionReconciler(cfg(), deps);
    const rep = await r.tick();
    expect(rep.reconciled).toBe(0);
    expect(deps.casConverge).not.toHaveBeenCalled();
    expect(deps.rows.some((x) => x.kind === 'probe-failed-deferred')).toBe(true);
    expect(r.status().counters.probeDeferrals).toBe(1);
  });

  it('fresh probes show <2 live copies → duplicate-resolved-before-action, episode closes quietly', async () => {
    const deps = makeDeps({
      probeLiveCopy: vi.fn(async (machineId: string) => ({ ok: true, live: machineId === 'laptop' })),
    });
    const r = new DuplicateSessionReconciler(cfg(), deps);
    const rep = await r.tick();
    expect(rep.reconciled).toBe(0);
    expect(rep.escalations).toBe(0);
    expect(deps.rows.some((x) => x.kind === 'duplicate-resolved-before-action')).toBe(true);
    expect(r.status().openEpisodes).toBe(0);
  });

  it('target-has-live-copy: an intended owner with NO live copy escalates (never converge onto a dead target)', async () => {
    const deps = makeDeps({
      readPin: vi.fn(() => ({ pinned: true, preferredMachine: 'ghost-machine' })),
    });
    const rep = await new DuplicateSessionReconciler(cfg(), deps).tick();
    expect(rep.escalations).toBe(1);
    expect(deps.casConverge).not.toHaveBeenCalled();
    expect(deps.rows.some((r) => r.kind === 'escalated' && String(r.reason).includes('has-no-live-copy'))).toBe(true);
  });

  it('3 convergence attempts per episode, then ONE escalation (attempts-exhausted)', async () => {
    const deps = makeDeps({ probeLiveCopy: vi.fn(async () => ({ ok: false, live: false })) });
    const r = new DuplicateSessionReconciler(cfg(), deps);
    await r.tick(); // attempt 1 (probe deferral burns an attempt)
    await r.tick(); // attempt 2
    await r.tick(); // attempt 3
    (deps.raiseAttention as ReturnType<typeof vi.fn>).mockClear();
    const rep4 = await r.tick(); // exhausted → escalate once
    expect(rep4.escalations).toBe(1);
    await r.tick(); // still exhausted — escalateOnce dedupes
    expect(deps.raiseAttention).toHaveBeenCalledTimes(1);
    expect(deps.rows.some((x) => x.kind === 'escalated' && String(x.reason).includes('convergence-attempts-exhausted'))).toBe(true);
  });
});

// ── per-tick caps (P17) ───────────────────────────────────────────────────

describe('per-tick caps', () => {
  it('maxReconcilesPerTick bounds how many candidates are consumed per tick', async () => {
    const many = Array.from({ length: 10 }, (_, i) => cand({ key: `telegram:${i}`, platformId: String(i) }));
    const deps = makeDeps({
      discoverCandidates: vi.fn(async () => ({ candidates: many })),
      readPin: vi.fn(() => ({ pinned: true, preferredMachine: 'laptop' })),
    });
    const rep = await new DuplicateSessionReconciler(cfg({ dryRun: true, maxReconcilesPerTick: 3, maxConvergenceWritesPerTick: 99 }), deps).tick();
    expect(rep.wouldConverge).toBe(3);
  });

  it('maxConvergenceWritesPerTick bounds live CAS writes per tick', async () => {
    const many = Array.from({ length: 6 }, (_, i) => cand({ key: `telegram:${i}`, platformId: String(i) }));
    const deps = makeDeps({
      discoverCandidates: vi.fn(async () => ({ candidates: many })),
      readPin: vi.fn(() => ({ pinned: true, preferredMachine: 'laptop' })),
    });
    const rep = await new DuplicateSessionReconciler(cfg({ maxReconcilesPerTick: 99, maxConvergenceWritesPerTick: 2 }), deps).tick();
    expect(rep.reconciled).toBe(2);
    expect(deps.casConverge).toHaveBeenCalledTimes(2);
  });
});

// ── §3.2.5 breaker ────────────────────────────────────────────────────────

describe('P19 breaker (§3.2.5)', () => {
  it('threshold re-duplications inside the window → topic clamped + ONE breaker item', async () => {
    const deps = makeDeps({ readPin: vi.fn(() => ({ pinned: true, preferredMachine: 'laptop' })) });
    const r = new DuplicateSessionReconciler(cfg({ dryRun: true, breakerThreshold: 3 }), deps);
    // dry-run deletes the episode each tick → each re-detection opens a NEW
    // episode → bumps the breaker.
    await r.tick();
    fakeNow += 60_000;
    await r.tick();
    (deps.raiseAttention as ReturnType<typeof vi.fn>).mockClear();
    fakeNow += 60_000;
    await r.tick(); // 3rd open → breaker trips
    expect(deps.raiseAttention).toHaveBeenCalledTimes(1);
    expect(r.breakerClamped('telegram:12345')).toBe(true);
    // 4th tick: candidate is SKIPPED (clamped), no would-converge row
    (deps.rows as JournalRow[]).length = 0;
    fakeNow += 60_000;
    const rep = await r.tick();
    expect(rep.breakerClamped).toBe(1);
    expect(deps.rows.filter((x) => x.kind === 'would-converge').length).toBe(0);
  });

  it('the clamp releases when episodes age out of the window', async () => {
    const deps = makeDeps({ readPin: vi.fn(() => ({ pinned: true, preferredMachine: 'laptop' })) });
    const r = new DuplicateSessionReconciler(cfg({ dryRun: true, breakerThreshold: 2, breakerWindowMs: 10 * 60_000 }), deps);
    await r.tick();
    fakeNow += 60_000;
    await r.tick();
    expect(r.breakerClamped('telegram:12345')).toBe(true);
    fakeNow += 11 * 60_000; // both opens age out
    expect(r.breakerClamped('telegram:12345')).toBe(false);
  });

  it('transfer-traceable episodes are EXCLUDED from the clamp (a deliberate mover is not a bug loop)', async () => {
    const deps = makeDeps({ readPin: vi.fn(() => ({ pinned: true, preferredMachine: 'laptop' })) });
    const r = new DuplicateSessionReconciler(cfg({ dryRun: true, breakerThreshold: 2 }), deps);
    await r.tick();
    r.noteTransferTraceable('telegram:12345'); // one of them is a traced move
    fakeNow += 60_000;
    await r.tick();
    // 2 opens − 1 transfer-traceable = 1 effective < threshold 2
    expect(r.breakerClamped('telegram:12345')).toBe(false);
  });

  it('≥3 transfer-traceable episodes raise ONE observability-only item (never a clamp)', async () => {
    const deps = makeDeps();
    const r = new DuplicateSessionReconciler(cfg(), deps);
    r.noteTransferTraceable('telegram:9');
    r.noteTransferTraceable('telegram:9');
    expect(deps.raiseAttention).not.toHaveBeenCalled();
    r.noteTransferTraceable('telegram:9');
    expect(deps.raiseAttention).toHaveBeenCalledTimes(1);
    const item = (deps.raiseAttention as ReturnType<typeof vi.fn>).mock.calls[0][0] as { title: string };
    expect(item.title).toContain('moved machines');
    expect(r.breakerClamped('telegram:9')).toBe(false);
  });
});

// ── clampBreakerRow (receive-side type clamp) ─────────────────────────────

describe('clampBreakerRow — replicated rows are strictly type-clamped', () => {
  it('accepts a well-formed row and floors the count', () => {
    expect(clampBreakerRow({ key: 'telegram:1', count: 2.9, lastAt: '2026-07-10T12:00:00.000Z' }))
      .toEqual({ key: 'telegram:1', count: 2, lastAt: '2026-07-10T12:00:00.000Z' });
  });

  it.each([
    ['null', null],
    ['non-object', 'x'],
    ['missing key', { count: 1, lastAt: '2026-07-10T12:00:00.000Z' }],
    ['empty key', { key: '', count: 1, lastAt: '2026-07-10T12:00:00.000Z' }],
    ['oversize key', { key: 'k'.repeat(257), count: 1, lastAt: '2026-07-10T12:00:00.000Z' }],
    ['negative count', { key: 'k', count: -1, lastAt: '2026-07-10T12:00:00.000Z' }],
    ['NaN count', { key: 'k', count: Number.NaN, lastAt: '2026-07-10T12:00:00.000Z' }],
    ['Infinity count', { key: 'k', count: Number.POSITIVE_INFINITY, lastAt: '2026-07-10T12:00:00.000Z' }],
    ['absurd count', { key: 'k', count: 2_000_000, lastAt: '2026-07-10T12:00:00.000Z' }],
    ['bad lastAt', { key: 'k', count: 1, lastAt: 'not-a-date' }],
    ['numeric lastAt', { key: 'k', count: 1, lastAt: 1234 }],
  ])('rejects %s', (_label, row) => {
    expect(clampBreakerRow(row)).toBeNull();
  });
});

// ── provenance & status ───────────────────────────────────────────────────

describe('provenance + status surfaces', () => {
  it('every verdict emits a provenance row with the deterministic floor named', async () => {
    const deps = makeDeps({ readPin: vi.fn(() => ({ pinned: true, preferredMachine: 'laptop' })) });
    await new DuplicateSessionReconciler(cfg({ dryRun: true }), deps).tick();
    expect(deps.provenance).toHaveBeenCalledTimes(1);
    const row = (deps.provenance as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<string, unknown>;
    expect(row.component).toBe('DuplicateSessionReconciler');
    expect(row.decisionPoint).toBe('which-duplicate-survives');
    expect(String(row.decision)).toContain('owner:laptop');
    expect(row.fallbackRung).toBe('deterministic');
  });

  it('a THROWING provenance sink never breaks the tick (observability never endangers the observed)', async () => {
    const deps = makeDeps({
      readPin: vi.fn(() => ({ pinned: true, preferredMachine: 'laptop' })),
      provenance: vi.fn(() => { throw new Error('provenance disk full'); }),
    });
    const rep = await new DuplicateSessionReconciler(cfg({ dryRun: true }), deps).tick();
    expect(rep.wouldConverge).toBe(1);
    expect(rep.skippedReason).toBeUndefined();
  });

  it('status() reports posture, substrate, last tick, open episodes, live breaker rows, counters, config', async () => {
    const deps = makeDeps({ readPin: vi.fn(() => ({ pinned: true, preferredMachine: 'laptop' })) });
    const r = new DuplicateSessionReconciler(cfg({ dryRun: true }), deps);
    await r.tick();
    const s = r.status();
    expect(s.enabled).toBe(true);
    expect(s.dryRun).toBe(true);
    expect(s.substrate.ready).toBe(true);
    expect(s.lastTick?.ran).toBe(true);
    expect(s.openEpisodes).toBe(0); // dry-run drains the episode
    expect(s.breaker.length).toBe(1); // the episode open still counted
    expect(s.breaker[0]).toMatchObject({ key: 'telegram:12345', episodes: 1, clamped: false });
    expect(s.counters.wouldConverge).toBe(1);
    expect(s.config.echoConfirmTicks).toBe(3);
  });
});
