/**
 * Queue pace pure arithmetic (docs/specs/queue-pace.md): reconciliation, coverage, verdicts,
 * hysteresis, days-to-clear, bottleneck, worker evidence, projected cap, maturation steps,
 * notices — each decision boundary from both sides.
 */
import { describe, it, expect } from 'vitest';
import {
  HOUR_MS, DAY_MS, INITIAL_HYSTERESIS, INITIAL_NOTICE, TIME_EXHAUSTED, NOTICE_ESCALATE_AFTER_MS,
  reconcileInterval, dedupeEvents, hourlyWindow, steppedWindow, classifyVerdict, applyHysteresis, daysToClear, perDay,
  classifyTickRow, workerEvidence, remainingScheduledTicks, avgCallsPerExhaustedTick, projectDailyCalls, evaluateBottleneck,
  maturationSteps, decideNotice, idsDigest, coverageSufficient, floorHour,
  type IntervalRow, type TickRow, type WindowSummary, type ExecutorFacts, type NoticeState,
} from '../../src/monitoring/QueuePace.js';

const T0 = Date.parse('2026-10-30T12:00:00Z');
const set = (...ids: string[]) => new Set(ids);

function row(from: number, over: Partial<IntervalRow> = {}): IntervalRow {
  return { schema: 'queue-pace/1', kind: 'interval', machineId: 'm', queue: 'commitments', from, to: from + HOUR_MS, ok: true,
    openStart: 10, open: 10, entered: 0, reentered: 0, completed: 0, exitedOther: 0, turnover: 'complete', ...over };
}

/** `hours` consecutive ok rows ending at `end`, each built by `f(i)`. */
function rows(end: number, hours: number, f: (i: number) => Partial<IntervalRow> = () => ({})): IntervalRow[] {
  const out: IntervalRow[] = [];
  for (let i = 0; i < hours; i++) out.push(row(end - (hours - i) * HOUR_MS, f(i)));
  return out;
}

function win(over: Partial<WindowSummary>): WindowSummary {
  return { windowFrom: 0, windowTo: 7 * DAY_MS, slots: 168, okSlots: 168, coverage: 1, last3Ok: true, label: '7d', full: true,
    inflow: 0, outflow: 0, exited: 0, deltaOpen: 0, startOpen: 100, open: 100, incompleteSlots: 0, lastIntervalTo: 7 * DAY_MS, days: 7, ...over };
}

