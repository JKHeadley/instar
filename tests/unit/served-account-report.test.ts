/**
 * quota-pacing step 3 (docs/specs/quota-pacing-spend-by-account.md §3-§4): spend by login,
 * size of a point, switch history and cross-machine mismatch paging.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import {
  closedCycles, sizeOfPoint, mergeMismatchPages, decodeCursor, encodeCursor, ServedSwitchHistory, switchOnThroughout,
  switchOnSince, mergeAccountsReports, type IntervalSpend, type MismatchRow, type LocalAccountsReport,
} from '../../src/monitoring/servedAccountReport.js';
import type { HistoryRow } from '../../src/monitoring/quotaPacing.js';

const dirs: string[] = [];
const temp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'served-report-')); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/unit/served-account-report.test.ts' }); });

const H = 3_600_000;
const DAY = 24 * H;
const RESET1 = Date.parse('2026-11-18T06:38:00Z');
const RESET2 = RESET1 + 7 * DAY;

function row(t: number, pct: number, resetsAt: number, extra: Partial<HistoryRow> = {}): HistoryRow {
  return {
    v: 1, polledAt: new Date(t).toISOString(), measuredAt: new Date(t).toISOString(), identity: 'anthropic:aaaaaaaaaaaaaaaa',
    source: 'oauth-usage-endpoint-fallback', drifted: false,
    windows: { sevenDay: { pct, resetsAt: new Date(resetsAt).toISOString() } }, ...extra,
  };
}

const money = (usd: number) => ({ calls: 1, tokens: 100, equivUsd: usd, unpricedTokens: 0 });
const part = (over: Partial<IntervalSpend> = {}): IntervalSpend => ({
  machineId: 'm1', costServed: money(10), costUnconfirmed: money(0), costBindingOnly: money(0), unattributed: money(0),
  oldestRawTs: RESET1 - 30 * DAY, switchHistory: [{ at: RESET1 - 30 * DAY, on: true }], ...over,
});

describe('closedCycles', () => {
  it('cuts a closed cycle into matched segments at an early drop (a credit) and sums points per segment', () => {
    const start = RESET1 - 6 * DAY;
    const rows = [
      row(start, 10, RESET1), row(start + H, 20, RESET1), row(start + 2 * H, 30, RESET1),
      row(start + 3 * H, 5, RESET1), // credit: a new segment, never negative burn
      row(start + 4 * H, 15, RESET1),
      row(RESET1 + H, 2, RESET2), // next cycle (still open)
    ];
    const c = closedCycles(rows, 'sevenDay', RESET1 + 2 * H);
    expect(c).toHaveLength(1);
    expect(c[0].segments).toEqual([{ start, end: start + 2 * H, points: 20 }, { start: start + 3 * H, end: start + 4 * H, points: 10 }]);
    expect(c[0].pointsUsed).toBe(30);
  });

  it('ignores synthesized and failed-read rows, and leaves the open cycle out', () => {
    const start = RESET1 - DAY;
    const rows = [row(start, 1, RESET1), row(start + H, 50, RESET1, { measuredAtSynthesized: true }), row(start + 2 * H, 4, RESET1)];
    const c = closedCycles(rows, 'sevenDay', RESET1 - H);
    expect(c).toEqual([]);
    expect(closedCycles(rows, 'sevenDay', RESET1 + H)[0].pointsUsed).toBe(3);
  });
});

describe('sizeOfPoint', () => {
  const cycle = { window: 'sevenDay' as const, resetsAt: RESET1, startedAt: RESET1 - 5 * DAY, segments: [{ start: RESET1 - 5 * DAY, end: RESET1 - H, points: 40 }], pointsUsed: 40, thinned: false };
  const now = RESET1 + DAY;

  it('reports a workload-dependent lower bound with an ok label and its caveats', () => {
    const s = sizeOfPoint(cycle, [part()], { now, machinesNotAnswered: [], codex: false });
    expect(s.result).toEqual({ state: 'ok', costPerPoint: 0.25, estimateUnconfirmed: null });
    expect(s.caveats.join(' ')).toMatch(/lower bound/);
    expect(s.caveats.join(' ')).toMatch(/workload/);
  });

  it('labels a figure low (shown, never hidden) under 5 points or over 10% unattributed cost', () => {
    expect(sizeOfPoint({ ...cycle, pointsUsed: 4, segments: [{ ...cycle.segments[0], points: 4 }] }, [part()], { now, machinesNotAnswered: [], codex: false }).result.state).toBe('low');
    expect(sizeOfPoint(cycle, [part({ unattributed: money(2) })], { now, machinesNotAnswered: [], codex: false }).result.state).toBe('low');
  });

  it('withholds the figure with the reason: no use, thinned history, a machine missing, retention, switch, Codex', () => {
    const reason = (s: ReturnType<typeof sizeOfPoint>) => (s.result.state === 'cannot-tell' ? s.result.reason : s.result.state);
    expect(reason(sizeOfPoint({ ...cycle, pointsUsed: 0 }, [part()], { now, machinesNotAnswered: [], codex: false }))).toBe('no use');
    expect(reason(sizeOfPoint({ ...cycle, thinned: true }, [part()], { now, machinesNotAnswered: [], codex: false }))).toBe('history thinned');
    expect(reason(sizeOfPoint(cycle, [part()], { now, machinesNotAnswered: ['m2 (unreachable)'], codex: false }))).toMatch(/did not answer/);
    expect(reason(sizeOfPoint(cycle, [part({ oldestRawTs: RESET1 - DAY })], { now, machinesNotAnswered: [], codex: false }))).toBe('retention incomplete');
    expect(reason(sizeOfPoint(cycle, [part({ switchHistory: [{ at: RESET1 - 2 * DAY, on: true }] })], { now, machinesNotAnswered: [], codex: false }))).toBe('switch not on for the whole cycle');
    const codex = sizeOfPoint(cycle, [part({ costServed: money(0), costUnconfirmed: money(8) })], { now, machinesNotAnswered: [], codex: true });
    expect(codex.result).toEqual({ state: 'cannot-tell', reason: 'no identity check', estimateUnconfirmed: 0.2 });
  });
});

describe('switch history', () => {
  it('records changes only, survives a restart, and answers "on for the whole span"', () => {
    const state = temp();
    let now = 1000;
    const h = new ServedSwitchHistory(state, () => now);
    h.note(true); now = 2000; h.note(true); now = 5000; h.note(false); now = 9000; h.note(true);
    const again = new ServedSwitchHistory(state).list();
    expect(again).toEqual([{ at: 1000, on: true }, { at: 5000, on: false }, { at: 9000, on: true }]);
    expect(switchOnThroughout(again, 1500, 4000)).toBe(true);
    expect(switchOnThroughout(again, 1500, 6000)).toBe(false);
    expect(switchOnThroughout(again, 500, 900)).toBe(false);
    expect(switchOnSince(again)).toBe(9000);
    expect(switchOnThroughout([], 0, 10)).toBe(false);
  });
});

describe('cross-machine mismatch paging', () => {
  const r = (sessionId: string, lastTs: number): MismatchRow => ({ sessionId, tagged: 't', served: 's', servedBasis: 'enrollment-confirmed', requests: 1, firstTs: lastTs, lastTs, confirmed: true });

  it('emits newest first and advances each machine only past emitted rows, so interleaved pages skip nothing', () => {
    const m1 = [r('a', 100), r('b', 90), r('c', 80), r('d', 70)];
    const m2 = [r('x', 95), r('y', 85), r('z', 60)];
    const page = (rows: MismatchRow[], c: { lastTs: number; sessionId: string } | null, limit: number) => {
      const rest = c ? rows.filter(x => x.lastTs < c.lastTs || (x.lastTs === c.lastTs && x.sessionId > c.sessionId)) : rows;
      return { rows: rest.slice(0, limit), full: rest.length > limit };
    };
    let cursor: Record<string, { lastTs: number; sessionId: string } | null> = {};
    const seen: string[] = [];
    for (let i = 0; i < 10; i++) {
      const p1 = page(m1, cursor.m1 ?? null, 2), p2 = page(m2, cursor.m2 ?? null, 2);
      const merged = mergeMismatchPages([{ machineId: 'm1', ...p1 }, { machineId: 'm2', ...p2 }], cursor, 2);
      seen.push(...merged.rows.map(x => x.sessionId));
      if (!merged.next) break;
      cursor = decodeCursor(merged.next);
    }
    expect(seen).toEqual(['a', 'x', 'b', 'y', 'c', 'd', 'z']);
  });

  it('decodes a malformed cursor as empty and round-trips a valid one', () => {
    expect(decodeCursor('not base64 json')).toEqual({});
    expect(decodeCursor(encodeCursor({ m1: { lastTs: 5, sessionId: 's' }, m2: null }))).toEqual({ m1: { lastTs: 5, sessionId: 's' }, m2: null });
  });
});

describe('mergeAccountsReports', () => {
  it('merges one login seen on two machines once and never folds unidentified spend into a login', () => {
    const rep = (machineId: string, usd: number): LocalAccountsReport => ({
      schema: 'usage-accounts/1', machineId, since: 0, until: 1, oldestRawTs: 0, switchHistory: [],
      logins: [{ identity: 'anthropic:aaaaaaaaaaaaaaaa', accounts: [machineId === 'm1' ? 'claude-a' : 'claude-a-m5'], total: money(usd), byBasis: { 'enrollment-confirmed': money(usd) } }],
      unidentified: [{ account: null, basis: 'unknown-root', spend: money(1) }],
    });
    const m = mergeAccountsReports([rep('m1', 3), rep('m2', 4)]);
    expect(m.logins).toHaveLength(1);
    expect(m.logins[0]).toMatchObject({ identity: 'anthropic:aaaaaaaaaaaaaaaa', accounts: ['claude-a', 'claude-a-m5'] });
    expect(m.logins[0].total.equivUsd).toBe(7);
    expect(m.unidentified).toEqual([{ account: null, basis: 'unknown-root', spend: { calls: 2, tokens: 200, equivUsd: 2, unpricedTokens: 0 } }]);
  });
});
