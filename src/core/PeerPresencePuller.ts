/**
 * PeerPresencePuller (Multi-Machine Session Pool — HTTP presence transport).
 *
 * The pool registry's notion of which peer machines are ONLINE was originally
 * fed only by the git-synced MachineHeartbeat: each machine writes its heartbeat
 * into the shared agent repo, peers pull it, and recency ⇒ online. That breaks
 * for a *credential-less standby* — a machine paired into the mesh over HTTP but
 * WITHOUT push access to the shared repo (e.g. a second machine gh-authed to a
 * different account). Its heartbeat never reaches the router, so the router
 * marks it offline and the placement engine refuses to transfer to it, even
 * though the two machines can reach each other perfectly over their tunnels.
 *
 * This puller closes that gap with a pull-based HTTP presence channel: on a
 * cadence, ask each reachable peer for its self-capacity over the signed
 * /mesh/rpc `session-status` command (a read-class command any registered peer
 * may issue) and record the answer into the local pool registry. A peer that
 * answers is, by definition, reachable + alive — so it goes online without ever
 * touching git. Symmetric by design: every mesh machine runs one, so each keeps
 * its own HTTP-sourced view of peer liveness, parallel to (and idempotent with)
 * the git-synced path for credentialed peers.
 *
 * Fully injected (peers, fetch, record, clock) so the loop logic is unit-testable
 * without a live mesh. `pullOnce()` NEVER throws — an unreachable peer simply is
 * not recorded this pass and ages out of `online` naturally via the registry's
 * failover threshold.
 */

/** A peer to consider polling: its machine id + resolved tunnel URL (null ⇒ unreachable). */
export interface PeerPresenceMachine {
  machineId: string;
  url: string | null;
}

/** The slice of a peer's self-capacity the puller records (from `session-status`). */
export interface PeerCapacity {
  selfReportedLastSeen?: string;
  loadAvg?: number;
  /**
   * The peer's OWN-stream coherence-journal advert (COHERENCE-JOURNAL-SPEC §3.4
   * rule 5), keyed `kind → { incarnation, lastSeq }`. Present only when the peer
   * runs the journal-sync transport; old peers omit it and the delta drive is a
   * no-op. Replication-gated: the puller only acts on it when the delta deps are
   * wired (server passes them ONLY when replication is explicitly enabled).
   */
  journalAdvert?: Record<string, { incarnation: string; lastSeq: number }>;
  /**
   * The peer's OWN commitments-store advert (COMMITMENTS-COHERENCE-SPEC
   * §3.2). Present only when the peer runs the commitments-sync layer; old
   * peers omit it and the drive is a no-op.
   */
  commitmentsAdvert?: { incarnation: string; replicationSeq: number };
  /**
   * The peer's self-reported LLM-account quota state (live-matrix finding A2,
   * 2026-06-06). It IS carried in the peer's session-status response (its
   * getCapacity(self) already includes it) but was being PARSED AWAY on the
   * receive side — so the router only ever saw its OWN quota and quota-aware
   * placement (#804) could never avoid a rate-limited PEER (the original EXO
   * failure). Absent from old peers = treated as not blocked (fail-open).
   */
  quotaState?: { blocked: boolean; blockedUntil?: string; reason?: string };
  /**
   * The peer's compact guard-posture summary (GUARD-POSTURE-ENDPOINT-SPEC
   * §2.3). Carried in the peer's session-status response (its
   * getCapacity(self) includes it); the A2 lesson above applies verbatim —
   * narrowing it away on receive would blind the pool view to every peer's
   * posture. Absent from old peers = no posture ("guards: unknown").
   */
  guardPosture?: import('./types.js').GuardPostureSummary;
}

/** One stream slice of a journal-sync delta (mirrors MeshRpc's `journal-sync.batch`). */
export interface JournalDeltaStream {
  kind: string;
  incarnation: string;
  entries: unknown[];
  oldestRetainedSeq?: number;
}

