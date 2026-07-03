/**
 * SwapAntiThrash — Piece 1 of swap-continuity-antithrash: the anti-thrash
 * brakes on the proactive account swap (docs/specs/swap-continuity-antithrash.md §3).
 *
 * The engine sits at the proactive DECISION chokepoint (ProactiveSwapMonitor's
 * evaluate pass) and owns:
 *   - brake (a): the all-hot brake — refuse when no eligible target measures
 *     under the target ceiling (§3.1); "measures" requires a PRESENT + FRESH
 *     quota reading (bound 0, R4-M1) — no reading is NEVER treated as 0%.
 *   - brake (b): per-session dwell (45 min default), restart-safe via the
 *     swap ledger (§3.2).
 *   - brake (c): target-materially-better — validity gate + absolute ceiling +
 *     relative improvement, in the normative filter→score→verify order (§3.3),
 *     plus the intra-tick per-target pile-on cap.
 *   - thrash detection + the two-tier breaker (T1 inversion / T2 frequency,
 *     §3.5) with episode continuation, restart-proof derivation from the
 *     ledger, and P17 one-deduped-attention-item episodes.
 *   - execution-failure accounting (§3.6): failed rows, per-session
 *     exponential backoff (proactive), streak escalation — kind-separated so a
 *     reactive streak never mixes with a proactive one.
 *   - the ledger-lost pause (I12): while the swap ledger is unwritable, every
 *     proactive intent refuses `ledger-lost` (counter-only) and resumes
 *     level-triggered on the first successful append.
 *   - measurement-blind surfacing (I13, R5-m1): evaluated per tick over the
 *     POOL ITSELF, candidacy-independent.
 *
 * The REACTIVE path is untouched by every brake (I6) — the engine only ever
 * OBSERVES reactive swaps (dwell clock-start, hop alerts, failed-row streaks).
 */

import type { SubscriptionAccount } from './SubscriptionPool.js';
import { bindingUtilization, scoreAccount } from './QuotaAwareScheduler.js';
import { isLocallyExecutable } from './SubscriptionPool.js';
import {
  SwapLedger,
  type SwapLedgerRow,
  type SwapReason,
  type TriggerSignature,
  type BreakerState,
  type EpisodeKind,
} from './SwapLedger.js';

// ── Knobs (§7) ───────────────────────────────────────────────────────────────

export interface AntiThrashKnobs {
  enabled: boolean;
  dryRun: boolean;
  /** From proactiveSwap: the source-pressure threshold (default 80). */
  thresholdPct: number;
  /** Monitor tick cadence (failure-backoff base). */
  tickMs: number;
  targetHeadroomPct: number;
  minImprovementPct: number;
  dwellMs: number;
  reversalWindowMs: number;
  thrashBreakerThreshold: number;
  thrashBreakerBackoffMs: number;
  swapFrequencyThreshold: number;
  swapFrequencyWindowMs: number;
  allHotHeartbeatMs: number;
  reactiveHopAlertThreshold: number;
  quotaFreshnessMs: number;
}

/** Raw config block shape (subscriptionPool.proactiveSwap.antiThrash). */
export interface AntiThrashConfigBlock {
  enabled?: boolean;
  dryRun?: boolean;
  targetHeadroomPct?: number;
  minImprovementPct?: number;
  dwellMs?: number;
  reversalWindowMs?: number;
  thrashBreakerThreshold?: number;
  thrashBreakerBackoffMs?: number;
  swapFrequencyThreshold?: number;
  swapFrequencyWindowMs?: number;
  allHotHeartbeatMs?: number;
  reactiveHopAlertThreshold?: number;
  quotaFreshnessMs?: number;
}

/**
 * Resolve the antiThrash knobs with shipped defaults (§7). All numeric reads
 * use nullish coalescing (zero is a legal disable for several knobs). An
 * ABSENT block on a proactiveSwap-enabled install resolves
 * `enabled:true, dryRun:true` (§12 migration default-direction assertion —
 * the dry-run soak is the default, never a silent skip).
 */
export function resolveAntiThrashKnobs(
  block: AntiThrashConfigBlock | undefined,
  proactive?: { thresholdPct?: number; tickMs?: number },
): AntiThrashKnobs {
  return {
    enabled: block?.enabled ?? true,
    dryRun: block?.dryRun ?? true,
    thresholdPct: proactive?.thresholdPct ?? 80,
    tickMs: proactive?.tickMs ?? 180_000,
    targetHeadroomPct: block?.targetHeadroomPct ?? 15,
    minImprovementPct: block?.minImprovementPct ?? 15,
    dwellMs: block?.dwellMs ?? 2_700_000,
    reversalWindowMs: block?.reversalWindowMs ?? 1_800_000,
    thrashBreakerThreshold: block?.thrashBreakerThreshold ?? 2,
    thrashBreakerBackoffMs: block?.thrashBreakerBackoffMs ?? 3_600_000,
    swapFrequencyThreshold: block?.swapFrequencyThreshold ?? 3,
    swapFrequencyWindowMs: block?.swapFrequencyWindowMs ?? 10_800_000,
    allHotHeartbeatMs: block?.allHotHeartbeatMs ?? 1_800_000,
    reactiveHopAlertThreshold: block?.reactiveHopAlertThreshold ?? 2,
    quotaFreshnessMs: block?.quotaFreshnessMs ?? 1_800_000,
  };
}

/**
 * The §3.2 one-formula retention/hydration bound (R3-M1, continuation term
 * R5-m2): retention ⊇ every detection window AND every continuation window,
 * structurally. 4 h at shipped defaults (the last term dominates). NOT a knob.
 */
export function retentionBoundMs(k: AntiThrashKnobs): number {
  return Math.max(
    k.dwellMs,
    k.reversalWindowMs,
    k.thrashBreakerBackoffMs,
    k.swapFrequencyWindowMs,
    k.thrashBreakerBackoffMs + Math.max(k.reversalWindowMs, k.swapFrequencyWindowMs),
  );
}

/**
 * Cross-knob coherence warnings (§7, R4-L2 — warn-only, never a startup
 * error). Returns the warning lines (the caller logs each exactly once).
 */
export function crossKnobWarnings(k: AntiThrashKnobs, pollIntervalMs: number): string[] {
  const out: string[] = [];
  if (k.swapFrequencyThreshold > 1 && k.dwellMs > k.swapFrequencyWindowMs / (k.swapFrequencyThreshold - 1)) {
    out.push(
      `[SwapAntiThrash] config warning: dwellMs (${k.dwellMs}) > swapFrequencyWindowMs/(swapFrequencyThreshold-1) ` +
        `(${Math.round(k.swapFrequencyWindowMs / (k.swapFrequencyThreshold - 1))}) — the T2 rotation detector is disarmed ` +
        `(dwell-paced hops can no longer fit the frequency window)`,
    );
  }
  if (k.quotaFreshnessMs < pollIntervalMs) {
    out.push(
      `[SwapAntiThrash] config warning: quotaFreshnessMs (${k.quotaFreshnessMs}) < quota poll interval (${pollIntervalMs}) — ` +
        `every reading goes stale between polls; proactive optimization degrades toward permanent refusal (safe, but almost certainly a misconfiguration)`,
    );
  }
  return out;
}

