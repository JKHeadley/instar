/**
 * MeteredSpendLedger — Layer 3 of the Routing Control Room
 * (docs/specs/routing-control-room-spend-alerts.md, Increment B).
 *
 * The AUTHORITATIVE money truth: an append-only, booking-priced ledger of every
 * metered-door reservation/settlement, plus a maintained O(1) committed total the
 * fail-closed gate reads. This ledger — NOT `feature_metrics`, NOT the Layer-1c
 * provider-report store — is the ONLY rebuild source for committed spend
 * (FD-3/FD-9): rebuilding from Layer 0 joined to current prices is FORBIDDEN at
 * the gate (a downward `corrects` would re-open capped headroom).
 *
 * Write discipline (adopted from DriftSpendLedger, upgraded per spec C4-2):
 *  - Rows are APPEND-ONLY JSONL, fsync'd, written FIRST; the totals file is a
 *    regenerable CACHE of the fold, rewritten atomically (tmp+rename) SECOND.
 *    A crash between the two leaves totals STALE-LOW by at most one booking; the
 *    next gate read runs a cheap high-water check (file size) and re-folds.
 *  - Writes are FAIL-CLOSED and NON-SWALLOWING: a booking that cannot be durably
 *    persisted throws, and the caller must refuse the metered call.
 *  - Boot: fold all rows, REWRITE the totals cache from row truth (torn totals
 *    rename / totals-without-append are always corrected; the append-first
 *    ordering makes totals-without-append impossible, asserted in tests).
 *  - A torn trailing append (partial last line) is the malformed-row-skip case.
 *
 * Reserve/settle lifecycle (A-B2/A2-1):
 *  - reserve(): books the worst-case estimate (cached tokens as FULL input,
 *    FD-19; output at the REQUIRED max-tokens ceiling). Outstanding reserves are
 *    INSIDE the committed total (concurrent reservations see each other).
 *  - settle(): idempotent terminal `reserved → settled`; books ACTUAL cost.
 *    A settle after expiry books the actual cost as a fresh ABSOLUTE row
 *    (expiry-aware settle) — the late-settle race can never under-count.
 *  - expire(): the reserve-expiry sweep (takes the per-key mutex) expires only
 *    reserves older than the TTL still in `reserved` state.
 *  - First terminal transition wins; the loser is a no-op.
 *
 * Concurrency: metered calls funnel through the single server process, so the
 * booking critical sections are guarded by an in-process async mutex per keyRef
 * (held only for the booking, RELEASED during the LLM round-trip) plus a
 * proper-lockfile advisory lock for defence against a second process.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import lockfile from 'proper-lockfile';

const LOCK_OPTIONS: lockfile.LockOptions = {
  retries: { retries: 50, factor: 1.2, minTimeout: 50, maxTimeout: 500 },
  stale: 10_000,
  realpath: false,
};

/** Default reserve TTL — pinned comfortably above the metered-call latency ceiling (spec: 15 min vs a 5-min call ceiling). */
export const DEFAULT_RESERVE_TTL_MS = 15 * 60 * 1000;

/**
 * Doors whose reserve EXPIRY books the full reserve as PROVISIONAL instead of
 * today's $0 (gemini-payg §5 settle table): a crash after the request was sent
 * cannot prove the provider did not bill. Every other door keeps the $0 fold.
 */
export const PROVISIONAL_EXPIRY_DOORS: ReadonlySet<string> = new Set(['gemini-api']);

export type MeteredBookingKind = 'reserve' | 'settle' | 'expire' | 'provisional';

/** One append-only booking row. NEVER mutated; corrections are new rows. */
export interface MeteredBookingRow {
  ts: string;
  keyRef: string;
  door: string;
  modelId: string;
  kind: MeteredBookingKind;
  /** The per-call id (=== meteredCallId) minted at reserve time. */
  reserveId: string;
  /**
   * Reserve: worst-case estimate. Settle: ACTUAL booked cost. Expire: 0 (or, on a
   * provisional-expiry door, the reserve amount booked provisional). Provisional:
   * the full reserve.
   */
  costUsd: number;
  /** The metered-lease epoch the booking was made under (A-B4). */
  leaseEpoch: number;
  /** Set on a settle that arrived after its reserve was expired (books absolute). */
  lateAfterExpire?: boolean;
  /**
   * The CHARGED period, computed at reserve time in the key's zone and
   * inherited by every later row for the same reservation — never recomputed,
   * so a zone change cannot move an existing commitment (gemini-payg §5).
   * Absent on pre-change rows: the fold then uses the row's UTC day/month.
   */
  dayEpoch?: string;
  monthEpoch?: string;
  /** Zone the charged period was computed in (reserve rows; absent ⇒ UTC). */
  periodTimeZone?: string;
  /** Attribution + idempotency (gemini-payg §2/§5/§6). */
  callId?: string;
  requestSha256?: string;
  component?: string;
  caller?: string;
  run?: string;
  tier?: string;
  pricePointId?: string;
  /** `${specSha256}#${round}` — the E1 pass slot this reservation occupies. */
  e1PassKey?: string;
  /** The booking rates the reserve was priced at — settle prices usage at these (the reserved point). */
  bookedInPerMtok?: number;
  bookedOutPerMtok?: number;
  /** A confirmed no-charge settle (releases an E1 slot). */
  noCharge?: boolean;
  /** A settle that reconciles an earlier provisional booking: only the excess books. */
  afterProvisional?: boolean;
  bookedExcessUsd?: number;
  /** An expire row on a provisional-expiry door. */
  provisional?: boolean;
}

