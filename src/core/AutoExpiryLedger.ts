/**
 * AutoExpiryLedger — the durable review record for the two auto-expiry sweeps
 * (CommitmentTracker `commitments.autoExpiry`, EvolutionManager
 * `evolutionActions.autoExpiry`). Spec: docs/specs/auto-expiry-review-ledger.md.
 *
 * WHY IT EXISTS. Both sweeps ship `dryRun: true`, and the rule for turning
 * dry-run off is "review what it would expire". Before this ledger a dry-run
 * sweep only logged aggregate counts, so the ids it would expire were never
 * written anywhere a reviewer could read — the flip rule could not be met.
 *
 * One JSONL row per sweep with eligible rows (plus one `eligible: 0` row when
 * the set becomes empty, including the first empty sweep after a start), at
 * `<stateDir>/logs/<feature>-auto-expiry.jsonl`. A row carries the full id list
 * only when the eligible set CHANGED since the last row this process wrote;
 * an unchanged set writes a short `unchanged: true` row with the same
 * `setHash`, so a 6-hourly sweep over a stable backlog does not rewrite the
 * same list four times a day. The first sweep after a restart always writes
 * the full list. Rotation: one `.1` generation past `maxBytes`.
 *
 * Observability only — it never changes what a sweep does, and an append
 * failure is logged and swallowed.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface AutoExpiryLedgerItem {
  id: string;
  /** Whole days the row has aged by the sweep's own measure. */
  ageDays: number;
  /** Which eligibility class the row matched (sweep-specific vocabulary). */
  class: string;
  /** The resolution text the row would get (or got). */
  reason?: string;
  /** True when this sweep actually expired the row (its branch was live). */
  applied: boolean;
}

export interface AutoExpiryLedgerRow {
  /** The main branch's dry-run setting; per-item `applied` is the authority on what was closed. */
  dryRun: boolean;
  maxAgeDays: number;
  scanned: number;
  eligible: number;
  /** Rows actually expired by this sweep (0 in dry-run). */
  expired: number;
  capped?: boolean;
  /** Sweep-specific scalars (e.g. the operator-wait branch's own switches). */
  extra?: Record<string, unknown>;
  items: AutoExpiryLedgerItem[];
}

const DEFAULT_MAX_BYTES = 5_000_000;
/** Bound on ids written per row; matches the commitment sweep cap. */
const MAX_ITEMS_PER_ROW = 500;

export class AutoExpiryLedger {
  readonly logPath: string;
  private readonly maxBytes: number;
  private readonly now: () => number;
  private lastHash: string | null = null;

  constructor(opts: { stateDir: string; feature: 'commitments' | 'evolution-actions'; maxBytes?: number; now?: () => number }) {
    this.logPath = path.join(opts.stateDir, 'logs', `${opts.feature}-auto-expiry.jsonl`);
    this.maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
    this.now = opts.now ?? (() => Date.now());
  }

  /**
   * Record one sweep. An empty sweep writes one `eligible: 0` row when the set
   * becomes empty (so the last row never shows ids that are no longer eligible),
   * then nothing while it stays empty.
   */
  record(row: AutoExpiryLedgerRow): void {
    const ids = row.items.map((item) => item.id).sort();
    const setHash = crypto.createHash('sha256').update(ids.join('\n')).digest('hex').slice(0, 16);
    const { items, extra, ...summary } = row;
    const base = { ts: new Date(this.now()).toISOString(), ...summary, ...(extra ?? {}), setHash };
    // An applied sweep is never folded into "unchanged": its ids are the expiry record.
    if (setHash === this.lastHash && row.expired === 0) {
      if (ids.length > 0) this.append({ ...base, unchanged: true });
      return;
    }
    const truncated = items.length > MAX_ITEMS_PER_ROW;
    this.append({ ...base, ...(truncated ? { itemsTruncated: items.length - MAX_ITEMS_PER_ROW } : {}), items: items.slice(0, MAX_ITEMS_PER_ROW) });
    this.lastHash = setHash;
  }

  private append(row: Record<string, unknown>): void {
    try {
      const dir = path.dirname(this.logPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      try {
        const st = fs.statSync(this.logPath);
        if (st.size > this.maxBytes) fs.renameSync(this.logPath, `${this.logPath}.1`);
      } catch { /* no file yet — nothing to rotate */ }
      fs.appendFileSync(this.logPath, `${JSON.stringify(row)}\n`, 'utf-8');
    } catch (err) {
      // @silent-fallback-ok: the review ledger is observability; a write fault must never break the sweep.
      console.warn(`[AutoExpiryLedger] append failed (${path.basename(this.logPath)}): ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
