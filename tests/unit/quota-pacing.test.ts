/**
 * quotaPacing (docs/specs/quota-pacing-forecast.md §2): the pure forecast. Eligibility in arrival
 * order, identity partitioning, cycles and segments (incl. the fixed-window check and the early
 * drop), least-squares slopes, projections, freshness, verdicts on both sides of every line, the
 * three-scenario runway with placement groups and unserved demand, the per-login merge, peer
 * validation and calibration replay (knowledge cutoff, censored outcomes). Includes the
 * 2026-11-17 replay of the headley Codex account, which must read will-leave-unused.
 */
import { describe, it, expect } from 'vitest';
import {
  HOUR_MS, PACING, accountVerdict, assembleProviders, calibrate, displayPct, forecastWindow, freshness, identityKey,
  isWindowValid, leastSquaresSlope, mergeLogins, partitionByIdentity, providerRunway, segmentWindow, summarizeLogin,
  validatePeerSummary, walkScenario,
  type ForecastWindowKey, type HistoryRow, type LoginSummary, type RunwayAccount, type WindowForecast,
} from '../../src/monitoring/quotaPacing.js';

const iso = (ms: number) => new Date(ms).toISOString();
const ID_A = identityKey('openai', 'a@example.com')!;
const ID_B = identityKey('openai', 'b@example.com')!;
const NOW = Date.parse('2026-11-17T18:38:00Z');
const RESET = Date.parse('2026-11-18T06:38:00Z');
const WEEK = 168 * HOUR_MS;

interface RowOpts {
  at: number;
  pct?: number | null;
  reset?: number | string;
  window?: ForecastWindowKey;
  identity?: string | null;
  measuredAt?: number;
  source?: string;
  synthesized?: boolean;
  outcome?: 'signed-out' | 'read-failing';
  drifted?: boolean;
  resolution?: HistoryRow['resolution'];
}
function row(o: RowOpts): HistoryRow {
  const window = o.window ?? 'sevenDay';
  const r: HistoryRow = {
    v: 1, polledAt: iso(o.at), measuredAt: o.outcome ? null : iso(o.measuredAt ?? o.at),
    identity: o.identity === undefined ? ID_A : o.identity, source: o.outcome ? null : (o.source ?? 'codex-app-server'),
    drifted: o.drifted ?? false, windows: {},
  };
  if (o.outcome) { r.outcome = o.outcome; return r; }
  const reset = o.reset ?? RESET;
  const resetsAt = typeof reset === 'string' ? reset : iso(reset);
  const valid = typeof reset === 'number' ? reset > o.at : !!resetsAt && Date.parse(resetsAt) > o.at;
  r.windows[window] = valid && o.pct !== null && o.pct !== undefined ? { pct: o.pct, resetsAt } : { pct: null, resetsAt: resetsAt || null, invalid: true };
  if (o.synthesized) r.measuredAtSynthesized = true;
  if (o.resolution) r.resolution = o.resolution;
  return r;
}
/** Readings every `stepMs` from `from` to `to` inclusive with pct = f(t). */
function series(from: number, to: number, stepMs: number, f: (t: number) => number, extra: Partial<RowOpts> = {}): HistoryRow[] {
  const out: HistoryRow[] = [];
  for (let t = from; t <= to; t += stepMs) out.push(row({ ...extra, at: t, pct: Math.round(f(t)) }));
  return out;
}
const fresh = (rows: HistoryRow[], now = NOW) => freshness(rows, { now, readIntervalMs: 15 * 60_000, benched: false, drifted: false });

/**
 * 2026-11-17 replay: the cycle began 11-11 06:38 (reset 11-18 06:38). Usage crept to 35% by
 * 11-16 18:38, held, climbed past 37% to 43% by ~02Z 11-17, then stayed flat through the
 * evaluation at 18:38Z, read live every 15 minutes.
 */
function replay1117(): HistoryRow[] {
  const cycleStart = RESET - WEEK;
  const h = (n: number) => NOW - 24 * HOUR_MS + n * HOUR_MS; // n hours after 11-16 18:38
  const early = series(cycleStart + HOUR_MS, h(0) - HOUR_MS, HOUR_MS, (t) => 30 + 5 * ((t - cycleStart) / (h(0) - cycleStart)));
  const recent = series(h(0), NOW, 15 * 60_000, (t) => {
    const x = (t - h(0)) / HOUR_MS;
    if (x < 3) return 35;
    if (x < 7.37) return 35 + 8 * ((x - 3) / 4.37);
    return 43;
  });
  return [...early, ...recent];
}

