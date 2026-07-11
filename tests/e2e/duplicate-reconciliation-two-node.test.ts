/**
 * Increment-2 ENTRY-GATE E2E (ownership-gated-spawn-and-judgment-within-floors
 * §4 line 242 / §5 line 261): the duplicate-reconciliation lifecycle on a REAL
 * two-node harness in which the replication hop is NOT stubbed — affirmative
 * (L7) evidence that a lease-holder convergence write lands in the PEER
 * machine's OWN registry view and arms the peer-side sweeper. Runs in CI as
 * the Increment-2 entry gate: "is duplicate-reconciliation-two-node green?"
 * is the objective gate question.
 *
 * The harness (tests/support/twoNodeOwnershipHarness.ts) runs, per node, the
 * DURABLE ownership substrate + a real AgentServer; the reconciler under test
 * is wired to REAL HTTP for every cross-machine read (probes, peer echo),
 * mirroring the production deps in src/commands/server.ts — discovery is
 * computed from both nodes' real /sessions listings, never a fed fixture.
 *
 * Also here: the §5 line 262 delayed-journal-replay case (echo timeout →
 * ONE aggregated escalation → late replication → convergence observed on a
 * later tick). The remaining §5 two-node scenarios are spec-anchored
 * it.todo entries — visible in every test run, never silently green.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { makeTwoNodeHarness, HARNESS_AUTH } from '../support/twoNodeOwnershipHarness.js';
import type { TwoNodeHarness, HarnessNode } from '../support/twoNodeOwnershipHarness.js';
import { DuplicateSessionReconciler } from '../../src/monitoring/DuplicateSessionReconciler.js';
import type { DuplicateCandidate, ReconcilerDeps } from '../../src/monitoring/DuplicateSessionReconciler.js';
import type { BoundedJsonlAudit } from '../../src/core/BoundedJsonlAudit.js';

type Row = Record<string, unknown>;

async function authedJson<T>(url: string): Promise<T> {
  const r = await fetch(url, { headers: { Authorization: `Bearer ${HARNESS_AUTH}` } });
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  return (await r.json()) as T;
}

/**
 * Wire a reconciler on node A whose every cross-machine read rides REAL HTTP —
 * the production dep shapes from src/commands/server.ts, pointed at the
 * harness nodes.
 */
