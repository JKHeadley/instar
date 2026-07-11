/**
 * DuplicateSessionReconciler — Layer B of ownership-gated-spawn-and-judgment-
 * within-floors (§3.2): converge the OWNERSHIP RECORD when the same
 * conversation is live on two or more machines, so the EXISTING gated closeout
 * (SessionReaper's topic-moved sweeper) can close the non-owner copy through
 * its normal path. **The reconciler never kills a session** — it repairs
 * records; the closeout's own guards (fresh re-checks, veto breaker,
 * terminate-time re-probe) do every close.
 *
 * The 2026-07-10 incident's healing gap in one line: the duplicate detector
 * was observe-only and request-driven (only ran when a dashboard polled), and
 * both machines' cleanup separately refused the duplicates (`not-lease-holder`
 * on one side, `open-commitment` on the other) — two individually-correct
 * guards jointly making a duplicate immortal.
 *
 * Deterministic core (all ambiguity ESCALATES, never guesses):
 *  - §3.2.0 substrate gate: refuses to arm on an in-memory ownership store
 *    (fleet default) — a loud `substrate-not-ready` status, never silent.
 *  - §3.2.1 discovery on the serving-lease holder only, tick-paced, fresh
 *    direct probe before ANY record write; per-tick caps (P17).
 *  - §3.2.2 intended-owner evidence ladder: hard pin (never a quarantined
 *    one) → highest ADMISSIBLE ownershipEpoch → server-registered live
 *    autonomous run (probe-confirmed) → J2/escalate. Rule-2/rule-3
 *    contradiction, both-self-with-equal-epochs, both-live-runs, and CAS
 *    409s always escalate. "Most recent user interaction" is deliberately
 *    NOT a rule — the non-owner duplicate often has the latest message
 *    BECAUSE of the bug.
 *  - §3.2.3 convergence: ONE fenced CAS naming the intended owner (journal
 *    replication fast-forwards every peer), then peer-echo confirmation
 *    within `echoConfirmTicks`; no echo → ONE aggregated
 *    `convergence-not-observed` escalation (P17).
 *  - §3.2.5 P19 breaker: a topic re-duplicating past the threshold stops
 *    being auto-reconciled and raises ONE item; record FLIPS and
 *    echoed-but-unhealed episodes count; transfer-traceable episodes are
 *    excluded from the clamp (but ≥3/24h raise an observability-only item).
 *  - Registry-error freeze: while the SpawnAdmission error episode is open,
 *    the reconciler pauses (same fault domain — §3.1 row e).
 *
 * Increment-1 posture: dev-gated + dryRun — detection, evidence ladder, and
 * would-converge decisions run and journal; NO CAS lands, NO closeout arms
 * until a deliberate dryRun:false (and the substrate gate holds regardless).
 */

import type { BoundedJsonlAudit } from '../core/BoundedJsonlAudit.js';

export interface DuplicateCandidate {
  /** `${platform}:${platformId}` — the conversation identity. */
  key: string;
  platform: string;
  platformId: string;
  /** Machines with a LIVE session for this conversation. */
  machines: Array<{ machineId: string; sessions: string[] }>;
}

export interface ReconcilerConfigView {
  enabled: boolean;
  dryRun: boolean;
  reconcilerTickMs: number;
  maxReconcilesPerTick: number;
  maxConvergenceWritesPerTick: number;
  echoConfirmTicks: number;
  breakerThreshold: number;
  breakerWindowMs: number;
}

export interface OwnershipViewRow {
  machineId: string;
  owner: string | null;
  epoch: number;
  /** Origin-stamp validated (§3 epoch hygiene) — inadmissible rows never count. */
  admissible: boolean;
}

export type IntendedOwnerVerdict =
  | { kind: 'owner'; owner: string; rule: 'hard-pin' | 'highest-epoch' | 'live-run'; detail: string }
  | { kind: 'escalate'; reason: string };