describe('reconcileInterval', () => {
  it('applies events and matches the snapshot id-by-id (conserved)', () => {
    const r = reconcileInterval({ prevIds: set('a', 'b'), snapshot: set('b', 'c'),
      events: [{ itemId: 'c', kind: 'entered', at: 2 }, { itemId: 'a', kind: 'completed', at: 3 }] });
    expect(r).toMatchObject({ ok: true, openStart: 2, open: 2, entered: 1, completed: 1, exitedOther: 0, turnover: 'complete', drift: 0 });
  });

  it('counts an item that enters and finishes inside one hour (invisible to a snapshot diff)', () => {
    const r = reconcileInterval({ prevIds: set('a'), snapshot: set('a'),
      events: [{ itemId: 'x', kind: 'entered', at: 1 }, { itemId: 'x', kind: 'completed', at: 2 }] });
    expect(r).toMatchObject({ ok: true, entered: 1, completed: 1 });
  });

  it('counts an item that leaves and returns', () => {
    const r = reconcileInterval({ prevIds: set('a'), snapshot: set('a'),
      events: [{ itemId: 'a', kind: 'exitedOther', at: 1 }, { itemId: 'a', kind: 'reentered', at: 2 }] });
    expect(r).toMatchObject({ ok: true, exitedOther: 1, reentered: 1 });
  });

  it('dedupes repeated events by (item, kind, at)', () => {
    const e = { itemId: 'c', kind: 'entered' as const, at: 2 };
    expect(dedupeEvents([e, { ...e }, { ...e, at: 3 }])).toHaveLength(2);
    const r = reconcileInterval({ prevIds: set(), snapshot: set('c'), events: [e, { ...e }] });
    expect(r).toMatchObject({ ok: true, entered: 1, drift: 0 });
  });

  it('an id that left with no recorded exit is count-drift (unless exits are snapshot-derived)', () => {
    const strict = reconcileInterval({ prevIds: set('a', 'b'), snapshot: set('a'), events: [] });
    expect(strict).toMatchObject({ ok: false, reason: 'count-drift', unexplainedExits: 1 });
    const derived = reconcileInterval({ prevIds: set('a', 'b'), snapshot: set('a'), events: [], snapshotDerivedExits: true });
    expect(derived).toMatchObject({ ok: true, exitedOther: 1, turnover: 'incomplete' });
  });

  it('unexplained arrivals: drift within 10% of transitions is ok, beyond is count-drift', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ itemId: `n${i}`, kind: 'entered' as const, at: i + 1 }));
    const snap = set(...many.map((e) => e.itemId), 'ghost1', 'ghost2');
    // 20 transitions, 2 unexplained = 10% → not MORE than 10% → ok
    expect(reconcileInterval({ prevIds: set(), snapshot: snap, events: many })).toMatchObject({ ok: true, drift: 2 });
    // 3 unexplained > 10% of 20 → drift
    expect(reconcileInterval({ prevIds: set(), snapshot: new Set([...snap, 'ghost3']), events: many })).toMatchObject({ ok: false, reason: 'count-drift' });
    // zero transitions: any unexplained arrival is drift
    expect(reconcileInterval({ prevIds: set('a'), snapshot: set('a', 'g'), events: [] })).toMatchObject({ ok: false, reason: 'count-drift' });
  });

  it('snapshot-derived arrivals count as reentered and mark turnover incomplete', () => {
    const r = reconcileInterval({ prevIds: set('a'), snapshot: set('a', 'h'), events: [], snapshotDerivedArrivals: true });
    expect(r).toMatchObject({ ok: true, reentered: 1, turnover: 'incomplete' });
  });

  it('a duplicate entry or orphan exit is a mismatch, not a count', () => {
    const r = reconcileInterval({ prevIds: set('a'), snapshot: set('a'), events: Array.from({ length: 30 }, (_, i) => ({ itemId: `x${i}`, kind: 'entered' as const, at: i }))
      .concat(Array.from({ length: 30 }, (_, i) => ({ itemId: `x${i}`, kind: 'completed' as const, at: 100 + i })))
      .concat([{ itemId: 'a', kind: 'entered', at: 500 }, { itemId: 'zz', kind: 'completed', at: 501 }]) });
    expect(r).toMatchObject({ ok: true, entered: 30, completed: 30, drift: 2 });
  });

  it('ids digest is order-independent', () => {
    expect(idsDigest(['b', 'a'])).toBe(idsDigest(['a', 'b']));
    expect(idsDigest(['a'])).not.toBe(idsDigest(['b']));
  });
});

describe('hourly coverage by elapsed time', () => {
  const end = floorHour(T0);
  it('full coverage over a 7-day window', () => {
    const w = hourlyWindow(rows(end, 168), T0);
    expect(w).toMatchObject({ slots: 168, okSlots: 168, coverage: 1, last3Ok: true, full: true });
  });
  it('a missed hour stays uncovered; ok:false rows are uncovered', () => {
    const rs = rows(end, 10).filter((_, i) => i !== 4);
    rs[2] = { ...rs[2], ok: false, reason: 'read-failed' };
    const w = hourlyWindow(rs, T0);
    expect(w.slots).toBe(10);
    expect(w.okSlots).toBe(8);
    expect(w.coverage).toBeCloseTo(0.8);
  });
  it('the shorter available window is labelled', () => {
    const w = hourlyWindow(rows(end, 48), T0);
    expect(w.full).toBe(false);
    expect(w.label).toBe('2d');
  });
  it('last 3 must be ok; a stale ledger (no recent rows) is not', () => {
    const rs = rows(end, 20);
    rs[18] = { ...rs[18], ok: false };
    expect(hourlyWindow(rs, T0).last3Ok).toBe(false);
    expect(hourlyWindow(rows(end - 5 * HOUR_MS, 20), T0).last3Ok).toBe(false);
  });
  it('one hour of grace for the tick that writes the newest hour', () => {
    const w = hourlyWindow(rows(end - HOUR_MS, 20), T0 + 30 * 60_000);
    expect(w.last3Ok).toBe(true);
  });
  it('inflow, outflow and Δopen are summed over the same covered hours', () => {
    const rs = rows(end, 5, (i) => ({ openStart: 10 + i, open: 11 + i, entered: 2, completed: 1 }));
    rs[2] = { ...rs[2], ok: false };
    const w = hourlyWindow(rs, T0);
    expect(w).toMatchObject({ inflow: 8, outflow: 4, deltaOpen: 4, startOpen: 10 });
  });
  it('coverageSufficient needs ≥80% AND the last 3 ok', () => {
    expect(coverageSufficient(win({ coverage: 0.8 }))).toBe(true);
    expect(coverageSufficient(win({ coverage: 0.79 }))).toBe(false);
    expect(coverageSufficient(win({ coverage: 1, last3Ok: false }))).toBe(false);
  });
});

