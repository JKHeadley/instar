/**
 * ProviderCostReportStore — Layer 1c of the Routing Control Room
 * (docs/specs/routing-control-room-spend-alerts.md §Layer 1c / FD-21).
 *
 * The provider-grounded REPORTING anchor: an immutable, append-only,
 * timestamped record set of what each metered PROVIDER itself reported about a
 * call — cost (OpenRouter) and/or authoritative token counts (all three) —
 * joined on the per-call `meteredCallId` (=== the money ledger's `reserveId`,
 * === `feature_metrics.callId`). Rows are APPENDED, never mutated; a later,
 * more-authoritative report (e.g. the OpenRouter `/generation` cost arriving
 * after the in-response `usage.cost`) is a NEW row that supersedes by
 * `(meteredCallId, greatest capturedAt)` — matching can never double-count.
 *
 * NEVER A GATE INPUT (the load-bearing invariant, FD-21 — the FD-9/FD-12
 * twin): nothing in `src/core/MeteredSpendGate.ts` / `MeteredSpendLedger.ts`
 * imports this store, and a structural test pins that. Provider-LOWER only
 * changes the report; provider-HIGHER is a drift signal feeding the PIN price-
 * promotion path. The committed counter is never rewritten in either direction.
 *
 * Receive-clamp discipline (the replicated-store pattern): every captured
 * numeric must be finite and ≥ 0 or the row is stored with `invalid = 1` and
 * null numerics (preserved for audit, excluded from every aggregate — never
 * stored raw, never dropped silently); strings are length/charset-clamped.
 *
 * Retention: declared at birth (state-coherence-registry.json) — default 400
 * days (`routingSpend.providerReportRetentionDays`), batched-delete prune
 * (scal-F4). A pruned provider report is NOT re-derivable; 400d of raw rows is
 * affordable because volume is bounded by METERED calls only.
 */

import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { Database as BetterSqliteDatabase } from 'better-sqlite3';
import { NativeModuleHealer } from '../memory/NativeModuleHealer.js';
import { registerSqliteHandle } from '../core/SqliteRegistry.js';

export type ProviderReportSource =
  | 'openrouter-usage'
  | 'openrouter-generation'
  | 'groq-usage'
  | 'gemini-usage-metadata'
  | 'gemini-billing-export'
  | 'invalid-provider-report';

export interface ProviderCostReport {
  ts: string;
  meteredCallId: string;
  keyRef: string;
  door: string;
  modelId: string;
  generationId?: string | null;
  source: ProviderReportSource;
  /** Null when the provider reports no per-call USD (Groq, Gemini). */
  providerCostUsd?: number | null;
  providerTokensIn?: number | null;
  providerTokensOut?: number | null;
  providerTokensCached?: number | null;
  capturedAt: string;
  /** 1 when receive-clamps rejected a numeric — audit-preserved, aggregate-excluded. */
  invalid?: 0 | 1;
}

