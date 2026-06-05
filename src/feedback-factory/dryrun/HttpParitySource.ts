/**
 * HttpParitySource.ts — the live Phase-1/3 ParitySource adapter.
 *
 * Portal exposes `GET /api/instar/read` (Dawn, committed at d65136b3b6) as the
 * read-only seam — the architectural pivot from raw Postgres after Prisma Data
 * Platform refused to mint a database role (it forbids CREATE ROLE / GRANT). API
 * level is actually a cleaner seam than direct DB access: the dry-run tests
 * against the same contract Phase 2 (write/update APIs) will use, with no
 * Prisma-admin dependency, and the architectural levels line up (Portal's HTTP
 * surface ↔ Instar's {@link ParitySource} interface).
 *
 * This adapter implements ParitySource via that endpoint. The runner's seam,
 * comparator, invariants, and JSONL audit trail are unchanged — only the read
 * adapter swaps. Reads are PRE-FETCHED in {@link prepare}: the dry-run captures
 * one snapshot of Portal's clusters at a moment in time, then compares against
 * that frozen view. This makes the sync `readPortalClusters()` contract trivially
 * satisfiable and stabilises the comparison against in-flight Portal writes
 * (Portal remains the sole writer; we just look at one consistent slice).
 *
 * The endpoint is paginated (server-side cap: 1000 rows per request). The
 * pagination is keyed off the feedback table — clusters/dispatches accompany each
 * page and may repeat — so cluster collection deduplicates by clusterId across
 * pages and stops when a page returns fewer feedback rows than the requested
 * limit (the documented "no more pages" signal) OR after a hard safety cap.
 *
 * Field naming is intentionally tolerant: cluster rows may arrive as camelCase
 * (Prisma default) or snake_case (raw SQL projection). The mapper accepts both.
 */

import type { ParitySource } from './dryRunCompare.js';
import type { PortalCluster } from '../processor/parity.js';

/** Minimal fetch shape the adapter needs (lets tests pass a stub). */
export type FetchLike = (input: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  statusText: string;
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

export interface HttpParitySourceConfig {
  /** Portal base URL, e.g. `https://portal.bot-me.ai`. */
  baseUrl: string;
  /** Bearer token with `instar:read` scope. */
  token: string;
  /** Page size sent as `?limit=`. Default 1000 (server max per Dawn's contract). */
  pageSize?: number;
  /** Safety cap on pagination loops. Default 200 pages (= 200k feedback rows). */
  maxPages?: number;
  /** Optional `?status=` filter passed through to the endpoint. */
  status?: string;
  /** Injectable fetch (for tests). Defaults to global `fetch`. */
  fetchImpl?: FetchLike;
  /** Optional path override (defaults to `/api/instar/read`). */
  readPath?: string;
  /**
   * Per-page fetch timeout in ms. Default 90 000 (a healthy full snapshot ran
   * ~15s/page, so 90s is ~6× headroom). Enforced via AbortSignal so one stalled
   * Portal page request cannot hang `prepare()` forever — the 2026-06-05 live
   * incident: a silent page stall left a triggered parity pass unresolved for
   * 10+ minutes with no logged outcome and nothing recorded.
   */
  pageTimeoutMs?: number;
  /**
   * Total budget for the whole snapshot fetch in ms. Default 600 000 (10 min).
   * Checked between pages AND bounds each page's abort signal, so `prepare()`
   * has a hard upper duration even at the 200-page safety cap.
   */
  totalTimeoutMs?: number;
  /**
   * When true, `prepare()` ALSO captures the raw cluster + feedback rows verbatim
   * (every field as the wire delivered it, no coercion) for the AS-IS import
   * runner. Off by default — parity mode only needs the typed cluster projection.
   */
  captureRaw?: boolean;
}

/** Shape returned by Portal at `/api/instar/read` (only the fields we read). */
interface ReadResponseEnvelope {
  data?: {
    clusters?: unknown[];
    feedback?: unknown[];
    dispatches?: unknown[];
  };
  meta?: {
    total_feedback_rows?: number;
    returned_count?: number;
    query_time_ms?: number;
    timestamp?: string;
  };
}

/** Error thrown when Portal returns non-OK. The status code is preserved for callers. */
export class HttpParitySourceError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'HttpParitySourceError';
    this.status = status;
  }
}

/**
 * Coerce one raw cluster row into the {@link PortalCluster} shape. Accepts both
 * camelCase and snake_case keys; missing optional fields stay undefined. Throws
 * only when the required keys (clusterId, type, title, fingerprint) cannot be
 * resolved — a row that opaque is a contract violation we want to surface.
 */