export interface ReconcilerDeps {
  selfMachineId: () => string | null;
  holdsLease: () => boolean;
  /** §3.2.0 — durable + replicated ownership substrate live pool-wide. */
  substrateReady: () => { ready: boolean; reason?: string };
  /** §3.1 row e — freeze while a registry-error episode is open (same fault domain). */
  errorEpisodeOpen: () => boolean;
  /** One authority in motion per topic: in-flight transfer / open stale-owner episode / active hold. */
  topicHasAuthorityInMotion: (sessionKey: string) => boolean;
  /** Candidate discovery (lease-holder bounded fan-out, or the pool poll-cache where live). */
  discoverCandidates: () => Promise<{ candidates: DuplicateCandidate[]; degraded?: string }>;
  /**
   * Fresh direct probe (5s budget in the wiring): does the machine still hold a
   * LIVE copy of this conversation? Cache rows are never acted on (§3.2.1).
   */
  probeLiveCopy: (machineId: string, key: string) => Promise<{ ok: boolean; live: boolean }>;
  /** Pin store read — a quarantined pin never counts (§3.2.2 rule 1). */
  readPin: (sessionKey: string) => { pinned: boolean; preferredMachine?: string | null; quarantined?: boolean } | null;
  /** Every machine's replicated registry view for this key (§3.2.2 rule 2). */
  readOwnershipViews: (sessionKey: string) => OwnershipViewRow[];
  /**
   * §3.2.2 rule 3 — journal-replicated live-run registration, confirmed by an
   * authenticated live probe to the hosting machine (never a bare poll row).
   */
  liveRunHosts: (sessionKey: string) => Promise<Array<{ machineId: string; registeredAt: number; confirmed: boolean }>>;
  /** The fenced convergence CAS (lease epoch + record epoch ride the wiring). */
  casConverge: (sessionKey: string, owner: string) => { ok: boolean; reason?: string };
  /** Peer-echo: does `machineId`'s OWN registry view now name `owner`? */
  peerEchoObserved: (sessionKey: string, owner: string, machineId: string) => Promise<boolean>;
  /**
   * Arm the existing closeout for the non-owner copy (reap-log reason
   * `duplicate-reconciled`) — the sweeper's own guards still decide the close.
   */
  armCloseout: (sessionKey: string, owner: string) => void;
  raiseAttention: (item: { id: string; title: string; body: string; priority: 'high' | 'medium' }) => void;
  journal: BoundedJsonlAudit;
  provenance?: (row: {
    component: string;
    decisionPoint: string;
    context: Record<string, unknown>;
    optionsPresented: string[];
    decision: string;
    reason: string;
    floor: string;
    fallbackRung: string;
  }) => void;
  log: (msg: string) => void;
  now?: () => number;
}

interface DuplicateEpisode {
  key: string;
  /** §3 glossary: OPENS at the contested copy's spawn-registration timestamp —
   * backdated at detection so post-spawn evidence never predates it. Increment-1
   * wiring uses detection time when the spawn-registration ts is unavailable,
   * recorded honestly in the row. */
  openedAt: number;
  openBackdated: boolean;
  convergenceAttempts: number;
  /** Set after a (dry-run or real) convergence write; echo checks count down. */
  echoPending: { owner: string; machines: string[]; ticksLeft: number } | null;
  escalated: boolean;
}

/** §3.2.5 — receive-side type clamp for replicated breaker rows. */
export function clampBreakerRow(row: unknown): { key: string; count: number; lastAt: string } | null {
  if (!row || typeof row !== 'object') return null;
  const r = row as Record<string, unknown>;
  if (typeof r.key !== 'string' || r.key.length === 0 || r.key.length > 256) return null;
  if (typeof r.count !== 'number' || !Number.isFinite(r.count) || r.count < 0 || r.count > 1_000_000) return null;
  if (typeof r.lastAt !== 'string' || Number.isNaN(Date.parse(r.lastAt))) return null;
  return { key: r.key, count: Math.floor(r.count), lastAt: r.lastAt };
}

