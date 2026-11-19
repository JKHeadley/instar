/**
 * servedAccountReport — spend by the account that actually served it, and the size of a
 * point (docs/specs/quota-pacing-spend-by-account.md §3-§4). Pure functions over the usage
 * ledger's raw rows, step 1's reading history and the on-read list prices.
 *
 * Everything here is a measurement: nothing reads it to place, move or shed work.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { UsageLedger, ServedAggregateRow } from './UsageLedger.js';
import { priceBucket, type ListPriceSource } from './usagePricing.js';
import { CONFIRMED_BASES, type ServedBasis } from './servedAccount.js';
import { PACING, HOUR_MS, isWindowValid, parseMs, sameReset, type ForecastWindowKey, type HistoryRow } from './quotaPacing.js';

const DAY_MS = 86_400_000;

// ── switch history ───────────────────────────────────────────────────────────

export interface SwitchEvent { at: number; on: boolean }

/**
 * Each machine's resolved value of `usage.ledger.servedAccount`, appended at boot and on every
 * change, so "on for the whole cycle" and the default `since` are derived from a record, never
 * inferred from rows. A machine with no history (an older build) counts as off.
 */
export class ServedSwitchHistory {
  private readonly file: string;
  private events: SwitchEvent[] | null = null;

  constructor(stateDir: string, private readonly now: () => number = Date.now) {
    this.file = path.join(stateDir, 'state', 'served-account-switch.jsonl');
  }

  list(): SwitchEvent[] {
    if (this.events) return this.events;
    const out: SwitchEvent[] = [];
    try {
      for (const line of fs.readFileSync(this.file, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          const v = JSON.parse(line) as SwitchEvent;
          if (Number.isFinite(v.at) && typeof v.on === 'boolean') out.push({ at: v.at, on: v.on });
        } catch { /* @silent-fallback-ok: a corrupt line is skipped; at worst a cycle reads as not fully covered */ }
      }
    } catch { /* @silent-fallback-ok: no file yet means no recorded switch-on; reads treat the machine as off */ }
    this.events = out;
    return out;
  }

  /** Record the resolved value when it differs from the last recorded one (boot and each tick). */
  note(on: boolean): void {
    const list = this.list();
    if (list.length > 0 && list[list.length - 1].on === on) return;
    const ev = { at: this.now(), on };
    list.push(ev);
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.appendFileSync(this.file, JSON.stringify(ev) + '\n');
    } catch (err) { /* @silent-fallback-ok: the in-memory history still answers until restart */
      console.warn('[served-account] switch history write failed (non-fatal):', err instanceof Error ? err.message : err);
    }
  }
}

/** Was the switch on for the whole of [start, end)? */
export function switchOnThroughout(history: readonly SwitchEvent[], start: number, end: number): boolean {
  let on = false;
  for (const e of history) {
    if (e.at <= start) { on = e.on; continue; }
    if (e.at < end && !e.on) return false;
    if (e.at < end && e.on && !on) return false;
  }
  return on;
}

/** The most recent switch-on time, or null when the switch is off now. */
export function switchOnSince(history: readonly SwitchEvent[]): number | null {
  const last = history[history.length - 1];
  return last && last.on ? last.at : null;
}

// ── spend by account ─────────────────────────────────────────────────────────

export interface Money { calls: number; tokens: number; equivUsd: number; unpricedTokens: number }
const zero = (): Money => ({ calls: 0, tokens: 0, equivUsd: 0, unpricedTokens: 0 });

function addMoney(m: Money, r: ServedAggregateRow, prices: ListPriceSource | null): void {
  const t = { input: r.input, cacheRead: r.cacheRead, cacheWrite: r.cacheWrite, output: r.output };
  m.calls += r.calls;
  m.tokens += t.input + t.cacheRead + t.cacheWrite + t.output;
  const p = priceBucket(prices, r.model, r.bucket, t);
  if (p.priced) m.equivUsd += p.usd; else m.unpricedTokens += p.tokens;
}

function mergeMoney(a: Money, b: Money): Money {
  return { calls: a.calls + b.calls, tokens: a.tokens + b.tokens, equivUsd: a.equivUsd + b.equivUsd, unpricedTokens: a.unpricedTokens + b.unpricedTokens };
}

