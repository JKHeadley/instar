/**
 * QueueDrainLoop — the policy engine over PendingInboundStore (Durable Inbound
 * Message Queue spec §2–§4, §6). Owns:
 *
 *  - the live ENQUEUE side (the router's `queueMessage` dep target): lease-
 *    gated, dry-run-aware, negative-cached, mirror-maintained custody taking;
 *  - the DRAIN side: head-only selection, hold verdicts, claims, dispatch via
 *    the injected `dispatchInbound` seam with the §3.4 receipt handover
 *    contract, disposition mapping, per-entry error isolation, backoff,
 *    maxAttempts forced re-place;
 *  - the backstop tick (Eternal Sentinel, declared §3.2) + event triggers;
 *  - operator halt (§3.6): stop transitions custody + PIS cleanup; pause
 *    freezes queued rows only (cumulative cap);
 *  - clock discipline (§6): sleep-shift on wake, nap clamp.
 *
 * Everything is injected — no timers or I/O of its own beyond the store — so
 * the policy is deterministic and unit-testable. The server wires the real
 * dispatch tail, breaker, registry, and reporting.
 *
 * P19 declaration — Eternal Sentinel (spec §3.2): the backstop tick never
 * gives up, by design. Conditions: (1) declared here; (2) critical-healer role
 * — it is the only thing that drains custody; (3) rate floor = drainTickMs
 * with constant per-tick cost (bounded scans over ≤hardMaxTotal rows);
 * (4) observable — tick failures are episode-latched: one log per episode,
 * one degradation signal after 10 min sustained, recovery logged once.
 */

import type {
  PendingInboundStore,
  PendingInboundRow,
  SenderEnvelope,
  EnqueueOutcome,
} from './PendingInboundStore.js';
import { sanitizeError } from './PendingInboundStore.js';
import type { InboundQueueConfig, HoldForStabilityConfig } from './inboundQueueConfig.js';

// ── Dispatch seam contract (§3.1/§3.4) ────────────────────────────────

export interface DrainMessage {
  sessionKey: string;
  messageId: string;
  payload: string;
  senderEnvelope: SenderEnvelope | null;
  topicMetadata: unknown;
  enqueueSeq: number;
}

/**
 * The ownership-handover contract handed to the dispatch tail. The tail MUST
 * call `commitReceipt()` at the handover point (before the PIS record on the
 * spawn path / before a direct inject) and honor a false return by ABORTING
 * the inject (the §3.6 transactional stop fence fired). After the receipt, it
 * MUST consult `stopRecheck()` immediately before the inject (the round-7
 * receipt→inject gap close) — true means stopped: skip the inject.
 */
export interface DrainHandover {
  commitReceipt(): boolean;
  stopRecheck(): boolean;
}

export type DrainDispatchResult =
  /** forwarded | duplicate | remote spawned | remote owner-dead-replaced. */
  | { kind: 'remote-delivered' }
  /** Local tail completed through the receipt; `injectError` carries a caught
   *  inject failure AFTER the receipt (→ delivered_unconfirmed, §3.4). */
  | { kind: 'local-delivered'; injectError?: string }
  /** commitReceipt() returned false — a stop transitioned the row mid-flight. */
  | { kind: 'handover-refused' }
  /** stopRecheck() fired after the receipt — inject skipped (orphaned receipt
   *  is the named-safe shape; the row already reads operator-stop). */
  | { kind: 'stopped-before-inject' }
  /** queued | placement-blocked | spawn-in-progress skip → release+backoff. */
  | { kind: 'un-routable'; reason: string }
  /** Typed NACK from a peer that re-validated the sender (§3.4 remote). */
  | { kind: 'sender-rejected' }
  | { kind: 'failed'; error: unknown };

// ── Deps ──────────────────────────────────────────────────────────────

export type HoldVerdict = 'hold' | 'failover' | 'deliver';

export interface LossItem {
  sessionKey: string;
  messageId: string;
  enqueuedAt: string;
  reason: string;
  senderDisplay?: string | null;
}

export interface QueueDrainLoopDeps {
  store: PendingInboundStore;
  qcfg: InboundQueueConfig;
  hcfg: HoldForStabilityConfig;
  selfMachineId: string;
  holdsLease(): boolean;
  /** Handoff-in-progress flips the enqueue gate to refused (§3.5 ordered handoff). */
  handoffInProgress?(): boolean;
  /** Per-topic operator-stop state (§3.6) — stop-scoped, never pause. */
  isStopped(sessionKey: string): boolean;
  /** The §3.1 dispatch seam (via:'drain'). Bounded by dispatchDeadlineMs here. */
  dispatchInbound(msg: DrainMessage, handover: DrainHandover): Promise<DrainDispatchResult>;
  /** maxAttempts escape hatch — ONE forced re-place bypassing hold/deliver
   *  verdicts (§3.3). Resolves true when the re-place succeeded, false on a
   *  non-terminal failure (→ attempts-exhausted), or the DISTINCT `'rejected'`
   *  verdict when the re-place hit a first-class sender refusal (silent-loss-
   *  refusal-conservation §2.A — mapped to the SAME sender-deauthorized terminal
   *  + unified notice, NOT mislabeled attempts-exhausted). */
  forceReplace(msg: DrainMessage): Promise<boolean | 'rejected'>;
  /** §4 hold verdict — required; the server injects always-'failover' when the
   *  policy is off (§4.2). Pure in-memory (breaker + capacity registry). */
  holdVerdict(sessionKey: string): HoldVerdict;
  /** Stop cleanup (§3.6/§3.4): delete the PIS record for a stopped session. */
  clearPisRecord(sessionKey: string): void;
  /** Loss reporting — the dep aggregates into ONE attention item per episode
   *  (§1 copy rules). Never receives payload bytes. */
  reportLoss(items: LossItem[], reason: string): void;
  /** "Possibly not injected — resend if unanswered" (§3.4/§5 windows 4+6). */
  reportPossiblyNotInjected(items: LossItem[]): void;
  log(line: string): void;
  reportDegradation(reason: string): void;
  now(): number;
  /** Monotonic ms (within-boot deadlines, §6). */
  mono(): number;
  bootSessionId: string;
}

