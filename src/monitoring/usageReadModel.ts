/**
 * usageReadModel — the `/usage/*` read answers (docs/specs/unified-usage-ledger.md, Slice 4).
 *
 * Pure functions over `UsageLedger.aggregate` (local + pooled rollups) and the on-read
 * pricing (Slice 3). Every money figure is the list-equivalent cost at the price in force
 * on the bucket's UTC day; tokens with no price are reported as unpriced, never as $0.
 * Parameters are validated against enums and windows are clamped by grain.
 */

import type { UsageLedger, AggregateDim, AggregateRow } from './UsageLedger.js';
import { CostAccumulator, priceBucket, type ListPriceSource } from './usagePricing.js';

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

export const WINDOW_LIMITS_MS = {
  hour: 14 * DAY_MS,
  day: 400 * DAY_MS,
  top: 90 * DAY_MS,
  session: 31 * DAY_MS,
} as const;

export interface PeerHealth {
  machineId: string;
  state: 'ok' | 'warming' | 'not-reached';
  lastPullAt: number | null;
  lastError: string | null;
}

export interface ReadContext {
  ledger: UsageLedger;
  prices: ListPriceSource | null;
  peers: PeerHealth[];
  now: number;
  /** 'pool' when the holder (or a single machine) answers; 'this-machine-only' when a standby could not reach the holder. */
  scope: 'pool' | 'this-machine-only';
}

export class UsageQueryError extends Error {
  constructor(message: string) { super(message); this.name = 'UsageQueryError'; }
}

export function parseSince(raw: unknown, now: number, maxMs: number, defaultMs: number): { sinceMs: number; clamped: boolean } {
  let since = now - defaultMs;
  if (typeof raw === 'string' && raw.trim()) {
    const n = Number(raw);
    const ms = Number.isFinite(n) ? (n < 1e11 ? n * 1000 : n) : Date.parse(raw);
    if (!Number.isFinite(ms)) throw new UsageQueryError('since must be an ISO date or a Unix time');
    since = ms;
  }
  const floor = now - maxMs;
  return since < floor ? { sinceMs: floor, clamped: true } : { sinceMs: since, clamped: false };
}

function oneOf<T extends string>(raw: unknown, allowed: readonly T[], fallback: T, name: string): T {
  if (raw === undefined || raw === '') return fallback;
  if (typeof raw === 'string' && (allowed as readonly string[]).includes(raw)) return raw as T;
  throw new UsageQueryError(`${name} must be one of ${allowed.join(', ')}`);
}

interface Figure {
  calls: number;
  tokens: { input: number; cacheRead: number; cacheWrite: number; output: number; reasoning: number; total: number };
  equivUsd: number;
  unpricedTokens: number;
  partialCalls: number;
  reportedActualUsd: number;
  reportedPlanRateUsd: number;
}

function emptyFigure(): Figure {
  return { calls: 0, tokens: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0, total: 0 }, equivUsd: 0, unpricedTokens: 0, partialCalls: 0, reportedActualUsd: 0, reportedPlanRateUsd: 0 };
}

function addRow(f: Figure, r: AggregateRow, prices: ListPriceSource | null, acc?: CostAccumulator): void {
  f.calls += r.calls;
  f.tokens.input += r.input; f.tokens.cacheRead += r.cacheRead; f.tokens.cacheWrite += r.cacheWrite;
  f.tokens.output += r.output; f.tokens.reasoning += r.reasoning;
  f.tokens.total += r.input + r.cacheRead + r.cacheWrite + r.output;
  f.partialCalls += r.missingAny;
  f.reportedActualUsd += r.reportedActualUsd;
  f.reportedPlanRateUsd += r.reportedPlanRateUsd;
  const t = { input: r.input, cacheRead: r.cacheRead, cacheWrite: r.cacheWrite, output: r.output };
  const p = priceBucket(prices, r.model, r.bucket, t);
  if (p.priced) f.equivUsd += p.usd; else f.unpricedTokens += p.tokens;
  acc?.add(prices, r.model, r.bucket, t);
}

function round(f: Figure): Figure {
  return { ...f, equivUsd: Math.round(f.equivUsd * 1e6) / 1e6, reportedActualUsd: Math.round(f.reportedActualUsd * 1e6) / 1e6, reportedPlanRateUsd: Math.round(f.reportedPlanRateUsd * 1e6) / 1e6 };
}

