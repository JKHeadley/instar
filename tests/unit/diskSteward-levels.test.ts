/** Disk Steward pure logic (spec docs/specs/disk-steward.md §3.2–§3.5). */
import { describe, it, expect } from 'vitest';
import {
  GiB, thresholdsFor, forecast, rawLevel, stepLevel, healCleared, repeatDue, gapAllows, sendRetryDelay, repeatInterval,
  type Sample, type LevelState,
} from '../../src/monitoring/diskSteward/levels.js';

const TOTAL = 926 * GiB;
const HOUR = 3_600_000;

describe('thresholdsFor', () => {
  it('uses the brief numbers on a big disk (Studio)', () => {
    const th = thresholdsFor(TOTAL);
    expect(th.warnBelow / GiB).toBeCloseTo(138.9, 1);
    expect(th.escalateBelow / GiB).toBeCloseTo(92.6, 1);
    expect(th.floor / GiB).toBeCloseTo(46.3, 1); // 5% — the media floor itself
  });
  it('caps the absolute minimums on a small disk', () => {
    const th = thresholdsFor(256 * GiB);
    expect(th.warnBelow / GiB).toBeCloseTo(76.8, 1); // 30%, not 100 GiB
    expect(th.escalateBelow / GiB).toBeCloseTo(51.2, 1); // 20%, not 60 GiB
  });
  it('the floor never drops below 2 GiB', () => {
    expect(thresholdsFor(20 * GiB).floor).toBe(2 * GiB);
  });
});

function series(n: number, stepMs: number, start: number, f: (i: number) => number, t0 = 0): Sample[] {
  return Array.from({ length: n }, (_, i) => ({ t: t0 + i * stepMs, free: f(i), total: TOTAL, ...(start ? {} : {}) }));
}

describe('forecast', () => {
  const th = thresholdsFor(TOTAL);
  it('reports insufficient data, never zero growth', () => {
    const s = series(5, 15 * 60_000, 0, () => 200 * GiB);
    const f = forecast(s, s[s.length - 1].t, th.floor, 200 * GiB);
    expect(f.fit24h.kind).toBe('insufficient');
    expect(f.fit7d.kind).toBe('insufficient');
    expect(f.daysToFloor).toBeNull();
  });
  it('a flat disk is not shrinking', () => {
    const s = series(96, 15 * 60_000, 0, () => 200 * GiB);
    const f = forecast(s, s[s.length - 1].t, th.floor, 200 * GiB);
    expect(f.fit24h.kind).toBe('fit');
    expect(f.daysToFloor).toBeNull();
  });
  it('a disk losing 10 GiB a day from 100 GiB reaches the floor in about 5.4 days', () => {
    const s = series(96, 15 * 60_000, 0, (i) => (110 - (i * 10) / 96) * GiB);
    const free = s[s.length - 1].free;
    const f = forecast(s, s[s.length - 1].t, th.floor, free);
    expect(f.daysToFloor!).toBeGreaterThan(5);
    expect(f.daysToFloor!).toBeLessThan(6);
  });
  it('a steward prune neither looks like recovery nor hides the leak', () => {
    const s = series(96, 15 * 60_000, 0, (i) => (110 - (i * 10) / 96 + (i >= 60 ? 20 : 0)) * GiB);
    s[60].recovered = 20 * GiB;
    const free = s[s.length - 1].free;
    const f = forecast(s, s[s.length - 1].t, th.floor, free);
    expect(f.fit24h.kind === 'fit' && f.fit24h.slopePerDay / GiB).toBeCloseTo(-10, 0);
  });
});

describe('levels', () => {
  const th = thresholdsFor(TOTAL);
  const ok: LevelState = { level: 'ok', critical: false, leaveStreak: 0 };
  it('a disk above the warn line is ok whatever the forecast', () => {
    expect(rawLevel(150 * GiB, th, 0.5).level).toBe('ok');
  });
  it('the forecast can raise warn to escalate, and critical under a day', () => {
    expect(rawLevel(120 * GiB, th, 2).level).toBe('escalate');
    expect(rawLevel(120 * GiB, th, 0.5).critical).toBe(true);
    expect(rawLevel(150 * GiB, th, 0.5).critical).toBe(false); // above warn: never urgent on the forecast alone
    expect(rawLevel(40 * GiB, th, null).critical).toBe(true);
  });
  it('enters on one reading, leaves on two clear readings with margin', () => {
    let st = stepLevel(ok, 130 * GiB, th, null);
    expect(st.level).toBe('warn'); expect(st.rose).toBe(true);
    st = stepLevel(st, 140 * GiB, th, null); // above warn but inside the 2% margin
    expect(st.level).toBe('warn');
    st = stepLevel(st, 160 * GiB, th, null);
    expect(st.level).toBe('warn');
    st = stepLevel(st, 160 * GiB, th, null);
    expect(st.level).toBe('ok'); expect(st.ended).toBe(true);
  });
  it('a noisy reading resets the leave streak', () => {
    let st = stepLevel(ok, 130 * GiB, th, null);
    st = stepLevel(st, 160 * GiB, th, null);
    st = stepLevel(st, 130 * GiB, th, null);
    st = stepLevel(st, 160 * GiB, th, null);
    expect(st.level).toBe('warn');
  });
  it('escalate clears once comfortably above the warn line even with a stale steep forecast', () => {
    let st = stepLevel(ok, 80 * GiB, th, null);
    expect(st.level).toBe('escalate');
    st = stepLevel(st, 170 * GiB, th, 2);
    st = stepLevel(st, 170 * GiB, th, 2);
    expect(st.level).toBe('ok');
  });
  it('entering critical is reported even when the level does not rise', () => {
    let st = stepLevel(ok, 80 * GiB, th, null);
    st = stepLevel(st, 80 * GiB, th, 0.5);
    expect(st.criticalEntered).toBe(true);
    expect(st.level).toBe('escalate');
  });
  it('the heal worked only when clear of warn AND of critical', () => {
    expect(healCleared(170 * GiB, th, null)).toBe(true);
    expect(healCleared(170 * GiB, th, 0.5)).toBe(false);
    expect(healCleared(130 * GiB, th, null)).toBe(false);
  });
});

describe('cadence', () => {
  it('repeats 24 h at warn, 6 h at escalate, 2 h critical; warn backoff caps at 7 days', () => {
    expect(repeatInterval('warn', false, 1)).toBe(24 * HOUR);
    expect(repeatInterval('escalate', false, 1)).toBe(6 * HOUR);
    expect(repeatInterval('warn', true, 1)).toBe(2 * HOUR);
    expect(repeatInterval('warn', false, 64)).toBe(7 * 24 * HOUR);
  });
  it('nothing repeats at ok', () => {
    expect(repeatDue({ lastPostAt: 0, stage: 1, warnBackoff: 1 }, 'ok', false, 10 * 24 * HOUR)).toBe(false);
  });
  it('the 1 h gap never delays an urgent rise', () => {
    const c = { lastPostAt: 1000, stage: 0, warnBackoff: 1 };
    expect(gapAllows(c, 1000 + 10 * 60_000, false)).toBe(false);
    expect(gapAllows(c, 1000 + 10 * 60_000, true)).toBe(true);
  });
  it('failed sends back off and stay capped', () => {
    expect(sendRetryDelay(1)).toBe(15 * 60_000);
    expect(sendRetryDelay(3)).toBe(60 * 60_000);
    expect(sendRetryDelay(99)).toBe(6 * HOUR);
  });
});