function coerceCluster(row: unknown): PortalCluster {
  if (!row || typeof row !== 'object') {
    throw new HttpParitySourceError(502, 'cluster row is not an object');
  }
  const r = row as Record<string, unknown>;
  const pick = (...keys: string[]): unknown => {
    for (const k of keys) if (r[k] !== undefined && r[k] !== null) return r[k];
    return undefined;
  };
  const clusterId = pick('clusterId', 'cluster_id', 'id');
  const type = pick('type');
  const title = pick('title');
  const fingerprint = pick('fingerprint') ?? '';
  if (typeof clusterId !== 'string' || typeof type !== 'string' || typeof title !== 'string') {
    throw new HttpParitySourceError(502, `cluster row missing required fields (clusterId/type/title)`);
  }
  const out: PortalCluster = { clusterId, type, title, fingerprint: String(fingerprint) };
  const status = pick('status');
  if (typeof status === 'string') out.status = status;
  const rc = pick('recurrenceCount', 'recurrence_count');
  if (typeof rc === 'number') out.recurrenceCount = rc;
  return out;
}

/**
 * Live ParitySource backed by Portal's `/api/instar/read` endpoint. Construct
 * with the base URL + read-scope token, then `await source.prepare()` once
 * before passing to {@link runDryRunCompare}. The pre-fetch captures a single
 * consistent snapshot of Portal's clusters; the runner reads it synchronously.
 */
export class HttpParitySource implements ParitySource {
  private snapshot: PortalCluster[] | null = null;
  /** Raw rows verbatim (only populated when `captureRaw` is set). */
  private rawClusters: Map<string, Record<string, unknown>> | null = null;
  private rawFeedback: Map<string, Record<string, unknown>> | null = null;
  private rawFeedbackUnkeyed: Record<string, unknown>[] = [];
  private readonly pageSize: number;
  private readonly maxPages: number;
  private readonly fetch: FetchLike;
  private readonly readPath: string;
  private readonly pageTimeoutMs: number;
  private readonly totalTimeoutMs: number;

  constructor(private readonly config: HttpParitySourceConfig) {
    this.pageSize = config.pageSize ?? 1000;
    this.maxPages = config.maxPages ?? 200;
    this.fetch = config.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
    this.readPath = config.readPath ?? '/api/instar/read';
    this.pageTimeoutMs = config.pageTimeoutMs ?? 90_000;
    this.totalTimeoutMs = config.totalTimeoutMs ?? 600_000;
    if (!this.fetch) {
      throw new HttpParitySourceError(500, 'no fetch available — pass fetchImpl or run on a runtime with global fetch');
    }
  }