describe('window validity and the reset tolerance', () => {
  it('an empty, unparseable or past reset is invalid; a valid window needs a finite pct', () => {
    expect(isWindowValid({ pct: 10, resetsAt: '' }, NOW)).toBe(false);
    expect(isWindowValid({ pct: 10, resetsAt: 'soon' }, NOW)).toBe(false);
    expect(isWindowValid({ pct: 10, resetsAt: iso(NOW - 1) }, NOW)).toBe(false);
    expect(isWindowValid({ pct: null, resetsAt: iso(RESET) }, NOW)).toBe(false);
    expect(isWindowValid({ pct: 10, resetsAt: iso(RESET) }, NOW)).toBe(true);
  });
});

describe('eligibility and identity', () => {
  it('decides eligibility in arrival order: an old usage-file reading arriving after a live one is excluded and counted', () => {
    const rows = [
      ...series(NOW - 20 * HOUR_MS, NOW - HOUR_MS, HOUR_MS, (t) => 20 + (t - (NOW - 20 * HOUR_MS)) / HOUR_MS),
      // arrives last, but was measured 10 hours ago with a much higher number
      row({ at: NOW, measuredAt: NOW - 10 * HOUR_MS, pct: 90, source: 'codex-rollout' }),
    ];
    const seg = segmentWindow(rows, 'sevenDay');
    expect(seg.outOfOrderRows).toBe(1);
    expect(seg.segment.every((p) => p.pct < 90)).toBe(true);
    const f = forecastWindow(rows, 'sevenDay', { now: NOW });
    expect(f.outOfOrderRows).toBe(1);
    expect(f.used).toBe(39);
  });

  it('partitions a rebound slot by identity: the new login never inherits the old login\'s rows', () => {
    const old = series(NOW - 30 * HOUR_MS, NOW - 13 * HOUR_MS, HOUR_MS, () => 80, { identity: ID_A });
    const fresh2 = series(NOW - 12 * HOUR_MS, NOW, HOUR_MS, (t) => 5 + (t - (NOW - 12 * HOUR_MS)) / HOUR_MS, { identity: ID_B });
    const rows = [...old, ...fresh2];
    expect(partitionByIdentity(rows, ID_B)).toHaveLength(fresh2.length);
    const f = forecastWindow(partitionByIdentity(rows, ID_B), 'sevenDay', { now: NOW });
    expect(f.used).toBe(17);
    expect(f.slopes.h24?.pctPerHour).toBeCloseTo(1, 5);
  });

  it('a synthesized measuredAt never makes an account fresh and never enters a rate', () => {
    const rows = [row({ at: NOW - 60_000, pct: 40, synthesized: true })];
    expect(fresh(rows).fresh).toBe(false);
    expect(fresh(rows).measuredAtSynthesized).toBe(true);
    expect(segmentWindow(rows, 'sevenDay').segment).toHaveLength(0);
  });
});