export interface DrainPassSummary {
  trigger: string;
  dispatched: number;
  delivered: number;
  unroutable: number;
  failed: number;
  skippedHeld: number;
  skippedStopped: number;
  staleCustodyExpired: number;
  deadlineHit: boolean;
}

// ── Engine ────────────────────────────────────────────────────────────

export class QueueDrainLoop {
  private readonly d: QueueDrainLoopDeps;
  /** In-memory session-count mirror (§2.3) — same-code-path updates at every
   *  transition site, boot-rebuilt, read-through on zero. */
  private mirror = new Map<string, { count: number; minSeq: number }>();
  /** Held-set cache (§3.2) — seqs currently excluded from selection. The
   *  first_held_at COLUMN is authoritative; this is a boot-rebuilt cache. */
  private heldSeqs = new Set<number>();
  /** Refusal negative cache keyed on the canonical id (§1). */
  private refusalCache = new Map<string, number>();
  /** Single-flight + rerun (§3.2). */
  private passInFlight = false;
  private rerunRequested: string | null = null;
  private lastPassEndedMono = -Infinity;
  /** Eternal-Sentinel episode latch (§3.2). */
  private tickFailureSinceMono: number | null = null;
  private tickFailureLogged = false;
  private tickDegradationSent = false;
  private holdRecheckLastMono = -Infinity;
  private tickCount = 0;
  /** Current tenure id — refreshed by observeLeaseClaim at lease acquisition. */
  private tenure: string | null = null;

  constructor(deps: QueueDrainLoopDeps) {
    this.d = deps;
    this.rebuildCaches();
    this.tenure = deps.store.currentTenure(deps.selfMachineId);
  }

  // ── Boot-rebuilt caches ─────────────────────────────────────────────

  private rebuildCaches(): void {
    this.mirror.clear();
    for (const r of this.d.store.sessionCounts()) {
      this.mirror.set(r.session_key, { count: r.count, minSeq: r.min_seq });
    }
    this.heldSeqs.clear();
    const nowMs = this.d.now();
    for (const row of this.d.store.listHeldRows()) {
      // Within budget → still held; past budget → release-eligible (the
      // recheck will pick it up immediately).
      const heldAt = Date.parse(row.first_held_at as string);
      if (Number.isFinite(heldAt) && nowMs - heldAt <= this.d.hcfg.holdMaxMs) {
        this.heldSeqs.add(row.enqueue_seq);
      }
    }
  }

  // ── Tenure (§3.5) ───────────────────────────────────────────────────

  /** Call at every lease ACQUISITION (not renewal) with the ref-tip holder
   *  observed at claim time. */
  onLeaseAcquired(tipHolderAtClaim: string | null): void {
    this.tenure = this.d.store.observeLeaseClaim(this.d.selfMachineId, tipHolderAtClaim);
  }

  currentTenure(): string | null {
    return this.tenure;
  }

  // ── Live enqueue (the router queueMessage dep target, §2.2) ─────────