function windowFrame(ctx: ReadContext, sinceMs: number, clamped: boolean) {
  const notReached = ctx.peers.filter(p => p.state === 'not-reached').map(p => p.machineId);
  const warming = ctx.peers.filter(p => p.state === 'warming').map(p => p.machineId);
  return { since: new Date(sinceMs).toISOString(), until: new Date(ctx.now).toISOString(), clamped, scope: ctx.scope, notReached, warming, pricing: 'list-equivalent, as of each UTC day' };
}

/** GET /usage/summary?since=&grain=hour|day */
export function usageSummary(ctx: ReadContext, q: Record<string, unknown>) {
  const grain = oneOf(q.grain, ['hour', 'day'] as const, 'day', 'grain');
  const { sinceMs, clamped } = parseSince(q.since, ctx.now, WINDOW_LIMITS_MS[grain], 7 * DAY_MS);
  const rows = ctx.ledger.aggregate(grain, bucketFloor(sinceMs, grain), ctx.now + DAY_MS, ['machine']);
  const total = emptyFigure();
  const byMachine = new Map<string, Figure>();
  for (const r of rows) {
    addRow(total, r, ctx.prices);
    const m = r.dims.machine ?? '';
    const f = byMachine.get(m) ?? emptyFigure();
    addRow(f, r, ctx.prices);
    byMachine.set(m, f);
  }
  const peersById = new Map(ctx.peers.map(p => [p.machineId, p]));
  const machines = [...byMachine.entries()].map(([machineId, f]) => ({
    machineId, self: machineId === ctx.ledger.machineId, ...round(f),
    pull: machineId === ctx.ledger.machineId ? null : peersById.get(machineId) ?? null,
  }));
  for (const p of ctx.peers) if (!byMachine.has(p.machineId)) machines.push({ machineId: p.machineId, self: false, ...round(emptyFigure()), pull: p });
  return { ...windowFrame(ctx, sinceMs, clamped), grain, total: round(total), unpricedShare: share(total.unpricedTokens, total.tokens.total), machines };
}

/** GET /usage/series?since=&grain=hour|day&split=model|framework|machine */
export function usageSeries(ctx: ReadContext, q: Record<string, unknown>) {
  const grain = oneOf(q.grain, ['hour', 'day'] as const, 'day', 'grain');
  const split = oneOf(q.split, ['model', 'framework', 'machine'] as const, 'model', 'split');
  const { sinceMs, clamped } = parseSince(q.since, ctx.now, WINDOW_LIMITS_MS[grain], grain === 'hour' ? 2 * DAY_MS : 30 * DAY_MS);
  const rows = ctx.ledger.aggregate(grain, bucketFloor(sinceMs, grain), ctx.now + DAY_MS, [split]);
  const buckets = new Map<number, Map<string, Figure>>();
  const keys = new Set<string>();
  for (const r of rows) {
    const k = (split === 'model' ? r.model : r.dims[split]) ?? '(unknown)';
    keys.add(k);
    const b = buckets.get(r.bucket) ?? new Map<string, Figure>();
    const f = b.get(k) ?? emptyFigure();
    addRow(f, r, ctx.prices);
    b.set(k, f);
    buckets.set(r.bucket, b);
  }
  const points = [...buckets.entries()].sort((a, b) => a[0] - b[0]).map(([bucket, m]) => ({
    bucket: new Date(bucket).toISOString(),
    series: Object.fromEntries([...m.entries()].map(([k, f]) => [k, {
      tokens: f.tokens.total, equivUsd: Math.round(f.equivUsd * 1e6) / 1e6, unpricedTokens: f.unpricedTokens,
      cacheRead: f.tokens.cacheRead, input: f.tokens.input, cacheWrite: f.tokens.cacheWrite,
    }])),
  }));
  return { ...windowFrame(ctx, sinceMs, clamped), grain, split, keys: [...keys].sort(), points };
}

/** GET /usage/top?dim=topic|job|session|feature&limit=&since= */
export function usageTop(ctx: ReadContext, q: Record<string, unknown>) {
  const dim = oneOf(q.dim, ['topic', 'job', 'session', 'feature'] as const, 'topic', 'dim');
  const limit = parseLimit(q.limit);
  const max = dim === 'session' ? WINDOW_LIMITS_MS.session : WINDOW_LIMITS_MS.top;
  const { sinceMs, clamped } = parseSince(q.since, ctx.now, max, 7 * DAY_MS);
  const col: AggregateDim = dim === 'session' ? 'session_id' : dim;
  const rows = ctx.ledger.aggregate(dim === 'session' ? 'session-day' : 'day', bucketFloor(sinceMs, 'day'), ctx.now + DAY_MS, dim === 'session' ? ['session_id', 'topic', 'job'] : [col]);
  const groups = new Map<string, { figure: Figure; topic: string | null; job: string | null }>();
  for (const r of rows) {
    const k = r.dims[col];
    if (k == null) continue;
    const g = groups.get(k) ?? { figure: emptyFigure(), topic: r.dims.topic ?? null, job: r.dims.job ?? null };
    addRow(g.figure, r, ctx.prices);
    groups.set(k, g);
  }
  const items = [...groups.entries()]
    .sort((a, b) => b[1].figure.equivUsd - a[1].figure.equivUsd || b[1].figure.tokens.total - a[1].figure.tokens.total)
    .slice(0, limit)
    .map(([key, g]) => ({ key, ...(dim === 'session' ? { topic: g.topic, job: g.job } : {}), ...round(g.figure) }));
  return { ...windowFrame(ctx, sinceMs, clamped), dim, limit, items };
}