describe('cycles and segments', () => {
  it('starts a new cycle when the reset jumps forward by more than half a window', () => {
    const prev = series(NOW - 40 * HOUR_MS, NOW - 25 * HOUR_MS, HOUR_MS, () => 90, { reset: NOW - 24 * HOUR_MS });
    const cur = series(NOW - 23 * HOUR_MS, NOW, HOUR_MS, (t) => 2 + 0.5 * (t - (NOW - 23 * HOUR_MS)) / HOUR_MS, { reset: NOW - 24 * HOUR_MS + WEEK });
    const seg = segmentWindow([...prev, ...cur], 'sevenDay');
    expect(seg.cycleEnds).toHaveLength(1);
    expect(seg.cycleEnds[0].last.pct).toBe(90);
    expect(seg.segment[0].pct).toBe(2);
    expect(forecastWindow([...prev, ...cur], 'sevenDay', { now: NOW }).slopes.h24!.pctPerHour).toBeGreaterThan(0);
  });

  it('an invalid window (resetsAt "") closes the cycle: usage unknown, never 0% or a fresh cycle', () => {
    const rows = [
      ...series(NOW - 20 * HOUR_MS, NOW - HOUR_MS, HOUR_MS, () => 50),
      row({ at: NOW, pct: 0, reset: '' }),
    ];
    const f = forecastWindow(rows, 'sevenDay', { now: NOW });
    expect(f.used).toBeNull();
    expect(f.central).toBeNull();
    expect(f.reason).toBe('window-invalid');
  });

  it('an early drop of more than 2 points with no reset move starts a new segment (no negative burn)', () => {
    const before = series(NOW - 30 * HOUR_MS, NOW - 15 * HOUR_MS, HOUR_MS, (t) => 40 + (t - (NOW - 30 * HOUR_MS)) / HOUR_MS);
    const after = series(NOW - 14 * HOUR_MS, NOW, HOUR_MS, (t) => 10 + 0.5 * (t - (NOW - 14 * HOUR_MS)) / HOUR_MS);
    const f = forecastWindow([...before, ...after], 'sevenDay', { now: NOW });
    expect(f.slopes.segment!.pctPerHour).toBeCloseTo(0.5, 1);
    expect(f.slopes.h24!.pctPerHour).toBeGreaterThan(0);
  });

  it('a 1-2 point wobble is noise and does not break the segment', () => {
    const rows = series(NOW - 20 * HOUR_MS, NOW, HOUR_MS, (t) => (Math.round((t - NOW) / HOUR_MS) % 2 ? 30 : 32));
    expect(segmentWindow(rows, 'sevenDay').segment.length).toBe(rows.length);
  });

  it('a reset that keeps creeping forward is rolling-suspected → cannot tell', () => {
    const rows = Array.from({ length: 10 }, (_, i) => row({ at: NOW - (10 - i) * HOUR_MS, pct: 20 + i, reset: RESET + i * HOUR_MS }));
    const f = forecastWindow(rows, 'sevenDay', { now: NOW });
    expect(f.rollingSuspected).toBe(true);
    expect(f.reason).toBe('rolling-suspected');
    expect(accountVerdict(f, fresh(rows), 'sustainable', NOW).verdict).toBe('unknown');
  });

  it('±2-second reset jitter (real Codex drift) is not rolling-suspected', () => {
    const rows = series(NOW - 24 * HOUR_MS, NOW, 15 * 60_000, (t) => 20 + (t - (NOW - 24 * HOUR_MS)) / HOUR_MS * 0.5)
      .map((r, i) => ({ ...r, windows: { sevenDay: { pct: r.windows.sevenDay!.pct, resetsAt: iso(RESET + ((i % 3) - 1) * 2_000) } } }));
    const seg = segmentWindow(rows, 'sevenDay');
    expect(seg.rollingSuspected).toBe(false);
    expect(seg.cycleEnds).toHaveLength(0);
    expect(seg.segment.length).toBe(rows.length);
  });

  it('five-hour, weekly and Fable windows are never mixed', () => {
    const rows = series(NOW - 20 * HOUR_MS, NOW, HOUR_MS, () => 0).map((r, i) => ({
      ...r, windows: {
        fiveHour: { pct: 99, resetsAt: iso(NOW + HOUR_MS) },
        sevenDay: { pct: 10 + i, resetsAt: iso(RESET) },
        fable: { pct: 60, resetsAt: iso(RESET + HOUR_MS) },
      },
    }));
    const w = forecastWindow(rows, 'sevenDay', { now: NOW });
    const f = forecastWindow(rows, 'fable', { now: NOW });
    expect(w.used).toBe(30);
    expect(f.used).toBe(60);
    expect(f.slopes.h24!.pctPerHour).toBeCloseTo(0, 5);
    expect(w.slopes.h24!.pctPerHour).toBeCloseTo(1, 5);
  });
});

describe('slopes and projections', () => {
  it('slopes are null below their minimum rows or span, and each reports the span it used', () => {
    const pts = (n: number, stepH: number) => Array.from({ length: n }, (_, i) => ({ t: i * stepH * HOUR_MS, pct: i }));
    expect(leastSquaresSlope(pts(2, 5), 3, 2)).toBeNull();
    expect(leastSquaresSlope(pts(3, 0.5), 3, 2)).toBeNull(); // 1h span < 2h
    const s = leastSquaresSlope(pts(3, 1), 3, 2)!;
    expect(s.spanH).toBe(2);
    expect(s.pctPerHour).toBeCloseTo(1, 6);
    const rows = series(NOW - 3 * HOUR_MS, NOW, HOUR_MS, (t) => 10 + (t - NOW) / HOUR_MS);
    const f = forecastWindow(rows, 'sevenDay', { now: NOW });
    expect(f.slopes.h6).not.toBeNull();
    expect(f.slopes.h24).toBeNull(); // 3 h < 12 h span
    expect(f.slopes.segment).toBeNull();
    expect(f.central).toBeNull(); // unknown, never 0
    expect(f.reason).toBe('not-enough-readings');
  });

  it('central, low and high project the 24h, slowest and fastest slopes; uncapped inside, capped on display', () => {
    // 2 points/hour for the last 6 hours, 0.5/hour before that
    const start = NOW - 30 * HOUR_MS;
    const rows = series(start, NOW, HOUR_MS, (t) => (t < NOW - 6 * HOUR_MS ? 10 + 0.5 * (t - start) / HOUR_MS : 22 + 2 * (t - (NOW - 6 * HOUR_MS)) / HOUR_MS));
    const f = forecastWindow(rows, 'sevenDay', { now: NOW, });
    expect(f.highBasis).toBe('6h');
    expect(f.high!).toBeGreaterThan(f.central!);
    expect(f.low!).toBeLessThanOrEqual(f.central!);
    expect(f.used).toBe(34);
    expect(f.high!).toBeGreaterThan(50);
    const busy = forecastWindow(series(start, NOW, HOUR_MS, (t) => 10 + 3 * (t - start) / HOUR_MS), 'sevenDay', { now: NOW });
    expect(busy.central!).toBeGreaterThan(100);
    expect(displayPct(busy.central)).toBe(100);
  });
});