  /**
   * Take custody. Returns the tri-state outcome; the router maps
   * `queued`/`already-queued` → acked:true, `refused` → today's fall-through.
   * NEVER throws — a storage failure maps to `refused` (fail-safe direction).
   * This is the caller's LAST fallible step before its outcome return
   * (no-throw-after-commit invariant).
   */
  enqueueLive(msg: {
    sessionKey: string;
    messageId: string;
    payload: string;
    senderEnvelope?: SenderEnvelope | null;
    topicMetadata?: unknown;
  }, reason: string): EnqueueOutcome {
    const q = this.d.qcfg;
    // Dry-run: never claims custody, never short-circuits (§2.4) — durable
    // counters are the evidence.
    if (q.dryRun) {
      try {
        this.d.store.incrementCounter('wouldEnqueue');
        if (this.d.holdVerdict(msg.sessionKey) === 'hold') this.d.store.incrementCounter('wouldHold');
      } catch {
        try { this.d.store.incrementCounter('dryRunErrors'); } catch { /* counted best-effort */ }
      }
      return { result: 'refused', reason: 'dry-run' };
    }
    // Lease gate (§2.2): custody only where it can be drained.
    if (!this.d.holdsLease()) return { result: 'refused', reason: 'not-lease-holder' };
    // Ordered handoff step 1 (§3.5): handoff-in-progress refuses new custody.
    if (this.d.handoffInProgress?.()) return { result: 'refused', reason: 'handoff-in-progress' };

    // Refusal negative cache (§1) — canonical-id keyed.
    const cacheKey = `${msg.sessionKey} ${msg.messageId}`;
    const cachedUntil = this.refusalCache.get(cacheKey);
    const nowMs = this.d.now();
    if (cachedUntil !== undefined && cachedUntil > nowMs) {
      return { result: 'refused', reason: 'negative-cache' };
    }

    // MUST 2 (no-throw-after-commit) is STRUCTURAL here (second-pass concern):
    // the refusal-mapping try covers ONLY the store commit — a throw from any
    // post-commit step (mirror, eviction loss report) can no longer convert a
    // COMMITTED enqueue into a 'refused' return (which would have meant
    // fall-through local dispatch PLUS drain delivery later — an unenumerated
    // duplicate).
    let out: EnqueueOutcome;
    try {
      out = this.d.store.enqueue(
        {
          sessionKey: msg.sessionKey,
          messageId: msg.messageId,
          payload: msg.payload,
          senderEnvelope: msg.senderEnvelope ?? null,
          topicMetadata: msg.topicMetadata,
          reason,
          tenure: this.tenure,
          nowIso: new Date(nowMs).toISOString(),
          monoMs: this.d.mono(),
          bootSessionId: this.d.bootSessionId,
          frozenAtEnqueue: this.d.store.isPaused(),
        },
        {
          maxPerSession: q.maxPerSession,
          maxTotal: q.maxTotal,
          hardMaxTotal: q.hardMaxTotal,
          maxPayloadBytes: q.maxPayloadBytes,
        },
      );
    } catch (err) {
      // ENOSPC / storage failure → refused → fall-through (§1 round-5).
      this.d.log(`[inbound-queue] enqueue failed (refused → fall-through): ${sanitizeError(err)}`);
      this.d.reportDegradation(`enqueue-storage-failure: ${sanitizeError(err)}`);
      return { result: 'refused', reason: 'storage-failure' };
    }
    try {
      if (out.result === 'queued') {
        this.mirrorAdd(msg.sessionKey, out.seq);
        if (out.evicted) {
          this.mirrorRemove(out.evicted.sessionKey);
          this.d.reportLoss(
            [{ sessionKey: out.evicted.sessionKey, messageId: out.evicted.messageId, enqueuedAt: out.evicted.enqueuedAt, reason: 'overflow-evicted', senderDisplay: out.evicted.senderDisplay }],
            'dropped-overflow',
          );
        }
      } else if (out.result === 'refused') {
        this.refusalCache.set(cacheKey, nowMs + q.refusalNegativeCacheMs);
        this.pruneRefusalCache(nowMs);
        // A refusal for a session WITH queued entries is ordering-affecting (§1).
        if (this.hasQueued(msg.sessionKey)) {
          this.d.store.incrementCounter('orderingViolations');
        }
        this.d.store.incrementCounter('wouldRefuse');
      }
    } catch (err) {
      // Post-commit bookkeeping must never change the custody outcome.
      this.d.log(`[inbound-queue] post-enqueue bookkeeping failed (outcome unchanged): ${sanitizeError(err)}`);
    }
    return out;
  }

  private pruneRefusalCache(nowMs: number): void {
    if (this.refusalCache.size < 1024) return;
    for (const [k, until] of this.refusalCache) {
      if (until <= nowMs) this.refusalCache.delete(k);
    }
  }

  // ── Ordering gate (§2.3) ────────────────────────────────────────────

  /** Mirror with read-through-on-zero (the round-2 honest-consistency contract). */
  hasQueued(sessionKey: string): boolean {
    const m = this.mirror.get(sessionKey);
    if (m && m.count > 0) return true;
    // Read-through to SQLite whenever the mirror reads zero for a gated session.
    try {
      const counts = this.d.store.sessionCounts().find((c) => c.session_key === sessionKey);
      if (counts && counts.count > 0) {
        this.mirror.set(sessionKey, { count: counts.count, minSeq: counts.min_seq });
        return true;
      }
    } catch {
      // Read error → honest false; the route-throw point read (NOT the mirror)
      // guards the custody-aware fall-through (§2.2).
    }
    return false;
  }

  /** §2.2 route-throw custody check — point read, never the mirror. Throws
   *  propagate so the caller can fail OPEN to fall-through. */
  hasCommittedRow(sessionKey: string, messageId: string): boolean {
    return this.d.store.hasNonTerminalRow(sessionKey, messageId);
  }

  private mirrorAdd(sessionKey: string, seq: number): void {
    const m = this.mirror.get(sessionKey);
    if (!m) this.mirror.set(sessionKey, { count: 1, minSeq: seq });
    else this.mirror.set(sessionKey, { count: m.count + 1, minSeq: Math.min(m.minSeq, seq) });
  }

  private mirrorRemove(sessionKey: string): void {
    const m = this.mirror.get(sessionKey);
    if (!m) return;
    if (m.count <= 1) this.mirror.delete(sessionKey);
    else this.mirror.set(sessionKey, { count: m.count - 1, minSeq: m.minSeq });
  }

  // ── Backstop tick (Eternal Sentinel, §3.2) ──────────────────────────

