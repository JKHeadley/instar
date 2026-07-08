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

export type MeteredBookingKind = 'reserve' | 'settle' | 'expire';

/** One append-only booking row. NEVER mutated; corrections are new rows. */
export interface MeteredBookingRow {
  ts: string;
  keyRef: string;
  door: string;
  modelId: string;
  kind: MeteredBookingKind;
  /** The per-call id (=== meteredCallId) minted at reserve time. */
  reserveId: string;
  /** Reserve: worst-case estimate. Settle: ACTUAL booked cost. Expire: 0. */
  costUsd: number;
  /** The metered-lease epoch the booking was made under (A-B4). */
  leaseEpoch: number;
  /** Set on a settle that arrived after its reserve was expired (books absolute). */
  lateAfterExpire?: boolean;
}

/** The maintained O(1) running totals (a regenerable cache of the fold). */
export interface MeteredCommittedTotals {
  keyRef: string;
  committedLifetimeUsd: number;
  committedDayUsd: number;
  /** UTC day (YYYY-MM-DD) the day total belongs to; a new day resets it. */
  dayEpoch: string;
  updatedAt: string;
}

interface TotalsFile {
  /** High-water mark: byte length of the rows file when this cache was written. */
  rowsBytes: number;
  totals: Record<string, MeteredCommittedTotals>;
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
   * critical section (`committed + reserve > cap` strict `>`, both caps) — the
   * only ordering under which two concurrent reservations are guaranteed to see
   * each other (spec Layer 3). Refusal throws CapExceededError; nothing books.
   */
  admitOnlyUnderCaps?: { lifetimeCapUsd: number; dailyCapUsd: number };
}

/** Thrown by reserve() when admitOnlyUnderCaps would be breached — nothing was booked. */
export class CapExceededError extends Error {
  constructor(
    public capKind: 'lifetime' | 'daily',
    public committedUsd: number,
    public reserveUsd: number,
    public capUsd: number,
  ) {
    super(`${capKind}: committed ${committedUsd.toFixed(4)} + reserve ${reserveUsd.toFixed(4)} > cap ${capUsd.toFixed(2)}`);
    this.name = 'CapExceededError';
  }
}

export interface ReserveHandle {
  reserveId: string;
  /** Committed lifetime total AFTER this reservation (outstanding reserves included). */
  committedLifetimeUsd: number;
  committedDayUsd: number;
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
  /** UTC day the contribution is attributed to (the reserve's day). */
  day: string;
  reservedAtMs: number;
  state: 'reserved' | 'settled' | 'expired';
  settledUsd?: number;
}

function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

export interface MeteredSpendLedgerOptions {
  /** The agent's `.instar/` dir; rows/totals live under `state/`, the lock under `local/`. */
  stateDir: string;
  reserveTtlMs?: number;
  now?: () => number;
}

export class MeteredSpendLedger {
  private readonly rowsPath: string;
  private readonly totalsPath: string;
  private readonly lockTarget: string;
  private readonly ttlMs: number;
  private readonly now: () => number;

