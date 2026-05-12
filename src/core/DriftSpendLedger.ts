/**
 * DriftSpendLedger — daily-rotated, lock-coordinated cost ledger for the
 * drift checker.
 *
 * Spec: docs/specs/PROJECT-SCOPE-SPEC.md § Phase 1.4 ("Cost ceiling").
 *
 * Contract:
 *   - Total drift-check spend per agent ≤ DEFAULT_DAILY_CAP_USD ($1) per UTC
 *     day. Cap enforcement is `spent + estimated > cap → reject` (strict
 *     `>` boundary, per spec corrected from iter 2).
 *   - One file per UTC day at `.instar/drift-spend-YYYY-MM-DD.jsonl`.
 *   - Old files retained ≤ DEFAULT_RETENTION_DAYS (30). Anything older is
 *     archived to `.instar/drift-spend-archive/<year>-<month>.tar.gz` by
 *     `pruneOlderThan()` (caller-driven; no internal timer).
 *   - Each call pre-reserves estimated cost in an append-only row
 *     `{recordId, projectId, estimatedCost, actualCost?: null, timestamp}`.
 *     After the call returns, `reconcile(recordId, actualCost)` appends a
 *     second row with `actualCost` set, so a tally over the day is
 *     `sum(estimatedCost where actualCost is null) +
 *      sum(actualCost where present)` — O(rows in the day).
 *   - Advisory file lock on `.instar/local/drift-spend.lock` via
 *     proper-lockfile (consistent with AgentRegistry, SharedStateLedger,
 *     PlatformActivityRegistry). Lock file lives under `.instar/local/`
 *     (machine-local, NOT git-synced — same convention as
 *     `round-runner.lock`).
 *   - Multi-machine semantics: each machine writes its own ledger. The
 *     cap is per-machine, summed via git-sync at the file layer. The spec
 *     documents this as "up to N machines × cap/day in worst case"; the
 *     true atomic cross-machine cap is a separately-tracked deferred
 *     child (`drift-spend-cross-machine`).
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import lockfile from 'proper-lockfile';

import { SafeFsExecutor } from './SafeFsExecutor.js';

export const DEFAULT_DAILY_CAP_USD = 1.0;
export const DEFAULT_RETENTION_DAYS = 30;
/** proper-lockfile options that match the rest of the codebase. */
const LOCK_OPTIONS: lockfile.LockOptions = {
  retries: { retries: 50, factor: 1.2, minTimeout: 50, maxTimeout: 500 },
  stale: 10_000,
  realpath: false,
};

export interface DriftSpendLedgerConfig {
  /** Absolute path to the agent's `.instar/` directory. */
  stateDir: string;
  /** Cap in USD per UTC day. Defaults to $1. Tests can lower. */
  dailyCapUsd?: number;
  /** Retention window in days; defaults to 30. */
  retentionDays?: number;
}

export interface ReserveInput {
  projectId: string;
  /** Best-effort upfront estimate; refined by `reconcile`. */
  estimatedCost: number;
}

export interface ReserveResult {
  /** Stable id used to reconcile actualCost later. */
  recordId: string;
  /** Cumulative spent today AFTER this reservation. */
  spentToday: number;
}

export class OverBudgetError extends Error {
  constructor(public capUsd: number, public spentToday: number, public estimatedCost: number) {
    super(
      `drift-spend daily cap exceeded: spent ${spentToday.toFixed(4)} + estimated ${estimatedCost.toFixed(4)} > cap ${capUsd.toFixed(2)}`
    );
    this.name = 'OverBudgetError';
  }
}

interface LedgerRow {
  recordId: string;
  projectId: string;
  estimatedCost: number;
  actualCost: number | null;
  timestamp: string;
}

export class DriftSpendLedger {
  private stateDir: string;
  private capUsd: number;
  private retentionDays: number;

  constructor(config: DriftSpendLedgerConfig) {
    this.stateDir = config.stateDir;
    this.capUsd = config.dailyCapUsd ?? DEFAULT_DAILY_CAP_USD;
    this.retentionDays = config.retentionDays ?? DEFAULT_RETENTION_DAYS;
  }