  /** One tick — the server schedules this every drainTickMs. Never throws. */
  async tick(): Promise<void> {
    this.tickCount += 1;
    try {
      const nowMs = this.d.now();
      const nowIso = new Date(nowMs).toISOString();
      // TTL expiry (frozen rows excluded by the store query).
      this.expireWithClamps(nowMs);
      // Terminal-row + receipt pruning (report-then-prune for unflipped).
      const cutoff = new Date(nowMs - this.d.qcfg.deliveredRetentionMs).toISOString();
      this.d.store.pruneTerminal(cutoff);
      const prunable = this.d.store.listPrunableReceipts(cutoff);
      if (prunable.needsReport.length > 0) {
        this.d.reportPossiblyNotInjected(
          prunable.needsReport.map((r) => ({ sessionKey: r.session_key, messageId: r.message_id, enqueuedAt: r.created_at, reason: 'receipt-never-injected (prune backstop)' })),
        );
        for (const r of prunable.needsReport) this.d.store.markReceiptReported(r.session_key, r.message_id, r.class);
      }
      this.d.store.confirmPruneReceipts(cutoff);
      // Mirror reconciliation every 4th tick (§2.3 pinned).
      if (this.tickCount % 4 === 0) this.reconcileMirror();
      // Hold recheck (its own cadence inside the tick).
      if (this.d.mono() - this.holdRecheckLastMono >= this.d.hcfg.holdRecheckMs) {
        this.holdRecheckLastMono = this.d.mono();
        this.recheckHolds(nowMs, nowIso);
      }
      // Drain pass.
      await this.runDrainPass('tick');
      // Episode recovery (§3.2 observability).
      if (this.tickFailureSinceMono !== null) {
        this.d.log('[inbound-queue] tick recovered');
        this.tickFailureSinceMono = null;
        this.tickFailureLogged = false;
        this.tickDegradationSent = false;
      }
    } catch (err) {
      // @silent-fallback-ok — NOT silent: episode-latched (one log per episode,
      // one DegradationReporter signal via reportDegradation after 10 min
      // sustained, recovery logged once) — the §3.2 Eternal-Sentinel contract.
      const mono = this.d.mono();
      if (this.tickFailureSinceMono === null) this.tickFailureSinceMono = mono;
      if (!this.tickFailureLogged) {
        this.d.log(`[inbound-queue] tick failed (episode start): ${sanitizeError(err)}`);
        this.tickFailureLogged = true;
      }
      if (!this.tickDegradationSent && mono - this.tickFailureSinceMono >= 10 * 60_000) {
        this.d.reportDegradation(`inbound-queue tick failing for 10min: ${sanitizeError(err)}`);
        this.tickDegradationSent = true;
      }
    }
  }

  private reconcileMirror(): void {
    const truth = new Map(this.d.store.sessionCounts().map((c) => [c.session_key, c] as const));
    let drift = 0;
    for (const [sk, m] of this.mirror) {
      const t = truth.get(sk);
      if (!t || t.count !== m.count || t.min_seq !== m.minSeq) drift += 1;
    }
    for (const sk of truth.keys()) {
      if (!this.mirror.has(sk)) drift += 1;
    }
    if (drift > 0) {
      this.d.log(`[inbound-queue] mirror drift corrected (${drift} sessions)`);
      this.d.store.incrementCounter('mirrorDrift', drift);
      this.mirror = new Map([...truth].map(([sk, c]) => [sk, { count: c.count, minSeq: c.min_seq }]));
    }
  }

  /** TTL + stale-custody/nap clamps (§3.5/§6). */
  private expireWithClamps(nowMs: number): void {
    const nowIso = new Date(nowMs).toISOString();
    const q = this.d.qcfg;
    const expired: LossItem[] = [];
    for (const row of this.d.store.listTtlExpired(nowIso, q.entryTtlMs)) {
      if (this.d.store.transition(row.enqueue_seq, 'queued', 'expired', { nowIso, terminalReason: 'ttl-expired' })) {
        this.mirrorRemove(row.session_key);
        this.heldSeqs.delete(row.enqueue_seq);
        expired.push(this.lossItem(row, 'ttl-expired'));
      }
    }
    if (expired.length > 0) this.d.reportLoss(expired, 'ttl-expired');
  }

  // ── Hold recheck (§3.2/§4.3) ────────────────────────────────────────

  private recheckHolds(nowMs: number, nowIso: string): void {
    const releaseBudget = this.d.qcfg.maxFailoverReleasesPerTick;
    let released = 0;
    let overBudgetHolds = 0;
    // Oldest-first (insertion order of the set follows seq order closely;
    // sort explicitly for correctness).
    const seqs = [...this.heldSeqs].sort((a, b) => a - b);
    for (const seq of seqs) {
      const row = this.d.store.getRow(seq);
      if (!row || row.state !== 'queued') {
        this.heldSeqs.delete(seq);
        continue;
      }
      // §4.3: per-entry cumulative budget — first_held_at vs holdMaxMs,
      // regardless of episode age. Frozen rows wait for resume.
      if (row.frozen_since) continue;
      const heldAt = Date.parse(row.first_held_at ?? nowIso);
      const overBudget = nowMs - heldAt > this.d.hcfg.holdMaxMs;
      // Re-evaluate the verdict — a recovered owner releases instantly via the
      // breaker-close trigger, but the recheck also notices.
      const verdict = this.d.holdVerdict(row.session_key);
      if (!overBudget && verdict === 'hold') continue; // still held
      // Release. Budget-expired releases imply re-placement → herd cap (§3.2).
      if (overBudget) {
        if (released >= releaseBudget) {
          overBudgetHolds += 1; // stays held, reason budget-overrun, counted
          continue;
        }
        released += 1;
        this.d.store.incrementCounter('holdsReleasedToFailover:budget-exhausted');
      } else {
        // Verdict changed (recovered / flap-forced failover) — recovery
        // deliveries are uncapped (§3.2: they spawn nothing... the rationale
        // is imprecise for restart-recovered owners, round-7 — the bound is
        // drainConcurrency + the peer's spawn-in-progress backpressure).
        this.d.store.incrementCounter(verdict === 'failover' ? 'holdsReleasedToFailover:flap-forced' : 'holdsRecoveredInPlace');
      }
      this.heldSeqs.delete(seq);
      this.d.store.resetNextAttempt(row.session_key);
    }
    if (overBudgetHolds > 0) this.d.store.incrementCounter('budgetOverrunHolds', overBudgetHolds);
  }