export interface ReconcilerTickReport {
  at: string;
  ran: boolean;
  skippedReason?: string;
  candidates: number;
  reconciled: number;
  wouldConverge: number;
  escalations: number;
  echoConfirmed: number;
  echoTimeouts: number;
  breakerClamped: number;
}

export interface ReconcilerStatus {
  enabled: boolean;
  dryRun: boolean;
  substrate: { ready: boolean; reason?: string };
  lastTick: ReconcilerTickReport | null;
  openEpisodes: number;
  breaker: Array<{ key: string; episodes: number; clamped: boolean }>;
  counters: Record<string, number>;
  config: Omit<ReconcilerConfigView, 'enabled' | 'dryRun'>;
}

export class DuplicateSessionReconciler {
  private readonly deps: ReconcilerDeps;
  private cfg: ReconcilerConfigView;
  private readonly nowFn: () => number;
  private episodes = new Map<string, DuplicateEpisode>();
  /** §3.2.5 per-topic re-duplication episode opens within the window. */
  private breakerEpisodes = new Map<string, number[]>();
  /** Topics whose episode is transfer-traceable this window (excluded from the clamp). */
  private transferTraceable = new Map<string, number[]>();
  private lastTick: ReconcilerTickReport | null = null;
  private substrateNotReadySince: number | null = null;
  private substratePauseItemRaised = false;
  private counters: Record<string, number> = {
    ticks: 0,
    candidatesSeen: 0,
    converged: 0,
    wouldConverge: 0,
    escalations: 0,
    echoConfirmed: 0,
    echoTimeouts: 0,
    breakerClamps: 0,
    probeDeferrals: 0,
    frozenTicks: 0,
  };

  constructor(cfg: ReconcilerConfigView, deps: ReconcilerDeps) {
    this.cfg = cfg;
    this.deps = deps;
    this.nowFn = deps.now ?? (() => Date.now());
  }

  setConfig(cfg: ReconcilerConfigView): void {
    this.cfg = cfg;
  }

  /** One reconciler pass. Returns the report (also retained for status()). */
  async tick(): Promise<ReconcilerTickReport> {
    const report: ReconcilerTickReport = {
      at: new Date(this.nowFn()).toISOString(),
      ran: false,
      candidates: 0,
      reconciled: 0,
      wouldConverge: 0,
      escalations: 0,
      echoConfirmed: 0,
      echoTimeouts: 0,
      breakerClamped: 0,
    };
    this.counters.ticks++;
    try {
      if (!this.cfg.enabled) return this.finish(report, 'disabled');
      if (!this.deps.holdsLease()) return this.finish(report, 'not-lease-holder');
      if (this.deps.errorEpisodeOpen()) {
        this.counters.frozenTicks++;
        return this.finish(report, 'registry-error-episode-open (frozen — same fault domain as the spawn error arm)');
      }
      const substrate = this.deps.substrateReady();
      if (!substrate.ready) {
        this.noteSubstrateNotReady(substrate.reason);
        return this.finish(report, `substrate-not-ready: ${substrate.reason ?? 'in-memory ownership store'}`);
      }
      this.substrateNotReadySince = null;
      this.substratePauseItemRaised = false;
      report.ran = true;

      // Echo confirmation countdown for episodes with a pending convergence.
      await this.checkPendingEchoes(report);

      const { candidates, degraded } = await this.deps.discoverCandidates();
      if (degraded) {
        this.deps.log(`[dup-reconciler] discovery degraded: ${degraded}`);
      }
      report.candidates = candidates.length;
      this.counters.candidatesSeen += candidates.length;

      let reconcilesThisTick = 0;
      let writesThisTick = 0;
      for (const cand of candidates) {
        if (reconcilesThisTick >= this.cfg.maxReconcilesPerTick) break;
        if (writesThisTick >= this.cfg.maxConvergenceWritesPerTick) break;
        const acted = await this.reconcileOne(cand, report);
        if (acted.consumed) reconcilesThisTick++;
        if (acted.wrote) writesThisTick++;
      }
      return this.finish(report);
    } catch (err) {
      this.deps.log(`[dup-reconciler] tick error: ${(err as Error)?.message ?? String(err)}`);
      return this.finish(report, `tick-error: ${(err as Error)?.message ?? String(err)}`);
    }
  }