describe('the 2026-11-17 replay', () => {
  it('reads will-leave-unused 12 hours before the reset (24h slope about 0.32 %/h, about 47% at reset)', () => {
    const rows = replay1117();
    const f = forecastWindow(rows, 'sevenDay', { now: NOW });
    expect(f.used).toBe(43);
    expect(f.hoursLeft).toBe(12);
    expect(f.slopes.h24!.pctPerHour).toBeGreaterThan(0.28);
    expect(f.slopes.h24!.pctPerHour).toBeLessThan(0.36);
    expect(f.central!).toBeGreaterThan(45.5);
    expect(f.central!).toBeLessThan(48.5);
    expect(Math.round(f.central!)).toBe(47);
    const fr = fresh(rows);
    expect(fr.fresh).toBe(true);
    const v = accountVerdict(f, fr, 'sustainable', NOW);
    expect(v.verdict).toBe('will-leave-unused');
    expect(v.plain).toMatch(/will leave about 53% unused/);
  });

  it('a busy week gives on-track', () => {
    const start = RESET - WEEK + HOUR_MS;
    const rows = series(start, NOW, HOUR_MS, (t) => 0.55 * (t - start) / HOUR_MS);
    const f = forecastWindow(rows, 'sevenDay', { now: NOW });
    expect(f.central!).toBeGreaterThanOrEqual(PACING.UNUSED_LINE);
    expect(f.central!).toBeLessThan(100);
    expect(accountVerdict(f, fresh(rows), 'sustainable', NOW).verdict).toBe('on-track');
  });
});

describe('freshness', () => {
  it('is fresh within 3 read intervals, otherwise stale with a reason', () => {
    const rows = series(NOW - 3 * HOUR_MS, NOW - 10 * 60_000, 15 * 60_000, () => 10);
    expect(fresh(rows).fresh).toBe(true);
    expect(fresh(rows, NOW + HOUR_MS).reason).toBe('not-polled');
    expect(fresh([], NOW).reason).toBe('not-polled');
    expect(fresh([...rows, row({ at: NOW, outcome: 'signed-out' })], NOW + HOUR_MS).reason).toBe('signed-out');
    expect(fresh([...rows, row({ at: NOW, outcome: 'read-failing' })], NOW + HOUR_MS).reason).toBe('read-failing');
    expect(freshness(rows, { now: NOW, readIntervalMs: 15 * 60_000, benched: false, drifted: true }).reason).toBe('identity-drifted');
    expect(freshness(rows, { now: NOW + 5 * HOUR_MS, readIntervalMs: 15 * 60_000, benched: true, drifted: false }).reason).toBe('benched');
    // read recently, but the usage file it returned is old
    const fileOnly = [row({ at: NOW, measuredAt: NOW - 5 * HOUR_MS, pct: 10, source: 'codex-rollout' })];
    expect(fresh(fileOnly).reason).toBe('file-only');
  });

  it('stale never counts as 0% or 100%', () => {
    const rows = series(NOW - 30 * HOUR_MS, NOW - 10 * HOUR_MS, HOUR_MS, () => 50);
    const f = forecastWindow(rows, 'sevenDay', { now: NOW });
    expect(accountVerdict(f, fresh(rows), 'sustainable', NOW)).toMatchObject({ verdict: 'unknown', reason: 'not-polled' });
  });
});

describe('account verdicts (both sides of every line)', () => {
  const base: WindowForecast = {
    window: 'sevenDay', used: 50, resetsAt: iso(RESET), hoursLeft: 12, slopes: { h6: null, h24: null, segment: null },
    central: 84.9, low: 80, high: 90, lowBasis: '6h', highBasis: '24h', pace: 2.9, rollingSuspected: false, outOfOrderRows: 0, usesHourlyRows: false, reason: null,
  };
  const fr = { fresh: true, reason: null, newestPolledAt: iso(NOW), newestMeasuredAt: iso(NOW), measuredAtSynthesized: false, source: 'codex-app-server' } as const;
  it('85 line: 84.9 leaves unused, 85 is on track', () => {
    expect(accountVerdict(base, fr, 'sustainable', NOW).verdict).toBe('will-leave-unused');
    expect(accountVerdict({ ...base, central: 85 }, fr, 'sustainable', NOW).verdict).toBe('on-track');
  });
  it('100 line: 99.9 on track, 100 will hit the limit (neutral while the pool is sustainable)', () => {
    expect(accountVerdict({ ...base, central: 99.9 }, fr, 'sustainable', NOW).verdict).toBe('on-track');
    const hit = accountVerdict({ ...base, central: 100 }, fr, 'sustainable', NOW);
    expect(hit).toMatchObject({ verdict: 'will-hit-limit', neutral: true });
    expect(hit.plain).toMatch(/the pool has room/);
    expect(accountVerdict({ ...base, central: 120 }, fr, 'tight', NOW).neutral).toBe(false);
  });
  it('used-up at 100%, neutral unless the provider runs dry', () => {
    expect(accountVerdict({ ...base, used: 100 }, fr, 'sustainable', NOW)).toMatchObject({ verdict: 'used-up', neutral: true });
    expect(accountVerdict({ ...base, used: 100 }, fr, 'runs-dry', NOW)).toMatchObject({ verdict: 'used-up', neutral: false });
    expect(accountVerdict({ ...base, used: 99.9, central: 101 }, fr, 'sustainable', NOW).verdict).toBe('will-hit-limit');
  });
});

