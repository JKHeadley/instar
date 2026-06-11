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
];

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
  private closed = false;

  constructor(opts: FeatureMetricsLedgerOptions) {
    this.now = opts.now ?? (() => Date.now());
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
         (ts, feature, kind, outcome, tokens_in, tokens_out, tokens_cached, latency_ms, model, framework, waited, wait_ms, verdict_id)
       VALUES (@ts, @feature, @kind, @outcome, @tokensIn, @tokensOut, @tokensCached, @latencyMs, @model, @framework, @waited, @waitMs, @verdictId)`,
    );
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
    try {
      this.insertStmt.run({
        ts: r.ts ?? this.now(),
        feature: r.feature && r.feature.trim() ? r.feature : 'unlabeled',
        kind: r.kind ?? 'llm',
        outcome: r.outcome,
        tokensIn: r.tokensIn ?? null,
        tokensOut: r.tokensOut ?? null,
        tokensCached: r.tokensCached ?? null,
        latencyMs: r.latencyMs ?? null,
        model: r.model ?? null,
        framework: r.framework ?? null,
        waited: r.waited ? 1 : 0,
        waitMs: r.waitMs ?? null,
        verdictId: r.verdictId ?? null,
      });
    } catch {
      // Observability must never break the path it observes (Close the Loop:
      // the metric is a side-channel, not a gate). Swallow write errors.
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
   * Delete rows older than `cutoffMs`. Returns rows deleted. Fail-open.
   * Observable Intelligence is balanced by the Responsible Resource standard:
   * the audit trail is kept long enough to see behaviour/performance trends, then
   * aged out — never hoarded forever. Mirrors ResourceLedger.pruneOlderThan.
   */
  pruneOlderThan(cutoffMs: number): number {
    if (this.closed) return 0;
    try {
      const res = this.db.prepare(`DELETE FROM feature_metrics WHERE ts < ?`).run(cutoffMs);
      return Number(res.changes ?? 0);
    } catch {
      // @silent-fallback-ok: retention prune is best-effort housekeeping. A failed
      // prune just leaves older rows for the next tick; it must never throw into
      // the path it observes.
      return 0;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try { this.db.close(); } catch { /* ignore */ }
  }
}