  private finish(report: ReconcilerTickReport, skippedReason?: string): ReconcilerTickReport {
    if (skippedReason) report.skippedReason = skippedReason;
    this.lastTick = report;
    return report;
  }

  private noteSubstrateNotReady(reason?: string): void {
    const now = this.nowFn();
    if (this.substrateNotReadySince === null) this.substrateNotReadySince = now;
    // §3.2.0 substrate flap: a NOT-ready pause persisting >30 min raises ONE item.
    if (!this.substratePauseItemRaised && this.cfg.enabled && now - this.substrateNotReadySince > 30 * 60_000) {
      this.substratePauseItemRaised = true;
      this.deps.raiseAttention({
        id: `dup-reconciler-substrate:${this.deps.selfMachineId() ?? 'local'}`,
        title: 'Duplicate reconciler paused — ownership substrate not ready',
        body: `The duplicate-session reconciler has been paused for over 30 minutes (${reason ?? 'in-memory ownership store / replication not live'}). Duplicates are not being auto-converged while this holds.`,
        priority: 'medium',
      });
    }
  }

  /** Reconcile one duplicate candidate. */
  private async reconcileOne(
    cand: DuplicateCandidate,
    report: ReconcilerTickReport,
  ): Promise<{ consumed: boolean; wrote: boolean }> {
    const now = this.nowFn();
    const sessionKey = cand.platform === 'telegram' ? cand.platformId : cand.platformId;

    // One authority in motion per topic (§3.2.1 item 3).
    if (this.deps.topicHasAuthorityInMotion(sessionKey)) {
      this.journalRow({ kind: 'deferred-authority-in-motion', key: cand.key });
      return { consumed: false, wrote: false };
    }

    // §3.2.5 breaker: a clamped topic is not auto-reconciled.
    if (this.breakerClamped(cand.key, now)) {
      report.breakerClamped++;
      this.counters.breakerClamps++;
      return { consumed: false, wrote: false };
    }

    const ep = this.openOrGetEpisode(cand.key, now);
    if (ep.echoPending) return { consumed: false, wrote: false }; // convergence in flight
    if (ep.convergenceAttempts >= 3) {
      // §3.8: 3 convergence attempts per episode, then escalate once.
      this.escalateOnce(ep, cand, 'convergence-attempts-exhausted', report);
      return { consumed: false, wrote: false };
    }

    // Fresh direct probes — a cache row is never acted on (§3.2.1 item 1).
    const probes = new Map<string, boolean>();
    for (const m of cand.machines) {
      const p = await this.deps.probeLiveCopy(m.machineId, cand.key);
      if (!p.ok) {
        this.counters.probeDeferrals++;
        ep.convergenceAttempts++;
        this.journalRow({ kind: 'probe-failed-deferred', key: cand.key, machine: m.machineId, attempts: ep.convergenceAttempts });
        return { consumed: true, wrote: false };
      }
      probes.set(m.machineId, p.live);
    }
    const liveMachines = cand.machines.filter((m) => probes.get(m.machineId));
    if (liveMachines.length < 2) {
      // Duplicate no longer exists — close the episode quietly.
      this.episodes.delete(cand.key);
      this.journalRow({ kind: 'duplicate-resolved-before-action', key: cand.key });
      return { consumed: true, wrote: false };
    }

    // Intended-owner determination (§3.2.2, evidence-ordered).
    const verdict = await this.intendedOwner(sessionKey, cand, ep);
    this.provenanceRow(cand, verdict);
    if (verdict.kind === 'escalate') {
      this.escalateOnce(ep, cand, verdict.reason, report);
      return { consumed: true, wrote: false };
    }

    // `target-has-live-copy` precondition (§3.2.1): the intended owner must
    // hold a LIVE copy — the reconciler never converges onto a dead target.
    if (!probes.get(verdict.owner)) {
      this.escalateOnce(ep, cand, `intended-owner-${verdict.owner}-has-no-live-copy`, report);
      return { consumed: true, wrote: false };
    }

    ep.convergenceAttempts++;
    if (this.cfg.dryRun) {
      report.wouldConverge++;
      this.counters.wouldConverge++;
      this.journalRow({
        kind: 'would-converge',
        key: cand.key,
        owner: verdict.owner,
        rule: verdict.rule,
        detail: verdict.detail,
        machines: liveMachines.map((m) => m.machineId),
        attempts: ep.convergenceAttempts,
        dryRun: true,
      });
      // Dry-run counts an episode "handled" — reset so the soak journals each
      // tick's fresh verdict without escalating attempt exhaustion.
      this.episodes.delete(cand.key);
      return { consumed: true, wrote: false };
    }

    // ── Already-converged record (the 2026-07-10 incident's OWN shape) ──
    // A bootleg spawn is exactly the un-gated path: it creates a duplicate
    // SESSION without ever touching the ownership RECORD, so the record
    // frequently already names the intended owner. The FSM refuses a claim
    // on an active self-owned record BY DESIGN ("claiming what you already
    // own... would burn an epoch for nothing and masks a reconciler bug"),
    // so a CAS here would land at `claim-out-of-sequence` → escalate — the
    // incident shape would page the operator instead of self-healing.
    // The record needs no repair: go straight to the peer-echo window (the
    // MISSING piece may be replication/materialization on the peer), and the
    // echo-confirmed path arms the existing closeout as usual. No epoch burn.
    const selfView = this.deps
      .readOwnershipViews(sessionKey)
      .find((v) => v.admissible && v.machineId === (this.deps.selfMachineId() ?? 'self'));
    if (selfView && selfView.owner === verdict.owner) {
      this.counters.converged++;
      report.reconciled++;
      this.journalRow({
        kind: 'record-already-converged',
        key: cand.key,
        owner: verdict.owner,
        rule: verdict.rule,
        detail: verdict.detail,
        attempts: ep.convergenceAttempts,
      });
      ep.echoPending = {
        owner: verdict.owner,
        machines: liveMachines.map((m) => m.machineId).filter((m) => m !== verdict.owner),
        ticksLeft: this.cfg.echoConfirmTicks,
      };
      return { consumed: true, wrote: false };
    }

    // ── LIVE convergence ──
    const cas = this.deps.casConverge(sessionKey, verdict.owner);
    if (!cas.ok) {
      // A 409/conflict escalates, never retries blindly (§3.2.2 / FD13).
      this.escalateOnce(ep, cand, `cas-refused: ${cas.reason ?? 'conflict'}`, report);
      return { consumed: true, wrote: true };
    }
    this.counters.converged++;
    report.reconciled++;
    this.journalRow({
      kind: 'converged-record',
      key: cand.key,
      owner: verdict.owner,
      rule: verdict.rule,
      detail: verdict.detail,
      attempts: ep.convergenceAttempts,
    });
    // Peer-echo confirmation window (§3.2.3 item 2).
    ep.echoPending = {
      owner: verdict.owner,
      machines: liveMachines.map((m) => m.machineId).filter((m) => m !== verdict.owner),
      ticksLeft: this.cfg.echoConfirmTicks,
    };
    return { consumed: true, wrote: true };
  }