export interface ReconRecord {
  ts: string;
  keyRef: string;
  door: string;
  windowStartMs: number;
  windowEndMs: number;
  internalUsd: number;
  providerUsd: number | null;
  committedUsd: number | null;
  /** Signed: positive = provider reports MORE than internally derived. */
  driftPct: number | null;
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS provider_cost_report (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     ts TEXT NOT NULL,
     metered_call_id TEXT NOT NULL,
     key_ref TEXT NOT NULL,
     door TEXT NOT NULL,
     model_id TEXT NOT NULL,
     generation_id TEXT,
     source TEXT NOT NULL,
     provider_cost_usd REAL,
     provider_tokens_in INTEGER,
     provider_tokens_out INTEGER,
     provider_tokens_cached INTEGER,
     captured_at TEXT NOT NULL,
     invalid INTEGER NOT NULL DEFAULT 0
   )`,
  `CREATE INDEX IF NOT EXISTS idx_pcr_call ON provider_cost_report (metered_call_id, captured_at)`,
  `CREATE INDEX IF NOT EXISTS idx_pcr_ts ON provider_cost_report (ts)`,
  `CREATE TABLE IF NOT EXISTS recon_record (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     ts TEXT NOT NULL,
     key_ref TEXT NOT NULL,
     door TEXT NOT NULL,
     window_start_ms INTEGER NOT NULL,
     window_end_ms INTEGER NOT NULL,
     internal_usd REAL NOT NULL,
     provider_usd REAL,
     committed_usd REAL,
     drift_pct REAL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_recon_ts ON recon_record (ts)`,
];

const PRUNE_BATCH = 5000;
const STR_MAX = 256;

/** Length + charset clamp for provider-authored strings (stored; HTML-escape happens at render). */
function clampStr(v: unknown, max = STR_MAX): string | null {
  if (typeof v !== 'string') return null;
  const s = v.slice(0, max).replace(/[^\x20-\x7E]/g, '?');
  return s.length ? s : null;
}

/** Finite ≥ 0 numeric or null (the receive clamp). */
function clampNum(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
}

export interface ProviderCostReportStoreOptions {
  dbPath: string;
  retentionDays?: number;
  now?: () => number;
  databaseFactory?: (dbPath: string) => BetterSqliteDatabase;
}

export class ProviderCostReportStore {
  private db: BetterSqliteDatabase;
  private readonly now: () => number;
  private readonly retentionDays: number;

  constructor(opts: ProviderCostReportStoreOptions) {
    this.now = opts.now ?? (() => Date.now());
    this.retentionDays = opts.retentionDays ?? 400;
    if (opts.dbPath !== ':memory:') fs.mkdirSync(path.dirname(opts.dbPath), { recursive: true });
    this.db = NativeModuleHealer.openWithHealSync(
      'ProviderCostReportStore',
      () => opts.databaseFactory?.(opts.dbPath) ?? new Database(opts.dbPath),
    );
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    for (const ddl of SCHEMA) this.db.exec(ddl);
    registerSqliteHandle(() => { try { this.db?.close(); } catch { /* already closed */ } });
  }

  /**
   * Append one provider report (the capture seam's write). Receive-clamped: a
   * NaN/Infinity/negative numeric marks the row `invalid` with null numerics —
   * preserved for audit, excluded from aggregates, never stored raw. Best-effort
   * BY SPEC at the seam (the CALLER swallows a throw; the settle at the same
   * seam is fail-closed and already durably booked before capture runs).
   */
  append(report: {
    meteredCallId: string;
    keyRef: string;
    door: string;
    modelId: string;
    generationId?: string | null;
    source: ProviderReportSource;
    providerCostUsd?: unknown;
    providerTokensIn?: unknown;
    providerTokensOut?: unknown;
    providerTokensCached?: unknown;
  }): void {
    const rawNums = [report.providerCostUsd, report.providerTokensIn, report.providerTokensOut, report.providerTokensCached];
    // invalid = a numeric was PRESENT but unclampable (absent/null is fine — providers differ).
    const invalid = rawNums.some((v) => v !== undefined && v !== null && clampNum(v) === null) ? 1 : 0;
    const nowIso = new Date(this.now()).toISOString();
    this.db
      .prepare(
        `INSERT INTO provider_cost_report
           (ts, metered_call_id, key_ref, door, model_id, generation_id, source,
            provider_cost_usd, provider_tokens_in, provider_tokens_out, provider_tokens_cached,
            captured_at, invalid)
         VALUES (@ts, @callId, @keyRef, @door, @modelId, @generationId, @source,
                 @cost, @tin, @tout, @tcached, @capturedAt, @invalid)`,
      )
      .run({
        ts: nowIso,
        callId: clampStr(report.meteredCallId, 64) ?? 'unknown',
        keyRef: clampStr(report.keyRef, 64) ?? 'unknown',
        door: clampStr(report.door, 64) ?? 'unknown',
        modelId: clampStr(report.modelId, 128) ?? 'unknown',
        generationId: clampStr(report.generationId ?? null),
        source: invalid ? 'invalid-provider-report' : report.source,
        cost: invalid ? null : clampNum(report.providerCostUsd),
        tin: invalid ? null : clampNum(report.providerTokensIn),
        tout: invalid ? null : clampNum(report.providerTokensOut),
        tcached: invalid ? null : clampNum(report.providerTokensCached),
        capturedAt: nowIso,
        invalid,
      });
  }

  /**
   * The superseded-resolved view of one call: the newest valid row per
   * meteredCallId (`greatest capturedAt` wins — a late /generation cost
   * supersedes the in-response usage.cost; never double-counts).
   */
  latestForCall(meteredCallId: string): ProviderCostReport | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM provider_cost_report
          WHERE metered_call_id = ? AND invalid = 0
          ORDER BY captured_at DESC, id DESC LIMIT 1`,
      )
      .get(meteredCallId) as Record<string, unknown> | undefined;
    return row ? rowToReport(row) : undefined;
  }

  /**
   * Superseded-resolved provider totals per (keyRef, door) over a window —
   * the reconciliation sweep's provider side. Bounded + indexed; one pass.
   */
  windowTotals(sinceMs: number, untilMs: number): Array<{ keyRef: string; door: string; providerCostUsd: number | null; reportedCalls: number; tokensOut: number | null }> {
    // Latest valid row per call inside the window, then aggregate.
    const rows = this.db
      .prepare(
        `SELECT key_ref, door, provider_cost_usd, provider_tokens_out FROM provider_cost_report p
          WHERE invalid = 0 AND ts >= ? AND ts <= ?
            AND id = (SELECT id FROM provider_cost_report q
                       WHERE q.metered_call_id = p.metered_call_id AND q.invalid = 0
                       ORDER BY q.captured_at DESC, q.id DESC LIMIT 1)`,
      )
      .all(new Date(sinceMs).toISOString(), new Date(untilMs).toISOString()) as Array<Record<string, unknown>>;
    const agg = new Map<string, { keyRef: string; door: string; cost: number; costSeen: boolean; calls: number; tout: number; toutSeen: boolean }>();
    for (const r of rows) {
      const keyRef = String(r.key_ref);
      const door = String(r.door);
      const k = `${keyRef} ${door}`;
      const a = agg.get(k) ?? { keyRef, door, cost: 0, costSeen: false, calls: 0, tout: 0, toutSeen: false };
      a.calls += 1;
      if (typeof r.provider_cost_usd === 'number') {
        a.cost += r.provider_cost_usd;
        a.costSeen = true;
      }
      if (typeof r.provider_tokens_out === 'number') {
        a.tout += r.provider_tokens_out;
        a.toutSeen = true;
      }
      agg.set(k, a);
    }
    return [...agg.values()].map((a) => ({
      keyRef: a.keyRef,
      door: a.door,
      providerCostUsd: a.costSeen ? Math.round(a.cost * 1e6) / 1e6 : null,
      reportedCalls: a.calls,
      tokensOut: a.toutSeen ? a.tout : null,
    }));
  }

  /** Daily provider-cost aggregates for the summary composer's provider-preferred basis. */
  dailyCostAggregates(sinceDays: number): Array<{ day: string; door: string; modelId: string; providerCostUsd: number; reportedCalls: number }> {
    const sinceIso = new Date(this.now() - sinceDays * 86_400_000).toISOString();
    const rows = this.db
      .prepare(
        `SELECT substr(ts, 1, 10) AS day, door, model_id, provider_cost_usd FROM provider_cost_report p
          WHERE invalid = 0 AND provider_cost_usd IS NOT NULL AND ts >= ?
            AND id = (SELECT id FROM provider_cost_report q
                       WHERE q.metered_call_id = p.metered_call_id AND q.invalid = 0
                       ORDER BY q.captured_at DESC, q.id DESC LIMIT 1)`,
      )
      .all(sinceIso) as Array<Record<string, unknown>>;
    const agg = new Map<string, { day: string; door: string; modelId: string; cost: number; calls: number }>();
    for (const r of rows) {
      const day = String(r.day);
      const door = String(r.door);
      const modelId = String(r.model_id);
      const k = `${day} ${door} ${modelId}`;
      const a = agg.get(k) ?? { day, door, modelId, cost: 0, calls: 0 };
      a.cost += r.provider_cost_usd as number;
      a.calls += 1;
      agg.set(k, a);
    }
    return [...agg.values()].map((a) => ({ day: a.day, door: a.door, modelId: a.modelId, providerCostUsd: Math.round(a.cost * 1e6) / 1e6, reportedCalls: a.calls }));
  }

  /** Append one reconciliation record (the sweep's output — append-only, same retention). */
  appendRecon(rec: Omit<ReconRecord, 'ts'>): void {
    this.db
      .prepare(
        `INSERT INTO recon_record
           (ts, key_ref, door, window_start_ms, window_end_ms, internal_usd, provider_usd, committed_usd, drift_pct)
         VALUES (@ts, @keyRef, @door, @ws, @we, @internal, @provider, @committed, @drift)`,
      )
      .run({
        ts: new Date(this.now()).toISOString(),
        keyRef: clampStr(rec.keyRef, 64) ?? 'unknown',
        door: clampStr(rec.door, 64) ?? 'unknown',
        ws: rec.windowStartMs,
        we: rec.windowEndMs,
        internal: rec.internalUsd,
        provider: rec.providerUsd,
        committed: rec.committedUsd,
        drift: rec.driftPct,
      });
  }

  /** Recent reconciliation records (newest first, bounded). */
  recentRecon(limit = 100): ReconRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM recon_record ORDER BY id DESC LIMIT ?`)
      .all(Math.max(1, Math.min(1000, limit))) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      ts: String(r.ts),
      keyRef: String(r.key_ref),
      door: String(r.door),
      windowStartMs: Number(r.window_start_ms),
      windowEndMs: Number(r.window_end_ms),
      internalUsd: Number(r.internal_usd),
      providerUsd: r.provider_usd === null ? null : Number(r.provider_usd),
      committedUsd: r.committed_usd === null ? null : Number(r.committed_usd),
      driftPct: r.drift_pct === null ? null : Number(r.drift_pct),
    }));
  }

  /** Batched retention prune (scal-F4) for BOTH tables. Returns rows removed. */
  prune(): number {
    const cutoff = new Date(this.now() - this.retentionDays * 86_400_000).toISOString();
    let removed = 0;
    for (const table of ['provider_cost_report', 'recon_record']) {
      for (;;) {
        const r = this.db
          .prepare(`DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE ts < ? LIMIT ${PRUNE_BATCH})`)
          .run(cutoff);
        removed += r.changes;
        if (r.changes < PRUNE_BATCH) break;
      }
    }
    return removed;
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      // @silent-fallback-ok: double-close at shutdown is benign.
    }
  }
}

function rowToReport(r: Record<string, unknown>): ProviderCostReport {
  return {
    ts: String(r.ts),
    meteredCallId: String(r.metered_call_id),
    keyRef: String(r.key_ref),
    door: String(r.door),
    modelId: String(r.model_id),
    generationId: r.generation_id === null ? null : String(r.generation_id),
    source: String(r.source) as ProviderReportSource,
    providerCostUsd: r.provider_cost_usd === null ? null : Number(r.provider_cost_usd),
    providerTokensIn: r.provider_tokens_in === null ? null : Number(r.provider_tokens_in),
    providerTokensOut: r.provider_tokens_out === null ? null : Number(r.provider_tokens_out),
    providerTokensCached: r.provider_tokens_cached === null ? null : Number(r.provider_tokens_cached),
    capturedAt: String(r.captured_at),
    invalid: (r.invalid as 0 | 1) ?? 0,
  };
}

/**
 * Per-door provider-report field extraction — the capture seam's parser
 * (spec §Layer 1c table). Reads ONLY the in-hand response body the settle
 * already used; a field that is absent/renamed/reshaped degrades that report
 * to token-only or nothing (a first-class NORMAL state, never an error path).
 */
export function extractProviderReport(
  door: string,
  body: Record<string, unknown> | undefined,
): { source: ProviderReportSource; providerCostUsd?: number; providerTokensIn?: number; providerTokensOut?: number; providerTokensCached?: number; generationId?: string } | null {
  if (!body || typeof body !== 'object') return null;
  const usage = (body.usage ?? body.usageMetadata) as Record<string, unknown> | undefined;
  if (!usage || typeof usage !== 'object') return null;
  const n = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined);
  if (door === 'openrouter-api') {
    const details = usage.prompt_tokens_details as Record<string, unknown> | undefined;
    return {
      source: 'openrouter-usage',
      providerCostUsd: n(usage.cost),
      providerTokensIn: n(usage.prompt_tokens),
      providerTokensOut: n(usage.completion_tokens),
      providerTokensCached: n(details?.cached_tokens),
      generationId: typeof body.id === 'string' ? body.id : undefined,
    };
  }
  if (door === 'groq-api') {
    return {
      source: 'groq-usage',
      providerTokensIn: n(usage.prompt_tokens),
      providerTokensOut: n(usage.completion_tokens),
    };
  }
  if (door === 'gemini-api') {
    // Native path (usageMetadata) or OpenAI-compat (usage) — both shapes named.
    const candidates = n(usage.candidatesTokenCount);
    const thoughts = n(usage.thoughtsTokenCount) ?? 0;
    return {
      source: 'gemini-usage-metadata',
      providerTokensIn: n(usage.promptTokenCount) ?? n(usage.prompt_tokens),
      providerTokensOut: candidates !== undefined ? candidates + thoughts : n(usage.completion_tokens),
      providerTokensCached: n(usage.cachedContentTokenCount),
    };
  }
  return null;
}