const TREE_DIMS = ['machine', 'framework', 'model', 'topic', 'job', 'feature', 'session_kind'] as const;
type TreeDim = typeof TREE_DIMS[number];

/**
 * GET /usage/tree?since=&by=machine,framework,model&parent=machine:m1/framework:claude-code
 * Nested nodes, at most 3 levels per response; each node returns at most 20 children by
 * cost plus an "other" node. The session level is returned only beneath a chosen parent
 * (`by=session` with a non-empty parent), within the 31-day session window.
 */
export function usageTree(ctx: ReadContext, q: Record<string, unknown>) {
  const parent = parseParent(q.parent);
  const rawBy = typeof q.by === 'string' && q.by ? q.by.split(',') : ['machine', 'framework', 'model'];
  const wantsSession = rawBy.includes('session');
  if (wantsSession && parent.length === 0) throw new UsageQueryError('the session level is only returned beneath a chosen parent node');
  const by = rawBy.filter(d => d !== 'session');
  for (const d of by) if (!(TREE_DIMS as readonly string[]).includes(d)) throw new UsageQueryError(`by must use ${[...TREE_DIMS, 'session'].join(', ')}`);
  const levels = by.slice(0, wantsSession ? 2 : 3) as TreeDim[];
  const max = wantsSession ? WINDOW_LIMITS_MS.session : WINDOW_LIMITS_MS.day;
  const { sinceMs, clamped } = parseSince(q.since, ctx.now, max, 7 * DAY_MS);
  const filter: Partial<Record<AggregateDim, string>> = {};
  for (const [k, v] of parent) filter[k as AggregateDim] = v;
  const grain = wantsSession ? 'session-day' : 'day';
  const dims: AggregateDim[] = [...levels, ...(wantsSession ? ['session_id' as const] : [])];
  if (grain === 'session-day' && levels.some(l => l === 'session_kind')) throw new UsageQueryError('session_kind is not kept per session');
  const rows = ctx.ledger.aggregate(grain, bucketFloor(sinceMs, 'day'), ctx.now + DAY_MS, dims, filter);
  const path = [...levels, ...(wantsSession ? ['session_id'] : [])];
  const root = buildNode('agent', null, rows, path, 0, ctx.prices);
  return { ...windowFrame(ctx, sinceMs, clamped), parent: q.parent ?? '', by: path.map(p => (p === 'session_id' ? 'session' : p)), root };
}

interface TreeNode { dim: string; key: string | null; label: string; figure: Figure; children?: TreeNode[]; otherCount?: number }

function buildNode(dim: string, key: string | null, rows: AggregateRow[], path: string[], depth: number, prices: ListPriceSource | null): TreeNode {
  const figure = emptyFigure();
  for (const r of rows) addRow(figure, r, prices);
  const node: TreeNode = { dim, key, label: key ?? (dim === 'agent' ? 'agent' : '(none)'), figure: round(figure) };
  if (depth >= path.length) return node;
  const d = path[depth];
  const groups = new Map<string, AggregateRow[]>();
  for (const r of rows) {
    const k = (d === 'model' ? r.model : r.dims[d]) ?? '\u0000';
    const arr = groups.get(k) ?? [];
    arr.push(r);
    groups.set(k, arr);
  }
  const children = [...groups.entries()].map(([k, rs]) => buildNode(d === 'session_id' ? 'session' : d, k === '\u0000' ? null : k, rs, path, depth + 1, prices));
  children.sort((a, b) => b.figure.equivUsd - a.figure.equivUsd || b.figure.tokens.total - a.figure.tokens.total);
  if (children.length > 20) {
    const rest = children.splice(20);
    const other = emptyFigure();
    for (const c of rest) {
      other.calls += c.figure.calls; other.equivUsd += c.figure.equivUsd; other.unpricedTokens += c.figure.unpricedTokens;
      for (const k of Object.keys(other.tokens) as (keyof Figure['tokens'])[]) other.tokens[k] += c.figure.tokens[k];
    }
    children.push({ dim: 'other', key: null, label: `${rest.length} more`, figure: round(other) });
    node.otherCount = rest.length;
  }
  node.children = children;
  return node;
}

