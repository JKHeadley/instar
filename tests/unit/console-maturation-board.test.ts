/**
 * Maturation board view (docs/specs/maturation-board.md §7–§8), readability
 * revision (Justin, 2026-10-30: "impossible to digest"): one answer sentence in
 * plain words, a square per feature, plain groups, human names, one short plain
 * line per row, technical detail only behind a tap — and still text-only.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { JSDOM } from 'jsdom';
import {
  GROUPS, groupOf, headline, subline, sortRows, SORTS, parseState, stateQuery, openGroups, filterRows, orderInGroup, squares,
  humanName, humanArea, ownerChip, statusLine, nextStep, timeline, attention, card, measureText,
} from '../../dashboard/console/maturation-board-model.js';

const NOW = Date.parse('2026-10-30T16:00:00Z');

function feature(id: string, verdict: string | null, over: Record<string, unknown> = {}) {
  return {
    id, title: null,
    review: verdict ? { date: '2026-10-28', verdict, verdictRaw: verdict, area: null, summary: null, nextStep: null, purpose: null, goal: null, plan: null, line: null, measure: null, stage: 'dark', evidence: `evidence for ${id}`, evidenceReadToday: true, measures: null, rule: null, decision: 'improve', action: 'none', commitments: [] } : null,
    history: verdict ? [{ date: '2026-10-25', verdict, carried: false }, { date: '2026-10-28', verdict, carried: false }] : [],
    unchangedReviews: 0,
    shippedAt: null, transitions: [], owners: [], deadlines: [],
    followUp: { state: 'none-linked', items: [] }, conflicts: [], flags: [],
    ...over,
  };
}
const withReview = (f: ReturnType<typeof feature>, r: Record<string, unknown>) => ({ ...f, review: { ...f.review!, ...r } });

function board(features: ReturnType<typeof feature>[], over: Record<string, unknown> = {}) {
  return { schema: 'maturation-board/1', reviewDate: '2026-10-28', reviewState: 'ok', sources: [], counts: {}, features, ...over };
}

describe('plain groups', () => {
  it('maps every review verdict to exactly one plain group', () => {
    expect(groupOf(feature('a', 'regressed')).label).toBe('Broken');
    expect(groupOf(feature('a', 'stalled')).label).toBe('Stuck');
    expect(groupOf(feature('a', 'blind')).label).toBe('Not measured');
    expect(groupOf(feature('a', 'on-track')).id).toBe('progressing');
    expect(groupOf(feature('a', 'ready')).id).toBe('progressing');
    expect(groupOf(feature('a', 'live')).label).toBe('Working');
    expect(groupOf(feature('a', 'retire-pending')).label).toBe('Being retired');
    expect(groupOf(feature('a', null)).label).toBe('Not reviewed');
    expect(new Set(GROUPS.flatMap(g => g.verdicts)).size).toBe(GROUPS.flatMap(g => g.verdicts).length);
  });
});

describe('the answer is plain words', () => {
  const fs = [feature('a', 'live'), feature('b', 'stalled'), feature('c', 'blind', { followUp: { state: 'linked', items: [{ ref: 'CMT-1', kind: 'commitment', status: 'pending', label: 'pending', due: null, nextCheckIn: null }] } })];

  it('says how many are working and how many need attention, without review jargon', () => {
    const h = headline(board(fs));
    expect(h).toBe('3 features: 1 working, 2 need attention.');
    for (const word of ['blind', 'stalled', 'regressed', 'verdict', 'CMT']) expect(h.toLowerCase()).not.toContain(word.toLowerCase());
    expect(attention(fs)).toEqual({ need: 2, nobody: 1, plannedOnly: 0 });
    expect(subline(board(fs))).toContain('Of those, 1 have no fix planned.');
  });

  it('is honest when the review cannot be read', () => {
    expect(headline(board([], { reviewState: 'unavailable' }))).toContain('isn’t answering');
  });
});

describe('human names', () => {
  it('turns setting paths into plain names and areas', () => {
    const f = feature('multiMachine.sessionPool.failoverRunner', 'regressed');
    expect(humanName(f)).toBe('Failover runner');
    expect(humanArea(f)).toBe('Session pool');
    expect(humanName(feature('monitoring.selfDeferralGuard', 'blind'))).toBe('Self deferral guard');
    expect(humanName(feature('routingSpend (.money)', 'live'))).toBe('Routing spend');
    expect(humanName(feature('intelligence.jevCirclesShadow.enabled', 'live'))).toBe('Jev circles shadow');
  });

  it('prefers the review’s own plain title and area', () => {
    const f = { ...withReview(feature('x.y', 'live'), { area: 'Sessions' }), title: 'Session failover' };
    expect(humanName(f)).toBe('Session failover');
    expect(humanArea(f)).toBe('Sessions');
  });
});

describe('row wording', () => {
  it('uses the review’s plain summary and next step when present', () => {
    const f = withReview(feature('a', 'stalled'), { summary: 'Hasn’t run since Tuesday.', nextStep: 'Fix due Friday.' });
    expect(statusLine(f)).toBe('Hasn’t run since Tuesday.');
    expect(nextStep(f)).toBe('Fix due Friday.');
  });

  it('never repeats the group blurb on every row', () => {
    expect(statusLine(feature('a', 'stalled'))).toBe('');
    expect(statusLine(feature('a', 'stalled', { unchangedReviews: 3 }))).toBe('Same for 3 reviews in a row.');
    expect(statusLine(feature('a', 'stalled', { deadlines: [{ date: '2026-10-20', source: 'dark-flag', ref: 'g', milestone: 'w', open: true, overdueDays: 10, machine: 'Studio' }] }))).toBe('10 days past its date.');
  });

  it('the owner chip says who is on it in plain words', () => {
    expect(ownerChip(feature('a', 'stalled'))).toEqual({ text: 'No fix planned', tone: 'bad' });
    // A written plan without a linked task is not "nobody on it" — the chip must not contradict the line.
    expect(ownerChip(withReview(feature('a', 'stalled'), { plan: 'Redesign queued for Nov 6.' }))).toEqual({ text: 'Fix planned, not started', tone: 'warn' });
    expect(ownerChip(withReview(feature('a', 'stalled'), { plan: 'Nothing planned.' }))!.text).toBe('No fix planned');
    expect(ownerChip(feature('a', 'live'))).toBeNull();
    expect(ownerChip(feature('a', 'stalled', { followUp: { state: 'unknown', items: [] } }))!.text).toBe('Can’t tell');
    const pending = { state: 'linked', items: [{ ref: 'CMT-1', kind: 'commitment', status: 'pending', label: 'pending', due: null, nextCheckIn: null }] };
    expect(ownerChip(feature('a', 'stalled', { followUp: pending }))!.text).toBe('Fix in progress');
    const delivered = { state: 'linked', items: [{ ref: 'CMT-1', kind: 'commitment', status: 'delivered', label: 'handed off', due: null, nextCheckIn: null }] };
    expect(ownerChip(feature('a', 'stalled', { followUp: delivered }))).toEqual({ text: 'Fix handed to a builder', tone: 'track' });
  });
});

describe('the 80/20 card', () => {
  const m = { what: 'checks failing', now: '41%', target: 'under 5%', before: '14%', trend: 'worse' };
  const f = withReview(feature('a', 'regressed', { deadlines: [{ date: '2026-11-04', source: 'review', ref: 'r', milestone: 'm', open: true, overdueDays: null, machine: null }] }),
    { purpose: 'Checks the agent’s “done” claims.', goal: 'Failures under 5% for 7 days.', plan: 'Log each failure and fix the path.', line: '41% failing (goal: under 5%) · up from 14% · fix due Nov 4', measure: m });

  it('the row leads with the dense glance line', () => {
    expect(statusLine(f)).toBe('41% failing (goal: under 5%) · up from 14% · fix due Nov 4');
    expect(nextStep(f)).toBe('Log each failure and fix the path.');
  });

  it('puts the number beside its goal and its last value', () => {
    expect(measureText(m)).toBe('41% checks failing · goal under 5% · was 14%, worse');
    expect(measureText(null)).toBe('');
  });

  it('shows what it does, the goal, now, plan and due — and drops empty rows', () => {
    const c = card(f);
    expect(c.map(x => x.label)).toEqual(['What it does', 'To move up', 'Now', 'Plan', 'Due']);
    expect(c.find(x => x.label === 'Now')!.tone).toBe('bad');
    expect(card(feature('b', 'live')).map(x => x.label)).toEqual([]);
  });
});

describe('order, map and URL state', () => {
  it('puts nobody-on-it first inside a group', () => {
    const rows = [feature('b', 'stalled', { followUp: { state: 'linked', items: [] } }), feature('a', 'stalled')];
    expect(orderInGroup(rows).map(f => f.id)).toEqual(['a', 'b']);
  });

  it('draws one square per feature in group order, dotting nobody-on-it', () => {
    const sq = squares([feature('w', 'live'), feature('s', 'stalled'), feature('r', 'regressed')]);
    expect(sq.map(s => s.group)).toEqual(['broken', 'stuck', 'working']);
    expect(sq.find(s => s.id === 's')!.nobody).toBe(true);
    expect(sq.find(s => s.id === 'w')!.nobody).toBe(false);
  });

  it('opens Broken and Stuck by default; filters and searches by plain name', () => {
    expect([...openGroups({})]).toEqual(['broken', 'stuck']);
    expect([...openGroups({ g: 'working' })]).toEqual(['working']);
    expect(parseState(stateQuery({ g: 'stuck', q: 'runner' }))).toEqual({ g: 'stuck', q: 'runner' });
    const fs = [feature('multiMachine.sessionPool.failoverRunner', 'regressed'), feature('b', 'live')];
    expect(filterRows(fs, { q: 'failover' }).map(f => f.id)).toEqual(['multiMachine.sessionPool.failoverRunner']);
    expect(filterRows(fs, { g: 'working' }).map(f => f.id)).toEqual(['b']);
    expect(filterRows(fs, { nobody: '1' }).map(f => f.id)).toEqual(['multiMachine.sessionPool.failoverRunner']);
  });

  it('timeline lists recorded dates in plain words, oldest first', () => {
    const t = timeline(feature('a', 'regressed', { history: [{ date: '2026-10-25', verdict: 'live', carried: false }, { date: '2026-10-28', verdict: 'regressed', carried: false }] }), NOW);
    expect(t.map(p => p.label)).toEqual(['Review: Working', 'Review: Broken']);
  });
});

describe('rendered page (jsdom)', () => {
  let dom: JSDOM;
  beforeEach(() => {
    dom = new JSDOM('<!doctype html><html><body><main id="m"></main></body></html>', { url: 'https://example.test/dashboard/maturation/' });
    Object.assign(globalThis, { window: dom.window, document: dom.window.document, location: dom.window.location, history: dom.window.history, HTMLElement: dom.window.HTMLElement });
  });
  afterEach(() => { dom.window.close(); });

  async function render(data: unknown, search = '') {
    const mod = await import('../../dashboard/console/maturation-board.js');
    const main = document.getElementById('m')!;
    let q = search;
    await mod.renderMaturation(main, { get: async () => (data instanceof Error ? { ok: false, reason: data.message } : { ok: true, data }) }, { read: () => q, write: (n: string) => { q = n; } });
    return main;
  }

  it('shows the answer, a square per feature and plain groups — no ids on the first screen', async () => {
    const main = await render(board([feature('multiMachine.sessionPool.failoverRunner', 'regressed'), feature('a.b', 'live')]));
    expect(main.querySelector('.mb-answer')!.textContent).toBe('2 features: 1 working, 1 need attention.');
    expect(main.querySelectorAll('.mb-sq')).toHaveLength(2);
    expect(main.querySelector('.mb-group-name')!.textContent).toBe('Broken · 1');
    const visible = [...main.querySelectorAll('.mb-row')].map(r => r.textContent).join(' ');
    expect(visible).toContain('Failover runner');
    expect(visible).not.toContain('multiMachine');
  });

  it('renders review text as text, never as markup', async () => {
    const hostile = { ...feature('x.y', 'stalled'), title: '<img src=x onerror="window.pwned=1">' };
    const main = await render(board([hostile]));
    expect(main.querySelector('img')).toBeNull();
    expect(main.textContent).toContain('<img src=x onerror="window.pwned=1">');
    expect((dom.window as unknown as { pwned?: number }).pwned).toBeUndefined();
  });

  it('keeps technical detail behind a tap', async () => {
    const main = await render(board([feature('a.b', 'stalled')]), '?f=a.b&open=stuck');
    const tech = main.querySelector('details.mb-tech') as HTMLDetailsElement;
    expect(tech).not.toBeNull();
    expect(tech.open).toBe(false);
    expect(tech.textContent).toContain('evidence for a.b');
  });

  it('shows the switched-off state on 503', async () => {
    const main = await render(new Error('switched off on this agent'));
    expect(main.textContent).toContain('not switched on for this agent');
  });
});

describe('sort choice', () => {
  const f = (id: string, extra: Record<string, unknown> = {}) => ({ id, review: null, followUp: { state: 'linked', items: [] }, deadlines: [], unchangedReviews: 0, ...extra });
  const rows = [
    f('beta', { unchangedReviews: 1, deadlines: [{ date: '2026-10-01', open: true, overdueDays: 29 }] }),
    f('alpha', { unchangedReviews: 5, deadlines: [{ date: '2026-10-20', open: true, overdueDays: 10 }] }),
    f('gamma', { unchangedReviews: 3 }),
  ];
  it('offers four sorts with worst-first first', () => {
    expect(SORTS.map((s: { id: string }) => s.id)).toEqual(['worst', 'overdue', 'stuck', 'name']);
  });
  it('most overdue puts the furthest-past date first and undated last', () => {
    expect(sortRows(rows, 'overdue').map((r: { id: string }) => r.id)).toEqual(['beta', 'alpha', 'gamma']);
  });
  it('longest stuck orders by reviews in a row unchanged', () => {
    expect(sortRows(rows, 'stuck').map((r: { id: string }) => r.id)).toEqual(['alpha', 'gamma', 'beta']);
  });
  it('A–Z orders by name; an unknown sort falls back to worst first', () => {
    expect(sortRows(rows, 'name').map((r: { id: string }) => r.id)).toEqual(['alpha', 'beta', 'gamma']);
    expect(sortRows(rows, 'bogus').map((r: { id: string }) => r.id)).toEqual(sortRows(rows, undefined).map((r: { id: string }) => r.id));
  });
  it('the sort survives in the page address', () => {
    expect(parseState(stateQuery({ sort: 'stuck' }))).toEqual({ sort: 'stuck' });
  });
  it('names machines it could not check, without claiming they failed to answer', () => {
    const b = { features: [], sources: [{ name: 'may-be-superseded', machine: 'Mama PC, Laptop', ok: false }] };
    expect(subline(b)).toContain('Couldn’t check Mama PC, Laptop');
  });
});