// ── Bound 0: the quota-reading validity gate (§3.3, R4-M1) ──────────────────

export interface ReadingValidity {
  /** Reading PRESENT and fresher than quotaFreshnessMs. */
  valid: boolean;
  /** bindingUtilization of the (possibly invalid) reading — 0 when absent. */
  utilPct: number;
  /** Why invalid, when invalid. */
  invalidReason?: 'absent' | 'stale';
}

export function readingValidity(
  acct: SubscriptionAccount,
  nowMs: number,
  quotaFreshnessMs: number,
): ReadingValidity {
  const snap = acct.lastQuota;
  const utilPct = bindingUtilization(snap);
  if (!snap) return { valid: false, utilPct, invalidReason: 'absent' };
  const measured = snap.measuredAt ? Date.parse(snap.measuredAt) : NaN;
  if (!Number.isFinite(measured)) return { valid: false, utilPct, invalidReason: 'absent' };
  if (nowMs - measured > quotaFreshnessMs) return { valid: false, utilPct, invalidReason: 'stale' };
  return { valid: true, utilPct };
}

// ── Engine ───────────────────────────────────────────────────────────────────

export interface ProactiveIntentInput {
  session: string;
  fromAccountId: string;
  /** The full pool account list (fresh snapshot). */
  accounts: SubscriptionAccount[];
  nowMs: number;
  /** Target accounts already executed onto this tick (per-target cap, §3.3). */
  targetsUsedThisTick: ReadonlySet<string>;
  /** Deferral bookkeeping stamped onto refusal rows when this intent is a deferred retry. */
  deferralAgeMs?: number;
  deferCount?: number;
}

export type BrakeVerdict =
  | { action: 'execute'; targetAccountId: string; fromUtilPct: number; toUtilPct: number }
  | { action: 'refuse'; reason: SwapReason | 'ledger-lost' }
  | { action: 'skip'; why: 'reintent-backoff' | 'failure-backoff' };

interface ExecutionRecord {
  tsMs: number;
  session: string;
  from: string;
  to: string;
  kind: 'proactive' | 'reactive';
}

interface BreakerEpisode {
  episodeId: string;
  openedAtMs: number;
  deadlineMs: number;
  signature: TriggerSignature;
}

interface StateRowEntry {
  reason: 'all-hot' | 'target-unmeasured';
  enteredAtMs: number;
  lastRowMs: number;
  episodeId: string;
  touchedTick: number;
}

interface FailureStreak {
  count: number;
  firstFailMs: number;
  lastFailMs: number;
  alerted: boolean;
}

export interface SwapAntiThrashEngineOptions {
  ledger: SwapLedger;
  getKnobs: () => AntiThrashKnobs;
  machineId?: string;
  raiseAttention?: (id: string, title: string, body: string) => void;
  logger?: { log: (m: string) => void; warn: (m: string) => void };
  now?: () => number;
}

export class SwapAntiThrashEngine {
  private readonly ledger: SwapLedger;
  private readonly getKnobs: () => AntiThrashKnobs;
  private readonly machineId: string;
  private readonly raiseAttention: (id: string, title: string, body: string) => void;
  private readonly logger: { log: (m: string) => void; warn: (m: string) => void };
  private readonly now: () => number;

  // ── in-memory write-through index (hydrated at boot, §3.5 read path) ──
  private executions: ExecutionRecord[] = [];
  private lastSwapAtBySession = new Map<string, number>();
  private inversionIncrementsMs: number[] = [];
  private breaker: BreakerEpisode | null = null;
  /** Signature-keyed continuation memory: most recent CLOSE per signature. */
  private continuationMemory = new Map<string, { episodeId: string; closedAtMs: number }>();
  private alertedEpisodeIds = new Set<string>();
  private failureStreaks = new Map<string, FailureStreak>(); // `${kind}:${session}`
  private failureBackoffUntil = new Map<string, number>(); // proactive only
  private lastDroppedAt = new Map<string, number>(); // re-intent backoff (§4.2)
  private stateRows = new Map<string, StateRowEntry>(); // all-hot / target-unmeasured per session
  private breakerSuppressionRows = new Map<string, { lastRowMs: number }>(); // per session per episode
  private reactiveHops = new Map<string, number[]>();
  private reactiveHopAlerted = new Set<string>();
  private blindSinceMs: number | null = null;
  private blindEpisodeId: string | null = null;
  private tickSeq = 0;

  // ── counters (§6.3) ──
  private refusalsByReason = new Map<string, number>();
  private reversalsDetected = 0;
  private pairLevelDetections = 0;
  private frequencyCrossings = 0;
  private droppedCount = 0;
  private invalidatedCount = 0;
  private proceededWithMitigations = 0;
  private ledgerLostRefusals = 0;