/** The maintained O(1) running totals (a regenerable cache of the fold). */
export interface MeteredCommittedTotals {
  keyRef: string;
  committedLifetimeUsd: number;
  committedDayUsd: number;
  /** Day (YYYY-MM-DD, in the key's period zone) the day total belongs to; a new day resets it. */
  dayEpoch: string;
  /** Month (YYYY-MM, in the key's period zone) the month total belongs to. */
  committedMonthUsd: number;
  monthEpoch: string;
  /** Unresolved provisional bookings charged to the current month. */
  provisionalMonthUsd: number;
  /** All reservations still outstanding (any period). */
  outstandingReserveUsd: number;
  /** E2 (caller `second-opinion`) committed in the current month / day. */
  e2MonthUsd: number;
  e2DayUsd: number;
  updatedAt: string;
}

interface TotalsFile {
  /** High-water mark: byte length of the rows file when this cache was written. */
  rowsBytes: number;
  totals: Record<string, MeteredCommittedTotals>;
}

/**
 * The limits checked atomically inside the per-key critical section. Every
 * field is optional; absent ⇒ not checked. Strict `committed + reserve > cap`.
 */
export interface AdmitCaps {
  lifetimeCapUsd?: number;
  monthlyCapUsd?: number;
  dailyCapUsd?: number;
  perCallCeilingUsd?: number;
  provisionalCeilingUsd?: number;
  /** E2 share limits — counted only when the reservation's caller is `second-opinion`. */
  e2?: { monthCapUsd?: number; dayCapUsd?: number };
  /** E1 passes allowed per `e1PassKey` (only checked when the request carries one). */
  e1PassLimit?: number;
}

export interface ReserveRequest {
  keyRef: string;
  door: string;
  modelId: string;
  /** Worst-case reserve in USD (computed by the gate at canonical BASE price). */
  reserveUsd: number;
  leaseEpoch: number;
  /**
   * When set, the cap comparison happens ATOMICALLY inside the per-key booking
   * critical section (`committed + reserve > cap` strict `>`) — the only
   * ordering under which two concurrent reservations are guaranteed to see
   * each other (spec Layer 3). Refusal throws CapExceededError; nothing books.
   */
  admitOnlyUnderCaps?: AdmitCaps;
  /**
   * Policy re-read INSIDE the lock (gemini-payg §5 step 5): called after the
   * callId dedupe and before any cap check. It may throw (the refusal
   * propagates; nothing books) and may return fresh caps that replace
   * `admitOnlyUnderCaps`, so a caller disabled or a cap lowered while the
   * token count ran is honoured at the moment of booking.
   */
  revalidateUnderLock?: () => AdmitCaps | void;
  /** IANA zone for the charged period (absent ⇒ UTC). */
  periodTimeZone?: string;
  callId?: string;
  requestSha256?: string;
  component?: string;
  caller?: string;
  run?: string;
  tier?: string;
  pricePointId?: string;
  e1PassKey?: string;
  bookedInPerMtok?: number;
  bookedOutPerMtok?: number;
}

export type CapKind = 'lifetime' | 'daily' | 'monthly' | 'e2-month' | 'e2-day' | 'per-call' | 'provisional';

/** Thrown by reserve() when admitOnlyUnderCaps would be breached — nothing was booked. */
export class CapExceededError extends Error {
  /** Settled (non-outstanding) spend in the period. */
  public settledUsd: number;
  public outstandingUsd: number;
  /**
   * True when committed + reserve breaches the cap but SETTLED + reserve would
   * not — the caller should retry shortly (`reserves-outstanding`), not give up.
   */
  public reservesOutstanding: boolean;
  public retryAfterSec: number | null;
  /** The period's reset instant (ISO), or null for lifetime/per-call. */
  public resetsAt: string | null;
  constructor(
    public capKind: CapKind,
    public committedUsd: number,
    public reserveUsd: number,
    public capUsd: number,
    extra?: { settledUsd?: number; outstandingUsd?: number; reservesOutstanding?: boolean; retryAfterSec?: number | null; resetsAt?: string | null },
  ) {
    super(`${capKind}: committed ${committedUsd.toFixed(4)} + reserve ${reserveUsd.toFixed(4)} > cap ${capUsd.toFixed(2)}`);
    this.name = 'CapExceededError';
    this.settledUsd = extra?.settledUsd ?? committedUsd;
    this.outstandingUsd = extra?.outstandingUsd ?? 0;
    this.reservesOutstanding = extra?.reservesOutstanding ?? false;
    this.retryAfterSec = extra?.retryAfterSec ?? null;
    this.resetsAt = extra?.resetsAt ?? null;
  }
}

/** Same callId, different request digest — never folded onto the existing call. */
export class CallIdConflictError extends Error {
  constructor(public callId: string) {
    super(`callId '${callId}' is already bound to a different request`);
    this.name = 'CallIdConflictError';
  }
}

/** The E1 (specSha256, round) pass slots are all taken. */
export class E1PassLimitError extends Error {
  constructor(public e1PassKey: string, public used: number, public limit: number) {
    super(`E1 pass limit reached for ${e1PassKey} (${used}/${limit})`);
    this.name = 'E1PassLimitError';
  }
}

export type ReservationState = 'reserved' | 'settled' | 'expired' | 'provisional';

export interface ReserveHandle {
  reserveId: string;
  /** Committed lifetime total AFTER this reservation (outstanding reserves included). */
  committedLifetimeUsd: number;
  committedDayUsd: number;
  committedMonthUsd: number;
  dayEpoch: string;
  monthEpoch: string;
  /** True when this was an existing call returned by callId dedupe (nothing new booked). */
  deduped?: boolean;
  state: ReservationState;
}