  /** §3.2.2 — the evidence ladder. */
  private async intendedOwner(
    sessionKey: string,
    cand: DuplicateCandidate,
    ep: DuplicateEpisode,
  ): Promise<IntendedOwnerVerdict> {
    // Rule 3 input first (needed for the rule-2/rule-3 contradiction guard).
    let runs: Array<{ machineId: string; registeredAt: number; confirmed: boolean }> = [];
    try {
      runs = (await this.deps.liveRunHosts(sessionKey)).filter((r) => r.confirmed);
    } catch {
      // @silent-fallback-ok: unreadable run registrations → rule 3 contributes
      // no evidence; with no other evidence the verdict ESCALATES, never guesses.
      runs = [];
    }
    // Both-copies-carry-live-runs → always escalate (§3.2.2).
    if (runs.length >= 2) return { kind: 'escalate', reason: 'both-copies-carry-live-runs' };

    // Rule 1 — hard pin (quarantined never counts).
    const pin = this.deps.readPin(sessionKey);
    if (pin?.pinned && pin.preferredMachine && !pin.quarantined) {
      return { kind: 'owner', owner: pin.preferredMachine, rule: 'hard-pin', detail: 'pin-store hard pin' };
    }

    // Rule 2 — highest ADMISSIBLE epoch; never wall-clock recency.
    const views = this.deps.readOwnershipViews(sessionKey).filter((v) => v.admissible && v.owner);
    let epochWinner: OwnershipViewRow | null = null;
    let tie = false;
    for (const v of views) {
      if (!epochWinner || v.epoch > epochWinner.epoch) {
        epochWinner = v;
        tie = false;
      } else if (v.epoch === epochWinner.epoch && v.owner !== epochWinner.owner) {
        tie = true;
      }
    }
    if (epochWinner && !tie) {
      // Rule-2/rule-3 contradiction guard: epoch winner vs live-run host.
      if (runs.length === 1 && runs[0].machineId !== epochWinner.owner) {
        return {
          kind: 'escalate',
          reason: `rule2-rule3-contradiction: epoch names ${epochWinner.owner}, live run on ${runs[0].machineId}`,
        };
      }
      return {
        kind: 'owner',
        owner: epochWinner.owner as string,
        rule: 'highest-epoch',
        detail: `admissible epoch ${epochWinner.epoch} (view of ${epochWinner.machineId})`,
      };
    }

    // Rule 3 — a single confirmed live run, with PRE-EPISODE registration
    // (evidence minted after the bootleg spawn never corroborates — §3.4 floor).
    if (runs.length === 1) {
      const r = runs[0];
      if (r.registeredAt < ep.openedAt || !ep.openBackdated) {
        return {
          kind: 'owner',
          owner: r.machineId,
          rule: 'live-run',
          detail: `server-registered live run (registered ${new Date(r.registeredAt).toISOString()})`,
        };
      }
      return { kind: 'escalate', reason: 'live-run-registered-after-episode-open (post-spawn evidence)' };
    }

    // Rule 4 — J2 arrives in Increment 3; the deterministic default IS escalate.
    return { kind: 'escalate', reason: tie ? 'symmetric-divergence-equal-epochs' : 'no-admissible-evidence' };
  }

