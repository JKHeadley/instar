/**
 * FeatureMetricsLedger — per-feature observability for LLM-driven systems.
 *
 * Records, per call, which system (sentinel/gate) invoked the LLM, what it
 * cost (tokens, latency), and what it decided (fired/noop/error/shed), so that
 * every gate's cost and hit-rate becomes a tracked number instead of a guess.
 * 'shed' (circuit-open, no call) is counted separately so `realCalls` reflects
 * only real round-trips. Read-
 * only observability — it NEVER gates, blocks, or mutates any flow (same
 * guarantee as TokenLedger). Spec: docs/specs/llm-feature-metrics-spec.md.
 *
 * Phase 1a: this store + its read API. The single funnel tap that feeds it
 * (CircuitBreakingIntelligenceProvider.evaluate → record()) is Phase 1b, added
 * on top of #638's hardened funnel. The store is fully exercisable now via
 * record()/recordEvent() (used by tests and, later, the tap).
 *
 * The per-feature key is the existing IntelligenceOptions.attribution.component
 * tag (e.g. "MessagingToneGate"); calls without one bucket under "unlabeled".
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { registerSqliteHandle } from '../core/SqliteRegistry.js';
import type { Database as BetterSqliteDatabase } from 'better-sqlite3';
import { NativeModuleHealer } from '../memory/NativeModuleHealer.js';

export type FeatureMetricKind = 'llm' | 'event';
/**
 * Outcome of a funnel call:
 *  - 'fired' — the gate acted (blocked/flagged). The fired-vs-noop verdict is
 *    Phase 2; today the funnel never sets this (the caller would).
 *  - 'noop'  — a REAL call completed and the gate took no action.
 *  - 'error' — a real call failed.
 *  - 'shed'  — the circuit was OPEN so no call ran (no token cost, no network
 *    round-trip). Distinct from 'noop' so `realCalls` (= calls − shed) reflects
 *    only real round-trips; otherwise breaker-shed load (0ms latency) inflates
 *    the call count and reads as completed work.
 */
export type FeatureMetricOutcome = 'fired' | 'noop' | 'error' | 'shed';

export interface FeatureMetricRecord {
  /** Source-side component label (IntelligenceOptions.attribution.component). */
  feature: string;
  /** 'llm' for a provider call; 'event' for a programmatic guard invocation. */
  kind?: FeatureMetricKind;
  /** What happened: fired (acted) vs noop (real call, no action) vs error vs shed (circuit-open, no call). */
  outcome: FeatureMetricOutcome;
  tokensIn?: number;
  tokensOut?: number;
  /**
   * Cache-read input tokens (token-audit-completeness). PINNED SEMANTICS
   * (P18 — the schema is the perception): tokensCached ⊆ tokensIn on every
   * framework — tokensIn's meaning is UNCHANGED (historical row continuity;
   * claude↔codex comparability), tokensCached is an informational subset,
   * and fresh cost is derivable as tokensIn − tokensCached. For claude this
   * is cache_read_input_tokens ONLY (cache CREATION costs ~1.25× fresh and
   * stays plain input; cache READS cost ~0.1× — collapsing them would point
   * the cost signal in two directions at once). For codex,
   * cached_input_tokens maps directly.
   */
  tokensCached?: number;
  latencyMs?: number;
  /** Resolved model string the provider actually ran (e.g. "gpt-5.4-mini", "claude-haiku-4-5"). */
  model?: string;
  /** Resolved framework that served the call (e.g. "codex-cli", "claude-code"). Observable Intelligence. */
  framework?: string;
  /**
   * Resolved routing DOOR (the access path — CLI harness or metered API) the call
   * used (routing-control-room-spend, Layer 0). NULL until the metered dispatch seam
   * stamps it (spec §Door attribution — out of scope for Increment A); NULL-door token
   * volume renders as UNCOSTED in the spend view, never a fabricated $0.
   */
  door?: string;
  /**
   * routing-control-room-spend Layer 1c: the per-call join key (=== the money
   * ledger reserveId === provider_cost_report.meteredCallId). Stamped only on
   * metered calls by the (future) dispatch seam; null on internal CLI calls.
   */
  callId?: string;
  /** Post-#638: did this call wait for a rate-limit window before running. */
  waited?: boolean;
  waitMs?: number;
  /** For Phase-2 effectiveness correlation (verdict ↔ downstream outcome). */
  verdictId?: string;
  /** Defaults to now(). */
  ts?: number;
}

export interface FeatureRollup {
  feature: string;
  /** All recorded funnel rows (includes 'shed' no-calls). */
  calls: number;
  /** Real round-trips only (calls − shed) — the honest call count. */
  realCalls: number;
  llmCalls: number;
  events: number;
  tokensIn: number;
  tokensOut: number;
  /** Cache-read subset of tokensIn (token-audit-completeness). */
  tokensCached: number;
  /** Distinct frameworks that served this feature in the window (Observable Intelligence). */
  frameworks: string[];
  /** Distinct models this feature ran in the window. */
  models: string[];
  fired: number;
  noop: number;
  errors: number;
  /** Circuit-open no-calls: the breaker refused the call, nothing ran. */
  shed: number;
  /** fired / realCalls (0..1) — how often the system acts on a call that actually ran. */
  fireRate: number;
  avgLatencyMs: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  maxLatencyMs: number;
  waitedCalls: number;
  avgWaitMs: number;
  /** This feature's slice of the feature×model partition (summary() only). */
  byModel?: FeatureModelRollup[];
}