/** A read-only view of one reservation, folded from rows (survives restart). */
export interface ReservationView {
  reserveId: string;
  keyRef: string;
  door: string;
  modelId: string;
  reserveUsd: number;
  state: ReservationState;
  /** What this reservation currently contributes to committed spend. */
  contributionUsd: number;
  dayEpoch: string;
  monthEpoch: string;
  callId?: string;
  requestSha256?: string;
  component?: string;
  caller?: string;
  run?: string;
  tier?: string;
  pricePointId?: string;
  e1PassKey?: string;
  bookedInPerMtok?: number;
  bookedOutPerMtok?: number;
}

export class MeteredLedgerWriteError extends Error {
  constructor(msg: string, public cause?: unknown) {
    super(`metered-spend ledger write failed (fail-closed): ${msg}`);
    this.name = 'MeteredLedgerWriteError';
  }
}

interface ReserveState {
  keyRef: string;
  door: string;
  modelId: string;
  reserveUsd: number;
  /** The CHARGED day / month (see MeteredBookingRow.dayEpoch). */
  day: string;
  month: string;
  zone: string;
  reservedAtMs: number;
  state: ReservationState;
  /** Settled: the total contribution (for a settle after provisional: max(provisional, actual)). */
  settledUsd?: number;
  /** The amount booked provisional (sunk). */
  provisionalUsd?: number;
  noCharge?: boolean;
  callId?: string;
  requestSha256?: string;
  component?: string;
  caller?: string;
  run?: string;
  tier?: string;
  pricePointId?: string;
  e1PassKey?: string;
  bookedInPerMtok?: number;
  bookedOutPerMtok?: number;
}

function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();

/**
 * The charged day (YYYY-MM-DD) and month (YYYY-MM) of an instant in an IANA
 * zone, computed with Intl (DST-correct). UTC takes the exact pre-change path.
 */
export function periodEpochs(ms: number, timeZone = 'UTC'): { dayEpoch: string; monthEpoch: string } {
  if (timeZone === 'UTC') {
    const d = utcDay(ms);
    return { dayEpoch: d, monthEpoch: d.slice(0, 7) };
  }
  let f = fmtCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
    fmtCache.set(timeZone, f);
  }
  const parts = f.formatToParts(new Date(ms));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '00';
  const dayEpoch = `${get('year')}-${get('month')}-${get('day')}`;
  return { dayEpoch, monthEpoch: dayEpoch.slice(0, 7) };
}

/**
 * The first instant after `ms` at which the day (or month) epoch in `timeZone`
 * changes — the `resetsAt` a refusal names. Binary search over a bounded
 * window; exact to the millisecond.
 */
export function nextPeriodBoundaryMs(ms: number, timeZone: string, kind: 'day' | 'month'): number {
  const pick = (t: number) => (kind === 'day' ? periodEpochs(t, timeZone).dayEpoch : periodEpochs(t, timeZone).monthEpoch);
  const cur = pick(ms);
  let lo = ms;
  let hi = ms + (kind === 'day' ? 2 : 33) * 86_400_000;
  // Invariant: pick(lo) === cur, pick(hi) !== cur. Converge to the exact millisecond.
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (pick(mid) === cur) lo = mid;
    else hi = mid;
  }
  return hi;
}

export interface MeteredSpendLedgerOptions {
  /** The agent's `.instar/` dir; rows/totals live under `state/`, the lock under `local/`. */
  stateDir: string;
  reserveTtlMs?: number;
  now?: () => number;
  /**
   * The current period zone of a key (from the PIN caps store). Absent, or
   * returning undefined ⇒ the zone of the key's most recent reservation, else
   * UTC. Only decides which period is "current" for the totals; every row
   * keeps the period it was charged to.
   */
  zoneForKey?: (keyRef: string) => string | undefined;
}

export class MeteredSpendLedger {
  private readonly rowsPath: string;
  private readonly totalsPath: string;
  private readonly lockTarget: string;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly zoneForKeyOpt?: (keyRef: string) => string | undefined;

  /** In-memory fold state, authoritative in-process. Rebuilt on construction. */
  private reserves = new Map<string, ReserveState>();
  private totals = new Map<string, MeteredCommittedTotals>();
  /** callId → reserveId, folded from reserve rows (dedupe survives restart). */
  private callIndex = new Map<string, string>();
  /** keyRef → zone of its most recent reservation. */
  private lastZone = new Map<string, string>();
  /** Byte length of the rows file as of our last append/fold (the high-water mark). */
  private rowsBytes = 0;
  /** In-process per-key mutex tail. */
  private mutexTail = new Map<string, Promise<void>>();

  constructor(opts: MeteredSpendLedgerOptions) {
    const stateSub = path.join(opts.stateDir, 'state');
    const localSub = path.join(opts.stateDir, 'local');
    fs.mkdirSync(stateSub, { recursive: true });
    fs.mkdirSync(localSub, { recursive: true });
    this.rowsPath = path.join(stateSub, 'metered-spend-ledger.jsonl');
    this.totalsPath = path.join(stateSub, 'metered-spend-totals.json');
    this.lockTarget = path.join(localSub, 'metered-spend.lock');
    if (!fs.existsSync(this.lockTarget)) fs.writeFileSync(this.lockTarget, '');
    this.ttlMs = opts.reserveTtlMs ?? DEFAULT_RESERVE_TTL_MS;
    this.now = opts.now ?? (() => Date.now());
    this.zoneForKeyOpt = opts.zoneForKey;
    // Boot: the fold is canon — rebuild from rows and REWRITE the totals cache.
    this.refoldFromRows();
    this.rewriteTotalsCache();
  }