function makeReconciler(h: TwoNodeHarness) {
  const journalRows: Row[] = [];
  const attention: Array<{ id: string; title: string; body: string }> = [];
  const closeoutsArmed: Array<{ key: string; owner: string }> = [];
  const nodes = () => [h.a, h.b];
  const nodeById = (id: string): HarnessNode | undefined => nodes().find((n) => n.machineId === id);

  const deps: ReconcilerDeps = {
    selfMachineId: () => h.a.machineId,
    holdsLease: () => true,
    // The harness runs the DURABLE store on both nodes — honestly ready.
    substrateReady: () => ({ ready: true }),
    errorEpisodeOpen: () => false,
    topicHasAuthorityInMotion: (sk) => {
      const r = h.a.registry.read(sk);
      return r?.status === 'transferring' || r?.status === 'placing';
    },
    // REAL discovery: both nodes' live /sessions listings over real HTTP,
    // grouped by conversation — the production duplicateTopics computation.
    discoverCandidates: async () => {
      const byKey = new Map<string, DuplicateCandidate>();
      for (const n of nodes()) {
        const list = await authedJson<Array<Record<string, unknown>>>(`${n.url}/sessions`);
        for (const s of Array.isArray(list) ? list : []) {
          if (s.platform !== 'telegram' || s.platformId == null) continue;
          const key = `telegram:${String(s.platformId)}`;
          const cand = byKey.get(key) ?? { key, platform: 'telegram', platformId: String(s.platformId), machines: [] };
          let m = cand.machines.find((x) => x.machineId === n.machineId);
          if (!m) {
            m = { machineId: n.machineId, sessions: [] };
            cand.machines.push(m);
          }
          m.sessions.push(String(s.tmuxSession ?? s.name));
          byKey.set(key, cand);
        }
      }
      return { candidates: [...byKey.values()].filter((c) => c.machines.length >= 2) };
    },
    // Fresh direct probe over REAL HTTP (production shape: GET <machine>/sessions).
    probeLiveCopy: async (machineId, key) => {
      const n = nodeById(machineId);
      if (!n) return { ok: false, live: false };
      try {
        const sep = key.indexOf(':');
        const platform = key.slice(0, sep);
        const pid = key.slice(sep + 1);
        const list = await authedJson<Array<Record<string, unknown>>>(`${n.url}/sessions`);
        const live = (Array.isArray(list) ? list : []).some(
          (s) => String(s.platform) === platform && String(s.platformId) === pid,
        );
        return { ok: true, live };
      } catch {
        return { ok: false, live: false };
      }
    },
    readPin: () => null,
    readOwnershipViews: (sk) => {
      const r = h.a.registry.read(sk);
      if (!r || !h.a.registry.ownerOf(sk)) return [];
      return [{ machineId: h.a.machineId, owner: h.a.registry.ownerOf(sk), epoch: r.ownershipEpoch, admissible: true }];
    },
    liveRunHosts: async () => [],
    // The fenced convergence CAS + the journal emit that IS the replication
    // path (production pairs emitPlacement('reconcile') — server.ts).
    casConverge: (sk, owner) => {
      const prevOwner = h.a.registry.read(sk)?.ownerMachineId;
      const r = h.a.registry.cas(
        { type: 'claim', machineId: owner },
        { sessionKey: sk, sender: h.a.machineId, nonce: `dup-reconcile:${sk}:${journalRows.length}` },
      );
      if (r.ok) {
        h.a.journal.emitPlacement(Number(sk), {
          owner: r.record.ownerMachineId ?? owner,
          ...(prevOwner ? { prevOwner } : {}),
          epoch: r.record.ownershipEpoch,
          reason: 'reconcile',
        });
      }
      return r.ok ? { ok: true } : { ok: false, reason: String((r as { reason?: string }).reason ?? 'cas-refused') };
    },
    // Peer echo over REAL HTTP: the peer's OWN registry view via its
    // Bearer-authed /pool/ownership-view (production shape).
    peerEchoObserved: async (sk, owner, machineId) => {
      const n = nodeById(machineId);
      if (!n) return false;
      const j = await authedJson<{ owner?: string | null }>(`${n.url}/pool/ownership-view?key=${encodeURIComponent(sk)}`);
      return j.owner === owner;
    },
    armCloseout: (sk, owner) => closeoutsArmed.push({ key: sk, owner }),
    raiseAttention: (item) => attention.push(item),
    journal: { append: (r: Row) => journalRows.push(r) } as unknown as BoundedJsonlAudit,
    log: () => {},
  };

  const reconciler = new DuplicateSessionReconciler(
    {
      enabled: true,
      dryRun: false, // in-test construction, not a rollout-ladder flip
      reconcilerTickMs: 60_000,
      maxReconcilesPerTick: 5,
      maxConvergenceWritesPerTick: 5,
      echoConfirmTicks: 2,
      breakerThreshold: 5,
      breakerWindowMs: 86_400_000,
    },
    deps,
  );
  return { reconciler, journalRows, attention, closeoutsArmed };
}