/**
 * One feature×model×framework group (token-audit-completeness, Slice 2).
 * llm-kind rows only. NULL model/framework render "unknown". The presence
 * counts ride the same single GROUP BY query — usage-presence is a NULL
 * test, not a SUM (a recorded 0 must count as reported; one large row must
 * not mask N null rows).
 */
export interface FeatureModelRollup {
  feature: string;
  model: string;
  framework: string;
  calls: number;
  realCalls: number;
  tokensIn: number;
  tokensOut: number;
  tokensCached: number;
  fired: number;
  noop: number;
  errors: number;
  shed: number;
  /** Success (fired+noop) rows whose tokens_in is non-NULL. */
  successRowsWithUsage: number;
  /** Error rows whose tokens_in is non-NULL (surfaces error-path recording). */
  errorRowsWithUsage: number;
}

/** Aggregate model×framework rollup across all features (totals.byModel). */
export interface ModelRollup {
  model: string;
  framework: string;
  calls: number;
  realCalls: number;
  tokensIn: number;
  tokensOut: number;
  tokensCached: number;
  fired: number;
  noop: number;
  errors: number;
  shed: number;
}

/**
 * One aggregated spend-token bucket (routing-control-room-spend, Layer 2). Immutable
 * token sums per bucket×door×model — the "pre-aggregate the IMMUTABLE fact, join the
 * MUTABLE price on read" shape. `door`/`modelId` are 'unknown' when the source row
 * had none (NULL-door pre-attribution volume). `bucketStartMs` is the UTC start of
 * the bucket; `bucket` is 'YYYY-MM-DD' (daily) or an ISO hour (hourly).
 */
export interface SpendTokenBucket {
  bucket: string;
  bucketStartMs: number;
  door: string;
  modelId: string;
  tokensIn: number;
  tokensOut: number;
  tokensCached: number;
}

/**
 * Per-framework usage-reporting coverage (the drift tripwire's durable
 * surface). Denominator = SUCCESSFUL llm rows only (fired + noop) — error
 * rows legitimately lack usage (claude parses usage only on success; codex
 * timeouts can kill the child pre-flush), and including them would normalize
 * coverage below 1.0 and train operators to ignore the tripwire. Error rows
 * are reported alongside (errorRowsWithUsage also surfaces the error-path
 * recording directly). Exemption is keyed PER PROVIDER IMPLEMENTATION, not
 * per framework: claude-code rows with model 'interactive-pool' are excluded
 * from the claude denominator (that provider NEVER invokes onUsage by
 * documented contract); gemini-cli is exempt; pi-cli is NOT exempt
 * (PiCliIntelligenceProvider invokes onUsage — exempting it would mask a
 * future pi parse-rot).
 */
export interface UsageCoverageRow {
  framework: string;
  successRows: number;
  successRowsWithUsage: number;
  /** successRowsWithUsage / successRows (0..1); 0 when denominator is 0. */
  coverage: number;
  errorRows: number;
  errorRowsWithUsage: number;
  /** True = this framework's provider cannot surface usage by documented contract. */
  exempt: boolean;
  /** claude-code only: interactive-pool rows excluded from the denominator. */
  excludedRows?: number;
}

export interface FeatureMetricsSummary {
  sinceMs: number;
  totals: {
    calls: number;
    realCalls: number;
    llmCalls: number;
    events: number;
    tokensIn: number;
    tokensOut: number;
    tokensCached: number;
    fired: number;
    noop: number;
    errors: number;
    shed: number;
    /** Aggregate model×framework breakdown (token-audit-completeness). */
    byModel: ModelRollup[];
    /** Per-framework usage-reporting coverage (drift tripwire surface). */
    usageCoverage: UsageCoverageRow[];
    /** Unlabeled (tokensIn+tokensOut) share of total token spend. 0 on zero denominator. */
    unlabeledTokenShare: number;
    /**
     * Unlabeled realCalls share of total realCalls. Token-blind unlabeled
     * calls contribute 0/0 to the token share, so a token-weighted metric
     * alone reads 0.00 while unlabeled traffic runs at volume.
     */
    unlabeledCallShare: number;
  };
  features: FeatureRollup[];
}