  // ── Public API ─────────────────────────────────────────────────────

  /** O(1) committed totals for a key, period-rolled to NOW. High-water-checked against external appends. */
  committed(keyRef: string): MeteredCommittedTotals {
    this.checkHighWater();
    return this.currentTotals(keyRef);
  }

  /** The reservation a callId is bound to, folded from rows (so it survives restart). */
  lookupCall(callId: string): ReservationView | null {
    this.checkHighWater();
    const id = this.callIndex.get(callId);
    return id ? this.reservation(id) : null;
  }

  /** A read-only view of one reservation. */
  reservation(reserveId: string): ReservationView | null {
    const st = this.reserves.get(reserveId);
    if (!st) return null;
    return {
      reserveId,
      keyRef: st.keyRef,
      door: st.door,
      modelId: st.modelId,
      reserveUsd: st.reserveUsd,
      state: st.state,
      contributionUsd: round6(this.contribution(st)),
      dayEpoch: st.day,
      monthEpoch: st.month,
      ...(st.callId ? { callId: st.callId } : {}),
      ...(st.requestSha256 ? { requestSha256: st.requestSha256 } : {}),
      ...(st.component ? { component: st.component } : {}),
      ...(st.caller ? { caller: st.caller } : {}),
      ...(st.run ? { run: st.run } : {}),
      ...(st.tier ? { tier: st.tier } : {}),
      ...(st.pricePointId ? { pricePointId: st.pricePointId } : {}),
      ...(st.e1PassKey ? { e1PassKey: st.e1PassKey } : {}),
      ...(st.bookedInPerMtok !== undefined ? { bookedInPerMtok: st.bookedInPerMtok } : {}),
      ...(st.bookedOutPerMtok !== undefined ? { bookedOutPerMtok: st.bookedOutPerMtok } : {}),
    };
  }

  /** Reserve worst-case cost. FAIL-CLOSED: any persistence failure throws. */
  async reserve(req: ReserveRequest): Promise<ReserveHandle> {
    if (!Number.isFinite(req.reserveUsd) || req.reserveUsd < 0) {
      throw new MeteredLedgerWriteError(`invalid reserveUsd ${req.reserveUsd}`);
    }
    return this.withKeyMutex(req.keyRef, async () => {
      this.checkHighWater();
      // Step 0 — callId dedupe, FIRST: an already-admitted call is returned as-is
      // and is never refused by a cap, a freeze or a disabled caller (§5 step 6).
      if (req.callId) {
        const existingId = this.callIndex.get(req.callId);
        const existing = existingId ? this.reserves.get(existingId) : undefined;
        if (existingId && existing) {
          // A resubmission must be the SAME call: same key, door and request digest
          // (§5 step 6 "with a matching … digest"). Anything else is a conflict,
          // never a returned call.
          if (
            existing.keyRef !== req.keyRef ||
            existing.door !== req.door ||
            !req.requestSha256 ||
            !existing.requestSha256 ||
            req.requestSha256 !== existing.requestSha256
          ) {
            throw new CallIdConflictError(req.callId);
          }
          const t = this.currentTotals(req.keyRef);
          return {
            reserveId: existingId,
            committedLifetimeUsd: t.committedLifetimeUsd,
            committedDayUsd: t.committedDayUsd,
            committedMonthUsd: t.committedMonthUsd,
            dayEpoch: existing.day,
            monthEpoch: existing.month,
            deduped: true,
            state: existing.state,
          };
        }
      }
      const nowMs = this.now();
      const zone = req.periodTimeZone ?? 'UTC';
      const { dayEpoch, monthEpoch } = periodEpochs(nowMs, zone);
      // Policy re-read INSIDE the lock (§5 step 5).
      const fresh = req.revalidateUnderLock ? req.revalidateUnderLock() : undefined;
      const caps = fresh ?? req.admitOnlyUnderCaps;
      if (caps) this.checkCapsLocked(req, caps, nowMs, zone, dayEpoch, monthEpoch);
      const reserveId = crypto.randomBytes(12).toString('hex');
      const row: MeteredBookingRow = {
        ts: new Date(nowMs).toISOString(),
        keyRef: req.keyRef,
        door: req.door,
        modelId: req.modelId,
        kind: 'reserve',
        reserveId,
        costUsd: round6(req.reserveUsd),
        leaseEpoch: req.leaseEpoch,
        dayEpoch,
        monthEpoch,
        ...(zone !== 'UTC' ? { periodTimeZone: zone } : {}),
        ...(req.callId ? { callId: req.callId } : {}),
        ...(req.requestSha256 ? { requestSha256: req.requestSha256 } : {}),
        ...(req.component ? { component: req.component } : {}),
        ...(req.caller ? { caller: req.caller } : {}),
        ...(req.run ? { run: req.run } : {}),
        ...(req.tier ? { tier: req.tier } : {}),
        ...(req.pricePointId ? { pricePointId: req.pricePointId } : {}),
        ...(req.e1PassKey ? { e1PassKey: req.e1PassKey } : {}),
        ...(req.bookedInPerMtok !== undefined ? { bookedInPerMtok: req.bookedInPerMtok } : {}),
        ...(req.bookedOutPerMtok !== undefined ? { bookedOutPerMtok: req.bookedOutPerMtok } : {}),
      };
      await this.appendDurable(row);
      this.applyRow(row);
      this.rewriteTotalsCache();
      const t = this.currentTotals(req.keyRef);
      return {
        reserveId,
        committedLifetimeUsd: t.committedLifetimeUsd,
        committedDayUsd: t.committedDayUsd,
        committedMonthUsd: t.committedMonthUsd,
        dayEpoch,
        monthEpoch,
        state: 'reserved',
      };
    });
  }