const roundMoney = (m: Money): Money => ({ ...m, equivUsd: Math.round(m.equivUsd * 1e6) / 1e6 });

export interface LoginSpend {
  /** step 1's identity key. */
  identity: string;
  /** Pool account ids seen serving this login (one login may be enrolled under several ids). */
  accounts: string[];
  total: Money;
  byBasis: Partial<Record<ServedBasis, Money>>;
}

export interface UnidentifiedSpend { account: string | null; basis: ServedBasis; spend: Money }

export interface LocalAccountsReport {
  schema: 'usage-accounts/1';
  machineId: string;
  since: number;
  until: number;
  logins: LoginSpend[];
  /** Rows with no served identity, never mixed into a login. */
  unidentified: UnidentifiedSpend[];
  oldestRawTs: number | null;
  switchHistory: SwitchEvent[];
}

export function localAccountsReport(ledger: UsageLedger, prices: ListPriceSource | null, q: { sinceMs: number; untilMs: number; switchHistory: SwitchEvent[] }): LocalAccountsReport {
  const logins = new Map<string, { accounts: Set<string>; total: Money; byBasis: Map<ServedBasis, Money> }>();
  const unid = new Map<string, UnidentifiedSpend>();
  for (const r of ledger.servedAggregate(q.sinceMs, q.untilMs)) {
    if (r.identity) {
      const l = logins.get(r.identity) ?? { accounts: new Set<string>(), total: zero(), byBasis: new Map<ServedBasis, Money>() };
      if (r.served) l.accounts.add(r.served);
      addMoney(l.total, r, prices);
      const b = l.byBasis.get(r.basis) ?? zero();
      addMoney(b, r, prices);
      l.byBasis.set(r.basis, b);
      logins.set(r.identity, l);
    } else {
      const key = `${r.served ?? ''}\u0000${r.basis}`;
      const u = unid.get(key) ?? { account: r.served, basis: r.basis, spend: zero() };
      addMoney(u.spend, r, prices);
      unid.set(key, u);
    }
  }
  return {
    schema: 'usage-accounts/1',
    machineId: ledger.machineId,
    since: q.sinceMs,
    until: q.untilMs,
    logins: [...logins.entries()].map(([identity, l]) => ({
      identity, accounts: [...l.accounts].sort(), total: roundMoney(l.total),
      byBasis: Object.fromEntries([...l.byBasis.entries()].map(([k, v]) => [k, roundMoney(v)])),
    })).sort((a, b) => b.total.equivUsd - a.total.equivUsd),
    unidentified: [...unid.values()].map(u => ({ ...u, spend: roundMoney(u.spend) })).sort((a, b) => b.spend.equivUsd - a.spend.equivUsd),
    oldestRawTs: ledger.oldestRawTs(),
    switchHistory: q.switchHistory,
  };
}

/** Merge several machines' local reports into one pool view (by login identity; unidentified kept apart). */
export function mergeAccountsReports(reports: readonly LocalAccountsReport[]): { logins: LoginSpend[]; unidentified: UnidentifiedSpend[] } {
  const logins = new Map<string, { accounts: Set<string>; total: Money; byBasis: Map<ServedBasis, Money> }>();
  const unid = new Map<string, UnidentifiedSpend>();
  for (const rep of reports) {
    for (const l of rep.logins) {
      const cur = logins.get(l.identity) ?? { accounts: new Set<string>(), total: zero(), byBasis: new Map<ServedBasis, Money>() };
      l.accounts.forEach(a => cur.accounts.add(a));
      cur.total = mergeMoney(cur.total, l.total);
      for (const [k, v] of Object.entries(l.byBasis) as Array<[ServedBasis, Money]>) cur.byBasis.set(k, mergeMoney(cur.byBasis.get(k) ?? zero(), v));
      logins.set(l.identity, cur);
    }
    for (const u of rep.unidentified) {
      const key = `${u.account ?? ''}\u0000${u.basis}`;
      const cur = unid.get(key) ?? { account: u.account, basis: u.basis, spend: zero() };
      cur.spend = mergeMoney(cur.spend, u.spend);
      unid.set(key, cur);
    }
  }
  return {
    logins: [...logins.entries()].map(([identity, l]) => ({
      identity, accounts: [...l.accounts].sort(), total: roundMoney(l.total),
      byBasis: Object.fromEntries([...l.byBasis.entries()].map(([k, v]) => [k, roundMoney(v)])),
    })).sort((a, b) => b.total.equivUsd - a.total.equivUsd),
    unidentified: [...unid.values()].map(u => ({ ...u, spend: roundMoney(u.spend) })).sort((a, b) => b.spend.equivUsd - a.spend.equivUsd),
  };
}

