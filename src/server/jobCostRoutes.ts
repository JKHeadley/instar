/**
 * Job cost read surface (docs/specs/job-cost-reduction.md §9.3).
 *
 *   GET  /jobs/cost?sinceDays=7[&scope=pool]  — per-slug runs, model calls, tokens,
 *        weighted tokens, framework/model mix, narrations, triage sessions, baseline.
 *        `scope=pool` merges every online machine; a peer that does not answer is a
 *        `pool.failed` entry, never a silent omission.
 *   POST /jobs/cost/baseline/freeze           — freeze this machine's baseline now
 *        (409 when already frozen, unless `{"force": true}`).
 *
 * Bearer-authenticated by the server's global auth middleware, like every other route.
 * Each machine keeps its own data (spec §13); the pool view merges on read.
 */
import type { Router, Request, Response as ExpressResponse } from 'express';
import { JobCostReport, JobCostBaselineFrozenError, type JobCostReportOutput, type TokenCounts } from '../scheduler/JobCostReport.js';
import { isPeerUrlAllowedForCredentials, type PeerEndpointKind } from './peerUrlGuard.js';
import { poolPeerFetch, type PoolPeerTarget, type RopeResultRecorder } from './poolPeerFetch.js';

export interface JobCostRoutesDeps {
  /** Null → both routes answer 503 (the report could not be constructed here). */
  report: JobCostReport | null;
  /** Peer URLs for `scope=pool` (ctx.resolvePeerUrls). Absent → pool view is self-only. */
  resolvePeerUrls?: () => PoolPeerTarget[];
  authToken?: string;
  peerUrlAllowlist?: string[];
  recordRopeResult?: RopeResultRecorder;
  /** Test seam for the peer dial. Defaults to poolPeerFetch. */
  fetchPeer?: (peer: PoolPeerTarget, path: string, init: Parameters<typeof fetch>[1]) => Promise<Response>;
}

const MAX_PEERS = 16;
const PEER_TIMEOUT_MS = 2_000;
const POOL_DEADLINE_MS = 5_000;
const MAX_PEER_BODY_BYTES = 2 * 1024 * 1024;

interface MergedSlug {
  slug: string;
  machines: number;
  runs: number;
  scriptRuns: number;
  failures: number;
  modelCalls: number;
  tokens: TokenCounts;
  weightedTokens: number;
  narrations: number;
  triageSessions: number;
  frameworks: Record<string, number>;
  models: Record<string, number>;
}

function num(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}
function countMap(v: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!v || typeof v !== 'object') return out;
  for (const [k, n] of Object.entries(v as Record<string, unknown>).slice(0, 64)) out[String(k).slice(0, 128)] = num(n);
  return out;
}

/** Validate a peer's report shape; null when it is not a schemaVersion-1 report. */
function sanitizePeerReport(body: unknown): JobCostReportOutput | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Partial<JobCostReportOutput>;
  if (b.schemaVersion !== 1 || !Array.isArray(b.slugs)) return null;
  return b as JobCostReportOutput;
}

export function mergeReports(reports: JobCostReportOutput[]): MergedSlug[] {
  const merged = new Map<string, MergedSlug>();
  for (const r of reports) {
    for (const s of r.slugs.slice(0, 2000)) {
      if (!s || typeof s.slug !== 'string') continue;
      const m = merged.get(s.slug) ?? {
        slug: s.slug, machines: 0, runs: 0, scriptRuns: 0, failures: 0, modelCalls: 0,
        tokens: { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 }, weightedTokens: 0,
        narrations: 0, triageSessions: 0, frameworks: {}, models: {},
      };
      m.machines++;
      m.runs += num(s.runs);
      m.scriptRuns += num(s.scriptRuns);
      m.failures += num(s.failures);
      m.modelCalls += num(s.modelCalls);
      m.tokens.in += num(s.tokens?.in);
      m.tokens.out += num(s.tokens?.out);
      m.tokens.cacheRead += num(s.tokens?.cacheRead);
      m.tokens.cacheWrite += num(s.tokens?.cacheWrite);
      m.weightedTokens += num(s.weightedTokens);
      m.narrations += num(s.narrations);
      m.triageSessions += num(s.triageSessions);
      for (const [k, n] of Object.entries(countMap(s.frameworks))) m.frameworks[k] = (m.frameworks[k] ?? 0) + n;
      for (const [k, n] of Object.entries(countMap(s.models))) m.models[k] = (m.models[k] ?? 0) + n;
      merged.set(s.slug, m);
    }
  }
  return [...merged.values()].sort((a, b) => b.weightedTokens - a.weightedTokens);
}