describe('verdicts (disjoint, 5% tolerance, min 1)', () => {
  it('falling-behind: Δopen above tolerance and inflow > outflow', () => {
    expect(classifyVerdict(win({ deltaOpen: 6, inflow: 20, outflow: 14 })).verdict).toBe('falling-behind');
    expect(classifyVerdict(win({ deltaOpen: 5, inflow: 20, outflow: 15 })).verdict).toBe('holding'); // exactly at tolerance
  });
  it('catching-up: Δopen below −tolerance and outflow > inflow', () => {
    expect(classifyVerdict(win({ deltaOpen: -6, inflow: 10, outflow: 16 })).verdict).toBe('catching-up');
    expect(classifyVerdict(win({ deltaOpen: -5, inflow: 10, outflow: 15 })).verdict).toBe('holding');
  });
  it('shrinking-by-exits: the backlog fell but outflow ≤ inflow', () => {
    expect(classifyVerdict(win({ deltaOpen: -10, inflow: 10, outflow: 10, exited: 10 })).verdict).toBe('shrinking-by-exits');
    expect(classifyVerdict(win({ deltaOpen: -10, inflow: 10, outflow: 5, exited: 15 })).verdict).toBe('shrinking-by-exits');
  });
  it('mixed-signal: growth without inflow > outflow', () => {
    expect(classifyVerdict(win({ deltaOpen: 10, inflow: 5, outflow: 5 }))).toEqual({ verdict: 'unknown', reason: 'mixed-signal' });
  });
  it('tolerance minimum 1 for a small queue', () => {
    expect(classifyVerdict(win({ startOpen: 2, deltaOpen: 1, inflow: 3, outflow: 2 })).verdict).toBe('holding');
    expect(classifyVerdict(win({ startOpen: 2, deltaOpen: 2, inflow: 4, outflow: 2 })).verdict).toBe('falling-behind');
  });
  it('unknown below coverage', () => {
    expect(classifyVerdict(win({ coverage: 0.5, deltaOpen: 50, inflow: 60, outflow: 10 }))).toEqual({ verdict: 'unknown', reason: 'coverage' });
  });
  it('owner-not-serving is a precondition that overrides everything', () => {
    expect(classifyVerdict(win({ deltaOpen: 50, inflow: 60, outflow: 10 }), { ownerServing: false }).verdict).toBe('owner-not-serving');
    expect(classifyVerdict(win({ deltaOpen: 50, inflow: 60, outflow: 10 }), { ownerServing: true }).verdict).toBe('falling-behind');
  });
});