  /**
   * Terminal settle at ACTUAL cost. Idempotent: a second settle is a no-op.
   * A settle after expiry books the actual as a fresh ABSOLUTE row (late-settle)
   * — except after a PROVISIONAL booking, where the fold keeps
   * max(provisional, actual) and the row books only the excess (never a fresh
   * full row; a lower actual never returns headroom — parent FD-21).
   */
  async settle(keyRef: string, reserveId: string, actualUsd: number, opts?: { noCharge?: boolean }): Promise<void> {
    if (!Number.isFinite(actualUsd) || actualUsd < 0) {
      throw new MeteredLedgerWriteError(`invalid actualUsd ${actualUsd}`);
    }
    return this.withKeyMutex(keyRef, async () => {
      const st = this.reserves.get(reserveId);
      if (st && st.state === 'settled') return; // first terminal wins — no-op
      const afterProvisional = st?.state === 'provisional';
      const lateAfterExpire = st?.state === 'expired';
      // A late settle after a $0 expiry books on the SETTLE's own period (pre-change
      // behaviour, which the zone-stamped row now records); every other settle
      // inherits the reserve's charged period.
      const period = st && !lateAfterExpire ? { dayEpoch: st.day, monthEpoch: st.month } : periodEpochs(this.now(), st?.zone ?? 'UTC');
      const row: MeteredBookingRow = {
        ts: new Date(this.now()).toISOString(),
        keyRef,
        door: st?.door ?? 'unknown',
        modelId: st?.modelId ?? 'unknown',
        kind: 'settle',
        reserveId,
        costUsd: round6(actualUsd),
        leaseEpoch: 0,
        dayEpoch: period.dayEpoch,
        monthEpoch: period.monthEpoch,
        ...(lateAfterExpire ? { lateAfterExpire: true } : {}),
        ...(afterProvisional
          ? { afterProvisional: true, bookedExcessUsd: round6(Math.max(0, actualUsd - (st?.provisionalUsd ?? 0))) }
          : {}),
        ...(opts?.noCharge ? { noCharge: true } : {}),
      };
      await this.appendDurable(row);
      this.applyRow(row);
      this.rewriteTotalsCache();
    });
  }

  /**
   * Book a PROVISIONAL charge at the full reserve (gemini-payg §5: a 5xx,
   * timeout, abort or drop AFTER the request was sent — we cannot prove the
   * provider did not bill). Only a `reserved` reservation transitions; anything
   * else is a no-op. A later actual settle reconciles with max(provisional, actual).
   */
  async settleProvisional(keyRef: string, reserveId: string): Promise<void> {
    return this.withKeyMutex(keyRef, async () => {
      const st = this.reserves.get(reserveId);
      if (!st || st.state !== 'reserved') return;
      const row: MeteredBookingRow = {
        ts: new Date(this.now()).toISOString(),
        keyRef,
        door: st.door,
        modelId: st.modelId,
        kind: 'provisional',
        reserveId,
        costUsd: round6(st.reserveUsd),
        leaseEpoch: 0,
        dayEpoch: st.day,
        monthEpoch: st.month,
      };
      await this.appendDurable(row);
      this.applyRow(row);
      this.rewriteTotalsCache();
    });
  }

  /** Reserve-expiry sweep (Layer 3 — takes the per-key mutex). Expires only TTL-stale `reserved` states. */
  async sweepExpired(): Promise<number> {
    const nowMs = this.now();
    let expired = 0;
    // Group stale reserves by key so each key's bookings stay serialized.
    const byKey = new Map<string, Array<{ id: string; st: ReserveState }>>();
    for (const [id, st] of this.reserves) {
      if (st.state !== 'reserved') continue;
      if (nowMs - st.reservedAtMs <= this.ttlMs) continue;
      const arr = byKey.get(st.keyRef) ?? [];
      arr.push({ id, st });
      byKey.set(st.keyRef, arr);
    }
    for (const [keyRef, stales] of byKey) {
      await this.withKeyMutex(keyRef, async () => {
        for (const { id, st } of stales) {
          if (st.state !== 'reserved') continue; // settled while we waited — first terminal wins
          const provisional = PROVISIONAL_EXPIRY_DOORS.has(st.door);
          const row: MeteredBookingRow = {
            ts: new Date(this.now()).toISOString(),
            keyRef,
            door: st.door,
            modelId: st.modelId,
            kind: 'expire',
            reserveId: id,
            costUsd: provisional ? round6(st.reserveUsd) : 0,
            leaseEpoch: 0,
            dayEpoch: st.day,
            monthEpoch: st.month,
            ...(provisional ? { provisional: true } : {}),
          };
          await this.appendDurable(row);
          this.applyRow(row);
          expired++;
        }
        this.rewriteTotalsCache();
      });
    }
    return expired;
  }

  /** All totals (for the caps view). Period-rolled to now. */
  allCommitted(): MeteredCommittedTotals[] {
    this.checkHighWater();
    const keys = new Set<string>();
    for (const st of this.reserves.values()) keys.add(st.keyRef);
    for (const k of this.totals.keys()) keys.add(k);
    return [...keys].map((k) => this.currentTotals(k));
  }