  /**
   * Pre-reserve `estimatedCost`. Throws `OverBudgetError` if doing so would
   * exceed the daily cap. The reservation is appended as a row with
   * `actualCost: null`; the caller MUST call `reconcile()` after the LLM
   * returns. If the caller dies before reconcile, the reservation stays in
   * place as `estimatedCost` and contributes to the cap until UTC rollover.
   */
  async reserve(input: ReserveInput): Promise<ReserveResult> {
    if (!Number.isFinite(input.estimatedCost) || input.estimatedCost < 0) {
      throw new Error(`reserve: estimatedCost must be a non-negative finite number; got ${input.estimatedCost}`);
    }
    this.ensureDirs();
    const release = await lockfile.lock(this.lockTargetPath(), LOCK_OPTIONS);
    try {
      const today = this.todayLedgerPath();
      const rows = this.readRows(today);
      const spentToday = this.tallySpent(rows);
      // Strict greater-than per spec § Phase 1.4. Equal-to-cap is allowed.
      if (spentToday + input.estimatedCost > this.capUsd) {
        throw new OverBudgetError(this.capUsd, spentToday, input.estimatedCost);
      }
      const recordId = crypto.randomBytes(8).toString('hex');
      const row: LedgerRow = {
        recordId,
        projectId: input.projectId,
        estimatedCost: input.estimatedCost,
        actualCost: null,
        timestamp: new Date().toISOString(),
      };
      this.appendRow(today, row);
      return { recordId, spentToday: spentToday + input.estimatedCost };
    } finally {
      await release();
    }
  }

  /**
   * Record the actual cost after the LLM call. Appends a SECOND row with
   * the same `recordId`, `estimatedCost: 0`, and `actualCost: <real>`.
   * `tallySpent()` already de-duplicates by recordId (a present `actualCost`
   * supersedes any pending `estimatedCost` rows for the same id).
   *
   * Idempotent: calling reconcile twice with the same recordId+actualCost
   * is harmless — the tally still resolves to one actual row.
   */
  async reconcile(recordId: string, actualCost: number): Promise<void> {
    if (!Number.isFinite(actualCost) || actualCost < 0) {
      throw new Error(`reconcile: actualCost must be a non-negative finite number; got ${actualCost}`);
    }
    this.ensureDirs();
    const release = await lockfile.lock(this.lockTargetPath(), LOCK_OPTIONS);
    try {
      // Walk forward through TODAY first (the common case), then yesterday
      // (in case the LLM call straddled UTC midnight). Beyond that we
      // refuse — a record that lived more than ~24h is stale anyway.
      const candidates = [this.todayLedgerPath(), this.yesterdayLedgerPath()];
      for (const file of candidates) {
        const rows = this.readRows(file);
        if (!rows.some((r) => r.recordId === recordId)) continue;
        const row: LedgerRow = {
          recordId,
          projectId: rows.find((r) => r.recordId === recordId)?.projectId ?? '<reconcile>',
          estimatedCost: 0,
          actualCost,
          timestamp: new Date().toISOString(),
        };
        this.appendRow(file, row);
        return;
      }
      // No matching reservation found. Still record the actualCost — the
      // caller's spend is real even if the bookkeeping is messy. Today's
      // file is the right home.
      const row: LedgerRow = {
        recordId,
        projectId: '<unknown>',
        estimatedCost: 0,
        actualCost,
        timestamp: new Date().toISOString(),
      };
      this.appendRow(this.todayLedgerPath(), row);
    } finally {
      await release();
    }
  }

  /**
   * Cumulative spent today, lock-coordinated for safety.
   * Useful for digests / dashboards.
   */
  async spentToday(): Promise<number> {
    this.ensureDirs();
    const release = await lockfile.lock(this.lockTargetPath(), LOCK_OPTIONS);
    try {
      return this.tallySpent(this.readRows(this.todayLedgerPath()));
    } finally {
      await release();
    }
  }