describe('hysteresis (2 consecutive evaluations)', () => {
  const fb = { verdict: 'falling-behind' as const };
  it('a new verdict needs two evaluations', () => {
    const one = applyHysteresis(INITIAL_HYSTERESIS, fb, 1);
    expect(one.shown).toBe('unknown');
    const two = applyHysteresis(one, fb, 2);
    expect(two.shown).toBe('falling-behind');
  });
  it('an interruption resets the candidate', () => {
    const one = applyHysteresis(INITIAL_HYSTERESIS, fb, 1);
    const flip = applyHysteresis(one, { verdict: 'holding' }, 2);
    const back = applyHysteresis(flip, fb, 3);
    expect(back.shown).toBe('unknown');
  });
  it('lost coverage and owner-not-serving apply at once', () => {
    const shown = { shown: 'falling-behind' as const, candidate: null, count: 0, shownSince: 0 };
    expect(applyHysteresis(shown, { verdict: 'unknown', reason: 'coverage' }, 5).shown).toBe('unknown');
    expect(applyHysteresis(shown, { verdict: 'owner-not-serving', reason: 'owner-not-serving' }, 5).shown).toBe('owner-not-serving');
    expect(applyHysteresis(shown, { verdict: 'unknown', reason: 'mixed-signal' }, 5).shown).toBe('falling-behind');
  });
});

describe('daysToClear and rates', () => {
  it('only when catching up at a strictly positive net rate, never for person', () => {
    const w = win({ inflow: 70, outflow: 140, open: 100, days: 7 });
    expect(daysToClear('catching-up', w, 'worker')).toBe(10);
    expect(daysToClear('catching-up', w, 'person')).toBeNull();
    expect(daysToClear('holding', w, null)).toBeNull();
    expect(daysToClear('catching-up', win({ inflow: 70, outflow: 70 }), null)).toBeNull();
  });
  it('per-day rates use covered hours only', () => {
    expect(perDay(48, win({ okSlots: 48, days: 7 }))).toBe(24);
    expect(perDay(5, win({ okSlots: 0 }))).toBeNull();
  });
});

describe('tick rows, worker evidence and projection', () => {
  const tick = (at: number, over: Partial<TickRow> = {}): TickRow => ({ at, source: 'triage', kind: 'tick', decided: 3, calls: 2, stopReason: TIME_EXHAUSTED, queueDepthAfter: 50, ...over });
  it('classifies refusals and normal runs', () => {
    expect(classifyTickRow(tick(0, { stopReason: 'call-cap-reached' }))).toMatchObject({ refusal: 'cap' });
    expect(classifyTickRow(tick(0, { stopReason: 'quota-pause' }))).toMatchObject({ refusal: 'quota' });
    expect(classifyTickRow(tick(0, { stopReason: 'quota-unreadable-pause' }))).toMatchObject({ refusal: 'quota' });
    expect(classifyTickRow(tick(0))).toMatchObject({ refusal: null, normal: true });
    expect(classifyTickRow({ at: 0, source: 'executor', kind: 'admission', admission: 'max-open-prs' })).toMatchObject({ refusal: 'cap' });
    expect(classifyTickRow({ at: 0, source: 'executor', kind: 'admission', admission: 'quota-shedding' })).toMatchObject({ refusal: 'quota' });
    expect(classifyTickRow({ at: 0, source: 'executor', kind: 'admission', admission: null })).toMatchObject({ normal: true });
    expect(classifyTickRow({ at: 0, source: 'triage', kind: 'refused', reason: 'tick-in-flight' })).toMatchObject({ refusal: null, normal: false });
  });
  it('worker: ≥3 of the last 4 ticks budget-exhausted with work queued and decisions made', () => {
    const now = T0;
    const four = [tick(now - 60_000), tick(now - 16 * 60_000), tick(now - 31 * 60_000), tick(now - 46 * 60_000, { stopReason: null })];
    expect(workerEvidence(four, now).matched).toBe(true);
    const two = [tick(now - 60_000), tick(now - 16 * 60_000, { queueDepthAfter: 0 }), tick(now - 31 * 60_000, { decided: 0 }), tick(now - 46 * 60_000)];
    expect(workerEvidence(two, now).matched).toBe(false);
    expect(workerEvidence([tick(now - 60_000), tick(now - 120_000)], now).matched).toBe(false); // too few
    expect(workerEvidence([tick(now - 4 * HOUR_MS), tick(now - 4 * HOUR_MS - 1), tick(now - 4 * HOUR_MS - 2)], now).matched).toBe(false); // outside window
  });
  it('remaining scheduled */15 ticks before UTC midnight', () => {
    expect(remainingScheduledTicks(Date.parse('2026-10-30T23:50:00Z'))).toBe(0);
    expect(remainingScheduledTicks(Date.parse('2026-10-30T23:40:00Z'))).toBe(1);
    expect(remainingScheduledTicks(Date.parse('2026-10-30T00:00:00Z'))).toBe(95);
  });
  it('projection: under vs reaching the call cap', () => {
    const now = Date.parse('2026-10-30T22:00:00Z'); // 7 ticks left
    const ticks = [tick(now - HOUR_MS, { calls: 4 }), tick(now - 2 * HOUR_MS, { calls: 2 })]; // avg 3
    expect(avgCallsPerExhaustedTick(ticks, now)).toBe(3);
    const under = projectDailyCalls({ callsUsedToday: 100, maxCallsPerDay: 150, ticks, now, extraTicksAllowed: 2 }); // 100 + 9*3 = 127
    expect(under).toMatchObject({ ok: true, projected: 127, reachesCap: false });
    const over = projectDailyCalls({ callsUsedToday: 124, maxCallsPerDay: 150, ticks, now, extraTicksAllowed: 2 }); // 151
    expect(over.reachesCap).toBe(true);
    expect(projectDailyCalls({ callsUsedToday: null, maxCallsPerDay: 150, ticks, now, extraTicksAllowed: 0 }).ok).toBe(false);
    expect(projectDailyCalls({ callsUsedToday: 1, maxCallsPerDay: 150, ticks: [], now, extraTicksAllowed: 0 }).ok).toBe(false);
  });
});