  // ── Event triggers (§3.2) ───────────────────────────────────────────

  /** Ownership transition for a session with entries (emitPlacement seam).
   *  Returns the pass promise so callers MAY await (tests do; the server
   *  fire-and-forgets). */
  onOwnershipTransition(sessionKey: string): Promise<DrainPassSummary | null> {
    if (!this.hasQueued(sessionKey)) return Promise.resolve(null);
    this.d.store.resetNextAttempt(sessionKey);
    return this.runDrainPass('ownership-transition');
  }

  /** Breaker close — held rows for the recovered owner deliver instantly. */
  onBreakerClose(): Promise<DrainPassSummary | null> {
    for (const seq of [...this.heldSeqs]) {
      const row = this.d.store.getRow(seq);
      if (!row || row.state !== 'queued' || row.frozen_since) continue;
      if (this.d.holdVerdict(row.session_key) !== 'hold') {
        this.heldSeqs.delete(seq);
        this.d.store.incrementCounter('holdsRecoveredInPlace');
        this.d.store.resetNextAttempt(row.session_key);
      }
    }
    return this.runDrainPass('breaker-close');
  }

  onMachineOnline(): Promise<DrainPassSummary | null> {
    return this.runDrainPass('machine-online');
  }

  // ── Drain pass (§3.2) ───────────────────────────────────────────────

  async runDrainPass(trigger: string): Promise<DrainPassSummary | null> {
    if (this.passInFlight) {
      this.rerunRequested = trigger;
      return null;
    }
    if (this.d.mono() - this.lastPassEndedMono < this.d.qcfg.minInterPassMs) {
      this.rerunRequested = trigger;
      return null;
    }
    this.passInFlight = true;
    const summary: DrainPassSummary = {
      trigger, dispatched: 0, delivered: 0, unroutable: 0, failed: 0,
      skippedHeld: 0, skippedStopped: 0, staleCustodyExpired: 0, deadlineHit: false,
    };
    try {
      const passStartMono = this.d.mono();
      // Batches until no eligible rows or the pass deadline.
      for (;;) {
        // Per pass AND per batch: lease + pause consults (§3.5/§3.6).
        if (!this.d.holdsLease()) break;
        if (this.d.store.isPaused()) break;
        if (this.d.mono() - passStartMono > this.d.qcfg.passDeadlineMs) {
          summary.deadlineHit = true;
          break;
        }
        const heads = this.d.store
          .selectEligibleHeads(new Date(this.d.now()).toISOString(), this.d.qcfg.drainBatchSize)
          .filter((row) => {
            if (this.heldSeqs.has(row.enqueue_seq)) { summary.skippedHeld += 1; return false; }
            return true;
          });
        if (heads.length === 0) break;

        // Hold verdicts BEFORE claiming (§3.2, pure in-memory).
        const dispatchable: PendingInboundRow[] = [];
        for (const row of heads) {
          if (this.d.isStopped(row.session_key)) {
            summary.skippedStopped += 1;
            this.onOperatorStop(row.session_key); // settle custody now
            continue;
          }
          const verdict = this.d.holdVerdict(row.session_key);
          // §4.3 per-entry cumulative budget: an entry past holdMaxMs since its
          // FIRST hold is failover regardless of verdict/episode — a released
          // row must never be re-held into TTL loss.
          const overHoldBudget =
            row.first_held_at !== null &&
            this.d.now() - Date.parse(row.first_held_at) > this.d.hcfg.holdMaxMs;
          if (verdict === 'hold' && !overHoldBudget && row.attempts < this.d.qcfg.maxAttempts) {
            // maxHeldTotal scope guard (§4.6): a hold that would exceed the cap
            // degrades to failover (counted) — never drop, never local-inject.
            if (this.heldSeqs.size >= this.d.qcfg.maxHeldTotal) {
              this.d.store.incrementCounter('holdsReleasedToFailover:maxHeldTotal-refused');
              dispatchable.push(row);
              continue;
            }
            this.d.store.markHeld(row.enqueue_seq, new Date(this.d.now()).toISOString());
            this.heldSeqs.add(row.enqueue_seq);
            this.d.store.incrementCounter('holdsStarted');
            summary.skippedHeld += 1;
            continue;
          }
          dispatchable.push(row);
        }
        if (dispatchable.length === 0) continue;

        // Dispatch with bounded cross-session concurrency.
        const conc = Math.max(1, this.d.qcfg.drainConcurrency);
        for (let i = 0; i < dispatchable.length; i += conc) {
          const slice = dispatchable.slice(i, i + conc);
          await Promise.all(slice.map((row) => this.dispatchOne(row, summary)));
          if (this.d.mono() - passStartMono > this.d.qcfg.passDeadlineMs) {
            summary.deadlineHit = true;
            break;
          }
        }
        if (summary.deadlineHit) break;
      }
      return summary;
    } finally {
      // Abnormal pass releases the single-flight guard (§3.3).
      this.passInFlight = false;
      this.lastPassEndedMono = this.d.mono();
      const rerun = this.rerunRequested;
      this.rerunRequested = null;
      if (rerun) {
        // Scheduled by the next tick; an immediate recursive pass could starve
        // the event loop — minInterPassMs paces it.
        this.d.log(`[inbound-queue] rerun requested (${rerun}) — next tick`);
      }
    }
  }

  private lossItem(row: PendingInboundRow, reason: string): LossItem {
    return {
      sessionKey: row.session_key,
      messageId: row.message_id,
      enqueuedAt: row.enqueued_at,
      reason,
      senderDisplay: row.sender_display,
    };
  }