// ── interval spend (one machine's share of a cycle) ──────────────────────────

export interface Interval { start: number; end: number }

export interface IntervalSpend {
  machineId: string;
  costServed: Money;
  costUnconfirmed: Money;
  costBindingOnly: Money;
  unattributed: Money;
  oldestRawTs: number | null;
  switchHistory: SwitchEvent[];
}

/**
 * One machine's spend inside the given intervals for one login (`identity`) / pool account
 * (`accountId`): confirmed spend, unconfirmed spend served from that account, binding-only rows
 * tagged with it, and rows with no served account at all (an upper bound on what is missing).
 */
export function localIntervalSpend(ledger: UsageLedger, prices: ListPriceSource | null, q: { identity: string | null; accountId: string; intervals: readonly Interval[]; fableOnly: boolean; switchHistory: SwitchEvent[] }): IntervalSpend {
  const out: IntervalSpend = { machineId: ledger.machineId, costServed: zero(), costUnconfirmed: zero(), costBindingOnly: zero(), unattributed: zero(), oldestRawTs: ledger.oldestRawTs(), switchHistory: q.switchHistory };
  for (const iv of q.intervals) {
    for (const r of ledger.servedAggregate(iv.start, iv.end, { fableOnly: q.fableOnly })) {
      if (CONFIRMED_BASES.has(r.basis) && q.identity && r.identity === q.identity) addMoney(out.costServed, r, prices);
      else if (r.basis === 'identity-unconfirmed' || r.basis === 'ledger-unverified') { if (r.served === q.accountId) addMoney(out.costUnconfirmed, r, prices); }
      else if (r.basis === 'no-transcript') { if (r.tagged === q.accountId) addMoney(out.costBindingOnly, r, prices); }
      else if (!r.served && r.basis !== 'off' && r.basis !== 'before-attribution') addMoney(out.unattributed, r, prices);
    }
  }
  for (const k of ['costServed', 'costUnconfirmed', 'costBindingOnly', 'unattributed'] as const) out[k] = roundMoney(out[k]);
  return out;
}

// ── closed cycles and matched segments (step 1 history) ──────────────────────

export interface ClosedCycle {
  window: ForecastWindowKey;
  resetsAt: number;
  startedAt: number;
  /** Matched rate segments: points and spend are both counted between first and last valid reading. */
  segments: Array<{ start: number; end: number; points: number }>;
  pointsUsed: number;
  /** A segment's readings were thinned by compaction (hourly or cycle-end only). */
  thinned: boolean;
}

/**
 * Closed cycles of one window from step 1's rows, cut into rate segments the same way
 * `segmentWindow` cuts the current cycle: a new cycle when the reset moves forward by more than
 * half a window, a new segment at an early drop or credit. Only cycles whose reset has passed.
 */