  /**
   * How many reservations are still in flight — the `settlingCount` the enable
   * surface reports (money-layer-operator-enable-surface §2).
   *
   * DERIVED from the live reserve set, never an independently-incremented
   * counter that can drift. Because a stale positive would keep sensitive audit
   * rows readable indefinitely, it is BOUNDED: an entry past its settle
   * deadline (the TTL) is excluded here and reconciled by the expiry sweep, so
   * a crashed or stuck call cannot pin the count above zero forever (T24).
   *
   * NOT persisted across restart: a process restart ends its own in-flight
   * work, and the new process folds from rows the ledger can still account for.
   */
  outstandingReserveCount(): number {
    this.checkHighWater();
    const nowMs = this.now();
    let n = 0;
    for (const st of this.reserves.values()) {
      if (st.state !== 'reserved') continue;
      if (nowMs - st.reservedAtMs > this.ttlMs) continue; // past the settle deadline — reconciled, stops counting
      n++;
    }
    return n;
  }

  /** E1 pass slots in use for a `${specSha256}#${round}` key (released only by a confirmed no-charge settle). */
  e1PassesUsed(keyRef: string, e1PassKey: string): number {
    let n = 0;
    for (const st of this.reserves.values()) {
      if (st.keyRef !== keyRef || st.e1PassKey !== e1PassKey) continue;
      if (st.state === 'settled' && st.noCharge) continue;
      if (st.state === 'expired') continue; // a $0 expiry (non-provisional door) charged nothing
      n++;
    }
    return n;
  }

  // ── Locked cap check ───────────────────────────────────────────────

  /**
   * The atomic cap comparison (inside the per-key mutex). Order: per-call
   * ceiling → E2 shares → month → day → lifetime → provisional ceiling → E1
   * slot. Strict `committed + reserve > cap` everywhere.
   */
  private checkCapsLocked(req: ReserveRequest, caps: AdmitCaps, nowMs: number, zone: string, day: string, month: string): void {
    const r = req.reserveUsd;
    if (caps.perCallCeilingUsd !== undefined && r > caps.perCallCeilingUsd) {
      throw new CapExceededError('per-call', 0, r, caps.perCallCeilingUsd);
    }
    // One pass over this key's reservations for every period figure.
    let lifeC = 0, lifeO = 0, monC = 0, monO = 0, dayC = 0, dayO = 0;
    let e2MonC = 0, e2MonO = 0, e2DayC = 0, e2DayO = 0;
    let provisional = 0, outstanding = 0;
    for (const st of this.reserves.values()) {
      if (st.keyRef !== req.keyRef) continue;
      const c = this.contribution(st);
      const out = st.state === 'reserved' ? c : 0;
      lifeC += c; lifeO += out;
      if (st.month === month) { monC += c; monO += out; }
      if (st.day === day) { dayC += c; dayO += out; }
      if (st.caller === 'second-opinion') {
        if (st.month === month) { e2MonC += c; e2MonO += out; }
        if (st.day === day) { e2DayC += c; e2DayO += out; }
      }
      if (st.state === 'provisional' && st.month === month) provisional += st.provisionalUsd ?? 0;
      if (st.state === 'reserved') outstanding += st.reserveUsd;
    }
    const retryAfterSec = this.retryAfterSec(req.keyRef, nowMs);
    // Every period limit is evaluated; a HARD breach (settled + reserve > cap)
    // anywhere wins over a `reserves-outstanding` one, so a caller is never told
    // to retry shortly when another limit is genuinely spent.
    const breaches: CapExceededError[] = [];
    const check = (kind: CapKind, committed: number, outst: number, cap: number | undefined, resetsKind: 'day' | 'month' | null) => {
      if (cap === undefined) return;
      if (committed + r > cap) {
        const settled = committed - outst;
        const reservesOutstanding = outst > 0 && settled + r <= cap;
        breaches.push(new CapExceededError(kind, round6(committed), r, cap, {
          settledUsd: round6(settled),
          outstandingUsd: round6(outst),
          reservesOutstanding,
          retryAfterSec: reservesOutstanding ? retryAfterSec : null,
          resetsAt: resetsKind ? new Date(nextPeriodBoundaryMs(nowMs, zone, resetsKind)).toISOString() : null,
        }));
      }
    };
    if (req.caller === 'second-opinion' && caps.e2) {
      check('e2-month', e2MonC, e2MonO, caps.e2.monthCapUsd, 'month');
      check('e2-day', e2DayC, e2DayO, caps.e2.dayCapUsd, 'day');
    }
    check('monthly', monC, monO, caps.monthlyCapUsd, 'month');
    check('daily', dayC, dayO, caps.dailyCapUsd, 'day');
    check('lifetime', lifeC, lifeO, caps.lifetimeCapUsd, null);
    if (breaches.length > 0) throw breaches.find((b) => !b.reservesOutstanding) ?? breaches[0]!;
    if (caps.provisionalCeilingUsd !== undefined && provisional + outstanding + r > caps.provisionalCeilingUsd) {
      throw new CapExceededError('provisional', round6(provisional + outstanding), r, caps.provisionalCeilingUsd, {
        settledUsd: round6(provisional),
        outstandingUsd: round6(outstanding),
        resetsAt: new Date(nextPeriodBoundaryMs(nowMs, zone, 'month')).toISOString(),
      });
    }
    if (req.e1PassKey && caps.e1PassLimit !== undefined) {
      const used = this.e1PassesUsed(req.keyRef, req.e1PassKey);
      if (used >= caps.e1PassLimit) throw new E1PassLimitError(req.e1PassKey, used, caps.e1PassLimit);
    }
  }