  /** In-memory fold state, authoritative in-process. Rebuilt on construction. */
  private reserves = new Map<string, ReserveState>();
  private totals = new Map<string, MeteredCommittedTotals>();
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
    // Boot: the fold is canon — rebuild from rows and REWRITE the totals cache.
    this.refoldFromRows();
    this.rewriteTotalsCache();
  }

  // ── Public API ─────────────────────────────────────────────────────

  /** O(1) committed totals for a key, day-rolled to NOW. High-water-checked against external appends. */
  committed(keyRef: string): MeteredCommittedTotals {
    this.checkHighWater();
    return this.currentTotals(keyRef);
  }

  /** Reserve worst-case cost. FAIL-CLOSED: any persistence failure throws. */
  async reserve(req: ReserveRequest): Promise<ReserveHandle> {
    if (!Number.isFinite(req.reserveUsd) || req.reserveUsd < 0) {
      throw new MeteredLedgerWriteError(`invalid reserveUsd ${req.reserveUsd}`);
    }
    return this.withKeyMutex(req.keyRef, async () => {
      this.checkHighWater();
      if (req.admitOnlyUnderCaps) {
        // ATOMIC check-and-reserve: this runs inside the per-key mutex, so every
        // outstanding concurrent reservation is already in the committed total.
        const t = this.currentTotals(req.keyRef);
        if (t.committedLifetimeUsd + req.reserveUsd > req.admitOnlyUnderCaps.lifetimeCapUsd) {
          throw new CapExceededError('lifetime', t.committedLifetimeUsd, req.reserveUsd, req.admitOnlyUnderCaps.lifetimeCapUsd);
        }
        if (t.committedDayUsd + req.reserveUsd > req.admitOnlyUnderCaps.dailyCapUsd) {
          throw new CapExceededError('daily', t.committedDayUsd, req.reserveUsd, req.admitOnlyUnderCaps.dailyCapUsd);
        }
      }
      const nowMs = this.now();
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
      };
      await this.appendDurable(row);
      this.applyRow(row);
      this.rewriteTotalsCache();
      const t = this.currentTotals(req.keyRef);
      return { reserveId, committedLifetimeUsd: t.committedLifetimeUsd, committedDayUsd: t.committedDayUsd };
    });
  }

  /**
   * Terminal settle at ACTUAL cost. Idempotent: a second settle is a no-op.
   * A settle after expiry books the actual as a fresh ABSOLUTE row (late-settle).
   */
  async settle(keyRef: string, reserveId: string, actualUsd: number): Promise<void> {
    if (!Number.isFinite(actualUsd) || actualUsd < 0) {
      throw new MeteredLedgerWriteError(`invalid actualUsd ${actualUsd}`);
    }
    return this.withKeyMutex(keyRef, async () => {
      const st = this.reserves.get(reserveId);
      if (st && st.state === 'settled') return; // first terminal wins — no-op
      const lateAfterExpire = st?.state === 'expired';
      const row: MeteredBookingRow = {
        ts: new Date(this.now()).toISOString(),
        keyRef,
        door: st?.door ?? 'unknown',
        modelId: st?.modelId ?? 'unknown',
        kind: 'settle',
        reserveId,
        costUsd: round6(actualUsd),
        leaseEpoch: 0,
        ...(lateAfterExpire ? { lateAfterExpire: true } : {}),
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
          const row: MeteredBookingRow = {
            ts: new Date(this.now()).toISOString(),
            keyRef,
            door: st.door,
            modelId: st.modelId,
            kind: 'expire',
            reserveId: id,
            costUsd: 0,
            leaseEpoch: 0,
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

  /** All totals (for the caps view). Day-rolled to now. */
  allCommitted(): MeteredCommittedTotals[] {
    this.checkHighWater();
    const keys = new Set<string>();
    for (const st of this.reserves.values()) keys.add(st.keyRef);
    for (const k of this.totals.keys()) keys.add(k);
    return [...keys].map((k) => this.currentTotals(k));
  }

  // ── Fold internals ─────────────────────────────────────────────────

  /** Apply one row to the in-memory fold. */
  private applyRow(row: MeteredBookingRow, opts?: { skipTotals?: boolean }): void {
    const day = utcDay(Date.parse(row.ts));
    if (row.kind === 'reserve') {
      this.reserves.set(row.reserveId, {
        keyRef: row.keyRef,
        door: row.door,
        modelId: row.modelId,
        reserveUsd: row.costUsd,
        day,
        reservedAtMs: Date.parse(row.ts),
        state: 'reserved',
      });
    } else if (row.kind === 'settle') {
      const st = this.reserves.get(row.reserveId);
      if (st) {
        if (st.state === 'settled') return; // idempotent
        st.state = 'settled';
        st.settledUsd = row.costUsd;
        // A late settle books on the SETTLE's own day when the reserve day already
        // contributed nothing (it was expired); otherwise the contribution keeps
        // the reserve's day.
        if (row.lateAfterExpire) st.day = day;
      } else {
        // Settle with no known reserve (e.g. rows pruned): book absolute on its own day.
        this.reserves.set(row.reserveId, {
          keyRef: row.keyRef,
          door: row.door,
          modelId: row.modelId,
          reserveUsd: 0,
          day,
          reservedAtMs: Date.parse(row.ts),
          state: 'settled',
          settledUsd: row.costUsd,
        });
      }
    } else if (row.kind === 'expire') {
      const st = this.reserves.get(row.reserveId);
      if (st && st.state === 'reserved') st.state = 'expired';
    }
    if (!opts?.skipTotals) this.recomputeTotalsForKey(row.keyRef);
  }

  /** Contribution of one reserve state to committed totals. */
  private contribution(st: ReserveState): number {
    if (st.state === 'settled') return st.settledUsd ?? 0;
    if (st.state === 'expired') return 0;
    return st.reserveUsd; // outstanding reserve — inside the committed total
  }

  private recomputeTotalsForKey(keyRef: string): void {
    const today = utcDay(this.now());
    let lifetime = 0;
    let dayUsd = 0;
    for (const st of this.reserves.values()) {
      if (st.keyRef !== keyRef) continue;
      const c = this.contribution(st);
      lifetime += c;
      if (st.day === today) dayUsd += c;
    }
    this.totals.set(keyRef, {
      keyRef,
      committedLifetimeUsd: round6(lifetime),
      committedDayUsd: round6(dayUsd),
      dayEpoch: today,
      updatedAt: new Date(this.now()).toISOString(),
    });
  }

  /** Day-rolled view of a key's totals (a new UTC day resets the day figure). */
  private currentTotals(keyRef: string): MeteredCommittedTotals {
    const today = utcDay(this.now());
    const t = this.totals.get(keyRef);
    if (!t) {
      return { keyRef, committedLifetimeUsd: 0, committedDayUsd: 0, dayEpoch: today, updatedAt: new Date(this.now()).toISOString() };
    }
    if (t.dayEpoch !== today) {
      this.recomputeTotalsForKey(keyRef);
      return this.totals.get(keyRef)!;
    }
    return t;
  }

  /** Full refold from row truth (the fold is canon; the totals file is a cache). */
  private refoldFromRows(): void {
    this.reserves = new Map();
    this.totals = new Map();
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
        !['reserve', 'settle', 'expire'].includes(row?.kind)
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