  constructor(opts: SwapAntiThrashEngineOptions) {
    this.ledger = opts.ledger;
    this.getKnobs = opts.getKnobs;
    this.machineId = opts.machineId ?? 'local';
    this.raiseAttention = opts.raiseAttention ?? (() => {});
    this.logger = opts.logger ?? { log: () => {}, warn: () => {} };
    this.now = opts.now ?? (() => Date.now());
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Hydration (boot, unconditional — R4-L3)
  // ─────────────────────────────────────────────────────────────────────────

  hydrate(): void {
    const { rows } = this.ledger.hydrate();
    const k = this.getKnobs();
    const nowMs = this.now();
    let openMarker: { row: SwapLedgerRow; tsMs: number } | null = null;
    const closesBySig = new Map<string, { episodeId: string; closedAtMs: number }>();
    const lastFailedRun = new Map<string, FailureStreak>();

    for (const row of rows) {
      const tsMs = Date.parse(row.ts);
      if (!Number.isFinite(tsMs)) continue;
      if (row.decision === 'swapped' || row.decision === 'proceeded') {
        if (row.session && row.from && row.to && row.kind !== 'interactive') {
          this.executions.push({ tsMs, session: row.session, from: row.from, to: row.to, kind: row.kind });
          this.lastSwapAtBySession.set(row.session, Math.max(tsMs, this.lastSwapAtBySession.get(row.session) ?? 0));
          // an executed swap resets the session's failure streak
          lastFailedRun.delete(`proactive:${row.session}`);
          lastFailedRun.delete(`reactive:${row.session}`);
        }
      }
      if (row.decision === 'dropped' && row.session) {
        this.lastDroppedAt.set(row.session, Math.max(tsMs, this.lastDroppedAt.get(row.session) ?? 0));
      }
      if (row.decision === 'failed' && row.session && (row.kind === 'proactive' || row.kind === 'reactive')) {
        const key = `${row.kind}:${row.session}`;
        const s = lastFailedRun.get(key);
        if (s) {
          s.count += 1;
          s.lastFailMs = tsMs;
          if (s.count >= 3) s.alerted = true;
        } else {
          lastFailedRun.set(key, { count: 1, firstFailMs: tsMs, lastFailMs: tsMs, alerted: false });
        }
      }
      // Breaker derivation anchors ONLY on rows carrying breakerDeadline
      // (equivalently episodeKind 'thrash-breaker') — R3-m1: an all-hot or
      // failure-streak row can never anchor or close the breaker.
      if (row.breakerDeadline && row.episodeKind === 'thrash-breaker') {
        if (openMarker === null || tsMs >= openMarker.tsMs) openMarker = { row, tsMs };
      }
      if (
        row.episodeKind === 'thrash-breaker' &&
        row.transition === 'leave' &&
        row.triggerSignature &&
        row.episodeId
      ) {
        closesBySig.set(signatureKey(row.triggerSignature), { episodeId: row.episodeId, closedAtMs: tsMs });
      }
      if (row.episodeId) this.alertedEpisodeIds.add(row.episodeId);
      // all-hot / target-unmeasured state re-derivation (enter/heartbeat
      // without a following leave ⇒ still in state).
      if (row.session && (row.reason === 'all-hot' || row.reason === 'target-unmeasured') && row.transition) {
        if (row.transition === 'leave') {
          this.stateRows.delete(row.session);
        } else {
          this.stateRows.set(row.session, {
            reason: row.reason,
            enteredAtMs: row.transition === 'enter' ? tsMs : (this.stateRows.get(row.session)?.enteredAtMs ?? tsMs),
            lastRowMs: tsMs,
            episodeId: row.episodeId ?? `${row.reason}-${row.session}-${tsMs}`,
            touchedTick: 0,
          });
        }
      }
    }

    this.failureStreaks = lastFailedRun;
    for (const [key, s] of lastFailedRun) {
      if (key.startsWith('proactive:')) {
        const session = key.slice('proactive:'.length);
        const backoff = Math.min(k.tickMs * Math.pow(2, s.count), k.dwellMs);
        this.failureBackoffUntil.set(session, s.lastFailMs + backoff);
      }
    }
    this.continuationMemory = closesBySig;

    if (openMarker) {
      const row = openMarker.row;
      const deadlineMs = Date.parse(row.breakerDeadline!);
      const sig: TriggerSignature = row.triggerSignature ?? { tier: 'T1' };
      const episodeId = row.episodeId ?? `thrash-${openMarker.tsMs}`;
      const sigKey = signatureKey(sig);
      if (Number.isFinite(deadlineMs) && deadlineMs > nowMs) {
        // Restart in the middle of the backoff: boot OPEN with the ORIGINAL
        // deadline; episodeId dedupe prevents a re-alert (I8, R2-M2).
        this.breaker = {
          episodeId,
          openedAtMs: row.breakerOpenedAt ? Date.parse(row.breakerOpenedAt) : openMarker.tsMs,
          deadlineMs,
          signature: sig,
        };
        this.alertedEpisodeIds.add(episodeId);
      } else if (Number.isFinite(deadlineMs) && !closesBySig.has(sigKey)) {
        // Down-across-the-deadline (R6-m3): the close row was never written
        // because no live process existed at backoff-elapse. Synthesize the
        // close IN MEMORY at the deadline — nothing is written at boot (the
        // read path stays read-only); a same-signature re-cross inside the
        // continuation window JOINS the episode instead of re-alerting.
        this.continuationMemory.set(sigKey, { episodeId, closedAtMs: deadlineMs });
        this.alertedEpisodeIds.add(episodeId);
      }
    }

    // Prune anything the formula says is out of window.
    this.pruneIndex(nowMs, k);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Per-tick housekeeping (prune, breaker close, measurement-blind, leaves)
  // ─────────────────────────────────────────────────────────────────────────

  beginTick(accounts: SubscriptionAccount[], nowMs: number, proactiveEnabled: boolean): void {
    this.tickSeq += 1;
    const k = this.getKnobs();
    this.pruneIndex(nowMs, k);
    this.maybeCloseBreaker(nowMs, k);
    this.evaluateMeasurementBlind(accounts, nowMs, k, proactiveEnabled);
  }

  /** End-of-tick: emit LEAVE rows for all-hot/target-unmeasured states no longer observed. */
  endTick(nowMs: number): void {
    for (const [session, entry] of [...this.stateRows]) {
      if (entry.touchedTick !== this.tickSeq) {
        this.appendRow({
          ts: new Date(nowMs).toISOString(),
          kind: 'proactive',
          decision: 'refused',
          callerClass: 'proactive-swap',
          session,
          machineId: this.machineId,
          from: '',
          reason: entry.reason,
          transition: 'leave',
          episodeId: entry.episodeId,
          episodeKind: entry.reason === 'all-hot' ? 'all-hot' : 'measurement-blind',
        });
        this.stateRows.delete(session);
      }
    }
  }

  private pruneIndex(nowMs: number, k: AntiThrashKnobs): void {
    const bound = retentionBoundMs(k);
    const cutoff = nowMs - bound;
    this.executions = this.executions.filter((e) => e.tsMs >= cutoff);
    this.inversionIncrementsMs = this.inversionIncrementsMs.filter((t) => nowMs - t <= k.reversalWindowMs);
    for (const [s, t] of [...this.lastSwapAtBySession]) if (t < cutoff) this.lastSwapAtBySession.delete(s);
    for (const [s, t] of [...this.lastDroppedAt]) if (t < cutoff) this.lastDroppedAt.delete(s);
    for (const [s, hops] of [...this.reactiveHops]) {
      const fresh = hops.filter((t) => nowMs - t <= k.reversalWindowMs);
      if (fresh.length === 0) this.reactiveHops.delete(s);
      else this.reactiveHops.set(s, fresh);
    }
    for (const [key, cont] of [...this.continuationMemory]) {
      if (cont.closedAtMs < cutoff) this.continuationMemory.delete(key);
    }
  }

  private maybeCloseBreaker(nowMs: number, k: AntiThrashKnobs): void {
    if (this.breaker && nowMs >= this.breaker.deadlineMs) {
      const ep = this.breaker;
      // The CLOSE row: the suppression `leave` row carrying the episode's
      // triggerSignature (§3.5 R5-m2) so continuation memory re-derives
      // across restarts.
      this.appendRow({
        ts: new Date(nowMs).toISOString(),
        kind: 'proactive',
        decision: 'refused',
        callerClass: 'proactive-swap',
        session: ep.signature.session ?? 'pool',
        machineId: this.machineId,
        from: '',
        reason: 'thrash-breaker',
        transition: 'leave',
        episodeId: ep.episodeId,
        episodeKind: 'thrash-breaker',
        breakerOpenedAt: new Date(ep.openedAtMs).toISOString(),
        breakerDeadline: new Date(ep.deadlineMs).toISOString(),
        triggerSignature: ep.signature,
      });
      this.continuationMemory.set(signatureKey(ep.signature), {
        episodeId: ep.episodeId,
        closedAtMs: nowMs,
      });
      this.breaker = null;
      this.breakerSuppressionRows.clear();
      this.logger.log(`[SwapAntiThrash] thrash breaker half-open (episode ${ep.episodeId}) — proactive swapping may resume`);
    }
  }

  private evaluateMeasurementBlind(
    accounts: SubscriptionAccount[],
    nowMs: number,
    k: AntiThrashKnobs,
    proactiveEnabled: boolean,
  ): void {
    // POOL-LEVEL trigger (R5-m1): proactiveSwap enabled AND ≥2 non-disabled
    // accounts (R6-L4) AND zero of them carry a present, fresh reading —
    // evaluated over the pool ITSELF, never over a candidate evaluation's
    // alternate set (whole-pool blindness must fire even when stale sources
    // mean zero candidate evaluations run).
    const nonDisabled = accounts.filter((a) => a.status !== 'disabled');
    const blind =
      proactiveEnabled &&
      nonDisabled.length >= 2 &&
      nonDisabled.every((a) => !readingValidity(a, nowMs, k.quotaFreshnessMs).valid);
    if (!blind) {
      this.blindSinceMs = null;
      this.blindEpisodeId = null;
      return;
    }
    if (this.blindSinceMs === null) {
      this.blindSinceMs = nowMs;
      this.blindEpisodeId = `measurement-blind-${nowMs}`;
      return;
    }
    if (nowMs - this.blindSinceMs > k.allHotHeartbeatMs && this.blindEpisodeId && !this.alertedEpisodeIds.has(this.blindEpisodeId)) {
      this.alertedEpisodeIds.add(this.blindEpisodeId);
      this.raiseAttention(
        `swap-antithrash-${this.blindEpisodeId}`,
        'Proactive account optimization is measurement-blind',
        `No fresh quota readings on any pool account for ${Math.round((nowMs - this.blindSinceMs) / 60000)}+ min — proactive swapping is effectively paused until the quota poller recovers (reactive rescue is unaffected).`,
      );
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // The brake pipeline (§3 — evaluated per candidate per tick)
  // ─────────────────────────────────────────────────────────────────────────

  /** Is this account eligible as a proactive SOURCE (valid fresh reading ≥ threshold)? §3.3 source leg. */
  sourceEligible(acct: SubscriptionAccount, nowMs: number): boolean {
    const k = this.getKnobs();
    const v = readingValidity(acct, nowMs, k.quotaFreshnessMs);
    return v.valid && v.utilPct >= k.thresholdPct;
  }

  /** Is the session inside re-intent backoff after a ceiling drop (§4.2)? */
  inReIntentBackoff(session: string, nowMs: number): boolean {
    const k = this.getKnobs();
    const dropped = this.lastDroppedAt.get(session);
    return dropped !== undefined && nowMs - dropped < k.dwellMs;
  }

  /**
   * Evaluate one proactive swap intent through the full brake pipeline.
   * Order: ledger-lost → breaker → dwell → filter (bound 0 + ceiling) →
   * score → verify (improvement) → reversal. Writes refusal rows (with the
   * state-transition machinery where mandated) as a side effect.
   */
  evaluateIntent(input: ProactiveIntentInput): BrakeVerdict {
    const k = this.getKnobs();
    const nowMs = input.nowMs;

    // 0. failure backoff (§3.6) / re-intent backoff (§4.2) — no intent generated.
    const backoff = this.failureBackoffUntil.get(input.session);
    if (backoff !== undefined && nowMs < backoff) return { action: 'skip', why: 'failure-backoff' };
    if (this.inReIntentBackoff(input.session, nowMs)) return { action: 'skip', why: 'reintent-backoff' };

    // 1. Ledger-lost pause (I12, R3-M3): level-triggered — try to resume first.
    if (!this.ledger.tryResume()) {
      this.ledgerLostRefusals += 1;
      this.bumpRefusal('ledger-lost');
      this.raiseLedgerLostAttention();
      return { action: 'refuse', reason: 'ledger-lost' };
    }

    // 2. Thrash breaker (evaluated before all-hot — §3.1 pipeline order).
    if (this.breaker) {
      this.recordBreakerSuppression(input, nowMs, k);
      return { action: 'refuse', reason: 'thrash-breaker' };
    }

    // 3. Dwell (brake b).
    const lastSwap = this.lastSwapAtBySession.get(input.session);
    if (lastSwap !== undefined && nowMs - lastSwap < k.dwellMs) {
      this.recordSimpleRefusal(input, 'dwell', nowMs, {
        dwellRemainingMs: k.dwellMs - (nowMs - lastSwap),
      });
      return { action: 'refuse', reason: 'dwell' };
    }

    // 4. FILTER (§3.3 normative order): validity gate (bound 0) + absolute
    // ceiling (bound 1) over the alternate set, minus this tick's used targets.
    const ceiling = k.thresholdPct - k.targetHeadroomPct;
    const alternates = input.accounts.filter(
      (a) => a.id !== input.fromAccountId && isLocallyExecutable(a),
    );
    let unmeasuredAlternates = 0;
    const filtered: Array<{ acct: SubscriptionAccount; utilPct: number }> = [];
    let validHotCount = 0;
    for (const a of alternates) {
      const v = readingValidity(a, nowMs, k.quotaFreshnessMs);
      if (!v.valid) {
        unmeasuredAlternates += 1;
        continue;
      }
      if (v.utilPct >= ceiling) {
        validHotCount += 1;
        continue;
      }
      if (input.targetsUsedThisTick.has(a.id)) continue; // intra-tick per-target cap
      filtered.push({ acct: a, utilPct: v.utilPct });
    }

    const sourceValidity = readingValidity(
      input.accounts.find((a) => a.id === input.fromAccountId) ?? ({ lastQuota: null } as SubscriptionAccount),
      nowMs,
      k.quotaFreshnessMs,
    );

    if (filtered.length === 0) {
      // Empty-filter classification, ONE rule (§3.1/§3.3 R5-L2): `all-hot`
      // iff EVERY alternate carried a VALID reading at/above the ceiling;
      // `target-unmeasured` the moment ANY alternate lacked a valid reading.
      // (Targets removed only by the per-tick cap resolve as
      // no-material-target — the pool is not hot, this tick is just full.)
      let reason: SwapReason;
      if (unmeasuredAlternates > 0) reason = 'target-unmeasured';
      else if (validHotCount > 0 && validHotCount === alternates.length) reason = 'all-hot';
      else if (alternates.length === 0) reason = 'all-hot'; // no alternates at all — nothing to move to
      else reason = 'no-material-target';
      if (reason === 'all-hot' || reason === 'target-unmeasured') {
        this.recordStateRefusal(input, reason, nowMs, k, unmeasuredAlternates);
      } else {
        this.recordSimpleRefusal(input, reason, nowMs, {});
      }
      return { action: 'refuse', reason };
    }
    // A refusal state this session was in has ended (a target survived) —
    // endTick() will emit the leave row because we do not touch stateRows here.

    // 5. SCORE with the existing use-before-reset scoring — over the FILTERED
    // cool set ONLY (§3.3: the scoring was never the bug; applying it over
    // the hot band was).
    let best: { acct: SubscriptionAccount; utilPct: number; score: number } | null = null;
    for (const f of filtered) {
      const s = scoreAccount(f.acct, nowMs);
      if (!best || s > best.score) best = { acct: f.acct, utilPct: f.utilPct, score: s };
    }
    const target = best!;

    // 6. VERIFY the survivor against bound 2 (relative improvement).
    const fromUtil = sourceValidity.utilPct;
    if (fromUtil - target.utilPct < k.minImprovementPct) {
      this.recordSimpleRefusal(input, 'no-material-target', nowMs, {
        to: target.acct.id,
        fromUtilPct: fromUtil,
        toUtilPct: target.utilPct,
      });
      return { action: 'refuse', reason: 'no-material-target' };
    }

    // 7. Reversal refusal (same-session keyed, §3.5): the intent's (from,to)
    // is the inverse of this session's most recent executed swap within the
    // reversal window.
    const recent = this.mostRecentExecution(input.session, nowMs, k.reversalWindowMs);
    if (recent && recent.from === target.acct.id && recent.to === input.fromAccountId) {
      this.reversalsDetected += 1;
      const row = this.buildRefusalRow(input, 'reversal', nowMs, {
        to: target.acct.id,
        fromUtilPct: fromUtil,
        toUtilPct: target.utilPct,
      });
      this.addInversionIncrement(nowMs, k, row, {
        tier: 'T1',
        pair: pairKey(input.fromAccountId, target.acct.id),
      });
      this.bumpRefusal('reversal');
      this.appendRow(row);
      return { action: 'refuse', reason: 'reversal' };
    }

    return {
      action: 'execute',
      targetAccountId: target.acct.id,
      fromUtilPct: fromUtil,
      toUtilPct: target.utilPct,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Recording — executed / failed / deferred / dropped / invalidated / reactive
  // ─────────────────────────────────────────────────────────────────────────

  /** Record an EXECUTED proactive swap: index write-through, pair-level +
   * frequency detection (which may open the breaker and stamp this row). */
  recordProactiveExecuted(args: {
    session: string;
    from: string;
    to: string;
    nowMs: number;
    fromUtilPct?: number;
    toUtilPct?: number;
    deferralAgeMs?: number;
    deferCount?: number;
    defaultAccountChanged?: boolean;
    dryRun?: boolean;
  }): void {
    const k = this.getKnobs();
    const row: SwapLedgerRow = {
      ts: new Date(args.nowMs).toISOString(),
      kind: 'proactive',
      decision: 'swapped',
      callerClass: 'proactive-swap',
      session: args.session,
      machineId: this.machineId,
      from: args.from,
      to: args.to,
      ...(args.fromUtilPct !== undefined ? { fromUtilPct: args.fromUtilPct } : {}),
      ...(args.toUtilPct !== undefined ? { toUtilPct: args.toUtilPct } : {}),
      ...(args.deferralAgeMs !== undefined ? { deferralAgeMs: args.deferralAgeMs } : {}),
      ...(args.deferCount !== undefined ? { deferCount: args.deferCount } : {}),
      ...(args.defaultAccountChanged ? { defaultAccountChanged: true } : {}),
      ...(args.dryRun ? { dryRun: true } : {}),
    };

    // Pair-level inversion detection (any session, §3.5 — detection-only).
    const inverted = this.executions.some(
      (e) =>
        args.nowMs - e.tsMs <= k.reversalWindowMs &&
        e.from === args.to &&
        e.to === args.from,
    );

    // Write-through index update — ALWAYS, regardless of append outcome (R4-m1).
    this.executions.push({ tsMs: args.nowMs, session: args.session, from: args.from, to: args.to, kind: 'proactive' });
    this.lastSwapAtBySession.set(args.session, args.nowMs);
    this.failureStreaks.delete(`proactive:${args.session}`);
    this.failureBackoffUntil.delete(args.session);

    if (inverted) {
      this.pairLevelDetections += 1;
      this.addInversionIncrement(args.nowMs, k, row, {
        tier: 'T1',
        pair: pairKey(args.from, args.to),
      });
    }

    // Frequency detector (T2, §3.5): this session's proactive executions in
    // the frequency window (including this one) reaching the threshold OPENS
    // the breaker directly — the crossing IS the episode trigger.
    const freq = this.executions.filter(
      (e) => e.session === args.session && e.kind === 'proactive' && args.nowMs - e.tsMs <= k.swapFrequencyWindowMs,
    ).length;
    if (freq >= k.swapFrequencyThreshold && !this.breaker) {
      this.frequencyCrossings += 1;
      this.openBreaker(args.nowMs, k, row, { tier: 'T2', session: args.session });
    }

    this.appendRow(row);
  }

  /** Observe a REACTIVE swap (I6 — never gates; dwell clock-start + hop alerts). */
  recordReactiveExecuted(args: {
    session: string;
    from: string;
    to: string;
    nowMs: number;
    defaultAccountChanged?: boolean;
  }): void {
    const k = this.getKnobs();
    // Index priming happens REGARDLESS of append outcome (R4-m1) — a
    // just-rescued session must be dwell-covered even through a ledger outage.
    this.executions.push({ tsMs: args.nowMs, session: args.session, from: args.from, to: args.to, kind: 'reactive' });
    this.lastSwapAtBySession.set(args.session, args.nowMs);
    this.failureStreaks.delete(`reactive:${args.session}`);

    const hops = this.reactiveHops.get(args.session) ?? [];
    hops.push(args.nowMs);
    const fresh = hops.filter((t) => args.nowMs - t <= k.reversalWindowMs);
    this.reactiveHops.set(args.session, fresh);
    if (fresh.length >= k.reactiveHopAlertThreshold) {
      const epId = `reactive-hops-${args.session}-${fresh[0]}`;
      if (!this.reactiveHopAlerted.has(epId)) {
        this.reactiveHopAlerted.add(epId);
        this.raiseAttention(
          `swap-antithrash-${epId}`,
          'Reactive account swaps are cascading',
          `Session "${args.session}" has emergency-hopped accounts ${fresh.length} times in the last ${Math.round(k.reversalWindowMs / 60000)} min — the pool is genuinely saturated (every hop was a forced rescue; the reactive guarantee is working, but there is no cool account to land on).`,
        );
      }
    }

    this.appendRow({
      ts: new Date(args.nowMs).toISOString(),
      kind: 'reactive',
      decision: 'swapped',
      callerClass: 'reactive-swap',
      session: args.session,
      machineId: this.machineId,
      from: args.from,
      to: args.to,
      ...(args.defaultAccountChanged ? { defaultAccountChanged: true } : {}),
    });
  }

  /** A REACTIVE swap was refused by the pre-existing refresh rate cap — the
   * one state where a session is stranded on a walled account (§3.1 trigger 2). */
  noteReactiveRateCapRefusal(session: string, nowMs: number): void {
    const epId = `reactive-ratecap-${session}`;
    if (!this.reactiveHopAlerted.has(epId)) {
      this.reactiveHopAlerted.add(epId);
      this.raiseAttention(
        `swap-antithrash-${epId}`,
        'Reactive rescue rate-capped — session stranded on a walled account',
        `Session "${session}" hit its account's rate limit but the refresh rate cap refused another swap this window (${new Date(nowMs).toISOString()}) — no further mechanical rescue exists until the window clears.`,
      );
    }
  }

  /** Record a swap-execution failure (§3.6). errorClass is a CONSTRUCTOR NAME
   * or fixed enum member ONLY — never .message/.stack. */
  recordExecFailure(args: {
    session: string;
    from: string;
    to?: string;
    kind: 'proactive' | 'reactive';
    errorClass: string;
    nowMs: number;
  }): void {
    const k = this.getKnobs();
    const key = `${args.kind}:${args.session}`;
    const s = this.failureStreaks.get(key);
    const streak: FailureStreak = s
      ? { ...s, count: s.count + 1, lastFailMs: args.nowMs }
      : { count: 1, firstFailMs: args.nowMs, lastFailMs: args.nowMs, alerted: false };
    this.failureStreaks.set(key, streak);
    if (args.kind === 'proactive') {
      // Exponential backoff, capped at dwellMs. Reactive NEVER backs off (I6).
      const backoff = Math.min(k.tickMs * Math.pow(2, streak.count), k.dwellMs);
      this.failureBackoffUntil.set(args.session, args.nowMs + backoff);
    }
    const episodeId = `failure-${args.kind}-${args.session}-${streak.firstFailMs}`;
    if (streak.count >= 3 && !streak.alerted) {
      streak.alerted = true;
      this.failureStreaks.set(key, streak);
      this.raiseAttention(
        `swap-antithrash-${episodeId}`,
        `${args.kind === 'reactive' ? 'Reactive' : 'Proactive'} account swap is failing repeatedly`,
        `Swap execution for session "${args.session}" has failed ${streak.count} consecutive times (${args.errorClass}).` +
          (args.kind === 'proactive' ? ' The session is in execution-failure backoff.' : ' Reactive rescue keeps retrying (never skipped).'),
      );
    }
    this.appendRow({
      ts: new Date(args.nowMs).toISOString(),
      kind: args.kind,
      decision: 'failed',
      callerClass: args.kind === 'proactive' ? 'proactive-swap' : 'reactive-swap',
      session: args.session,
      machineId: this.machineId,
      from: args.from,
      ...(args.to ? { to: args.to } : {}),
      reason: 'swap-exec-failed',
      errorClass: args.errorClass,
      episodeId,
      episodeKind: 'failure-streak',
    });
  }

  recordDeferred(args: {
    session: string;
    from: string;
    to: string;
    nowMs: number;
    reason: 'busy-turn' | 'busy-subagents' | 'busy-indeterminate';
    inFlight: { turn: boolean; subagents: number };
    subagentLeg: 'ok' | 'absent' | 'indeterminate';
    deferralAgeMs: number;
    deferCount: number;
    dryRun?: boolean;
    /** Dedup (§4.2): only the FIRST and FINAL rows are written per intent episode. */
    rowKind: 'first' | 'final';
  }): void {
    this.bumpRefusal(args.reason);
    this.appendRow({
      ts: new Date(args.nowMs).toISOString(),
      kind: 'proactive',
      decision: 'deferred',
      callerClass: 'proactive-swap',
      session: args.session,
      machineId: this.machineId,
      from: args.from,
      to: args.to,
      reason: args.reason,
      deferralAgeMs: args.deferralAgeMs,
      deferCount: args.deferCount,
      inFlight: args.inFlight,
      subagentLeg: args.subagentLeg,
      ...(args.dryRun ? { dryRun: true } : {}),
    });
  }

  recordDropped(args: {
    session: string;
    from: string;
    to: string;
    nowMs: number;
    deferralAgeMs: number;
    deferCount: number;
    inFlight: { turn: boolean; subagents: number };
    subagentLeg: 'ok' | 'absent' | 'indeterminate';
    dryRun?: boolean;
  }): void {
    this.droppedCount += 1;
    // Re-intent backoff clock-start (write-through regardless of append).
    this.lastDroppedAt.set(args.session, args.nowMs);
    this.appendRow({
      ts: new Date(args.nowMs).toISOString(),
      kind: 'proactive',
      decision: 'dropped',
      callerClass: 'proactive-swap',
      session: args.session,
      machineId: this.machineId,
      from: args.from,
      to: args.to,
      reason: 'deferral-ceiling-dropped',
      deferralAgeMs: args.deferralAgeMs,
      deferCount: args.deferCount,
      inFlight: args.inFlight,
      subagentLeg: args.subagentLeg,
      ...(args.dryRun ? { dryRun: true } : {}),
    });
  }

  recordInvalidated(args: {
    session: string;
    from: string;
    to?: string;
    nowMs: number;
    deferralAgeMs?: number;
    deferCount?: number;
    dryRun?: boolean;
  }): void {
    this.invalidatedCount += 1;
    this.appendRow({
      ts: new Date(args.nowMs).toISOString(),
      kind: 'proactive',
      decision: 'invalidated',
      callerClass: 'proactive-swap',
      session: args.session,
      machineId: this.machineId,
      from: args.from,
      ...(args.to ? { to: args.to } : {}),
      reason: 'intent-stale',
      ...(args.deferralAgeMs !== undefined ? { deferralAgeMs: args.deferralAgeMs } : {}),
      ...(args.deferCount !== undefined ? { deferCount: args.deferCount } : {}),
      ...(args.dryRun ? { dryRun: true } : {}),
    });
  }

  /** Execute-time revalidation refusal (§3.3 R4-m4 — refuse, never re-select). */
  recordRevalidationRefusal(args: {
    session: string;
    from: string;
    to: string;
    nowMs: number;
    reason: 'target-revalidation-failed' | 'intent-stale';
  }): void {
    if (args.reason === 'intent-stale') {
      this.invalidatedCount += 1;
      this.appendRow({
        ts: new Date(args.nowMs).toISOString(),
        kind: 'proactive',
        decision: 'invalidated',
        callerClass: 'proactive-swap',
        session: args.session,
        machineId: this.machineId,
        from: args.from,
        to: args.to,
        reason: 'intent-stale',
      });
      return;
    }
    this.bumpRefusal(args.reason);
    this.appendRow({
      ts: new Date(args.nowMs).toISOString(),
      kind: 'proactive',
      decision: 'refused',
      callerClass: 'proactive-swap',
      session: args.session,
      machineId: this.machineId,
      from: args.from,
      to: args.to,
      reason: args.reason,
    });
  }

  /** §4.5 interactive work-gate rows (kind 'interactive' — R6-m1). */
  recordInteractiveRefusal(args: {
    session: string;
    nowMs: number;
    inFlight: { turn: boolean; subagents: number };
    subagentLeg: 'ok' | 'absent' | 'indeterminate';
    dryRun?: boolean;
  }): void {
    this.bumpRefusal('session-busy');
    this.appendRow({
      ts: new Date(args.nowMs).toISOString(),
      kind: 'interactive',
      decision: 'refused',
      callerClass: 'interactive-refresh',
      session: args.session,
      machineId: this.machineId,
      from: '',
      reason: 'session-busy',
      inFlight: args.inFlight,
      subagentLeg: args.subagentLeg,
      ...(args.dryRun ? { dryRun: true } : {}),
    });
  }

  /** A forced kill proceeded over busy work — reactive-after-grace or force (§4.3). */
  recordProceeded(args: {
    session: string;
    kind: 'reactive' | 'interactive';
    callerClass: string;
    nowMs: number;
    from: string;
    to?: string;
    reason: 'busy-turn' | 'busy-subagents' | 'busy-indeterminate';
    inFlight: { turn: boolean; subagents: number };
    subagentLeg: 'ok' | 'absent' | 'indeterminate';
    killedSubagents?: number;
    killedSubagentList?: Array<{ agentType: string; ageMinutes: number; transcriptPath?: string }>;
    inbound: 'reinjected' | 'none' | 'unknown';
    force?: boolean;
    defaultAccountChanged?: boolean;
    dryRun?: boolean;
  }): void {
    this.proceededWithMitigations += 1;
    if (args.kind === 'reactive' && args.to) {
      // A reactive proceed IS an executed swap — dwell clock-start (R4-m1
      // write-through, regardless of append outcome).
      this.executions.push({ tsMs: args.nowMs, session: args.session, from: args.from, to: args.to, kind: 'reactive' });
      this.lastSwapAtBySession.set(args.session, args.nowMs);
    }
    // Unreadable ≠ zero (R5-M1): when the subagent leg is 'absent' the killed-
    // subagent fields are OMITTED, never an implicit empty list.
    const legAbsent = args.subagentLeg === 'absent';
    this.appendRow({
      ts: new Date(args.nowMs).toISOString(),
      kind: args.kind,
      decision: 'proceeded',
      callerClass: args.callerClass,
      session: args.session,
      machineId: this.machineId,
      from: args.from,
      ...(args.to ? { to: args.to } : {}),
      reason: args.reason,
      inFlight: args.inFlight,
      subagentLeg: args.subagentLeg,
      ...(!legAbsent && args.killedSubagents !== undefined ? { killedSubagents: args.killedSubagents } : {}),
      ...(!legAbsent && args.killedSubagentList ? { killedSubagentList: args.killedSubagentList } : {}),
      inbound: args.inbound,
      ...(args.force ? { force: true, authLevel: 'bearer' } : {}),
      ...(args.defaultAccountChanged ? { defaultAccountChanged: true } : {}),
      ...(args.dryRun ? { dryRun: true } : {}),
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Status (§6.3)
  // ─────────────────────────────────────────────────────────────────────────

  breakerState(): BreakerState {
    return this.breaker ? 'open' : 'closed';
  }

  /** In-memory count of `ledger-lost` refusals (the one refusal class that can
   *  never write its own row — the writer is what died, §3.5/I5). Supplied to
   *  the SwapLedger's outage-resume `outage-summary` row. */
  ledgerLostRefusalCount(): number {
    return this.ledgerLostRefusals;
  }

  isBreakerOpen(): boolean {
    return this.breaker !== null;
  }

  status(nowMs?: number): Record<string, unknown> {
    const ledgerStatus = this.ledger.status();
    const byReason: Record<string, number> = {};
    for (const [r, n] of this.refusalsByReason) byReason[r] = n;
    const streaks: Record<string, number> = {};
    for (const [k, s] of this.failureStreaks) streaks[k] = s.count;
    const k = this.getKnobs();
    const now = nowMs ?? this.now();
    return {
      refusals: { byReason },
      thrash: {
        reversalsDetected: this.reversalsDetected,
        pairLevelDetections: this.pairLevelDetections,
        frequencyCrossings: this.frequencyCrossings,
        breakerState: this.breakerState(),
        ...(this.breaker
          ? {
              breakerOpenedAt: new Date(this.breaker.openedAtMs).toISOString(),
              episodes: [
                {
                  episodeId: this.breaker.episodeId,
                  episodeKind: 'thrash-breaker' as EpisodeKind,
                  openedAt: new Date(this.breaker.openedAtMs).toISOString(),
                  expiresAt: new Date(this.breaker.deadlineMs).toISOString(),
                },
              ],
            }
          : { episodes: [] }),
      },
      execFailures: { bySession: streaks, streaks },
      deferrals: {
        dropped: this.droppedCount,
        invalidated: this.invalidatedCount,
        proceededWithMitigations: this.proceededWithMitigations,
      },
      hydration: ledgerStatus.hydration,
      corruptLinesSkipped: ledgerStatus.corruptLinesSkipped,
      ledger: {
        writable: ledgerStatus.writable,
        ...(ledgerStatus.lostSince ? { lostSince: ledgerStatus.lostSince } : {}),
        ledgerLostRefusals: this.ledgerLostRefusals,
        rowsLostWhileDown: ledgerStatus.rowsLostWhileDown,
      },
      quotaValidity: {
        freshnessMs: k.quotaFreshnessMs,
        measurementBlindSince: this.blindSinceMs !== null ? new Date(this.blindSinceMs).toISOString() : null,
      },
      retentionBoundMs: retentionBoundMs(k),
      scope: 'local',
      _now: new Date(now).toISOString(),
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Internals
  // ─────────────────────────────────────────────────────────────────────────

  private mostRecentExecution(session: string, nowMs: number, windowMs: number): ExecutionRecord | null {
    let best: ExecutionRecord | null = null;
    for (const e of this.executions) {
      if (e.session !== session) continue;
      if (nowMs - e.tsMs > windowMs) continue;
      if (!best || e.tsMs > best.tsMs) best = e;
    }
    return best;
  }

  /** Add a T1 inversion-class increment; open the breaker when the pool-wide
   * count inside reversalWindowMs reaches the threshold. The increment ROW is
   * the open marker (R3-m2) — stamped with the episode fields at append time. */
  private addInversionIncrement(nowMs: number, k: AntiThrashKnobs, row: SwapLedgerRow, sig: TriggerSignature): void {
    this.inversionIncrementsMs.push(nowMs);
    this.inversionIncrementsMs = this.inversionIncrementsMs.filter((t) => nowMs - t <= k.reversalWindowMs);
    if (this.inversionIncrementsMs.length >= k.thrashBreakerThreshold && !this.breaker) {
      this.openBreaker(nowMs, k, row, sig);
    }
  }

  private openBreaker(nowMs: number, k: AntiThrashKnobs, openMarkerRow: SwapLedgerRow, sig: TriggerSignature): void {
    const sigKey = signatureKey(sig);
    const contWindow = sig.tier === 'T2' ? k.swapFrequencyWindowMs : k.reversalWindowMs;
    const cont = this.continuationMemory.get(sigKey);
    const isContinuation = cont !== undefined && nowMs - cont.closedAtMs <= contWindow;
    const episodeId = isContinuation ? cont.episodeId : `thrash-${nowMs}-${Math.random().toString(36).slice(2, 8)}`;
    const deadlineMs = nowMs + k.thrashBreakerBackoffMs;
    this.breaker = { episodeId, openedAtMs: nowMs, deadlineMs, signature: sig };
    // Stamp the open-marker row (the increment row that crossed the trigger).
    openMarkerRow.episodeId = episodeId;
    openMarkerRow.episodeKind = 'thrash-breaker';
    openMarkerRow.breakerOpenedAt = new Date(nowMs).toISOString();
    openMarkerRow.breakerDeadline = new Date(deadlineMs).toISOString();
    openMarkerRow.triggerSignature = sig;
    if (!this.alertedEpisodeIds.has(episodeId)) {
      this.alertedEpisodeIds.add(episodeId);
      this.raiseAttention(
        `swap-antithrash-${episodeId}`,
        'Proactive account-swap is thrashing — suppressed',
        `The thrash breaker opened (${sig.tier === 'T2' ? `session "${sig.session}" hit the swap-frequency threshold` : `account pair ${sig.pair} reversed within the window`}). ` +
          `Proactive swaps are suppressed for ${Math.round(k.thrashBreakerBackoffMs / 60000)} min; reactive rescue is unaffected.`,
      );
    }
    this.logger.warn(
      `[SwapAntiThrash] thrash breaker OPEN (${sig.tier}, episode ${episodeId}) — proactive swaps suppressed until ${new Date(deadlineMs).toISOString()}`,
    );
  }

  private recordBreakerSuppression(input: ProactiveIntentInput, nowMs: number, k: AntiThrashKnobs): void {
    this.bumpRefusal('thrash-breaker');
    if (!this.breaker) return;
    const key = `${this.breaker.episodeId}:${input.session}`;
    const prev = this.breakerSuppressionRows.get(key);
    let transition: 'enter' | 'heartbeat' | null = null;
    if (!prev) transition = 'enter';
    else if (nowMs - prev.lastRowMs >= k.allHotHeartbeatMs) transition = 'heartbeat';
    if (transition) {
      this.breakerSuppressionRows.set(key, { lastRowMs: nowMs });
      this.appendRow({
        ts: new Date(nowMs).toISOString(),
        kind: 'proactive',
        decision: 'refused',
        callerClass: 'proactive-swap',
        session: input.session,
        machineId: this.machineId,
        from: input.fromAccountId,
        reason: 'thrash-breaker',
        transition,
        episodeId: this.breaker.episodeId,
        episodeKind: 'thrash-breaker',
        breakerOpenedAt: new Date(this.breaker.openedAtMs).toISOString(),
        breakerDeadline: new Date(this.breaker.deadlineMs).toISOString(),
        triggerSignature: this.breaker.signature,
      });
    }
  }

  /** all-hot / target-unmeasured refusals use state-transition rows (§3.1). */
  private recordStateRefusal(
    input: ProactiveIntentInput,
    reason: 'all-hot' | 'target-unmeasured',
    nowMs: number,
    k: AntiThrashKnobs,
    unmeasuredAlternates: number,
  ): void {
    this.bumpRefusal(reason);
    const prev = this.stateRows.get(input.session);
    let transition: 'enter' | 'heartbeat' | null = null;
    let entry: StateRowEntry;
    if (!prev || prev.reason !== reason) {
      if (prev && prev.reason !== reason) {
        // reason change: leave the old state first
        this.appendRow({
          ts: new Date(nowMs).toISOString(),
          kind: 'proactive',
          decision: 'refused',
          callerClass: 'proactive-swap',
          session: input.session,
          machineId: this.machineId,
          from: input.fromAccountId,
          reason: prev.reason,
          transition: 'leave',
          episodeId: prev.episodeId,
          episodeKind: prev.reason === 'all-hot' ? 'all-hot' : 'measurement-blind',
        });
      }
      transition = 'enter';
      entry = {
        reason,
        enteredAtMs: nowMs,
        lastRowMs: nowMs,
        episodeId: `${reason}-${input.session}-${nowMs}`,
        touchedTick: this.tickSeq,
      };
    } else {
      entry = { ...prev, touchedTick: this.tickSeq };
      if (nowMs - prev.lastRowMs >= k.allHotHeartbeatMs) {
        transition = 'heartbeat';
        entry.lastRowMs = nowMs;
      }
    }
    this.stateRows.set(input.session, entry);
    if (transition) {
      this.appendRow({
        ts: new Date(nowMs).toISOString(),
        kind: 'proactive',
        decision: 'refused',
        callerClass: 'proactive-swap',
        session: input.session,
        machineId: this.machineId,
        from: input.fromAccountId,
        reason,
        transition,
        episodeId: entry.episodeId,
        episodeKind: reason === 'all-hot' ? 'all-hot' : 'measurement-blind',
        ...(reason === 'target-unmeasured' ? { unmeasuredAlternates } : {}),
        ...(input.deferralAgeMs !== undefined ? { deferralAgeMs: input.deferralAgeMs } : {}),
      });
    }
  }

  private recordSimpleRefusal(
    input: ProactiveIntentInput,
    reason: SwapReason,
    nowMs: number,
    extra: Partial<SwapLedgerRow>,
  ): void {
    this.bumpRefusal(reason);
    this.appendRow(this.buildRefusalRow(input, reason, nowMs, extra));
  }

  private buildRefusalRow(
    input: ProactiveIntentInput,
    reason: SwapReason,
    nowMs: number,
    extra: Partial<SwapLedgerRow>,
  ): SwapLedgerRow {
    return {
      ts: new Date(nowMs).toISOString(),
      kind: 'proactive',
      decision: 'refused',
      callerClass: 'proactive-swap',
      session: input.session,
      machineId: this.machineId,
      from: input.fromAccountId,
      reason,
      ...extra,
    };
  }

  private appendRow(row: SwapLedgerRow): void {
    const k = this.getKnobs();
    if (k.dryRun && row.dryRun === undefined && (row.decision === 'refused' || row.decision === 'deferred' || row.decision === 'dropped' || row.decision === 'invalidated')) {
      // Rung-2 honesty: a would-decision under dryRun is marked as such.
      row.dryRun = true;
    }
    this.ledger.append(row);
    this.logRow(row);
  }

  private logRow(row: SwapLedgerRow): void {
    if (row.decision === 'refused' && row.reason) {
      this.logger.log(
        `[ProactiveSwap] ${row.dryRun ? 'WOULD-REFUSE' : 'REFUSED'} session=${row.session} from=${row.from} reason=${row.reason}` +
          (row.fromUtilPct !== undefined ? ` fromUtil=${row.fromUtilPct}` : '') +
          (row.toUtilPct !== undefined ? ` bestAltUtil=${row.toUtilPct}` : ''),
      );
    } else if (row.decision === 'deferred') {
      this.logger.log(
        `[SwapWorkGate] ${row.dryRun ? 'WOULD-DEFER' : 'DEFERRED'} session=${row.session} caller=proactive-swap reason=${row.reason}` +
          (row.inFlight ? `(${row.inFlight.subagents})` : '') +
          ` deferralAgeMs=${row.deferralAgeMs ?? 0}`,
      );
    } else if (row.decision === 'proceeded') {
      this.logger.log(
        `[SwapWorkGate] PROCEEDED-WITH-MITIGATIONS session=${row.session} caller=${row.callerClass} killedSubagents=${row.killedSubagents ?? 'unreadable'} inbound=${row.inbound}`,
      );
    }
  }

  private bumpRefusal(reason: string): void {
    this.refusalsByReason.set(reason, (this.refusalsByReason.get(reason) ?? 0) + 1);
  }

  private ledgerLostAlerted = false;
  private raiseLedgerLostAttention(): void {
    if (this.ledgerLostAlerted) return;
    this.ledgerLostAlerted = true;
    this.raiseAttention(
      'swap-antithrash-ledger-lost',
      'Swap ledger unwritable — proactive optimization paused',
      'The swap-decision ledger cannot be written (disk error?). Every anti-thrash brake depends on it, so proactive account swapping is PAUSED until writes recover (level-triggered — no restart needed). Reactive rescue is unaffected.',
    );
  }
}

// ── helpers ─────────────────────────────────────────────────────────────────

export function pairKey(a: string, b: string): string {
  return [a, b].sort().join('|');
}

export function signatureKey(sig: TriggerSignature): string {
  return sig.tier === 'T2' ? `T2:${sig.session ?? ''}` : `T1:${sig.pair ?? ''}`;
}