export interface PeerPresencePullerDeps {
  /** This machine's id — never pulled (a machine doesn't poll itself). */
  selfMachineId: string;
  /** The current mesh peers (id + resolved URL). Re-read each pass so newly paired peers are picked up. */
  listPeers: () => PeerPresenceMachine[];
  /**
   * Send a signed `session-status` read to a peer and resolve its self-capacity,
   * or `null` if the peer did not answer / rejected. May reject; `pullOnce`
   * treats a rejection identically to a `null` (peer not recorded this pass).
   */
  fetchPeerCapacity: (machineId: string, url: string) => Promise<PeerCapacity | null>;
  /** Record an observed peer heartbeat into the pool registry (marks it online for the failover window). */
  recordHeartbeat: (obs: { machineId: string; selfReportedLastSeen: string; loadAvg?: number; quotaState?: { blocked: boolean; blockedUntil?: string; reason?: string }; guardPosture?: import('./types.js').GuardPostureSummary }) => void;
  /** Wall clock — injectable for tests. Defaults to `Date`. */
  now?: () => Date;
  /** Optional structured log line per pass (e.g. for the boot log). */
  log?: (line: string) => void;

  // ── Coherence-journal delta drive (REPLICATION-GATED) ──────────────────────
  // These three deps are passed by the server ONLY when journal replication is
  // EXPLICITLY enabled (config.multiMachine.coherenceJournal.replication.enabled
  // === true). When any is undefined the puller behaves exactly as before — no
  // delta is ever requested or applied. This is the SEND/drive gate: the engine
  // and transport land dark, and a human flips replication on for a monitored
  // live proof.
  /**
   * Request a journal delta for `kind` from a peer (a signed `journal-sync`
   * request → the peer's served own-stream batch), or null if unavailable.
   * MUST NOT throw into the puller (the puller treats a throw as null).
   */
  requestJournalDelta?: (
    machineId: string,
    url: string,
    kind: string,
    fromSeq: number,
  ) => Promise<JournalDeltaStream | null>;
  /** Apply a served delta into the local replica (delegates to JournalSyncApplier.apply). */
  applyDelta?: (senderMachineId: string, batch: JournalDeltaStream[]) => void;
  /**
   * What this machine ALREADY holds for `machineId` per kind (from the applier's
   * advert state). Used to decide whether the peer's advert is ahead of us.
   * Returns `{ kind → { incarnation, lastSeq } }` (possibly empty).
   */
  localAdvertFor?: (machineId: string) => Record<string, { incarnation: string; lastSeq: number }>;
  /**
   * Fired once per peer recorded online this pass (WORKING-SET-HANDOFF-SPEC
   * §3.4 — the pending-pull re-arm rides the same cadence journal-sync does).
   * MUST NOT throw into the puller; consumers dedupe/stagger themselves.
   */
  onPeerRecorded?: (machineId: string) => void;
  /**
   * REPLICATION-GATED commitments-sync drive (COMMITMENTS-COHERENCE-SPEC
   * §3.2): called with the peer's commitments advert when present; the
   * consumer compares against its replica cursor and pulls delta pages
   * (bounded per tick). MUST NOT throw into the puller.
   */
  driveCommitmentsSync?: (
    machineId: string,
    url: string,
    advert: { incarnation: string; replicationSeq: number },
  ) => Promise<void>;
}

export class PeerPresencePuller {
  constructor(private readonly d: PeerPresencePullerDeps) {}