describe('the provider runway', () => {
  const acct = (id: string, f: Partial<WindowForecast> | null, extra: Partial<RunwayAccount> = {}): RunwayAccount => ({
    key: identityKey('openai', `${id}@x.io`)!, accountId: id, identity: identityKey('openai', `${id}@x.io`), machines: ['m1'], fresh: f !== null,
    forecast: f === null ? null : {
      window: 'sevenDay', used: 50, resetsAt: iso(NOW + 100 * HOUR_MS), hoursLeft: 100, slopes: { h6: null, h24: null, segment: null },
      central: 50, low: 50, high: 50, lowBasis: '6h', highBasis: '6h', pace: 0, rollingSuspected: false, outOfOrderRows: 0, usesHourlyRows: false, reason: null, ...f,
    },
    ...extra,
  });

  it('cannot-tell when every account has unknown pace', () => {
    const r = providerRunway([acct('a', null), acct('b', null)], NOW, { label: 'Codex', replayedResets: 0 });
    expect(r.verdict).toBe('cannot-tell');
  });

  it('sustainable when even the fastest pace keeps room; leads with the pool', () => {
    const r = providerRunway([acct('a', { pace: 0.1, high: 70 }), acct('b', { pace: 0.1, high: 70 })], NOW, { label: 'Codex', replayedResets: 1 });
    expect(r.verdict).toBe('sustainable');
    expect(r.plain).toMatch(/^2 of 2 Codex accounts have room/);
  });

  it('runs-dry when the central scenario has unserved demand', () => {
    // room 50 each, 1.5 points/hour each, reset in 100h → runs out around hour 34
    const r = providerRunway([acct('a', { pace: 1.5, high: 200 }), acct('b', { pace: 1.5, high: 200 })], NOW, { label: 'Codex', replayedResets: 1 });
    expect(r.verdict).toBe('runs-dry');
    expect(r.scenarios!.central.firstUnservedAt).not.toBeNull();
    expect(r.scenarios!.central.unservedGroup).toEqual(['a', 'b']);
    expect(r.plain).toMatch(/weekly room runs out/);
  });

  it('tight (provisional before any replayed reset) when only the pessimistic scenario runs out', () => {
    const accounts = [acct('a', { pace: 0.2, high: 200 }), acct('b', { pace: 0.2, high: 200 })];
    const r = providerRunway(accounts, NOW, { label: 'Codex', replayedResets: 0 });
    expect(r.verdict).toBe('tight');
    expect(r.provisional).toBe(true);
    expect(r.scenarios!.central.firstUnservedAt).toBeNull();
    expect(providerRunway(accounts, NOW, { label: 'Codex', replayedResets: 2 }).provisional).toBe(false);
  });

  it('tight when the pessimistic lowest point dips under 50 points without running out', () => {
    // a: room 30 → drifts lower; one account of 50 room total can fall under 50
    const r = providerRunway([acct('a', { used: 70, pace: 0.05, high: 72 })], NOW, { label: 'Codex', replayedResets: 1 });
    expect(r.scenarios!.pessimistic.firstUnservedAt).toBeNull();
    expect(r.scenarios!.pessimistic.lowestRoom).toBeLessThan(50);
    expect(r.verdict).toBe('tight');
  });

  it('cannot-tell (not tight) when no account can be used from any machine', () => {
    const r = providerRunway([acct('a', { pace: 0.3, high: 60 }, { machines: [] })], NOW, { label: 'Codex', replayedResets: 1 });
    expect(r.verdict).toBe('cannot-tell');
    expect(r.reason).toBe('no account can be used from any machine');
    expect(r.plain).not.toMatch(/tight/);
  });

  it('says "already tight now" instead of naming the current time when room starts under the line', () => {
    const r = providerRunway([acct('a', { used: 70, pace: 0.05, high: 72 })], NOW, { label: 'Codex', replayedResets: 1 });
    expect(r.verdict).toBe('tight');
    expect(r.plain).toMatch(/already tight now/);
  });

  it('identity-less slots are forecast on their own but left out of supply', () => {
    const r = providerRunway([acct('a', { pace: 0.1 }), acct('n', { pace: 0.1 }, { identity: null })], NOW, { label: 'Codex', replayedResets: 1 });
    expect(r.leftOutNoIdentity).toBe(1);
    expect(r.counted).toBe(1);
  });

  it('scenario rules for unknown pace and unknown room', () => {
    // b is stale/unknown: central burns it at the median known pace and keeps its last room;
    // pessimistic gives it no room and the fastest pace; optimistic burns it at 0.
    const a = acct('a', { pace: 1, high: 50 + 2 * 100, low: 50 + 0.5 * 100 });
    const b = { ...acct('b', { pace: 0 }), fresh: false };
    const r = providerRunway([a, b], NOW, { label: 'Codex', replayedResets: 1 });
    expect(r.scenarios!.pessimistic.lowestRoom).toBeLessThanOrEqual(r.scenarios!.central.lowestRoom);
    expect(r.scenarios!.optimistic.lowestRoom).toBeGreaterThanOrEqual(r.scenarios!.central.lowestRoom);
    // pessimistic starts with b's room removed (50 instead of 100)
    expect(r.scenarios!.pessimistic.firstUnservedAt).not.toBeNull();
  });

  it('a stale account whose reset already passed returns to full room in the central scenario', () => {
    const stale = { ...acct('s', { used: 90, resetsAt: iso(NOW - HOUR_MS), pace: 0 }), fresh: false };
    const live = acct('l', { pace: 0.01, high: 52 });
    const r = providerRunway([stale, live], NOW, { label: 'Codex', replayedResets: 1 });
    expect(r.scenarios!.central.lowestRoom).toBeGreaterThan(140);
  });
});