function parseParent(raw: unknown): Array<[string, string]> {
  if (raw === undefined || raw === '') return [];
  if (typeof raw !== 'string' || raw.length > 1024) throw new UsageQueryError('parent must be a path like machine:m1/framework:claude-code');
  return raw.split('/').map(seg => {
    const i = seg.indexOf(':');
    const k = i > 0 ? seg.slice(0, i) : '';
    if (!(TREE_DIMS as readonly string[]).includes(k)) throw new UsageQueryError(`parent dimensions must be ${TREE_DIMS.join(', ')}`);
    return [k, decodeURIComponent(seg.slice(i + 1))] as [string, string];
  });
}

/** GET /usage/coverage */
export function usageCoverage(ctx: ReadContext, sinceMs = ctx.now - 30 * DAY_MS) {
  const l = ctx.ledger;
  const status = l.statusCounts();
  const counted = Object.entries(status).filter(([k]) => k.startsWith('counted')).reduce((a, [, n]) => a + n, 0);
  const cwdOnly = status['counted:cwd'] ?? 0;
  const shares = l.coverageShares(sinceMs);
  const acc = new CostAccumulator();
  for (const r of l.aggregate('day', bucketFloor(sinceMs, 'day'), ctx.now + DAY_MS, [])) {
    acc.add(ctx.prices, r.model, r.bucket, { input: r.input, cacheRead: r.cacheRead, cacheWrite: r.cacheWrite, output: r.output });
  }
  return {
    ...windowFrame(ctx, sinceMs, false),
    roots: l.listRoots(),
    rows: status,
    shares: {
      unattributed: share(shares.unattributedTokens, shares.totalTokens),
      cwdOnly: share(cwdOnly, counted),
      unpriced: acc.unpricedShare,
      nullTokenCalls: share(shares.nullTokenCalls, shares.calls),
    },
    unpricedModels: Object.fromEntries(acc.unpricedModels),
    pairs: l.pairCounts(),
    counters: l.coverageCounters(),
    snapshot: l.snapshotStatus(),
    peers: l.peerCursors(),
    pull: ctx.peers,
    notRead: [
      { source: 'pi, Grok and Gemini session files', reason: 'no reader yet; these engines are counted through their one-off calls only' },
    ],
  };
}

function share(part: number, whole: number): number {
  return whole > 0 ? Math.round((part / whole) * 10_000) / 10_000 : 0;
}

function parseLimit(raw: unknown): number {
  if (raw === undefined || raw === '') return 25;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new UsageQueryError('limit must be a whole number from 1 to 200');
  return Math.min(200, n);
}

function bucketFloor(ms: number, grain: 'hour' | 'day'): number {
  const g = grain === 'hour' ? HOUR_MS : DAY_MS;
  return Math.floor(ms / g) * g;
}

/** Validate a session id from a query string (length and characters). */
export function validSessionId(raw: unknown): string | null {
  return typeof raw === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(raw) ? raw : null;
}

/**
 * GET /mobile/usage trim: totals, series and top topics/jobs/features by name, with no
 * account, session or machine ids. Built locally from the bearer answers.
 */
export function trimForPhone(summary: ReturnType<typeof usageSummary>, series: ReturnType<typeof usageSeries>, tops: Record<'topic' | 'job' | 'feature', ReturnType<typeof usageTop>>) {
  return {
    since: summary.since,
    until: summary.until,
    pricing: summary.pricing,
    partial: summary.notReached.length > 0 || summary.warming.length > 0,
    machinesNotReached: summary.notReached.length,
    machinesWarming: summary.warming.length,
    total: { tokens: summary.total.tokens.total, cacheRead: summary.total.tokens.cacheRead, equivUsd: summary.total.equivUsd, unpricedTokens: summary.total.unpricedTokens, calls: summary.total.calls },
    series: series.points.map(p => ({ bucket: p.bucket, byModel: Object.fromEntries(Object.entries(p.series).map(([k, v]) => [k, { tokens: v.tokens, equivUsd: v.equivUsd }])) })),
    top: Object.fromEntries((['topic', 'job', 'feature'] as const).map(d => [d, tops[d].items.map(i => ({ name: i.key, tokens: i.tokens.total, equivUsd: i.equivUsd }))])),
  };
}