describe('bottleneck', () => {
  const now = Date.parse('2026-10-30T06:00:00Z');
  const tick = (ago: number, over: Partial<TickRow> = {}): TickRow => ({ at: now - ago, source: 'triage', kind: 'tick', decided: 3, calls: 2, stopReason: TIME_EXHAUSTED, queueDepthAfter: 50, ...over });
  const okProjection = { ok: true, projected: 50, maxCallsPerDay: 150, reachesCap: false };
  const workerTicks = [tick(60_000), tick(16 * 60_000), tick(31 * 60_000), tick(46 * 60_000)];

  it('worker on positive evidence with the projection under the cap', () => {
    const b = evaluateBottleneck({ queue: 'feedback.triage', now, ticks: workerTicks, projection: okProjection });
    expect(b.kind).toBe('worker');
    expect(b.matched).toEqual(['worker']);
  });
  it('a projected cap is cap with the plain detail, never worker', () => {
    const b = evaluateBottleneck({ queue: 'feedback.triage', now, ticks: workerTicks, projection: { ...okProjection, reachesCap: true } });
    expect(b.kind).toBe('cap');
    expect(b.detail).toBe('the daily sorting call limit would be reached');
  });
  it('no projection → no worker (positive evidence only)', () => {
    expect(evaluateBottleneck({ queue: 'feedback.triage', now, ticks: workerTicks, projection: null }).kind).toBe('unknown');
  });
  it('refusal wins over precedence: the newest uncleared refusal', () => {
    const ticks = [tick(60_000, { stopReason: 'quota-pause', decided: 0 }), ...workerTicks.slice(1)];
    const b = evaluateBottleneck({ queue: 'feedback.triage', now, ticks, projection: okProjection });
    expect(b.kind).toBe('quota');
    expect(b.matched).toContain('quota');
  });
  it('a refusal cleared by a later normal tick no longer counts', () => {
    const ticks = [tick(60_000), tick(16 * 60_000), tick(31 * 60_000, { stopReason: 'call-cap-reached' }), tick(46 * 60_000)];
    const b = evaluateBottleneck({ queue: 'feedback.triage', now, ticks, projection: okProjection });
    expect(b.kind).not.toBe('cap');
    expect(b.history['call-cap-reached']).toBe(1);
  });
  it('stale evidence (newest > 90 min) is unknown', () => {
    const ticks = [tick(100 * 60_000), tick(110 * 60_000), tick(120 * 60_000)];
    expect(evaluateBottleneck({ queue: 'feedback.triage', now, ticks, projection: okProjection }).kind).toBe('unknown');
    const fresh = [tick(85 * 60_000), tick(100 * 60_000), tick(115 * 60_000), tick(130 * 60_000)];
    expect(evaluateBottleneck({ queue: 'feedback.triage', now, ticks: fresh, projection: okProjection }).kind).toBe('worker');
  });
  it('refusals outside the 3 h actionable window are history only', () => {
    const ticks = [{ at: now - 4 * HOUR_MS, source: 'executor' as const, kind: 'admission' as const, admission: 'max-open-prs' }];
    const b = evaluateBottleneck({ queue: 'feedback.fix', now, ticks });
    expect(b.kind).toBe('unknown');
    expect(b.history['max-open-prs']).toBe(1);
  });
  const ex = (over: Partial<ExecutorFacts> = {}): ExecutorFacts => ({ ok: true, awaitingOwnerPrs: [], approverLatched: false, openPrs: 4, failedReviewPrs: 4, repo: 'o/r', ...over });
  it('cap detail names what holds the slots', () => {
    const ticks = [{ at: now - 60_000, source: 'executor' as const, kind: 'admission' as const, admission: 'max-open-prs' }];
    const b = evaluateBottleneck({ queue: 'feedback.fix', now, ticks, executor: ex() });
    expect(b).toMatchObject({ kind: 'cap', count: 4 });
    expect(b.detail).toContain('failed review');
  });
  it('person by precedence when no refusal row exists (PRs awaiting owner review)', () => {
    const b = evaluateBottleneck({ queue: 'feedback.fix', now, ticks: [], executor: ex({ awaitingOwnerPrs: [2439, 2442] }) });
    expect(b).toMatchObject({ kind: 'person', prs: [2439, 2442], count: 2, repo: 'o/r' });
    expect(b.detail).toBe('2 fixes are ready for your review');
  });
  it('approver latch alone is shown as the one-time acceptance', () => {
    const b = evaluateBottleneck({ queue: 'feedback.fix', now, ticks: [], executor: ex({ approverLatched: true }) });
    expect(b.detail).toContain('one-time acceptance');
  });
  it('a refusal row beats person', () => {
    const ticks = [{ at: now - 60_000, source: 'executor' as const, kind: 'admission' as const, admission: 'max-open-prs' }];
    const b = evaluateBottleneck({ queue: 'feedback.fix', now, ticks, executor: ex({ awaitingOwnerPrs: [1] }) });
    expect(b.kind).toBe('cap');
    expect(b.matched).toEqual(['person', 'cap']);
  });
  it('a failed executor read never matches person', () => {
    expect(evaluateBottleneck({ queue: 'feedback.fix', now, ticks: [], executor: ex({ ok: false, awaitingOwnerPrs: [1] }) }).kind).toBe('unknown');
  });
  it('an invalid repo is dropped', () => {
    expect(evaluateBottleneck({ queue: 'feedback.fix', now, ticks: [], executor: ex({ awaitingOwnerPrs: [1], repo: 'x/../../evil y' }) }).repo).toBeNull();
  });
  it('queues without tick evidence are unknown', () => {
    expect(evaluateBottleneck({ queue: 'commitments', now, ticks: workerTicks }).kind).toBe('unknown');
  });
});