describe('walking the scenario', () => {
  const sim = (key: string, room: number, resetH: number, demand: number, machines = ['m1']) =>
    ({ key, accountId: key, machines: new Set(machines), room, reset: NOW + resetH * HOUR_MS, demand });

  it('burn moves to the soonest-resetting account that shares a machine and still has room', () => {
    const r = walkScenario([sim('a', 2, 150, 5), sim('soon', 30, 20, 0), sim('late', 30, 120, 0)], NOW, 6);
    // a is empty after the first hour; its demand drains "soon" (resets first), not "late"
    expect(r.firstUnservedAt).toBeNull();
    expect(r.lowestRoom).toBeCloseTo(62 - 30, 5);
  });

  it('demand persists as unserved while a placement group is exhausted, and resumes after its reset', () => {
    const r = walkScenario([sim('a', 10, 8, 5), sim('b', 0, 50, 0)], NOW, 20);
    expect(r.firstUnservedAt).toBe(iso(NOW + 3 * HOUR_MS));
    expect(r.unservedAccounts).toEqual(['a']);
    expect(r.unservedGroup).toEqual(['a', 'b']);
    expect(r.nextResetAfterUnserved).toBe(iso(NOW + 8 * HOUR_MS));
  });

  it('burn never moves to an account on a machine the busy account cannot use', () => {
    const r = walkScenario([sim('a', 0, 100, 5, ['m1']), sim('other', 100, 100, 0, ['m2'])], NOW, 3);
    expect(r.firstUnservedAt).toBe(iso(NOW + HOUR_MS));
    expect(r.unservedGroup).toEqual(['a']);
  });

  it('staggered resets each refill to 100 at their own hour', () => {
    const r = walkScenario([sim('a', 10, 2, 0), sim('b', 10, 5, 0)], NOW, 6);
    expect(r.lowestRoom).toBe(20);
    const after = walkScenario([sim('a', 10, 2, 1), sim('b', 10, 5, 1)], NOW, 6);
    expect(after.firstUnservedAt).toBeNull();
  });
});

// ── Summaries, merge, assembly ──────────────────────────────────────────────

function summary(over: Partial<LoginSummary> & { accountId: string; machineId: string }, rows?: HistoryRow[]): LoginSummary {
  const s = summarizeLogin(rows ?? replay1117(), {
    accountId: over.accountId, provider: over.provider ?? 'openai', framework: over.framework ?? 'codex-cli', machineId: over.machineId,
    identity: over.identity === undefined ? ID_A : over.identity, status: over.status ?? 'active', drifted: over.drifted ?? false, benched: false, readIntervalMs: 15 * 60_000,
  }, NOW);
  return { ...s, ...over };
}