function parseSinceDays(v: unknown): number | null {
  if (v === undefined) return 7;
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= 90 ? n : null;
}

export function mountJobCostRoutes(router: Router, deps: JobCostRoutesDeps): void {
  router.get('/jobs/cost', async (req: Request, res: ExpressResponse) => {
    if (!deps.report) { res.status(503).json({ error: 'job cost report unavailable' }); return; }
    const sinceDays = parseSinceDays(req.query.sinceDays);
    const scope = String(req.query.scope ?? 'local');
    if (sinceDays === null || !['local', 'pool'].includes(scope)) {
      res.status(400).json({ error: 'invalid query: sinceDays must be an integer 1-90, scope local|pool' });
      return;
    }
    let local: JobCostReportOutput;
    try {
      local = await deps.report.compute(sinceDays);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
      return;
    }
    if (scope === 'local') { res.json(local); return; }

    const peers = (deps.resolvePeerUrls?.() ?? []).slice(0, MAX_PEERS);
    const machines: JobCostReportOutput[] = [local];
    const failed: Array<{ machineId: string; reason: string }> = [];
    const started = Date.now();
    const dial = deps.fetchPeer ?? ((p, path, init) => poolPeerFetch(deps.recordRopeResult, p, path, init));
    for (let i = 0; i < peers.length; i += 4) {
      await Promise.all(peers.slice(i, i + 4).map(async (p) => {
        if (Date.now() - started > POOL_DEADLINE_MS) { failed.push({ machineId: p.machineId, reason: 'deadline' }); return; }
        if (!isPeerUrlAllowedForCredentials({ url: p.url, kind: (p.kind ?? 'last-known-url') as PeerEndpointKind }, deps.peerUrlAllowlist).ok) {
          failed.push({ machineId: p.machineId, reason: 'url-rejected' }); return;
        }
        try {
          const response = await dial(p, `/jobs/cost?sinceDays=${sinceDays}&scope=local`, {
            headers: { Authorization: `Bearer ${deps.authToken ?? ''}` },
            signal: AbortSignal.timeout(PEER_TIMEOUT_MS),
            redirect: 'manual',
          });
          if (response.status === 404) { failed.push({ machineId: p.machineId, reason: 'unsupported' }); return; }
          if (!response.ok) { failed.push({ machineId: p.machineId, reason: `http-${response.status}` }); return; }
          const text = await response.text();
          if (Buffer.byteLength(text) > MAX_PEER_BODY_BYTES) { failed.push({ machineId: p.machineId, reason: 'truncated' }); return; }
          const body = sanitizePeerReport(JSON.parse(text));
          if (!body) { failed.push({ machineId: p.machineId, reason: 'invalid-body' }); return; }
          machines.push({ ...body, machineId: p.machineId });
        } catch {
          // @silent-fallback-ok: an unreachable peer is a pool.failed row, stated, not dropped.
          failed.push({ machineId: p.machineId, reason: 'peer-unreachable' });
        }
      }));
    }
    res.json({
      schemaVersion: 1,
      scope: 'pool',
      sinceDays,
      weights: local.weights,
      weightsNote: local.weightsNote,
      merged: mergeReports(machines),
      // Baselines are per machine (spec §13); they are never summed across machines.
      machines,
      pool: { peersQueried: peers.length, peersOk: machines.length - 1, failed },
      generatedAt: new Date().toISOString(),
    });
  });

  router.post('/jobs/cost/baseline/freeze', async (req: Request, res: ExpressResponse) => {
    if (!deps.report) { res.status(503).json({ error: 'job cost report unavailable' }); return; }
    const force = (req.body as { force?: unknown } | undefined)?.force === true;
    try {
      const file = await deps.report.freeze({ method: 'prospective-manual', force });
      res.json({ frozen: true, baseline: file });
    } catch (err) {
      if (err instanceof JobCostBaselineFrozenError) {
        res.status(409).json({ error: 'already-frozen', frozenAt: err.frozenAt, hint: 'send {"force": true} to refreeze' });
        return;
      }
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}