  private async dispatchOne(row: PendingInboundRow, summary: DrainPassSummary): Promise<void> {
    const nowMs = this.d.now();
    const nowIso = new Date(nowMs).toISOString();
    const q = this.d.qcfg;

    // Tenure clamp (§3.5): an entry dispatched under a DIFFERENT tenure takes
    // the staleCustodyTtlMs clamp. Same clamp post-reboot (boot_session_id
    // mismatch — monotonic deadlines unreconstructable, wall governs, §6).
    const crossTenure = row.lease_epoch !== this.tenure;
    const crossBoot = row.boot_session_id !== this.d.bootSessionId;
    if (crossTenure || crossBoot) {
      const age = nowMs - Date.parse(row.enqueued_at) - row.total_frozen_ms;
      if (age > q.staleCustodyTtlMs) {
        if (this.d.store.transition(row.enqueue_seq, 'queued', 'expired', { nowIso, terminalReason: crossTenure ? 'stale-custody-tenure' : 'stale-custody-reboot' })) {
          this.mirrorRemove(row.session_key);
          summary.staleCustodyExpired += 1;
          this.d.reportLoss([this.lossItem(row, 'stale-custody')], 'stale-custody');
        }
        return;
      }
    }

    // Poison check (§3.3): unparseable metadata/envelope → terminal poisoned.
    let senderEnvelope: SenderEnvelope | null = null;
    let topicMetadata: unknown = undefined;
    try {
      senderEnvelope = row.sender_envelope ? (JSON.parse(row.sender_envelope) as SenderEnvelope) : null;
      topicMetadata = row.topic_metadata ? JSON.parse(row.topic_metadata) : undefined;
      if (row.payload == null) throw new Error('null payload on non-terminal row');
    } catch (err) {
      if (this.d.store.transition(row.enqueue_seq, 'queued', 'expired', { nowIso, terminalReason: 'poisoned', lastError: sanitizeError(err) })) {
        this.mirrorRemove(row.session_key);
        this.d.reportLoss([this.lossItem(row, 'poisoned')], 'poisoned');
      }
      return;
    }

    // maxAttempts → ONE final forced re-place (§3.3), bypassing verdicts.
    if (row.attempts >= q.maxAttempts) {
      const claimed = this.d.store.claim(row.enqueue_seq, nowIso);
      if (!claimed) return;
      this.d.store.incrementCounter('holdBypassedByAttemptsCap');
      let res: boolean | 'rejected' = false;
      try {
        res = await this.d.forceReplace(this.toMsg(row, senderEnvelope, topicMetadata));
      } catch { res = false; }
      if (res === true) {
        this.d.store.transition(row.enqueue_seq, 'claimed', 'delivered', { nowIso: new Date(this.d.now()).toISOString() });
        this.mirrorRemove(row.session_key);
        summary.delivered += 1;
      } else if (res === 'rejected') {
        // §2.A — the forced re-place hit a first-class sender refusal. Terminal
        // the SAME way as the direct 'sender-rejected' dispatch result (below):
        // sender-deauthorized + the unified §2.C loss notice, NOT attempts-exhausted.
        this.d.store.transition(row.enqueue_seq, 'claimed', 'expired', { nowIso: new Date(this.d.now()).toISOString(), terminalReason: 'sender-deauthorized' });
        this.mirrorRemove(row.session_key);
        this.d.reportLoss([this.lossItem(row, 'sender-deauthorized')], 'sender-deauthorized');
      } else {
        this.d.store.transition(row.enqueue_seq, 'claimed', 'expired', { nowIso: new Date(this.d.now()).toISOString(), terminalReason: 'attempts-exhausted' });
        this.mirrorRemove(row.session_key);
        this.d.reportLoss([this.lossItem(row, 'attempts-exhausted')], 'attempts-exhausted');
      }
      return;
    }

    // Claim (atomic CAS).
    const claimed = this.d.store.claim(row.enqueue_seq, nowIso);
    if (!claimed) return;
    summary.dispatched += 1;

    // The §3.4 handover contract, bound to THIS row.
    const handover: DrainHandover = {
      commitReceipt: () => this.d.store.writeReceiptIfClaimed(row.enqueue_seq, row.session_key, row.message_id, new Date(this.d.now()).toISOString()),
      stopRecheck: () => this.d.isStopped(row.session_key),
    };

    // Per-dispatch deadline (§3.4 round-3) — deadline-exceeded = failed attempt.
    let result: DrainDispatchResult;
    try {
      result = await withDeadline(
        this.d.dispatchInbound(this.toMsg(row, senderEnvelope, topicMetadata), handover),
        q.dispatchDeadlineMs,
      );
    } catch (err) {
      result = { kind: 'failed', error: err };
    }

    const settleIso = new Date(this.d.now()).toISOString();
    switch (result.kind) {
      case 'remote-delivered':
        this.d.store.transition(row.enqueue_seq, 'claimed', 'delivered', { nowIso: settleIso });
        this.mirrorRemove(row.session_key);
        summary.delivered += 1;
        break;
      case 'local-delivered': {
        // `delivered` derives from receipt-write success on local paths (§3.1).
        // A redispatch that finds an existing receipt settles without injecting
        // — also this arm (the dep returns local-delivered on receipt-found).
        const unconfirmed = result.injectError !== undefined;
        this.d.store.transition(row.enqueue_seq, 'claimed', 'delivered', { nowIso: settleIso, deliveredUnconfirmed: unconfirmed });
        this.mirrorRemove(row.session_key);
        summary.delivered += 1;
        if (unconfirmed) {
          this.d.store.incrementCounter('possiblyNotInjected');
          this.d.reportPossiblyNotInjected([this.lossItem(row, `inject-error: ${result.injectError}`)]);
        }
        break;
      }
      case 'handover-refused':
      case 'stopped-before-inject': {
        // A stop transitioned the row mid-flight — settle as a logged no-op;
        // the ledger honestly reads operator-stop (§3.6).
        this.d.log(`[inbound-queue] dispatch aborted by stop for ${row.session_key} seq=${row.enqueue_seq} (${result.kind})`);
        const cur = this.d.store.getRow(row.enqueue_seq);
        if (cur && cur.state === 'claimed') {
          // The stop hasn't transitioned it (stop landed between selection and
          // claim?) — settle it the stop way ourselves.
          this.d.store.transition(row.enqueue_seq, 'claimed', 'expired', { nowIso: settleIso, terminalReason: 'operator-stop' });
          this.mirrorRemove(row.session_key);
        }
        break;
      }
      case 'sender-rejected':
        // Typed NACK (§3.4 remote): non-retryable, peer is healthy.
        this.d.store.transition(row.enqueue_seq, 'claimed', 'expired', { nowIso: settleIso, terminalReason: 'sender-deauthorized' });
        this.mirrorRemove(row.session_key);
        this.d.reportLoss([this.lossItem(row, 'sender-deauthorized')], 'sender-deauthorized');
        break;
      case 'un-routable': {
        // queued | placement-blocked | spawn-in-progress → release + backoff +
        // attempts++ (§3.1 round-3: without the increment, maxAttempts was
        // unreachable from this class).
        summary.unroutable += 1;
        this.releaseWithBackoff(row, claimed.attempts + 1, `un-routable: ${result.reason}`, settleIso);
        break;
      }
      case 'failed': {
        summary.failed += 1;
        this.releaseWithBackoff(row, claimed.attempts + 1, sanitizeError(result.error) ?? 'dispatch-failed', settleIso);
        break;
      }
    }
  }