describe('merge per login', () => {
  it('counts one login once across machines and picks the newest measuredAt', () => {
    const a = summary({ accountId: 'codex-a', machineId: 'm_1', newestMeasuredAt: iso(NOW - 10 * 60_000) });
    const b = summary({ accountId: 'codex-a-alias', machineId: 'm_2', newestMeasuredAt: iso(NOW - 60_000) });
    const m = mergeLogins([a, b], NOW);
    expect(m.logins).toHaveLength(1);
    expect(m.logins[0].chosen.machineId).toBe('m_2');
    expect(m.logins[0].machines).toEqual(['m_1', 'm_2']);
  });

  it('refuses drifted slots and keeps identity-less slots apart', () => {
    const m = mergeLogins([
      summary({ accountId: 'x', machineId: 'm_1', drifted: true }),
      summary({ accountId: 'n1', machineId: 'm_1', identity: null }),
      summary({ accountId: 'n2', machineId: 'm_2', identity: null }),
    ], NOW);
    expect(m.logins.map((l) => l.chosen.accountId)).toEqual(['n1', 'n2']);
  });

  it('two machines more than 5 points apart within 15 minutes disagree → unknown, never averaged', () => {
    const a = summary({ accountId: 'c', machineId: 'm_1', newestMeasuredAt: iso(NOW - 2 * 60_000) });
    const b0 = summary({ accountId: 'c', machineId: 'm_2', newestMeasuredAt: iso(NOW - 60_000) });
    const b = { ...b0, sevenDay: { ...b0.sevenDay!, used: 60 } };
    const m = mergeLogins([a, b], NOW);
    expect(m.logins[0].disagree).toBe(true);
    const p = assembleProviders(m.logins, NOW, { localOnly: false });
    expect(p[0].accounts[0].weekly!.verdict).toBe('unknown');
    expect(p[0].accounts[0].weekly!.reason).toBe('machines-disagree');
  });

  it('ignores a peer reading more than 5 minutes in the future', () => {
    const m = mergeLogins([summary({ accountId: 'c', machineId: 'm_9', newestPolledAt: iso(NOW + 10 * 60_000) })], NOW);
    expect(m.logins).toHaveLength(0);
    expect(m.clockAhead).toBe(1);
  });

  it('Claude and Codex accounts are never pooled together', () => {
    const codex = summary({ accountId: 'codex-a', machineId: 'm_1' });
    const claudeId = identityKey('anthropic', 'a@example.com')!;
    const claude = summary({ accountId: 'claude-a', machineId: 'm_1', provider: 'anthropic', framework: 'claude-code', identity: claudeId },
      replay1117().map((r) => ({ ...r, identity: claudeId })));
    const p = assembleProviders(mergeLogins([codex, claude], NOW).logins, NOW, { localOnly: false });
    expect(p.map((x) => x.provider)).toEqual(['anthropic', 'openai']);
    expect(p.every((x) => x.accounts.length === 1)).toBe(true);
    expect(identityKey('anthropic', 'a@example.com')).not.toBe(identityKey('openai', 'a@example.com'));
  });

  it('a local answer on an agent with peers says cannot-tell for the provider', () => {
    const p = assembleProviders(mergeLogins([summary({ accountId: 'codex-a', machineId: 'm_1' })], NOW).logins, NOW, { localOnly: true });
    expect(p[0]).toMatchObject({ verdict: 'cannot-tell', reason: "only this machine's readings" });
    expect(p[0].accounts[0].weekly!.verdict).toBe('will-leave-unused');
  });
});

describe('peer summary validation', () => {
  it('accepts a real summary and rejects out-of-bounds values', () => {
    const s = summary({ accountId: 'codex-a', machineId: 'm_1' });
    const wire = JSON.parse(JSON.stringify(s));
    expect(validatePeerSummary(wire, 'm_peer')).toMatchObject({ accountId: 'codex-a', machineId: 'm_peer' });
    expect(validatePeerSummary({ ...wire, accountId: '../etc' }, 'm')).toBeNull();
    expect(validatePeerSummary({ ...wire, sevenDay: { ...wire.sevenDay, used: 140 } }, 'm')).toBeNull();
    expect(validatePeerSummary({ ...wire, sevenDay: { ...wire.sevenDay, central: 900 } }, 'm')).not.toBeNull(); // uncapped projection ok
    expect(validatePeerSummary({ ...wire, sevenDay: { ...wire.sevenDay, central: 5000 } }, 'm')).toBeNull();
    expect(validatePeerSummary({ ...wire, sevenDay: { ...wire.sevenDay, slopes: { h6: { pctPerHour: 500, spanH: 1, rows: 3 } } } }, 'm')).toBeNull();
    expect(validatePeerSummary({ ...wire, status: 'owner' }, 'm')).toBeNull();
    expect(validatePeerSummary({ ...wire, newestPolledAt: 'yesterday' }, 'm')).toBeNull();
  });
});