export interface FeatureMetricsLedgerOptions {
  /** SQLite db path, or ':memory:' for tests. */
  dbPath: string;
  /** Test seam — inject a Database instance (e.g. an in-memory one). */
  databaseFactory?: (dbPath: string) => BetterSqliteDatabase;
  /** Injectable clock for deterministic tests. */
  now?: () => number;
  /**
   * Maintain the `spend_token_rollup` daily aggregate on each insert (Layer 2 of
   * routing-control-room-spend). Gated so the daily rollup writes only where the spend
   * view is live (dev agents; dark on the fleet) — the `door` column and batched prune
   * are always active (additive/safe). Absent ⇒ false (no rollup maintenance).
   */
  maintainSpendRollup?: boolean;
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS feature_metrics (
     id          INTEGER PRIMARY KEY AUTOINCREMENT,
     ts          INTEGER NOT NULL,
     feature     TEXT NOT NULL,
     kind        TEXT NOT NULL,
     outcome     TEXT NOT NULL,
     tokens_in   INTEGER,
     tokens_out  INTEGER,
     latency_ms  INTEGER,
     model       TEXT,
     framework   TEXT,
     waited      INTEGER NOT NULL DEFAULT 0,
     wait_ms     INTEGER,
     verdict_id  TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS idx_feature_metrics_ts ON feature_metrics (ts)`,
  `CREATE INDEX IF NOT EXISTS idx_feature_metrics_feature ON feature_metrics (feature, ts)`,
  // Layer 2 (routing-control-room-spend): a maintained daily aggregate of IMMUTABLE
  // token sums per UTC day×door×model. Provably untouched by any price/subsidy/credit
  // correction (it holds tokens only — cost is a read-time join). Created idempotently
  // at open; door/modelId are NOT NULL (COALESCE'd to 'unknown') so ON CONFLICT can
  // dedupe (SQLite treats each NULL as distinct in a UNIQUE key).
  `CREATE TABLE IF NOT EXISTS spend_token_rollup (
     day           TEXT NOT NULL,
     door          TEXT NOT NULL DEFAULT 'unknown',
     model_id      TEXT NOT NULL DEFAULT 'unknown',
     tokens_in     INTEGER NOT NULL DEFAULT 0,
     tokens_out    INTEGER NOT NULL DEFAULT 0,
     tokens_cached INTEGER NOT NULL DEFAULT 0,
     PRIMARY KEY (day, door, model_id)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_spend_token_rollup_day ON spend_token_rollup (day)`,
];

/**
 * Columns added after the table's first ship. CREATE TABLE IF NOT EXISTS never
 * alters an existing table, so a DB created by an earlier instar lacks these —
 * we add them idempotently at open (pragma-guarded). `model` predates this list
 * (it shipped in the original schema) so only genuinely-new columns appear here.
 */
const ADDED_COLUMNS: Array<{ name: string; ddl: string }> = [
  { name: 'framework', ddl: 'ALTER TABLE feature_metrics ADD COLUMN framework TEXT' },
  { name: 'tokens_cached', ddl: 'ALTER TABLE feature_metrics ADD COLUMN tokens_cached INTEGER' },
  // routing-control-room-spend Layer 0: the routing DOOR dimension. Additive + nullable
  // (matches framework/tokens_cached); a DB from an earlier instar gains it at open.
  { name: 'door', ddl: 'ALTER TABLE feature_metrics ADD COLUMN door TEXT' },
  // routing-control-room-spend Layer 1c: the per-call join key (=== the money
  // ledger's reserveId === every provider_cost_report row's meteredCallId).
  // Additive + nullable; only metered calls stamp it (FD-21).
  { name: 'call_id', ddl: 'ALTER TABLE feature_metrics ADD COLUMN call_id TEXT' },
];

/** Batch ceiling for the retention prune (scal-F4): SQLite-portable bounded DELETE. */
const PRUNE_BATCH = 5000;

/** UTC day key 'YYYY-MM-DD' for a timestamp (the daily-rollup bucket key). */
function dayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** UTC day-start ms for a 'YYYY-MM-DD' key. */
function dayStartMs(day: string): number {
  return Date.parse(`${day}T00:00:00.000Z`);
}

function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  if (sortedAsc.length === 1) return sortedAsc[0];
  // Nearest-rank on a 0..1 fraction.
  const rank = Math.ceil(p * sortedAsc.length);
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, rank - 1));
  return sortedAsc[idx];
}

export class FeatureMetricsLedger {
  private db: BetterSqliteDatabase;
  private now: () => number;
  private insertStmt!: ReturnType<BetterSqliteDatabase['prepare']>;
  private rollupUpsertStmt: ReturnType<BetterSqliteDatabase['prepare']> | null = null;
  private readonly maintainSpendRollup: boolean;
  private lastRollupReconcileMs: number | null = null;
  private closed = false;

  constructor(opts: FeatureMetricsLedgerOptions) {
    this.now = opts.now ?? (() => Date.now());
    this.maintainSpendRollup = opts.maintainSpendRollup === true;
    if (opts.dbPath !== ':memory:') {
      fs.mkdirSync(path.dirname(opts.dbPath), { recursive: true });
    }
    // Open through the native-module healer — same ABI-resilience as TokenLedger,
    // so a Node upgrade can't brick /metrics/features forever.
    this.db = NativeModuleHealer.openWithHealSync(
      'FeatureMetricsLedger',
      () => opts.databaseFactory?.(opts.dbPath) ?? new Database(opts.dbPath),
    );
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    for (const ddl of SCHEMA) this.db.exec(ddl);
    this.ensureAddedColumns();
    // Close-on-exit registry (SqliteRegistry.ts) — closed once at shutdown.
    registerSqliteHandle(() => { try { this.db?.close(); } catch { /* already closed */ } });
    this.insertStmt = this.db.prepare(
      `INSERT INTO feature_metrics
         (ts, feature, kind, outcome, tokens_in, tokens_out, tokens_cached, latency_ms, model, framework, door, call_id, waited, wait_ms, verdict_id)
       VALUES (@ts, @feature, @kind, @outcome, @tokensIn, @tokensOut, @tokensCached, @latencyMs, @model, @framework, @door, @callId, @waited, @waitMs, @verdictId)`,
    );
    if (this.maintainSpendRollup) {
      try {
        this.rollupUpsertStmt = this.db.prepare(
          `INSERT INTO spend_token_rollup (day, door, model_id, tokens_in, tokens_out, tokens_cached)
             VALUES (@day, @door, @modelId, @tokensIn, @tokensOut, @tokensCached)
           ON CONFLICT(day, door, model_id) DO UPDATE SET
             tokens_in     = tokens_in     + excluded.tokens_in,
             tokens_out    = tokens_out    + excluded.tokens_out,
             tokens_cached = tokens_cached + excluded.tokens_cached`,
        );
        // Bounded boot reconcile: recompute the last 30 days of daily buckets from raw
        // rows, so an upsert dropped by a crash is repaired before the raw rows prune,
        // and a missing rollup table is backfilled (scal — the fold is idempotent).
        this.reconcileSpendRollup(30);
      } catch {
        // @silent-fallback-ok: the rollup is a reporting aggregate. A prepare/reconcile
        // failure leaves it un-maintained (the spend view degrades to what it can read)
        // — it must never break the primary metrics insert path this store exists for.
        this.rollupUpsertStmt = null;
      }
    }
  }

  /** Add post-ship columns to an existing table, idempotently (pragma-guarded). */
  private ensureAddedColumns(): void {
    try {
      const existing = new Set(
        (this.db.prepare(`PRAGMA table_info(feature_metrics)`).all() as Array<{ name: string }>).map((c) => c.name),
      );
      for (const col of ADDED_COLUMNS) {
        if (!existing.has(col.name)) this.db.exec(col.ddl);
      }
    } catch {
      // @silent-fallback-ok: a failed column add leaves the DB on the old shape;
      // record() writes the new field as null and the rollup degrades to []
      // rather than throwing. Observability must never break its own open path.
    }
  }

  /** Record a metric row (typically one LLM funnel call). Never throws to callers. */
  record(r: FeatureMetricRecord): void {
    if (this.closed) return;
    const ts = r.ts ?? this.now();
    const kind = r.kind ?? 'llm';
    try {
      this.insertStmt.run({
        ts,
        feature: r.feature && r.feature.trim() ? r.feature : 'unlabeled',
        kind,
        outcome: r.outcome,
        tokensIn: r.tokensIn ?? null,
        tokensOut: r.tokensOut ?? null,
        tokensCached: r.tokensCached ?? null,
        latencyMs: r.latencyMs ?? null,
        model: r.model ?? null,
        framework: r.framework ?? null,
        door: r.door ?? null,
        callId: r.callId ?? null,
        waited: r.waited ? 1 : 0,
        waitMs: r.waitMs ?? null,
        verdictId: r.verdictId ?? null,
      });
    } catch {
      // Observability must never break the path it observes (Close the Loop:
      // the metric is a side-channel, not a gate). Swallow write errors.
    }
    // Layer 2 daily-rollup upsert — post-insert, fire-and-forget, fully isolated in its
    // own try/catch so it can NEVER affect the primary insert above or its guarantees.
    // llm-kind rows only (token-bearing); events carry no spend.
    if (this.rollupUpsertStmt && kind === 'llm') {
      try {
        this.rollupUpsertStmt.run({
          day: dayKey(ts),
          door: r.door && r.door.trim() ? r.door : 'unknown',
          modelId: r.model && r.model.trim() ? r.model : 'unknown',
          tokensIn: r.tokensIn ?? 0,
          tokensOut: r.tokensOut ?? 0,
          tokensCached: r.tokensCached ?? 0,
        });
      } catch {
        // @silent-fallback-ok: the daily rollup is a reporting aggregate repaired by the
        // boot reconcile from raw truth — a dropped upsert is never lost data.
      }
    }
  }

  /** Convenience for programmatic (non-LLM) guards: invocation + verdict, no token cost. */
  recordEvent(feature: string, outcome: FeatureMetricOutcome, verdictId?: string): void {
    this.record({ feature, kind: 'event', outcome, verdictId });
  }

  private sinceMsFrom(opts: { sinceHours?: number }): number {
    return opts.sinceHours && opts.sinceHours > 0 ? this.now() - opts.sinceHours * 3_600_000 : 0;
  }

  /** Per-feature rollup over the lookback window (default: all time). */
  byFeature(opts: { sinceHours?: number } = {}): FeatureRollup[] {
    return this.byFeatureCore(this.sinceMsFrom(opts), { includeProviderScan: true });
  }

  /**
   * Core per-feature rollup. `includeProviderScan: false` skips the DISTINCT
   * frameworks/models window scan — summary() derives those arrays from the
   * byFeatureModel partition instead (its group keys ARE feature×framework×
   * model), so the per-model slice lands at NET-ZERO window scans, not +1.
   */
  private byFeatureCore(
    sinceMs: number,
    o: { includeProviderScan: boolean },
  ): FeatureRollup[] {
    const agg = this.db
      .prepare(
        `SELECT
           feature,
           COUNT(*)                                           AS calls,
           SUM(CASE WHEN kind='llm'   THEN 1 ELSE 0 END)      AS llmCalls,
           SUM(CASE WHEN kind='event' THEN 1 ELSE 0 END)      AS events,
           COALESCE(SUM(tokens_in), 0)                        AS tokensIn,
           COALESCE(SUM(tokens_out), 0)                       AS tokensOut,
           COALESCE(SUM(tokens_cached), 0)                    AS tokensCached,
           SUM(CASE WHEN outcome='fired' THEN 1 ELSE 0 END)   AS fired,
           SUM(CASE WHEN outcome='noop'  THEN 1 ELSE 0 END)   AS noop,
           SUM(CASE WHEN outcome='error' THEN 1 ELSE 0 END)   AS errors,
           SUM(CASE WHEN outcome='shed'  THEN 1 ELSE 0 END)   AS shed,
           SUM(waited)                                        AS waitedCalls,
           COALESCE(AVG(CASE WHEN waited=1 THEN wait_ms END), 0) AS avgWaitMs,
           COALESCE(AVG(latency_ms), 0)                       AS avgLatencyMs,
           COALESCE(MAX(latency_ms), 0)                       AS maxLatencyMs
         FROM feature_metrics
         WHERE ts >= ?
         GROUP BY feature
         ORDER BY calls DESC`,
      )
      .all(sinceMs) as Array<Record<string, number | string>>;

    // Percentiles in JS from the per-feature latency lists (bounded by the
    // window). This is the one full-row-materializing query and stays
    // single-keyed — a future per-model percentile must reuse one
    // composite-key query, never a second full-window load.
    const latRows = this.db
      .prepare(
        `SELECT feature, latency_ms FROM feature_metrics
          WHERE ts >= ? AND latency_ms IS NOT NULL
          ORDER BY feature, latency_ms ASC`,
      )
      .all(sinceMs) as Array<{ feature: string; latency_ms: number }>;
    const latByFeature = new Map<string, number[]>();
    for (const row of latRows) {
      const arr = latByFeature.get(row.feature) ?? [];
      arr.push(row.latency_ms);
      latByFeature.set(row.feature, arr);
    }

    // Distinct provider/model per feature in the window (Observable
    // Intelligence). Skipped when the caller derives these from the
    // byFeatureModel partition (summary()).
    const fwByFeature = new Map<string, Set<string>>();
    const modelByFeature = new Map<string, Set<string>>();
    if (o.includeProviderScan) {
      const fwRows = this.db
        .prepare(
          `SELECT DISTINCT feature, framework, model FROM feature_metrics
            WHERE ts >= ? AND (framework IS NOT NULL OR model IS NOT NULL)`,
        )
        .all(sinceMs) as Array<{ feature: string; framework: string | null; model: string | null }>;
      for (const row of fwRows) {
        if (row.framework) {
          const s = fwByFeature.get(row.feature) ?? new Set<string>();
          s.add(row.framework);
          fwByFeature.set(row.feature, s);
        }
        if (row.model) {
          const s = modelByFeature.get(row.feature) ?? new Set<string>();
          s.add(row.model);
          modelByFeature.set(row.feature, s);
        }
      }
    }

    return agg.map((a) => {
      const calls = Number(a.calls) || 0;
      const fired = Number(a.fired) || 0;
      const shed = Number(a.shed) || 0;
      const realCalls = calls - shed;
      const lats = latByFeature.get(String(a.feature)) ?? [];
      return {
        feature: String(a.feature),
        calls,
        realCalls,
        llmCalls: Number(a.llmCalls) || 0,
        events: Number(a.events) || 0,
        tokensIn: Number(a.tokensIn) || 0,
        tokensOut: Number(a.tokensOut) || 0,
        tokensCached: Number(a.tokensCached) || 0,
        frameworks: Array.from(fwByFeature.get(String(a.feature)) ?? []).sort(),
        models: Array.from(modelByFeature.get(String(a.feature)) ?? []).sort(),
        fired,
        noop: Number(a.noop) || 0,
        errors: Number(a.errors) || 0,
        shed,
        fireRate: realCalls > 0 ? fired / realCalls : 0,
        avgLatencyMs: Math.round(Number(a.avgLatencyMs) || 0),
        p50LatencyMs: percentile(lats, 0.5),
        p95LatencyMs: percentile(lats, 0.95),
        maxLatencyMs: Number(a.maxLatencyMs) || 0,
        waitedCalls: Number(a.waitedCalls) || 0,
        avgWaitMs: Math.round(Number(a.avgWaitMs) || 0),
      };
    });
  }

  /**
   * Feature×model×framework partition (token-audit-completeness, Slice 2).
   * llm-kind rows only; NULL model/framework render "unknown". ONE composite-
   * key GROUP BY carries the usage-presence counts itself — SQLite
   * COUNT(expr) counts non-NULL, so `COUNT(CASE WHEN outcome IN
   * ('fired','noop') THEN tokens_in END)` is the success-rows-with-usage
   * count (a recorded 0 counts as reported; a SUM would let one large row
   * mask N null rows). No latency percentiles on this dimension.
   */
  byFeatureModel(opts: { sinceHours?: number } = {}): FeatureModelRollup[] {
    const sinceMs = this.sinceMsFrom(opts);
    let rows: Array<Record<string, number | string | null>>;
    try {
      rows = this.db
        .prepare(
          `SELECT
             feature,
             model,
             framework,
             COUNT(*)                                                          AS calls,
             COALESCE(SUM(tokens_in), 0)                                       AS tokensIn,
             COALESCE(SUM(tokens_out), 0)                                      AS tokensOut,
             COALESCE(SUM(tokens_cached), 0)                                   AS tokensCached,
             SUM(CASE WHEN outcome='fired' THEN 1 ELSE 0 END)                  AS fired,
             SUM(CASE WHEN outcome='noop'  THEN 1 ELSE 0 END)                  AS noop,
             SUM(CASE WHEN outcome='error' THEN 1 ELSE 0 END)                  AS errors,
             SUM(CASE WHEN outcome='shed'  THEN 1 ELSE 0 END)                  AS shed,
             COUNT(CASE WHEN outcome IN ('fired','noop') THEN tokens_in END)   AS successRowsWithUsage,
             COUNT(CASE WHEN outcome='error' THEN tokens_in END)               AS errorRowsWithUsage
           FROM feature_metrics
           WHERE ts >= ? AND kind='llm'
           GROUP BY feature, model, framework
           ORDER BY tokensIn + tokensOut DESC, calls DESC`,
        )
        .all(sinceMs) as Array<Record<string, number | string | null>>;
    } catch {
      // @silent-fallback-ok: identical failure envelope to byFeature on a DB
      // whose ALTER was swallowed — degrade to [] rather than throw.
      return [];
    }
    return rows.map((r) => {
      const calls = Number(r.calls) || 0;
      const shed = Number(r.shed) || 0;
      return {
        feature: String(r.feature),
        model: r.model === null || r.model === undefined ? 'unknown' : String(r.model),
        framework: r.framework === null || r.framework === undefined ? 'unknown' : String(r.framework),
        calls,
        realCalls: calls - shed,
        tokensIn: Number(r.tokensIn) || 0,
        tokensOut: Number(r.tokensOut) || 0,
        tokensCached: Number(r.tokensCached) || 0,
        fired: Number(r.fired) || 0,
        noop: Number(r.noop) || 0,
        errors: Number(r.errors) || 0,
        shed,
        successRowsWithUsage: Number(r.successRowsWithUsage) || 0,
        errorRowsWithUsage: Number(r.errorRowsWithUsage) || 0,
      };
    });
  }

  /**
   * Frameworks whose provider implementation cannot surface per-call usage by
   * documented contract (the cannot-surface list, keyed per implementation —
   * see the provider usage-contract test, which derives expectations from
   * fixtures, never from this list).
   */
  private static readonly USAGE_EXEMPT_FRAMEWORKS = new Set(['gemini-cli']);

  /** Totals + per-feature rollup, enriched with the per-model partition. */
  summary(opts: { sinceHours?: number } = {}): FeatureMetricsSummary {
    const sinceMs = this.sinceMsFrom(opts);
    // ONE byFeatureModel call, partitioned in JS — per-feature slicing
    // queries are forbidden (N× full-window scans on synchronous
    // better-sqlite3).
    const partition = this.byFeatureModel(opts);
    const features = this.byFeatureCore(sinceMs, { includeProviderScan: false });

    // Derive per-feature byModel + frameworks/models from the partition
    // (scan-neutral: subsumes the DISTINCT provider scan).
    const byFeaturePartition = new Map<string, FeatureModelRollup[]>();
    for (const row of partition) {
      const arr = byFeaturePartition.get(row.feature) ?? [];
      arr.push(row);
      byFeaturePartition.set(row.feature, arr);
    }
    for (const f of features) {
      const rows = byFeaturePartition.get(f.feature) ?? [];
      f.byModel = rows;
      f.frameworks = Array.from(new Set(rows.filter((r) => r.framework !== 'unknown').map((r) => r.framework))).sort();
      f.models = Array.from(new Set(rows.filter((r) => r.model !== 'unknown').map((r) => r.model))).sort();
    }

    // totals.byModel — aggregate the same partition by model×framework.
    const modelAgg = new Map<string, ModelRollup>();
    for (const row of partition) {
      const key = `${row.model} ${row.framework}`;
      const acc =
        modelAgg.get(key) ??
        ({
          model: row.model,
          framework: row.framework,
          calls: 0,
          realCalls: 0,
          tokensIn: 0,
          tokensOut: 0,
          tokensCached: 0,
          fired: 0,
          noop: 0,
          errors: 0,
          shed: 0,
        } as ModelRollup);
      acc.calls += row.calls;
      acc.realCalls += row.realCalls;
      acc.tokensIn += row.tokensIn;
      acc.tokensOut += row.tokensOut;
      acc.tokensCached += row.tokensCached;
      acc.fired += row.fired;
      acc.noop += row.noop;
      acc.errors += row.errors;
      acc.shed += row.shed;
      modelAgg.set(key, acc);
    }
    const byModel = Array.from(modelAgg.values()).sort(
      (a, b) => b.tokensIn + b.tokensOut - (a.tokensIn + a.tokensOut),
    );

    // usageCoverage — per framework from the SAME partition (no second window
    // scan). Success-only denominator; interactive-pool rows excluded from
    // the claude-code denominator (that provider never invokes onUsage by
    // documented contract).
    const coverageAgg = new Map<
      string,
      { successRows: number; successRowsWithUsage: number; errorRows: number; errorRowsWithUsage: number; excludedRows: number }
    >();
    for (const row of partition) {
      const fw = row.framework;
      const acc =
        coverageAgg.get(fw) ??
        { successRows: 0, successRowsWithUsage: 0, errorRows: 0, errorRowsWithUsage: 0, excludedRows: 0 };
      const isInteractivePool = fw === 'claude-code' && row.model === 'interactive-pool';
      if (isInteractivePool) {
        acc.excludedRows += row.fired + row.noop;
      } else {
        acc.successRows += row.fired + row.noop;
        acc.successRowsWithUsage += row.successRowsWithUsage;
      }
      acc.errorRows += row.errors;
      acc.errorRowsWithUsage += row.errorRowsWithUsage;
      coverageAgg.set(fw, acc);
    }
    const usageCoverage: UsageCoverageRow[] = Array.from(coverageAgg.entries())
      .map(([framework, c]) => ({
        framework,
        successRows: c.successRows,
        successRowsWithUsage: c.successRowsWithUsage,
        coverage: c.successRows > 0 ? c.successRowsWithUsage / c.successRows : 0,
        errorRows: c.errorRows,
        errorRowsWithUsage: c.errorRowsWithUsage,
        exempt: FeatureMetricsLedger.USAGE_EXEMPT_FRAMEWORKS.has(framework),
        ...(c.excludedRows > 0 ? { excludedRows: c.excludedRows } : {}),
      }))
      .sort((a, b) => a.framework.localeCompare(b.framework));

    const totals = features.reduce(
      (acc, f) => {
        acc.calls += f.calls;
        acc.realCalls += f.realCalls;
        acc.llmCalls += f.llmCalls;
        acc.events += f.events;
        acc.tokensIn += f.tokensIn;
        acc.tokensOut += f.tokensOut;
        acc.tokensCached += f.tokensCached;
        acc.fired += f.fired;
        acc.noop += f.noop;
        acc.errors += f.errors;
        acc.shed += f.shed;
        return acc;
      },
      {
        calls: 0, realCalls: 0, llmCalls: 0, events: 0,
        tokensIn: 0, tokensOut: 0, tokensCached: 0,
        fired: 0, noop: 0, errors: 0, shed: 0,
      },
    );

    // Unlabeled shares — both needed: token-blind unlabeled calls contribute
    // 0/0 to the token share, so the call share is what catches unlabeled
    // traffic running at volume. Zero denominators → 0.
    const unlabeled = features.find((f) => f.feature === 'unlabeled');
    const totalTokens = totals.tokensIn + totals.tokensOut;
    const unlabeledTokens = unlabeled ? unlabeled.tokensIn + unlabeled.tokensOut : 0;
    const unlabeledTokenShare = totalTokens > 0 ? unlabeledTokens / totalTokens : 0;
    const unlabeledCallShare = totals.realCalls > 0 ? (unlabeled?.realCalls ?? 0) / totals.realCalls : 0;

    return {
      sinceMs,
      totals: { ...totals, byModel, usageCoverage, unlabeledTokenShare, unlabeledCallShare },
      features,
    };
  }

  /**
   * Delete raw rows older than `cutoffMs`. Returns rows deleted. Fail-open.
   * Observable Intelligence is balanced by the Responsible Resource standard:
   * the audit trail is kept long enough to see behaviour/performance trends, then
   * aged out — never hoarded forever. Mirrors ResourceLedger.pruneOlderThan.
   *
   * BATCHED (scal-F4): a single unbounded DELETE could lock the DB for a long span on
   * a large table. This deletes in bounded batches (SQLite-portable rowid idiom) up to
   * a per-tick ceiling so a big backlog is drained across ticks, never in one stall.
   */
  pruneOlderThan(cutoffMs: number, opts: { maxBatches?: number } = {}): number {
    if (this.closed) return 0;
    const maxBatches = opts.maxBatches ?? 20;
    let deleted = 0;
    try {
      const stmt = this.db.prepare(
        `DELETE FROM feature_metrics WHERE rowid IN
           (SELECT rowid FROM feature_metrics WHERE ts < ? LIMIT ${PRUNE_BATCH})`,
      );
      for (let i = 0; i < maxBatches; i++) {
        const res = stmt.run(cutoffMs);
        const n = Number(res.changes ?? 0);
        deleted += n;
        if (n < PRUNE_BATCH) break; // drained
      }
      return deleted;
    } catch {
      // @silent-fallback-ok: retention prune is best-effort housekeeping. A failed
      // prune just leaves older rows for the next tick; it must never throw into
      // the path it observes.
      return deleted;
    }
  }

  /**
   * Retention prune for the daily spend rollup (routing-control-room-spend, scal-F3):
   * the long spend history lives here, decoupled from the short raw-row horizon.
   * Deletes buckets whose day is older than `retentionDays`. Fail-open.
   */
  pruneSpendRollup(retentionDays: number): number {
    if (this.closed) return 0;
    try {
      const cutoff = dayKey(this.now() - retentionDays * 86_400_000);
      const res = this.db.prepare(`DELETE FROM spend_token_rollup WHERE day < ?`).run(cutoff);
      return Number(res.changes ?? 0);
    } catch {
      // @silent-fallback-ok: rollup retention prune is best-effort housekeeping (mirrors
      // pruneOlderThan) — a failed prune just leaves old buckets for the next tick.
      return 0;
    }
  }

  /**
   * Recompute the last `days` daily buckets of `spend_token_rollup` from raw
   * feature_metrics rows (idempotent fold — DELETE the window, re-INSERT from truth).
   * Repairs an upsert dropped by a crash and backfills a missing/empty table. No-op
   * when rollup maintenance is off. Returns the number of buckets written.
   */
  reconcileSpendRollup(days: number): number {
    if (this.closed || !this.maintainSpendRollup) return 0;
    try {
      const cutoffDay = dayKey(this.now() - days * 86_400_000);
      const tx = this.db.transaction(() => {
        this.db.prepare(`DELETE FROM spend_token_rollup WHERE day >= ?`).run(cutoffDay);
        const cutoffMs = dayStartMs(cutoffDay);
        const res = this.db
          .prepare(
            `INSERT INTO spend_token_rollup (day, door, model_id, tokens_in, tokens_out, tokens_cached)
             SELECT
               strftime('%Y-%m-%d', ts/1000, 'unixepoch')       AS day,
               COALESCE(NULLIF(TRIM(door), ''), 'unknown')       AS door,
               COALESCE(NULLIF(TRIM(model), ''), 'unknown')      AS model_id,
               COALESCE(SUM(tokens_in), 0),
               COALESCE(SUM(tokens_out), 0),
               COALESCE(SUM(tokens_cached), 0)
             FROM feature_metrics
             WHERE kind='llm' AND ts >= ?
             GROUP BY day, door, model_id`,
          )
          .run(cutoffMs);
        return Number(res.changes ?? 0);
      });
      const written = tx();
      this.lastRollupReconcileMs = this.now();
      return written;
    } catch {
      // @silent-fallback-ok: a reconcile failure leaves the last-good rollup in place;
      // the next boot/reconcile retries. It never touches the raw truth it reads from.
      return 0;
    }
  }

  /** When the daily rollup was last reconciled from raw truth (reportingBasis surface). */
  lastSpendReconcileMs(): number | null {
    return this.lastRollupReconcileMs;
  }

  /** Is the daily spend rollup being maintained on this ledger? */
  spendRollupEnabled(): boolean {
    return this.maintainSpendRollup;
  }

  /**
   * Daily spend-token buckets from the maintained rollup (survives the 400-day horizon).
   * `sinceDays` bounds the window (default: all rollup rows). Returns immutable token
   * sums per day×door×model; price is joined ON READ by the composer.
   */
  spendTokenRollupDaily(opts: { sinceDays?: number } = {}): SpendTokenBucket[] {
    try {
      const params: unknown[] = [];
      let where = '';
      if (opts.sinceDays && opts.sinceDays > 0) {
        where = 'WHERE day >= ?';
        params.push(dayKey(this.now() - opts.sinceDays * 86_400_000));
      }
      const rows = this.db
        .prepare(
          `SELECT day, door, model_id AS modelId, tokens_in AS tokensIn, tokens_out AS tokensOut, tokens_cached AS tokensCached
             FROM spend_token_rollup ${where}
            ORDER BY day ASC`,
        )
        .all(...params) as Array<Record<string, string | number>>;
      return rows.map((r) => ({
        bucket: String(r.day),
        bucketStartMs: dayStartMs(String(r.day)),
        door: String(r.door),
        modelId: String(r.modelId),
        tokensIn: Number(r.tokensIn) || 0,
        tokensOut: Number(r.tokensOut) || 0,
        tokensCached: Number(r.tokensCached) || 0,
      }));
    } catch {
      // @silent-fallback-ok: a read-only reporting query — degrade to an empty result
      // (the spend view shows no rows) rather than throw into the read path.
      return [];
    }
  }

  /**
   * Hourly spend-token buckets computed on read from raw feature_metrics rows within
   * the short raw-retention window (spec Layer 2 — hourly detail is not offered beyond
   * the raw horizon). `sinceHours` bounds the scan (indexed on ts).
   */
  spendTokenRollupHourly(opts: { sinceHours?: number } = {}): SpendTokenBucket[] {
    try {
      const sinceMs = this.sinceMsFrom(opts);
      const rows = this.db
        .prepare(
          `SELECT
             strftime('%Y-%m-%dT%H:00:00Z', ts/1000, 'unixepoch')  AS hour,
             COALESCE(NULLIF(TRIM(door), ''), 'unknown')           AS door,
             COALESCE(NULLIF(TRIM(model), ''), 'unknown')          AS modelId,
             COALESCE(SUM(tokens_in), 0)                           AS tokensIn,
             COALESCE(SUM(tokens_out), 0)                          AS tokensOut,
             COALESCE(SUM(tokens_cached), 0)                       AS tokensCached
           FROM feature_metrics
           WHERE kind='llm' AND ts >= ?
           GROUP BY hour, door, modelId
           ORDER BY hour ASC`,
        )
        .all(sinceMs) as Array<Record<string, string | number>>;
      return rows.map((r) => ({
        bucket: String(r.hour),
        bucketStartMs: Date.parse(String(r.hour)),
        door: String(r.door),
        modelId: String(r.modelId),
        tokensIn: Number(r.tokensIn) || 0,
        tokensOut: Number(r.tokensOut) || 0,
        tokensCached: Number(r.tokensCached) || 0,
      }));
    } catch {
      // @silent-fallback-ok: a read-only reporting query — degrade to an empty result
      // (the spend view shows no hourly rows) rather than throw into the read path.
      return [];
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try { this.db.close(); } catch { /* ignore */ }
  }
}