  private async checkPendingEchoes(report: ReconcilerTickReport): Promise<void> {
    const timedOut: Array<{ key: string; owner: string; machines: string[] }> = [];
    for (const [key, ep] of this.episodes) {
      if (!ep.echoPending) continue;
      const pending: string[] = [];
      for (const m of ep.echoPending.machines) {
        let echoed = false;
        try {
          echoed = await this.deps.peerEchoObserved(key.includes(':') ? key.split(':').slice(1).join(':') : key, ep.echoPending.owner, m);
        } catch {
          echoed = false;
        }
        if (!echoed) pending.push(m);
      }
      if (pending.length === 0) {
        this.counters.echoConfirmed++;
        report.echoConfirmed++;
        this.journalRow({ kind: 'echo-confirmed', key, owner: ep.echoPending.owner });
        // Convergence observed everywhere → the existing closeout owns the close.
        if (!this.cfg.dryRun) this.deps.armCloseout(key.includes(':') ? key.split(':').slice(1).join(':') : key, ep.echoPending.owner);
        this.episodes.delete(key);
        continue;
      }
      ep.echoPending.machines = pending;
      ep.echoPending.ticksLeft--;
      if (ep.echoPending.ticksLeft <= 0) {
        this.counters.echoTimeouts++;
        report.echoTimeouts++;
        // Echoed-but-unhealed counts toward the breaker (§3.2.3 item 2 backstop).
        this.bumpBreaker(key, this.nowFn());
        timedOut.push({ key, owner: ep.echoPending.owner, machines: pending });
        ep.echoPending = null;
      }
    }
    // Per-tick aggregation (P17): ALL convergence-not-observed escalations in
    // one tick fold into ONE attention item enumerating topics.
    if (timedOut.length > 0) {
      report.escalations++;
      this.counters.escalations++;
      this.deps.raiseAttention({
        id: `dup-reconciler-echo:${new Date(this.nowFn()).toISOString().slice(0, 13)}`,
        title: `Convergence not observed on ${timedOut.length} conversation(s)`,
        body:
          'I repaired the ownership record for these conversations but the other machine(s) never showed the repair in their own view:\n' +
          timedOut.map((t) => `• ${t.key} → ${t.owner} (unconfirmed: ${t.machines.join(', ')})`).join('\n') +
          '\nDetails: logs/duplicate-reconciler.jsonl.',
        priority: 'high',
      });
      for (const t of timedOut) {
        this.journalRow({ kind: 'convergence-not-observed', key: t.key, owner: t.owner, unconfirmed: t.machines });
      }
    }
  }