  private toMsg(row: PendingInboundRow, senderEnvelope: SenderEnvelope | null, topicMetadata: unknown): DrainMessage {
    return {
      sessionKey: row.session_key,
      messageId: row.message_id,
      payload: row.payload as string,
      senderEnvelope,
      topicMetadata,
      enqueueSeq: row.enqueue_seq,
    };
  }

  private releaseWithBackoff(row: PendingInboundRow, attempts: number, lastError: string, nowIso: string): void {
    const q = this.d.qcfg;
    const backoff = Math.min(q.baseBackoffMs * 2 ** Math.max(0, attempts - 1), q.maxBackoffMs);
    this.d.store.release(row.enqueue_seq, {
      nowIso,
      attempts,
      nextAttemptAt: new Date(Date.parse(nowIso) + backoff).toISOString(),
      lastError,
      // §3.6 round-9: a claimed row releasing while a pause is in effect is
      // frozen at release (TTL accounting pauses too).
      freeze: this.d.store.isPaused(),
    });
  }

  // ── Operator halt (§3.6) ────────────────────────────────────────────

  /**
   * Emergency stop for a topic: transition that session's non-terminal rows
   * terminal `expired` reason `operator-stop`, delete the PIS record, ONE
   * loss report ("dropped on your stop command — resend anything still
   * wanted"). The claimed→expired transition is the transactional fence that
   * makes any in-flight conditional receipt write fail atomically.
   */
  onOperatorStop(sessionKey: string): void {
    const nowIso = new Date(this.d.now()).toISOString();
    const rows = this.d.store.listNonTerminal().filter((r) => r.session_key === sessionKey);
    const dropped: LossItem[] = [];
    for (const row of rows) {
      const prior = row.state as 'queued' | 'claimed';
      if (this.d.store.transition(row.enqueue_seq, prior, 'expired', { nowIso, terminalReason: 'operator-stop' })) {
        this.mirrorRemove(row.session_key);
        this.heldSeqs.delete(row.enqueue_seq);
        dropped.push(this.lossItem(row, 'operator-stop'));
      }
    }
    if (dropped.length > 0) {
      try { this.d.clearPisRecord(sessionKey); } catch { /* PIS cleanup best-effort; boot-sweep veto is the backstop */ }
      this.d.reportLoss(dropped, 'operator-stop');
    }
  }

  /** Pause: freeze QUEUED rows only (round-9 pin) — in-flight dispatches
   *  complete normally; the pass/batch consult stops new dispatches. Durable. */
  onPause(): void {
    const nowIso = new Date(this.d.now()).toISOString();
    this.d.store.setPaused(true, nowIso);
    const n = this.d.store.freezeQueuedRows(nowIso);
    this.d.log(`[inbound-queue] paused — ${n} queued rows frozen`);
  }

  /** Resume: fold frozen spans, shift deadlines, expire past-cumulative-cap
   *  rows as pause-expired (loss-reported), re-enter via the trigger seam. */
  onResume(): Promise<DrainPassSummary | null> {
    const nowIso = new Date(this.d.now()).toISOString();
    this.d.store.setPaused(false, nowIso);
    const { overCap } = this.d.store.resumeFrozenRows(nowIso, this.d.qcfg.pauseMaxMs);
    const dropped: LossItem[] = [];
    for (const row of overCap) {
      const prior = row.state as 'queued' | 'claimed';
      if (this.d.store.transition(row.enqueue_seq, prior, 'expired', { nowIso, terminalReason: 'pause-expired' })) {
        this.mirrorRemove(row.session_key);
        this.heldSeqs.delete(row.enqueue_seq);
        dropped.push(this.lossItem(row, 'pause-expired'));
      }
    }
    if (dropped.length > 0) this.d.reportLoss(dropped, 'pause-expired');
    return this.runDrainPass('resume');
  }