export function closedCycles(rows: readonly HistoryRow[], window: ForecastWindowKey, now: number): ClosedCycle[] {
  const halfWindowMs = (PACING.WINDOW_HOURS[window] / 2) * HOUR_MS;
  const pts = rows
    .filter(r => !r.outcome && !r.measuredAtSynthesized)
    .map(r => ({ r, w: r.windows?.[window], t: parseMs(r.measuredAt), polled: parseMs(r.polledAt) }))
    .filter(x => x.w && Number.isFinite(x.t) && isWindowValid(x.w, x.polled))
    .map(x => ({ t: x.t, pct: x.w!.pct as number, resetsAt: parseMs(x.w!.resetsAt), thin: !!x.r.resolution }))
    .sort((a, b) => a.t - b.t);
  const cycles: ClosedCycle[] = [];
  let cur: typeof pts = [];
  const close = () => {
    if (cur.length === 0) return;
    const resetsAt = cur[cur.length - 1].resetsAt;
    const segs: ClosedCycle['segments'] = [];
    let seg = [cur[0]];
    for (let i = 1; i < cur.length; i++) {
      const p = cur[i], prev = cur[i - 1];
      if (sameReset(p.resetsAt, prev.resetsAt) && prev.pct - p.pct > PACING.EARLY_DROP_POINTS) {
        segs.push({ start: seg[0].t, end: seg[seg.length - 1].t, points: Math.max(0, seg[seg.length - 1].pct - seg[0].pct) });
        seg = [p];
      } else seg.push(p);
    }
    segs.push({ start: seg[0].t, end: seg[seg.length - 1].t, points: Math.max(0, seg[seg.length - 1].pct - seg[0].pct) });
    if (Number.isFinite(resetsAt) && resetsAt <= now) {
      cycles.push({ window, resetsAt, startedAt: cur[0].t, segments: segs.filter(s => s.end > s.start), pointsUsed: segs.reduce((n, s) => n + s.points, 0), thinned: cur.some(p => p.thin) });
    }
    cur = [];
  };
  for (const p of pts) {
    if (cur.length > 0 && p.resetsAt - cur[cur.length - 1].resetsAt > halfWindowMs) close();
    cur.push(p);
  }
  close();
  return cycles;
}

// ── size of a point ──────────────────────────────────────────────────────────

export type SizeVerdict =
  | { state: 'ok' | 'low'; costPerPoint: number; estimateUnconfirmed: number | null }
  | { state: 'cannot-tell'; reason: string; estimateUnconfirmed: number | null };

export interface SizeOfPoint {
  window: ForecastWindowKey;
  resetsAt: string;
  pointsUsed: number;
  costServed: number;
  costUnconfirmed: number;
  costBindingOnly: number;
  unattributedCost: number;
  retentionComplete: boolean;
  switchOnThroughout: boolean;
  machinesNotAnswered: string[];
  result: SizeVerdict;
  caveats: string[];
}

export const SIZE_LIMITS = {
  /** Points below which a figure is labelled `low` (it is still shown). */
  LOW_POINTS: 5,
  /** Unattributed cost above this share of costServed labels a figure `low`. */
  LOW_UNATTRIBUTED_SHARE: 0.1,
  /** Only cycles inside step 1's full-detail history can be segmented. */
  FULL_DETAIL_MS: 14 * DAY_MS,
} as const;

const CAVEATS = [
  'Use of the same login outside this agent (the web app, the phone, machines outside the pool) adds points but no ledger cost, so this is a lower bound on the full list-equivalent cost per point.',
  'It depends on the workload: a different mix of models or cache use changes it. It is not a capacity measurement.',
];