describe('duplicate reconciliation — two-node lifecycle (Increment-2 entry gate)', () => {
  let h: TwoNodeHarness;

  beforeAll(async () => {
    h = await makeTwoNodeHarness();
  });

  afterAll(async () => {
    await h?.teardown();
  });

  it('L7 lifecycle: duplicate → converge on A → un-stubbed replication → B\'s OWN view echoes → peer-side sweeper armed', async () => {
    const TOPIC = 777;
    const sk = String(TOPIC);

    // ── 1. The incident shape: A owns the conversation (durable record),
    //       and BOTH nodes hold a live session for it (the bootleg copy).
    const seed = h.a.registry.cas(
      { type: 'place', machineId: h.a.machineId },
      { sessionKey: sk, sender: h.a.machineId, nonce: 'seed-place-777' },
    );
    expect(seed.ok).toBe(true);
    // placing→active confirmation (the production two-step: the owner claims
    // its own placement — server.ts's post-spawn confirmation CAS).
    const confirm = h.a.registry.cas(
      { type: 'claim', machineId: h.a.machineId },
      { sessionKey: sk, sender: h.a.machineId, nonce: 'seed-claim-777' },
    );
    expect(confirm.ok).toBe(true);
    // Production pairs emitPlacement with every ownership CAS (the journal
    // emit IS the replication path) — the seed placement mirrors that.
    if (confirm.ok) {
      h.a.journal.emitPlacement(TOPIC, { owner: h.a.machineId, epoch: confirm.record.ownershipEpoch, reason: 'placed' });
    }
    h.a.addLiveSession(TOPIC);
    const bootlegCopy = h.b.addLiveSession(TOPIC);

    // Sanity: B currently has NO owner record for the topic (its own view is dark).
    expect(h.b.registry.ownerOf(sk)).toBeFalsy();

    const { reconciler, journalRows, attention, closeoutsArmed } = makeReconciler(h);

    // ── 2. Reconciler tick on the lease holder: REAL-HTTP discovery finds the
    //       duplicate, fresh probes confirm both copies, the evidence ladder
    //       names A (highest admissible epoch), the fenced CAS lands + the
    //       placement is journaled with reason 'reconcile'.
    const t1 = await reconciler.tick();
    expect(t1.ran).toBe(true);
    expect(t1.candidates).toBe(1);
    expect(t1.reconciled).toBe(1);
    // The incident's OWN shape: the record already names the owner (the
    // bootleg spawn never wrote one) — healed via the no-epoch-burn skip.
    expect(journalRows.some((r) => r.kind === 'record-already-converged' && r.rule === 'highest-epoch')).toBe(true);

    // Echo NOT yet observed — nothing has replicated. No closeout armed.
    expect(closeoutsArmed.length).toBe(0);

    // ── 3. THE UN-STUBBED HOP: A's own journal stream → signed envelope →
    //       B's real /mesh/rpc → B's sync applier → B's OWN replica stream.
    const hop = await h.replicate(h.a, h.b);
    expect(hop.applied).toBeGreaterThanOrEqual(1);
    expect(hop.forgedEntries).toBe(0);

    // ── 4. B materializes the replicated placement into its OWN durable store.
    const mat = h.applierTick(h.b);
    expect(mat.materialized).toBeGreaterThanOrEqual(1);

    // L7 affirmative evidence, read through B's REAL Bearer-authed HTTP surface
    // (never a direct store read): B's OWN view now names the converged owner.
    const bView = await authedJson<{ owner: string | null; epoch: number }>(
      `${h.b.url}/pool/ownership-view?key=${sk}`,
    );
    expect(bView.owner).toBe(h.a.machineId);
    expect(bView.epoch).toBeGreaterThanOrEqual(2); // seed place + confirm-claim (the heal burns NO epoch)

    // ── 5. Next reconciler tick: the peer echo (REAL HTTP against B) confirms;
    //       the closeout is armed for the non-owner copy via the EXISTING
    //       gated sweeper path (the reconciler itself never kills).
    const t2 = await reconciler.tick();
    expect(t2.echoConfirmed).toBe(1);
    expect(journalRows.some((r) => r.kind === 'echo-confirmed')).toBe(true);
    expect(closeoutsArmed).toEqual([{ key: sk, owner: h.a.machineId }]);

    // The peer-side sweeper predicate (§2.3 topicOwnerElsewhere): B's OWN
    // registry now says the owner is NOT B — exactly what arms B's closeout.
    expect(h.b.registry.ownerOf(sk)).toBe(h.a.machineId);
    expect(h.b.registry.ownerOf(sk)).not.toBe(h.b.machineId);

    // Zero escalations on the happy path.
    expect(attention.length).toBe(0);

    // FD15 calibration input: log the measured journal-hop latency.
    // eslint-disable-next-line no-console
    console.log(`[FD15] journal-hop latency ms: ${JSON.stringify(h.b.hopLatenciesMs)}`);

    // What the armed closeout does next (its own gated path, out of scope
    // here): the non-owner copy closes. Simulate the close so the shared
    // harness carries no live duplicate into the next scenario.
    h.b.endSession(bootlegCopy.tmuxSession);
  });

  it('delayed journal replay (§5): echo timeout → ONE aggregated escalation; late replication → convergence observed on a later tick', async () => {
    const TOPIC = 888;
    const sk = String(TOPIC);
    const seed = h.a.registry.cas(
      { type: 'place', machineId: h.a.machineId },
      { sessionKey: sk, sender: h.a.machineId, nonce: 'seed-place-888' },
    );
    expect(seed.ok).toBe(true);
    const confirm = h.a.registry.cas(
      { type: 'claim', machineId: h.a.machineId },
      { sessionKey: sk, sender: h.a.machineId, nonce: 'seed-claim-888' },
    );
    expect(confirm.ok).toBe(true);
    if (confirm.ok) {
      h.a.journal.emitPlacement(TOPIC, { owner: h.a.machineId, epoch: confirm.record.ownershipEpoch, reason: 'placed' });
    }
    h.a.addLiveSession(TOPIC);
    const lateCopy = h.b.addLiveSession(TOPIC);

    const { reconciler, journalRows, attention } = makeReconciler(h);

    // Tick 1: converge on A. Replication is WITHHELD (the delayed-replay fault).
    const t1 = await reconciler.tick();
    expect(t1.reconciled).toBe(1);

    // Ticks 2-3: echoConfirmTicks(2) exhaust without the peer ever showing the
    // repair → ONE aggregated convergence-not-observed escalation (P17).
    await reconciler.tick();
    const t3 = await reconciler.tick();
    expect(t3.echoTimeouts).toBe(1);
    const escalations = attention.filter((a) => a.title.includes('Convergence not observed'));
    expect(escalations.length).toBe(1);
    expect(escalations[0].body).toContain(`telegram:${TOPIC}`);
    expect(journalRows.some((r) => r.kind === 'convergence-not-observed')).toBe(true);

    // The LATE replay arrives: replicate + materialize on B.
    const hop = await h.replicate(h.a, h.b);
    expect(hop.applied).toBeGreaterThanOrEqual(1);
    h.applierTick(h.b);

    // A later tick re-detects the still-live duplicate; the record is already
    // right (record-already-converged — no new CAS, no epoch burn), so the
    // echo window re-opens, and the following tick confirms against B's
    // late-materialized view.
    const t4 = await reconciler.tick();
    expect(t4.reconciled).toBe(1);
    const t5 = await reconciler.tick();
    expect(t5.echoConfirmed).toBe(1);
    expect(h.b.registry.ownerOf(sk)).toBe(h.a.machineId);

    // Simulate the armed closeout so the shared harness carries no live
    // duplicate into the next scenario.
    h.b.endSession(lateCopy.tmuxSession);
  });

  // ── Remaining §5 two-node scenarios — spec-anchored, visibly pending ──
  // (never silently green; each lands with the increment that builds its
  // mechanics, per the staged rollout the operator approved)

  it('§5: partition-formed duplicates heal on merge — the higher-epoch claim wins after both-ways replication, no operator involved', async () => {
    const TOPIC = 999;
    const sk = String(TOPIC);

    // ── The partition: BOTH nodes independently placed + claimed the topic
    //    while they could not hear each other. B additionally moved the
    //    conversation (transfer + abort — two more fenced epochs), so B's
    //    claim carries the STRONGER history. Every CAS pairs emitPlacement
    //    (the production chokepoint discipline).
    const aPlace = h.a.registry.cas({ type: 'place', machineId: h.a.machineId }, { sessionKey: sk, sender: h.a.machineId, nonce: 'p-a-999' });
    expect(aPlace.ok).toBe(true);
    const aClaim = h.a.registry.cas({ type: 'claim', machineId: h.a.machineId }, { sessionKey: sk, sender: h.a.machineId, nonce: 'c-a-999' });
    expect(aClaim.ok).toBe(true);
    if (aClaim.ok) h.a.journal.emitPlacement(TOPIC, { owner: h.a.machineId, epoch: aClaim.record.ownershipEpoch, reason: 'placed' });

    const bPlace = h.b.registry.cas({ type: 'place', machineId: h.b.machineId }, { sessionKey: sk, sender: h.b.machineId, nonce: 'p-b-999' });
    expect(bPlace.ok).toBe(true);
    const bClaim = h.b.registry.cas({ type: 'claim', machineId: h.b.machineId }, { sessionKey: sk, sender: h.b.machineId, nonce: 'c-b-999' });
    expect(bClaim.ok).toBe(true);
    const bXfer = h.b.registry.cas({ type: 'transfer', to: h.b.machineId }, { sessionKey: sk, sender: h.b.machineId, nonce: 't-b-999' });
    expect(bXfer.ok).toBe(true);
    const bAbort = h.b.registry.cas({ type: 'abort-transfer', machineId: h.b.machineId }, { sessionKey: sk, sender: h.b.machineId, nonce: 'x-b-999' });
    expect(bAbort.ok).toBe(true);
    if (bAbort.ok) h.b.journal.emitPlacement(TOPIC, { owner: h.b.machineId, epoch: bAbort.record.ownershipEpoch, reason: 'failover' });

    const aEpoch = aClaim.ok ? aClaim.record.ownershipEpoch : 0;
    const bEpoch = bAbort.ok ? bAbort.record.ownershipEpoch : 0;
    expect(bEpoch).toBeGreaterThan(aEpoch); // the asymmetry under test

    // Both copies live (the partition left a session on each side).
    h.a.addLiveSession(TOPIC);
    const aCopy = h.b.addLiveSession(TOPIC); // b's copy — expected survivor is B
    void aCopy;

    // ── The MERGE: replication flows both ways; each applier materializes
    //    the strictly-newer history. A adopts B's higher-epoch record; B
    //    ignores A's older one (epoch-gated fast-forward — never a clobber).
    await h.replicate(h.a, h.b);
    await h.replicate(h.b, h.a);
    h.applierTick(h.a);
    h.applierTick(h.b);
    expect(h.a.registry.ownerOf(sk)).toBe(h.b.machineId); // A adopted B's claim
    expect(h.b.registry.ownerOf(sk)).toBe(h.b.machineId); // B kept its own

    // ── The reconciler on the lease holder now sees a duplicate whose record
    //    (A's own materialized view) already names B → the no-epoch-burn skip
    //    → echo against B's REAL HTTP view confirms → closeout armed for the
    //    non-owner copy. Zero escalations, zero operator involvement.
    const { reconciler, attention, closeoutsArmed } = makeReconciler(h);
    const t1 = await reconciler.tick();
    expect(t1.reconciled).toBe(1);
    const t2 = await reconciler.tick();
    expect(t2.echoConfirmed).toBe(1);
    expect(closeoutsArmed).toEqual([{ key: sk, owner: h.b.machineId }]);
    expect(attention.length).toBe(0);
  });
  it.todo('§5 line 262: registry-error episode freezes the reconciler + bounded fail-open, with post-recovery convergence (§3.1 row e two-node)');
  it.todo('§5 line 260: EVERY duplicate-reconciled/topic-moved termination closes ONLY with the terminate-time live-owner probe confirmed (blocked on the SessionReaper duplicate-reconciled reap-reason extension)');
  it.todo('§4 line 243 / §3.2.4a: commitment-custody transfer two-node E2E — origin commitment on A, survivor on B, successor minted on B, A\'s record terminal-superseded (blocked on Increment 2b: the custody mechanics are deliberately NOT built in Increment 1)');
});