describe('calibration replay', () => {
  it('scores the forecast as it stood 24h before the reset, using only rows known then', () => {
    const prevReset = NOW - 2 * HOUR_MS;
    const start = prevReset - WEEK + HOUR_MS;
    const prev = series(start, prevReset - 10 * 60_000, 15 * 60_000, (t) => 0.4 * (t - start) / HOUR_MS, { reset: prevReset });
    const cur = series(prevReset + 5 * 60_000, NOW, 15 * 60_000, () => 1, { reset: prevReset + WEEK });
    const c = calibrate([...prev, ...cur], 'sevenDay', { now: NOW, readIntervalMs: 15 * 60_000 });
    expect(c.outcomes).toHaveLength(1);
    expect(c.outcomes[0].status).toBe('scored');
    // a steady pace: the replayed forecast lands within rounding of what happened
    expect(['inside', 'above', 'below']).toContain(c.outcomes[0].position);
    expect(Math.abs(c.outcomes[0].error!)).toBeLessThan(2);
    expect(c.outcomes[0].width!).toBeGreaterThanOrEqual(0);
    expect(c.scored).toBe(1);
  });

  it.each([
    { interval: 15, measurementAge: 45, pollAge: 0, drifted: false, expected: 'scored' },
    { interval: 15, measurementAge: 46, pollAge: 0, drifted: false, expected: 'no-forecast' },
    { interval: 15, measurementAge: 46, pollAge: 46, drifted: false, expected: 'no-forecast' },
    { interval: 30, measurementAge: 46, pollAge: 46, drifted: false, expected: 'scored' },
    { interval: 15, measurementAge: 5, pollAge: 0, drifted: true, expected: 'no-forecast' },
  ])('for a $interval-min interval, ages $measurementAge/$pollAge min and drifted=$drifted yield $expected', ({ interval, measurementAge, pollAge, drifted, expected }) => {
    const reset = NOW - HOUR_MS;
    const cutoff = reset - 24 * HOUR_MS;
    const prior = [-30, -20, -10].map((h, i) => row({ at: cutoff + h * HOUR_MS, pct: 10 + 5 * i, reset }));
    const latestKnown = row({ at: cutoff - pollAge * 60_000, measuredAt: cutoff - measurementAge * 60_000, pct: 25, reset, drifted });
    const actual = row({ at: reset - 60_000, pct: 60, reset });
    const history = [...prior, latestKnown, actual];
    const calibration = calibrate(history, 'sevenDay', { now: NOW, readIntervalMs: interval * 60_000 });
    expect(calibration.outcomes[0]).toMatchObject({ actual: 60, status: expected });
    if (expected === 'no-forecast') {
      expect(calibration.scored).toBe(0);
      expect(calibration.meanAbsError).toBeNull();
      expect(calibration.outcomes[0].central).toBeNull();
    } else {
      expect(calibration.scored).toBe(1);
      expect(calibration.outcomes[0].central).toBeGreaterThan(25);
    }
  });

  it('honours the knowledge cutoff: a row read after the replay moment is not used', () => {
    const prevReset = NOW - 2 * HOUR_MS;
    const start = prevReset - WEEK + HOUR_MS;
    const prev = series(start, prevReset - 10 * 60_000, 15 * 60_000, (t) => 0.4 * (t - start) / HOUR_MS, { reset: prevReset });
    // a late-arriving file reading (polled after the cutoff) that claims a measurement before it
    const late = row({ at: prevReset - HOUR_MS, measuredAt: prevReset - 30 * HOUR_MS, pct: 99, reset: prevReset, source: 'codex-rollout' });
    const a = calibrate(prev, 'sevenDay', { now: NOW, readIntervalMs: 15 * 60_000 });
    const b = calibrate([...prev, late], 'sevenDay', { now: NOW, readIntervalMs: 15 * 60_000 });
    expect(a.outcomes[0].status).toBe('scored');
    expect(b.outcomes[0].central).toBe(a.outcomes[0].central);
  });

  it('a cycle whose last reading is far from the reset is censored and left out of the statistics', () => {
    const prevReset = NOW - 2 * HOUR_MS;
    const start = prevReset - WEEK + HOUR_MS;
    const prev = series(start, prevReset - 6 * HOUR_MS, HOUR_MS, (t) => 0.4 * (t - start) / HOUR_MS, { reset: prevReset });
    const cur = series(prevReset + 5 * 60_000, NOW, 15 * 60_000, () => 1, { reset: prevReset + WEEK });
    const c = calibrate([...prev, ...cur], 'sevenDay', { now: NOW, readIntervalMs: 15 * 60_000 });
    expect(c.outcomes[0].status).toBe('censored');
    expect(c.outcomes[0].lastReadingHoursBefore).toBeGreaterThanOrEqual(6);
    expect(c.scored).toBe(0);
    expect(c.meanAbsError).toBeNull();
  });

  it('a cycle cut short by the row cap is reported unavailable, not computed from partial data', () => {
    const prevReset = NOW - 2 * HOUR_MS;
    const start = prevReset - WEEK + HOUR_MS;
    const prev = series(start, prevReset - 10 * 60_000, HOUR_MS, (t) => 0.4 * (t - start) / HOUR_MS, { reset: prevReset });
    const cur = series(prevReset + 5 * 60_000, NOW, 15 * 60_000, () => 1, { reset: prevReset + WEEK });
    const c = calibrate([...prev, ...cur], 'sevenDay', { now: NOW, readIntervalMs: HOUR_MS, historyCutAtMs: start + HOUR_MS });
    expect(c.outcomes[0].status).toBe('unavailable');
  });
});