  private openOrGetEpisode(key: string, now: number): DuplicateEpisode {
    let ep = this.episodes.get(key);
    if (ep) return ep;
    // §3 glossary: episode-open = the contested copy's spawn-registration ts,
    // BACKDATED at detection. The wiring supplies detection-time here; the
    // backdating refinement rides the spawn-registration read where available.
    ep = { key, openedAt: now, openBackdated: false, convergenceAttempts: 0, echoPending: null, escalated: false };
    this.episodes.set(key, ep);
    this.bumpBreaker(key, now);
    this.journalRow({ kind: 'duplicate-episode-opened', key, openedAt: new Date(now).toISOString() });
    return ep;
  }

  /** Record a topic-moved (transfer-traceable) episode — excluded from the clamp. */
  noteTransferTraceable(key: string): void {
    const now = this.nowFn();
    const arr = (this.transferTraceable.get(key) ?? []).filter((t) => now - t < this.cfg.breakerWindowMs);
    arr.push(now);
    this.transferTraceable.set(key, arr);
    // ≥3 transfer-traceable episodes per topic per window → ONE observability-only item.
    if (arr.length === 3) {
      this.deps.raiseAttention({
        id: `dup-reconciler-transfer-flap:${key}`,
        title: `Conversation ${key} moved machines ${arr.length} times in 24h`,
        body: 'An automated mover is flapping this conversation between machines (moves are exempt from the duplicate breaker, but this volume is worth a look).',
        priority: 'medium',
      });
    }
  }

  private bumpBreaker(key: string, now: number): void {
    const arr = (this.breakerEpisodes.get(key) ?? []).filter((t) => now - t < this.cfg.breakerWindowMs);
    arr.push(now);
    this.breakerEpisodes.set(key, arr);
    // TTL prune of idle topics rides the filter above; drop empty entries lazily.
    if (arr.length === this.cfg.breakerThreshold) {
      // Breaker just tripped: ONE item; the ladder clamp is read via breakerClamped().
      this.deps.raiseAttention({
        id: `dup-reconciler-breaker:${key}`,
        title: `Conversation ${key} keeps re-duplicating — auto-reconcile stopped`,
        body:
          `This conversation duplicated ${arr.length} times inside the window. I've stopped auto-converging it (and clamped its owner-dark ladder to the notice floor) — something is re-creating the duplicate. Details: logs/duplicate-reconciler.jsonl.`,
        priority: 'high',
      });
      this.journalRow({ kind: 'breaker-tripped', key, episodes: arr.length });
    }
  }