/** Combine one cycle's per-machine interval spend into the size-of-a-point verdict (spec §4). */
export function sizeOfPoint(cycle: ClosedCycle, parts: readonly IntervalSpend[], opts: { now: number; machinesNotAnswered: string[]; codex: boolean }): SizeOfPoint {
  const sum = (k: 'costServed' | 'costUnconfirmed' | 'costBindingOnly' | 'unattributed') => parts.reduce((n, p) => n + p[k].equivUsd, 0);
  const costServed = sum('costServed'), costUnconfirmed = sum('costUnconfirmed');
  const retentionComplete = parts.length > 0 && parts.every(p => p.oldestRawTs != null && p.oldestRawTs <= cycle.startedAt);
  const firstStart = cycle.segments[0]?.start ?? cycle.startedAt;
  const lastEnd = cycle.segments[cycle.segments.length - 1]?.end ?? cycle.resetsAt;
  const switchOn = parts.length > 0 && parts.every(p => switchOnThroughout(p.switchHistory, firstStart, lastEnd));
  const estimate = cycle.pointsUsed > 0 && costUnconfirmed > 0 ? Math.round((costUnconfirmed / cycle.pointsUsed) * 1e6) / 1e6 : null;
  let result: SizeVerdict;
  if (cycle.pointsUsed <= 0) result = { state: 'cannot-tell', reason: 'no use', estimateUnconfirmed: null };
  else if (opts.now - cycle.startedAt > SIZE_LIMITS.FULL_DETAIL_MS || cycle.thinned) result = { state: 'cannot-tell', reason: 'history thinned', estimateUnconfirmed: estimate };
  else if (opts.machinesNotAnswered.length > 0) result = { state: 'cannot-tell', reason: `machines did not answer: ${opts.machinesNotAnswered.join(', ')}`, estimateUnconfirmed: estimate };
  else if (!retentionComplete) result = { state: 'cannot-tell', reason: 'retention incomplete', estimateUnconfirmed: estimate };
  else if (!switchOn) result = { state: 'cannot-tell', reason: 'switch not on for the whole cycle', estimateUnconfirmed: estimate };
  else if (opts.codex) result = { state: 'cannot-tell', reason: 'no identity check', estimateUnconfirmed: estimate };
  else {
    const unattributed = sum('unattributed');
    const low = cycle.pointsUsed < SIZE_LIMITS.LOW_POINTS || unattributed > SIZE_LIMITS.LOW_UNATTRIBUTED_SHARE * costServed;
    result = { state: low ? 'low' : 'ok', costPerPoint: Math.round((costServed / cycle.pointsUsed) * 1e6) / 1e6, estimateUnconfirmed: estimate };
  }
  return {
    window: cycle.window, resetsAt: new Date(cycle.resetsAt).toISOString(), pointsUsed: Math.round(cycle.pointsUsed * 100) / 100,
    costServed: Math.round(costServed * 1e6) / 1e6, costUnconfirmed: Math.round(costUnconfirmed * 1e6) / 1e6,
    costBindingOnly: Math.round(sum('costBindingOnly') * 1e6) / 1e6, unattributedCost: Math.round(sum('unattributed') * 1e6) / 1e6,
    retentionComplete, switchOnThroughout: switchOn, machinesNotAnswered: opts.machinesNotAnswered, result, caveats: CAVEATS,
  };
}

// ── mismatch paging across machines ──────────────────────────────────────────

export interface MismatchRow { sessionId: string; tagged: string; served: string; servedBasis: ServedBasis; requests: number; firstTs: number; lastTs: number; confirmed: boolean }
export type MachineCursor = { lastTs: number; sessionId: string } | null;

export const MISMATCH_PAGE = { DEFAULT: 50, MAX: 500 } as const;

export function encodeCursor(c: Record<string, MachineCursor>): string {
  return Buffer.from(JSON.stringify(c), 'utf8').toString('base64url');
}

export function decodeCursor(raw: unknown): Record<string, MachineCursor> {
  if (typeof raw !== 'string' || !raw) return {};
  try {
    const v = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Record<string, MachineCursor>;
    const out: Record<string, MachineCursor> = {};
    for (const [k, c] of Object.entries(v ?? {})) {
      if (typeof k !== 'string' || k.length > 128) continue;
      out[k] = c && Number.isFinite(c.lastTs) && typeof c.sessionId === 'string' ? { lastTs: c.lastTs, sessionId: c.sessionId.slice(0, 128) } : null;
    }
    return out;
  } catch { return {}; }
}

/**
 * Merge per-machine pages newest first by (lastTs desc, machineId, sessionId), emit up to
 * `limit`, and advance each machine's cursor only past the rows actually emitted, so a fetched
 * but unemitted row is never skipped.
 */
export function mergeMismatchPages(pages: ReadonlyArray<{ machineId: string; rows: MismatchRow[]; full: boolean }>, prior: Record<string, MachineCursor>, limit: number): { rows: Array<MismatchRow & { machineId: string }>; next: string | null } {
  const all = pages.flatMap(p => p.rows.map(r => ({ ...r, machineId: p.machineId })));
  all.sort((a, b) => b.lastTs - a.lastTs || a.machineId.localeCompare(b.machineId) || a.sessionId.localeCompare(b.sessionId));
  const emitted = all.slice(0, limit);
  const cursor: Record<string, MachineCursor> = { ...prior };
  let more = all.length > emitted.length;
  for (const p of pages) {
    const mine = emitted.filter(r => r.machineId === p.machineId);
    if (mine.length > 0) { const last = mine[mine.length - 1]; cursor[p.machineId] = { lastTs: last.lastTs, sessionId: last.sessionId }; }
    if (p.full) more = true;
  }
  return { rows: emitted, next: more ? encodeCursor(cursor) : null };
}