  /** Pre-fetch and cache the cluster snapshot. Idempotent: re-calling re-fetches. */
  async prepare(): Promise<void> {
    const byId = new Map<string, PortalCluster>();
    const rawClusters = this.config.captureRaw ? new Map<string, Record<string, unknown>>() : null;
    const rawFeedback = this.config.captureRaw ? new Map<string, Record<string, unknown>>() : null;
    const rawFeedbackUnkeyed: Record<string, unknown>[] = [];
    const base = this.config.baseUrl.replace(/\/+$/, '');
    const authHeader = `Bearer ${this.config.token}`;
    const deadline = Date.now() + this.totalTimeoutMs;

    for (let page = 0; page < this.maxPages; page++) {
      const offset = page * this.pageSize;
      const qs = new URLSearchParams({ limit: String(this.pageSize), offset: String(offset) });
      if (this.config.status) qs.set('status', this.config.status);
      const url = `${base}${this.readPath}?${qs.toString()}`;

      // Hard duration bound (the 2026-06-05 hang fix): every page fetch carries
      // an AbortSignal capped by BOTH the per-page timeout and the remaining
      // total budget. A stalled request aborts instead of hanging the pass —
      // the route layer then logs the classified failure (per #807's
      // always-logged-outcome contract) and records nothing.
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        throw new HttpParitySourceError(
          504,
          `parity snapshot fetch exceeded the total budget (${this.totalTimeoutMs}ms) before page ${page}`,
        );
      }
      const budgetMs = Math.min(this.pageTimeoutMs, remainingMs);
      let res: Awaited<ReturnType<FetchLike>>;
      try {
        res = await this.fetch(url, {
          headers: { Authorization: authHeader, Accept: 'application/json' },
          signal: AbortSignal.timeout(budgetMs),
        });
      } catch (err) {
        const name = err instanceof Error ? err.name : '';
        if (name === 'TimeoutError' || name === 'AbortError') {
          throw new HttpParitySourceError(
            504,
            `Portal /api/instar/read page ${page} timed out after ${budgetMs}ms (pageTimeoutMs=${this.pageTimeoutMs}, totalTimeoutMs=${this.totalTimeoutMs})`,
          );
        }
        throw err;
      }
      if (!res.ok) {
        let detail = '';
        try { detail = (await res.text()).slice(0, 200); } catch { /* ignore */ }
        throw new HttpParitySourceError(
          res.status,
          `Portal /api/instar/read failed (page ${page}, status ${res.status} ${res.statusText}): ${detail}`,
        );
      }
      // The abort signal also bounds the BODY read — a page whose headers arrive
      // in time but whose body streams too slowly aborts here, not in fetch().
      // Classify it the same way (live finding, 2026-06-05 11:01Z: a slow page
      // body propagated the raw "operation was aborted" instead of naming the
      // page and budgets).
      let envelope: ReadResponseEnvelope;
      try {
        envelope = (await res.json()) as ReadResponseEnvelope;
      } catch (err) {
        const name = err instanceof Error ? err.name : '';
        if (name === 'TimeoutError' || name === 'AbortError') {
          throw new HttpParitySourceError(
            504,
            `Portal /api/instar/read page ${page} body read timed out after ${budgetMs}ms (pageTimeoutMs=${this.pageTimeoutMs}, totalTimeoutMs=${this.totalTimeoutMs})`,
          );
        }
        throw err;
      }
      const pageClusters = envelope?.data?.clusters ?? [];
      for (const raw of pageClusters) {
        const c = coerceCluster(raw);
        if (!byId.has(c.clusterId)) byId.set(c.clusterId, c);
        // Raw capture: keep the wire row VERBATIM (no coercion) for the AS-IS
        // import. Dedup by the same clusterId (pages repeat clusters).
        if (rawClusters && !rawClusters.has(c.clusterId)) {
          rawClusters.set(c.clusterId, raw as Record<string, unknown>);
        }
      }
      if (rawFeedback) {
        for (const raw of envelope?.data?.feedback ?? []) {
          if (!raw || typeof raw !== 'object') continue;
          const r = raw as Record<string, unknown>;
          const idv = r['feedbackId'] ?? r['feedback_id'] ?? r['id'];
          const id = typeof idv === 'string' ? idv : typeof idv === 'number' ? String(idv) : '';
          // Feedback is the paginated table itself; offset pagination can repeat a
          // row across page boundaries under concurrent writes — dedup by id when
          // one resolves, keep verbatim otherwise (the import will surface it).
          if (id) {
            if (!rawFeedback.has(id)) rawFeedback.set(id, r);
          } else {
            rawFeedbackUnkeyed.push(r);
          }
        }
      }

      // Pagination stop signal: returned_count < pageSize means the feedback table
      // is exhausted (clusters/dispatches per Dawn's contract accompany the feedback
      // pages and stabilise quickly via the byId dedup above).
      const returned = envelope?.meta?.returned_count ?? pageClusters.length;
      if (returned < this.pageSize) break;
    }

    this.snapshot = [...byId.values()];
    this.rawClusters = rawClusters;
    this.rawFeedback = rawFeedback;
    this.rawFeedbackUnkeyed = rawFeedbackUnkeyed;
  }

  /** Sync ParitySource read — returns the snapshot captured by {@link prepare}. */
  readPortalClusters(): PortalCluster[] {
    if (this.snapshot === null) {
      throw new HttpParitySourceError(500, 'HttpParitySource.prepare() must be awaited before readPortalClusters()');
    }
    return this.snapshot.map((c) => ({ ...c }));
  }

  /** Raw cluster rows verbatim (requires `captureRaw` + a completed prepare()). */
  readRawClusters(): Record<string, unknown>[] {
    if (!this.rawClusters) {
      throw new HttpParitySourceError(500, 'raw capture unavailable — construct with captureRaw:true and await prepare() first');
    }
    return [...this.rawClusters.values()].map((r) => ({ ...r }));
  }

  /** Raw feedback rows verbatim (requires `captureRaw` + a completed prepare()). */
  readRawFeedback(): Record<string, unknown>[] {
    if (!this.rawFeedback) {
      throw new HttpParitySourceError(500, 'raw capture unavailable — construct with captureRaw:true and await prepare() first');
    }
    return [...this.rawFeedback.values(), ...this.rawFeedbackUnkeyed].map((r) => ({ ...r }));
  }
}