  // ── Wake handling (§6) ──────────────────────────────────────────────

  /**
   * Sleep/wake (§6): shift backoff deadlines by the nap span (monotonic
   * deadlines are only reconstructable within one boot session — the shift
   * applies the sleep-shift pattern), then clamp: entries older than
   * `maxNapDeliveryAgeMs` of wall age expire (`nap-stale`, loss-reported) —
   * a 10-minute-old instruction should not fire into a conversation the user
   * has moved past. Low wake-confidence → the conservative branch: clamp
   * WITHOUT deadline-shift (deadlines fire sooner, the clamp still bounds
   * staleness — the fail-safe direction).
   */
  onWake(napMs: number, confidence: 'high' | 'low'): Promise<DrainPassSummary | null> {
    const nowMs = this.d.now();
    const nowIso = new Date(nowMs).toISOString();
    const q = this.d.qcfg;
    const stale: LossItem[] = [];
    for (const row of this.d.store.listNonTerminal()) {
      if (row.frozen_since) continue; // pause governs frozen rows
      const age = nowMs - Date.parse(row.enqueued_at) - row.total_frozen_ms;
      if (age > q.maxNapDeliveryAgeMs && row.state === 'queued') {
        if (this.d.store.transition(row.enqueue_seq, 'queued', 'expired', { nowIso, terminalReason: 'nap-stale' })) {
          this.mirrorRemove(row.session_key);
          this.heldSeqs.delete(row.enqueue_seq);
          stale.push(this.lossItem(row, 'nap-stale'));
        }
        continue;
      }
      if (confidence === 'high' && row.state === 'queued' && row.next_attempt_at) {
        const t = Date.parse(row.next_attempt_at);
        if (Number.isFinite(t)) this.shiftDeadline(row.enqueue_seq, t + napMs);
      }
    }
    if (stale.length > 0) this.d.reportLoss(stale, 'nap-stale');
    return this.runDrainPass('wake');
  }

  private shiftDeadline(seq: number, newDeadlineMs: number): void {
    // Narrow, policy-owned deadline shift (sleep-shift §6). Implemented via
    // release-style update through the store's transition API surface:
    const row = this.d.store.getRow(seq);
    if (!row || row.state !== 'queued') return;
    this.d.store.setNextAttempt(seq, new Date(newDeadlineMs).toISOString());
  }

  /** Bounded top-K per-session depth list (§5.1 heartbeat field; K byte-small
   *  by construction — sessionKey is a topic id string). */
  topKSessionDepths(k: number): Array<{ sessionKey: string; depth: number }> {
    return this.d.store
      .sessionCounts()
      .sort((a, b) => b.count - a.count)
      .slice(0, k)
      .map((c) => ({ sessionKey: c.session_key, depth: c.count }));
  }

  // ── Remote receive side (§3.4 remote path — peer-side surface) ──────

  /** Receive-side durable receipt, canonical-id keyed (loss window 6 arm). */
  recordRemoteReceipt(sessionKey: string, messageId: string): boolean {
    return this.d.store.recordRemoteReceipt(sessionKey, messageId, new Date(this.d.now()).toISOString());
  }

  /** Flip the injected marker after the local inject completed. */
  markRemoteInjected(sessionKey: string, messageId: string): void {
    this.d.store.markReceiptInjected(sessionKey, messageId, 'remote');
  }

  /** Peer-side CAUGHT inject failure after receipt-commit (round-9): report at
   *  error time + counter; marker stays unflipped (prune backstop re-covers). */
  reportPeerInjectError(sessionKey: string, messageId: string, error: string): void {
    this.d.store.incrementCounter('possiblyNotInjected');
    this.d.reportPossiblyNotInjected([
      { sessionKey, messageId, enqueuedAt: new Date(this.d.now()).toISOString(), reason: `peer-inject-error: ${error.slice(0, 200)}` },
    ]);
  }

  // ── Observability (read surface for /pool/queue) ────────────────────

  snapshot(): {
    counts: ReturnType<PendingInboundStore['counts']>;
    counters: Record<string, number>;
    heldSeqs: number;
    paused: boolean;
    tenure: string | null;
  } {
    const counterKeys = [
      'wouldEnqueue', 'wouldHold', 'wouldRefuse', 'dryRunErrors',
      'orderingViolations', 'mirrorDrift', 'possiblyNotInjected',
      'holdBypassedByAttemptsCap', 'holdsStarted', 'holdsRecoveredInPlace',
      'holdsReleasedToFailover:budget-exhausted', 'holdsReleasedToFailover:flap-forced',
      'holdsReleasedToFailover:maxHeldTotal-refused', 'budgetOverrunHolds',
    ];
    const counters: Record<string, number> = {};
    for (const k of counterKeys) counters[k] = this.d.store.getCounter(k);
    return {
      counts: this.d.store.counts(),
      counters,
      heldSeqs: this.heldSeqs.size,
      paused: this.d.store.isPaused(),
      tenure: this.tenure,
    };
  }
}

// ── Helpers ───────────────────────────────────────────────────────────

async function withDeadline<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`dispatch deadline exceeded (${ms}ms)`)), ms);
        // Don't hold the event loop open for the deadline alone.
        (timer as { unref?: () => void }).unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