  /**
   * One presence pass: poll every reachable peer in parallel and record any that
   * answer into the pool registry. Resolves with the ids recorded this pass.
   * Never rejects.
   */
  async pullOnce(): Promise<{ recorded: string[] }> {
    const peers = this.d.listPeers().filter((m) => m.machineId !== this.d.selfMachineId && !!m.url);
    const results = await Promise.all(
      peers.map(async (m): Promise<string | null> => {
        let cap: PeerCapacity | null = null;
        try {
          cap = await this.d.fetchPeerCapacity(m.machineId, m.url as string);
        } catch {
          cap = null; // unreachable / rejected → not recorded; ages out of online
        }
        if (!cap) return null;
        const seen = cap.selfReportedLastSeen ?? (this.d.now?.() ?? new Date()).toISOString();
        this.d.recordHeartbeat({ machineId: m.machineId, selfReportedLastSeen: seen, loadAvg: cap.loadAvg, ...(cap.quotaState ? { quotaState: cap.quotaState } : {}), ...(cap.guardPosture ? { guardPosture: cap.guardPosture } : {}) });
        // REPLICATION-GATED journal-delta drive — only when the server wired the
        // delta deps (i.e. replication.enabled === true). Otherwise a complete
        // no-op (engine/transport stay dark). Never throws into the puller.
        await this.driveJournalDelta(m.machineId, m.url as string, cap.journalAdvert);
        if (cap.commitmentsAdvert && this.d.driveCommitmentsSync) {
          try {
            await this.d.driveCommitmentsSync(m.machineId, m.url as string, cap.commitmentsAdvert);
          } catch { /* @silent-fallback-ok: the puller's contract is NEVER to throw — a failed commitments pull retries on the next presence pass (COMMITMENTS-COHERENCE-SPEC §3.2) */
          }
        }
        try {
          this.d.onPeerRecorded?.(m.machineId);
        } catch { /* @silent-fallback-ok: the puller's contract is NEVER to throw — a pending-pull re-arm failure must not break the presence pass (WORKING-SET-HANDOFF-SPEC §3.4) */
        }
        return m.machineId;
      }),
    );
    const recorded = results.filter((r): r is string => r !== null);
    if (recorded.length && this.d.log) this.d.log(`recorded ${recorded.length} peer(s) online over HTTP: ${recorded.join(', ')}`);
    return { recorded };
  }

  /**
   * REPLICATION-GATED: for a freshly-recorded peer, if the journal-delta deps are
   * wired AND the peer's advert shows a kind ahead of what we hold (same
   * incarnation, higher lastSeq — OR a kind we hold nothing for), request that
   * kind's delta and apply it. The send/drive path is therefore active ONLY when
   * the server passed these deps, which it does ONLY when replication is
   * explicitly enabled. Never throws (a failing fetch/apply is swallowed — the
   * presence pass must always complete).
   */
  private async driveJournalDelta(
    machineId: string,
    url: string,
    peerAdvert?: Record<string, { incarnation: string; lastSeq: number }>,
  ): Promise<void> {
    // Gate: all three deps must be present (server wires them only when
    // replication.enabled === true). Any absent → no-op (dark).
    const { requestJournalDelta, applyDelta, localAdvertFor } = this.d;
    if (!requestJournalDelta || !applyDelta || !localAdvertFor) return;
    if (!peerAdvert || typeof peerAdvert !== 'object') return;

    let local: Record<string, { incarnation: string; lastSeq: number }> = {};
    try {
      local = localAdvertFor(machineId) || {};
    } catch { /* @silent-fallback-ok: the puller's contract is NEVER to throw (presence must always complete); an empty local view safely treats any peer seq as ahead and the applier de-dupes on apply */
      local = {};
    }

    for (const [kind, peer] of Object.entries(peerAdvert)) {
      try {
        if (!peer || typeof peer.lastSeq !== 'number' || !Number.isFinite(peer.lastSeq)) continue;
        const held = local[kind];
        // We hold nothing for this kind → request from 0. We hold the SAME
        // incarnation but the peer is ahead → request from our lastSeq. A
        // DIFFERENT incarnation is still requested from our lastSeq; the applier
        // performs the incarnation-fencing/quarantine on apply (its job, not
        // ours) — so we still pull and let it reconcile.
        const fromSeq = held && typeof held.lastSeq === 'number' ? held.lastSeq : 0;
        const peerAhead = !held || peer.incarnation !== held.incarnation || peer.lastSeq > fromSeq;
        if (!peerAhead) continue;

        let delta: JournalDeltaStream | null = null;
        try {
          delta = await requestJournalDelta(machineId, url, kind, fromSeq);
        } catch { /* @silent-fallback-ok: an unreachable/rejected delta fetch is a transient, self-healing condition — the next presence pass re-requests; surfacing it here would break the puller's never-throw contract */
          delta = null;
        }
        if (!delta) continue;
        try {
          applyDelta(machineId, [delta]);
        } catch { /* @silent-fallback-ok: apply() is itself fully tolerant + observable via its own counters; this guard only preserves the puller's never-throw contract */ }
      } catch { /* @silent-fallback-ok: per-kind drive is best-effort; one bad kind must never poison the rest of the presence pass (the puller's never-throw contract) */ }
    }
  }
}