  /** Seconds until the soonest outstanding reservation must settle or expire, bounded to [1, 60]. */
  private retryAfterSec(keyRef: string, nowMs: number): number {
    let soonest = Infinity;
    for (const st of this.reserves.values()) {
      if (st.keyRef !== keyRef || st.state !== 'reserved') continue;
      soonest = Math.min(soonest, st.reservedAtMs + this.ttlMs - nowMs);
    }
    if (!Number.isFinite(soonest)) return 1;
    return Math.min(60, Math.max(1, Math.ceil(soonest / 1000)));
  }

  // ── Fold internals ─────────────────────────────────────────────────

  /** Apply one row to the in-memory fold. */
  private applyRow(row: MeteredBookingRow, opts?: { skipTotals?: boolean }): void {
    const ms = Date.parse(row.ts);
    const legacy = periodEpochs(ms, 'UTC');
    const day = row.dayEpoch ?? legacy.dayEpoch;
    const month = row.monthEpoch ?? legacy.monthEpoch;
    if (row.kind === 'reserve') {
      const zone = row.periodTimeZone ?? 'UTC';
      this.lastZone.set(row.keyRef, zone);
      this.reserves.set(row.reserveId, {
        keyRef: row.keyRef,
        door: row.door,
        modelId: row.modelId,
        reserveUsd: row.costUsd,
        day,
        month,
        zone,
        reservedAtMs: ms,
        state: 'reserved',
        ...(row.callId ? { callId: row.callId } : {}),
        ...(row.requestSha256 ? { requestSha256: row.requestSha256 } : {}),
        ...(row.component ? { component: row.component } : {}),
        ...(row.caller ? { caller: row.caller } : {}),
        ...(row.run ? { run: row.run } : {}),
        ...(row.tier ? { tier: row.tier } : {}),
        ...(row.pricePointId ? { pricePointId: row.pricePointId } : {}),
        ...(row.e1PassKey ? { e1PassKey: row.e1PassKey } : {}),
        ...(typeof row.bookedInPerMtok === 'number' ? { bookedInPerMtok: row.bookedInPerMtok } : {}),
        ...(typeof row.bookedOutPerMtok === 'number' ? { bookedOutPerMtok: row.bookedOutPerMtok } : {}),
      });
      if (row.callId && !this.callIndex.has(row.callId)) this.callIndex.set(row.callId, row.reserveId);
    } else if (row.kind === 'settle') {
      const st = this.reserves.get(row.reserveId);
      if (st) {
        if (st.state === 'settled') return; // idempotent
        if (st.state === 'provisional') {
          // max(provisional, actual): the provisional amount is sunk; only an excess books.
          const prov = st.provisionalUsd ?? st.reserveUsd;
          st.state = 'settled';
          st.settledUsd = Math.max(prov, row.costUsd);
          // A no-charge confirmation after a provisional booking keeps the slot (money stays sunk).
        } else {
          const wasExpired = st.state === 'expired';
          st.state = 'settled';
          st.settledUsd = row.costUsd;
          if (row.noCharge) st.noCharge = true;
          // A late settle books on the SETTLE's own period when the reserve period
          // already contributed nothing (it was expired at $0); otherwise the
          // contribution keeps the reserve's charged period.
          if (row.lateAfterExpire || wasExpired) {
            st.day = day;
            st.month = month;
          }
        }
      } else {
        // Settle with no known reserve (e.g. rows pruned): book absolute on its own period.
        this.reserves.set(row.reserveId, {
          keyRef: row.keyRef,
          door: row.door,
          modelId: row.modelId,
          reserveUsd: 0,
          day,
          month,
          zone: 'UTC',
          reservedAtMs: ms,
          state: 'settled',
          settledUsd: row.costUsd,
        });
      }
    } else if (row.kind === 'expire') {
      const st = this.reserves.get(row.reserveId);
      if (st && st.state === 'reserved') {
        // Decided by the ROW's own flag, so a pre-change $0 expiry row on any door
        // folds exactly as before; only rows this build writes for a
        // provisional-expiry door carry `provisional: true`.
        if (row.provisional === true) {
          st.state = 'provisional';
          st.provisionalUsd = st.reserveUsd;
        } else {
          st.state = 'expired';
        }
      }
    } else if (row.kind === 'provisional') {
      const st = this.reserves.get(row.reserveId);
      if (st && st.state === 'reserved') {
        st.state = 'provisional';
        st.provisionalUsd = st.reserveUsd;
      }
    }
    if (!opts?.skipTotals) this.recomputeTotalsForKey(row.keyRef);
  }

  /** Contribution of one reserve state to committed totals. */
  private contribution(st: ReserveState): number {
    if (st.state === 'settled') return st.settledUsd ?? 0;
    if (st.state === 'expired') return 0;
    if (st.state === 'provisional') return st.provisionalUsd ?? st.reserveUsd;
    return st.reserveUsd; // outstanding reserve — inside the committed total
  }

  private zoneFor(keyRef: string): string {
    return this.zoneForKeyOpt?.(keyRef) ?? this.lastZone.get(keyRef) ?? 'UTC';
  }