  /**
   * Prune ledger files older than `retentionDays`. NOT called automatically;
   * the caller (server startup, a scheduled job, or a CLI) decides when.
   * Files older than the window are moved to
   * `.instar/drift-spend-archive/<year>-<month>.tar.gz` — but for Phase 1
   * we just delete them via SafeFsExecutor. The tarball archive is a
   * later refinement (the spec describes it but explicitly leaves the
   * concrete archive format open).
   */
  async pruneOlderThan(now: Date = new Date()): Promise<{ removed: string[] }> {
    this.ensureDirs();
    const release = await lockfile.lock(this.lockTargetPath(), LOCK_OPTIONS);
    try {
      const dir = this.stateDir;
      const cutoff = new Date(now);
      cutoff.setUTCDate(cutoff.getUTCDate() - this.retentionDays);
      const removed: string[] = [];
      for (const entry of fs.readdirSync(dir)) {
        const m = entry.match(/^drift-spend-(\d{4}-\d{2}-\d{2})\.jsonl$/);
        if (!m) continue;
        const fileDate = new Date(m[1] + 'T00:00:00Z');
        if (fileDate < cutoff) {
          const abs = path.join(dir, entry);
          SafeFsExecutor.safeRmSync(abs, { force: true, operation: 'src/core/DriftSpendLedger.ts:pruneOlderThan' });
          removed.push(entry);
        }
      }
      return { removed };
    } finally {
      await release();
    }
  }

  // ── Internals ─────────────────────────────────────────────────────

  private ensureDirs(): void {
    if (!fs.existsSync(this.stateDir)) fs.mkdirSync(this.stateDir, { recursive: true });
    const localDir = path.join(this.stateDir, 'local');
    if (!fs.existsSync(localDir)) fs.mkdirSync(localDir, { recursive: true });
    // proper-lockfile needs the target file to exist.
    const lockTarget = this.lockTargetPath();
    if (!fs.existsSync(lockTarget)) {
      fs.writeFileSync(lockTarget, '');
    }
  }

  private lockTargetPath(): string {
    return path.join(this.stateDir, 'local', 'drift-spend.lock');
  }

  private todayLedgerPath(): string {
    return this.ledgerPathForDate(new Date());
  }

  private yesterdayLedgerPath(): string {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - 1);
    return this.ledgerPathForDate(d);
  }

  private ledgerPathForDate(d: Date): string {
    const utc = d.toISOString().slice(0, 10); // YYYY-MM-DD
    return path.join(this.stateDir, `drift-spend-${utc}.jsonl`);
  }

  private readRows(file: string): LedgerRow[] {
    if (!fs.existsSync(file)) return [];
    const raw = fs.readFileSync(file, 'utf-8');
    const lines = raw.split('\n').filter((l) => l.trim().length > 0);
    const rows: LedgerRow[] = [];
    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        if (typeof obj.recordId !== 'string') continue;
        if (typeof obj.projectId !== 'string') continue;
        if (typeof obj.estimatedCost !== 'number') continue;
        if (obj.actualCost !== null && typeof obj.actualCost !== 'number') continue;
        if (typeof obj.timestamp !== 'string') continue;
        rows.push(obj as LedgerRow);
      } catch {
        // Skip malformed rows. The append path always writes valid JSON,
        // so any corruption is either external editing or partial-write
        // — neither should crash the checker.
        continue;
      }
    }
    return rows;
  }

  private appendRow(file: string, row: LedgerRow): void {
    fs.appendFileSync(file, JSON.stringify(row) + '\n', { mode: 0o600 });
  }

  /**
   * Sum cost across a row set: present `actualCost` supersedes the
   * matching pending `estimatedCost`. O(rows).
   */
  private tallySpent(rows: LedgerRow[]): number {
    // De-dup by recordId: actualCost present wins; otherwise sum estimatedCost.
    const byId = new Map<string, { estimated: number; actual: number | null }>();
    for (const r of rows) {
      const existing = byId.get(r.recordId) ?? { estimated: 0, actual: null };
      if (r.actualCost !== null) {
        existing.actual = r.actualCost;
      } else {
        existing.estimated = r.estimatedCost;
      }
      byId.set(r.recordId, existing);
    }
    let total = 0;
    for (const v of byId.values()) {
      total += v.actual ?? v.estimated;
    }
    return total;
  }
}