  /** §3.2.5 — also consulted by the owner-dark ladder (clamp to rung 3). */
  breakerClamped(key: string, now?: number): boolean {
    const t = now ?? this.nowFn();
    const transferTraceable = (this.transferTraceable.get(key) ?? []).filter((x) => t - x < this.cfg.breakerWindowMs);
    const arr = (this.breakerEpisodes.get(key) ?? []).filter((x) => t - x < this.cfg.breakerWindowMs);
    // Transfer-traceable episodes do not clamp (§3.2.5).
    const effective = arr.length - transferTraceable.length;
    return effective >= this.cfg.breakerThreshold;
  }

  private escalateOnce(ep: DuplicateEpisode, cand: DuplicateCandidate, reason: string, report: ReconcilerTickReport): void {
    if (ep.escalated) return;
    ep.escalated = true;
    report.escalations++;
    this.counters.escalations++;
    // Fixed template + metadata (§3.4) — never free text from tails/arbiters.
    this.deps.raiseAttention({
      id: `dup-reconciler-escalate:${cand.key}`,
      title: `Duplicate conversation needs your call: ${cand.key}`,
      body:
        `The same conversation is live on ${cand.machines.length} machines (${cand.machines.map((m) => m.machineId).join(', ')}) ` +
        `and I can't safely converge it automatically (reason: ${reason}). ` +
        `Close the copy you don't want from the dashboard, or move the topic explicitly. Details: logs/duplicate-reconciler.jsonl.`,
      priority: 'high',
    });
    this.journalRow({ kind: 'escalated', key: cand.key, reason });
  }

  private journalRow(row: Record<string, unknown>): void {
    this.deps.journal.append({ ts: new Date(this.nowFn()).toISOString(), ...row });
  }

  private provenanceRow(cand: DuplicateCandidate, verdict: IntendedOwnerVerdict): void {
    if (!this.deps.provenance) return;
    try {
      this.deps.provenance({
        component: 'DuplicateSessionReconciler',
        decisionPoint: 'which-duplicate-survives',
        context: {
          key: cand.key,
          machines: cand.machines.map((m) => m.machineId),
          dryRun: this.cfg.dryRun,
        },
        optionsPresented: ['owner-copy-survives', 'escalate-to-attention'],
        decision: verdict.kind === 'owner' ? `owner:${verdict.owner} (${verdict.rule})` : `escalate:${verdict.reason}`,
        reason: verdict.kind === 'owner' ? verdict.detail : verdict.reason,
        floor: 'evidence-ladder pin→epoch→live-run→escalate (§3.2.2); J2 shadow arrives Increment 3',
        fallbackRung: 'deterministic',
      });
    } catch {
      /* @silent-fallback-ok: provenance is observability. */
    }
  }

  status(): ReconcilerStatus {
    const now = this.nowFn();
    return {
      enabled: this.cfg.enabled,
      dryRun: this.cfg.dryRun,
      substrate: this.deps.substrateReady(),
      lastTick: this.lastTick,
      openEpisodes: this.episodes.size,
      breaker: [...this.breakerEpisodes.entries()]
        .map(([key, arr]) => ({
          key,
          episodes: arr.filter((t) => now - t < this.cfg.breakerWindowMs).length,
          clamped: this.breakerClamped(key, now),
        }))
        .filter((b) => b.episodes > 0),
      counters: { ...this.counters },
      config: {
        reconcilerTickMs: this.cfg.reconcilerTickMs,
        maxReconcilesPerTick: this.cfg.maxReconcilesPerTick,
        maxConvergenceWritesPerTick: this.cfg.maxConvergenceWritesPerTick,
        echoConfirmTicks: this.cfg.echoConfirmTicks,
        breakerThreshold: this.cfg.breakerThreshold,
        breakerWindowMs: this.cfg.breakerWindowMs,
      },
    };
  }
}