  private recomputeTotalsForKey(keyRef: string): void {
    const { dayEpoch, monthEpoch } = periodEpochs(this.now(), this.zoneFor(keyRef));
    let lifetime = 0, dayUsd = 0, monthUsd = 0, provisional = 0, outstanding = 0, e2Month = 0, e2Day = 0;
    for (const st of this.reserves.values()) {
      if (st.keyRef !== keyRef) continue;
      const c = this.contribution(st);
      lifetime += c;
      if (st.day === dayEpoch) dayUsd += c;
      if (st.month === monthEpoch) monthUsd += c;
      if (st.state === 'provisional' && st.month === monthEpoch) provisional += st.provisionalUsd ?? 0;
      if (st.state === 'reserved') outstanding += st.reserveUsd;
      if (st.caller === 'second-opinion') {
        if (st.month === monthEpoch) e2Month += c;
        if (st.day === dayEpoch) e2Day += c;
      }
    }
    this.totals.set(keyRef, {
      keyRef,
      committedLifetimeUsd: round6(lifetime),
      committedDayUsd: round6(dayUsd),
      dayEpoch,
      committedMonthUsd: round6(monthUsd),
      monthEpoch,
      provisionalMonthUsd: round6(provisional),
      outstandingReserveUsd: round6(outstanding),
      e2MonthUsd: round6(e2Month),
      e2DayUsd: round6(e2Day),
      updatedAt: new Date(this.now()).toISOString(),
    });
  }

  /** Period-rolled view of a key's totals (a new day or month resets that figure). */
  private currentTotals(keyRef: string): MeteredCommittedTotals {
    const { dayEpoch, monthEpoch } = periodEpochs(this.now(), this.zoneFor(keyRef));
    const t = this.totals.get(keyRef);
    if (!t) {
      return {
        keyRef,
        committedLifetimeUsd: 0,
        committedDayUsd: 0,
        dayEpoch,
        committedMonthUsd: 0,
        monthEpoch,
        provisionalMonthUsd: 0,
        outstandingReserveUsd: 0,
        e2MonthUsd: 0,
        e2DayUsd: 0,
        updatedAt: new Date(this.now()).toISOString(),
      };
    }
    if (t.dayEpoch !== dayEpoch || t.monthEpoch !== monthEpoch) {
      this.recomputeTotalsForKey(keyRef);
      return this.totals.get(keyRef)!;
    }
    return t;
  }

  /** Full refold from row truth (the fold is canon; the totals file is a cache). */
  private refoldFromRows(): void {
    this.reserves = new Map();
    this.totals = new Map();
    this.callIndex = new Map();
    this.lastZone = new Map();
    let raw = '';
    try {
      raw = fs.readFileSync(this.rowsPath, 'utf-8');
      this.rowsBytes = Buffer.byteLength(raw);
    } catch {
      // @silent-fallback-ok: no rows file yet — a fresh ledger folds to zero.
      this.rowsBytes = 0;
      return;
    }
    const keys = new Set<string>();
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      let row: MeteredBookingRow;
      try {
        row = JSON.parse(line);
      } catch {
        // Malformed-row-skip: a torn trailing append is expected crash residue.
        continue;
      }
      if (
        typeof row?.reserveId !== 'string' ||
        typeof row?.keyRef !== 'string' ||
        typeof row?.costUsd !== 'number' ||
        !Number.isFinite(row.costUsd) ||
        row.costUsd < 0 ||
        !['reserve', 'settle', 'expire', 'provisional'].includes(row?.kind)
      ) {
        continue;
      }
      // Inline apply without per-row totals recompute (batched below).
      keys.add(row.keyRef);
      this.applyRow(row, { skipTotals: true });
    }
    for (const k of keys) this.recomputeTotalsForKey(k);
  }

  /** Cheap external-append detection: rows-file byte length vs our high-water mark. */
  private checkHighWater(): void {
    let size = 0;
    try {
      size = fs.statSync(this.rowsPath).size;
    } catch {
      // @silent-fallback-ok: rows file absent — nothing appended externally.
      size = 0;
    }
    if (size !== this.rowsBytes) {
      this.refoldFromRows();
      this.rewriteTotalsCache();
    }
  }

  // ── Durable write internals ────────────────────────────────────────

  /** Append one row, fsync'd, under the advisory file lock. NON-SWALLOWING. */
  private async appendDurable(row: MeteredBookingRow): Promise<void> {
    let release: (() => Promise<void>) | null = null;
    try {
      release = await lockfile.lock(this.lockTarget, LOCK_OPTIONS);
      const line = JSON.stringify(row) + '\n';
      const fd = fs.openSync(this.rowsPath, 'a', 0o600);
      try {
        fs.writeSync(fd, line);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      this.rowsBytes += Buffer.byteLength(line);
    } catch (err) {
      throw new MeteredLedgerWriteError(String(err), err);
    } finally {
      if (release) await release().catch(() => {});
    }
  }

  /** Atomic (tmp+rename) rewrite of the totals cache. Best-effort — rows are canon. */
  private rewriteTotalsCache(): void {
    try {
      const file: TotalsFile = { rowsBytes: this.rowsBytes, totals: Object.fromEntries(this.totals) };
      const tmp = this.totalsPath + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(file, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, this.totalsPath);
    } catch {
      // @silent-fallback-ok: the totals file is a regenerable CACHE of the fold —
      // a failed cache write never blocks a booking (rows are already durable) and
      // is corrected by the next boot-time refold.
    }
  }

  // ── In-process per-key mutex ───────────────────────────────────────

  private withKeyMutex<T>(keyRef: string, fn: () => Promise<T>): Promise<T> {
    const tail = this.mutexTail.get(keyRef) ?? Promise.resolve();
    let done!: () => void;
    const next = new Promise<void>((r) => (done = r));
    this.mutexTail.set(keyRef, next);
    return tail.then(async () => {
      try {
        return await fn();
      } finally {
        done();
        if (this.mutexTail.get(keyRef) === next) this.mutexTail.delete(keyRef);
      }
    });
  }
}