describe('maturation steps', () => {
  it('membership = stalled/regressed/blind; improved verdict completes, leaving the review or retiring exits', () => {
    const steps = maturationSteps([
      { date: '2026-10-01', at: 1, rows: [{ id: 'a', verdict: 'stalled' }, { id: 'b', verdict: 'blind' }, { id: 'c', verdict: 'regressed' }, { id: 'd', verdict: 'live' }] },
      { date: '2026-10-08', at: 2, rows: [{ id: 'a', verdict: 'on-track' }, { id: 'c', verdict: 'retire-pending' }, { id: 'd', verdict: 'regressed' }] },
    ]);
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ openStart: 3, open: 1, entered: 1, completed: 1, exitedOther: 2 });
  });
  it('stepped window: last 3 steps all ok', () => {
    const rs = [row(0, { to: 1 }), row(1, { to: 2 }), row(2, { to: 3 })].map((r, i) => ({ ...r, from: i * DAY_MS, to: (i + 1) * DAY_MS, queue: 'maturation.fix' as const }));
    expect(steppedWindow(rs).last3Ok).toBe(true);
    expect(steppedWindow(rs.slice(1)).last3Ok).toBe(false);
  });
});

describe('notices', () => {
  const base = { now: 0, verdict: 'falling-behind' as const, bottleneck: 'worker' as const, coverageFull: true, tunerLive: false, tunerAtMax: false, ownsQueue: true };
  it('heal unavailable: worker-bound behind for 24 h raises, not before', () => {
    let s: NoticeState = INITIAL_NOTICE;
    let r = decideNotice({ ...base, state: s, now: 0 });
    expect(r.action.action).toBe('none');
    s = r.next;
    r = decideNotice({ ...base, state: s, now: NOTICE_ESCALATE_AFTER_MS - 1 });
    expect(r.action.action).toBe('none');
    r = decideNotice({ ...base, state: r.next, now: NOTICE_ESCALATE_AFTER_MS });
    expect(r.action).toEqual({ action: 'raise', why: 'heal-unavailable' });
  });
  it('heal exhausted: tuner live at its maximum for 24 h', () => {
    let r = decideNotice({ ...base, tunerLive: true, tunerAtMax: false, state: INITIAL_NOTICE, now: 0 });
    r = decideNotice({ ...base, tunerLive: true, tunerAtMax: false, state: r.next, now: 2 * NOTICE_ESCALATE_AFTER_MS });
    expect(r.action.action).toBe('none'); // live tuner not at max: heal still working
    r = decideNotice({ ...base, tunerLive: true, tunerAtMax: true, state: r.next, now: 3 * NOTICE_ESCALATE_AFTER_MS });
    r = decideNotice({ ...base, tunerLive: true, tunerAtMax: true, state: r.next, now: 4 * NOTICE_ESCALATE_AFTER_MS });
    expect(r.action).toEqual({ action: 'raise', why: 'heal-exhausted' });
  });
  it('cap / quota / person never raise', () => {
    for (const b of ['cap', 'quota', 'person'] as const) {
      let r = decideNotice({ ...base, bottleneck: b, state: INITIAL_NOTICE, now: 0 });
      r = decideNotice({ ...base, bottleneck: b, state: r.next, now: 10 * NOTICE_ESCALATE_AFTER_MS });
      expect(r.action.action).toBe('none');
    }
  });
  it('clears only on an affirmative recovery with full coverage; unknown marks it unavailable', () => {
    const open: NoticeState = { ...INITIAL_NOTICE, open: true, reopenedAt: [0] };
    expect(decideNotice({ ...base, verdict: 'unknown', state: open, now: 1 }).action.action).toBe('mark-unavailable');
    expect(decideNotice({ ...base, verdict: 'holding', coverageFull: false, state: open, now: 1 }).action.action).toBe('none');
    expect(decideNotice({ ...base, verdict: 'catching-up', state: open, now: 1 }).action.action).toBe('clear');
  });
  it('breaker: a third reopen in 7 days holds the item open instead of clearing', () => {
    const open: NoticeState = { ...INITIAL_NOTICE, open: true, reopenedAt: [1, 2, 3] };
    const r = decideNotice({ ...base, verdict: 'holding', state: open, now: 4 });
    expect(r.action.action).toBe('hold-open');
    expect(decideNotice({ ...base, verdict: 'holding', state: r.next, now: 5 }).action.action).toBe('none');
  });
  it('ownership moved clears with that resolution', () => {
    const r = decideNotice({ ...base, ownsQueue: false, state: { ...INITIAL_NOTICE, open: true }, now: 1 });
    expect(r.action).toEqual({ action: 'clear', resolution: 'ownership moved' });
  });
});
