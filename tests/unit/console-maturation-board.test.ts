/**
 * Maturation board view (docs/specs/maturation-board.md §7–§8): the pure view
 * model (headline from counts, the five F10 tiles, URL state, filters, sorts,
 * follow-up and date wording, recorded-dates-only timeline) and the rendered
 * page in jsdom (text-only rendering, first view without the table, 503 state).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { JSDOM } from 'jsdom';
import {
  headline, subline, tiles, parseState, stateQuery, tableOpen, filterRows, sortRows,
  followUpText, deadlineText, timeline, fmtDate, verdictInfo,
} from '../../dashboard/console/maturation-board-model.js';

const NOW = Date.parse('2026-10-30T16:00:00Z');

function feature(id: string, verdict: string | null, over: Record<string, unknown> = {}) {
  return {
    id, title: null,
    review: verdict ? { date: '2026-10-28', verdict, verdictRaw: verdict, stage: 'dark', evidence: `evidence for ${id}`, evidenceReadToday: true, measures: null, rule: null, decision: 'improve', action: 'none', commitments: [] } : null,
    history: verdict ? [{ date: '2026-10-25', verdict, carried: false }, { date: '2026-10-28', verdict, carried: false }] : [],
    unchangedReviews: verdict ? 2 : 0,
    shippedAt: null, transitions: [], owners: [], deadlines: [],
    followUp: { state: 'none-linked', items: [] }, conflicts: [], flags: [],
    ...over,
  };
}

function board(features: ReturnType<typeof feature>[], over: Record<string, unknown> = {}) {
  return {
    schema: 'maturation-board/1', advisory: true, authority: 'none', generatedAt: new Date(NOW).toISOString(), scope: 'pool',
    reviewDate: '2026-10-28', reviewMachine: 'Studio', reviewState: 'ok', reviewCachedAt: null,
    sources: [{ name: 'd7', machine: 'Studio', ok: true }],
    counts: { features: features.length, reviewed: features.length, byVerdict: { stalled: 2, live: 1 }, stalledRegressedBlind: 2, stalledRegressedBlindNoFollowUp: 1, stalledRegressedBlindFollowUpUnknown: 0, withDate: 1, pastDate: 1, conflicts: 0, live: 1 },
    excluded: { ambiguousJoins: 0, unparsedRows: 0, duplicatesDropped: 0 },
    features,
    ...over,
  };
}

describe('headline and tiles come from response counts only', () => {
  it('names the verdicts, never a combined board word', () => {
    const h = headline(board([]));
    expect(h).toMatch(/^Per the .* review: 2 stalled of 0; 1 of those have no linked follow-up\.$/);
    expect(h.toLowerCase()).not.toContain('stuck');
    expect(tiles(board([])).map(t => t.label)).toEqual([
      'Stalled / regressed / blind (per review)', 'No linked follow-up', 'Past a recorded date', 'Sources disagree', 'Live (per review)',
    ]);
  });

  it('says honestly when the review cannot be read or never ran', () => {
    expect(headline(board([], { reviewState: 'unavailable' }))).toContain("can't be read right now: Studio is not answering");
    expect(headline(board([], { reviewDate: null }))).toContain('No maturation review has run on this agent yet');
  });

  it('subline names a machine that did not answer', () => {
    const s = subline(board([], { sources: [{ name: 'may-be-superseded', machine: 'Mac Mini', ok: false, reason: 'did-not-answer' }] }));
    expect(s).toContain('May be out of date: Mac Mini did not answer.');
  });
});

describe('URL state', () => {
  it('round-trips and opens the table only when a filter is set', () => {
    const st = parseState('?v=stalled,blind&fu=none-linked&q=queue');
    expect(st).toEqual({ v: 'stalled,blind', fu: 'none-linked', q: 'queue' });
    expect(parseState(stateQuery(st))).toEqual(st);
    expect(tableOpen({})).toBe(false);
    expect(tableOpen({ sort: 'due' })).toBe(false);
    expect(tableOpen({ all: '1' })).toBe(true);
  });
});

describe('filters and sorts', () => {
  const rows = [
    feature('b.stalled', 'stalled', { conflicts: [{ rule: 'C1', machine: 'Studio', a: 'x', b: 'y' }] }),
    feature('a.live', 'live', { followUp: { state: 'linked', items: [{ ref: 'CMT-1', kind: 'commitment', status: 'pending', label: 'pending', due: null, nextCheckIn: null }] } }),
    feature('c.blind', 'blind', { deadlines: [{ date: '2026-10-20', source: 'dark-flag', ref: 'g', milestone: 'w', open: true, overdueDays: 10, machine: 'Studio' }], owners: [{ machine: 'Mac Mini', source: 'guard', ownerId: 'c.blind', facts: {}, at: null }] }),
    feature('d.none', null),
  ];

  it('filters by verdict, follow-up, past date, conflict, machine and text', () => {
    expect(filterRows(rows, { v: 'stalled,blind' }).map(f => f.id)).toEqual(['b.stalled', 'c.blind']);
    expect(filterRows(rows, { fu: 'linked' }).map(f => f.id)).toEqual(['a.live']);
    expect(filterRows(rows, { past: '1' }).map(f => f.id)).toEqual(['c.blind']);
    expect(filterRows(rows, { conflict: '1' }).map(f => f.id)).toEqual(['b.stalled']);
    expect(filterRows(rows, { m: 'Mac Mini' }).map(f => f.id)).toEqual(['c.blind']);
    expect(filterRows(rows, { q: 'EVIDENCE FOR A' }).map(f => f.id)).toEqual(['a.live']);
    expect(filterRows(rows, { v: 'not-reviewed' }).map(f => f.id)).toEqual(['d.none']);
  });

  it('sorts by verdict severity, then name; by due date with undated last', () => {
    expect(sortRows(rows, 'verdict').map(f => f.id)).toEqual(['b.stalled', 'c.blind', 'a.live', 'd.none']);
    expect(sortRows(rows, 'due')[0].id).toBe('c.blind');
    expect(sortRows(rows, 'feature', 'desc')[0].id).toBe('d.none');
  });
});

describe('row wording', () => {
  it('follow-up: no linked follow-up is red only for stalled/regressed/blind; unknown says can\'t tell', () => {
    expect(followUpText(feature('x', 'stalled'))).toEqual({ text: 'No linked follow-up', tone: 'bad' });
    expect(followUpText(feature('x', 'live')).tone).toBe('muted');
    expect(followUpText(feature('x', 'stalled', { followUp: { state: 'unknown', items: [] } })).text).toBe("Can't tell");
  });

  it('a review date past is amber and says it is the review\'s date; a recorded deadline is red', () => {
    const rev = deadlineText(feature('x', 'stalled', { deadlines: [{ date: '2026-10-25', source: 'review', ref: 'r', milestone: 'm', open: true, overdueDays: 4, machine: null }] }));
    expect(rev.tone).toBe('attn');
    expect(rev.text).toContain("past the review's date");
    const rec = deadlineText(feature('x', 'stalled', { deadlines: [{ date: '2026-10-25T00:00:00Z', source: 'commitment', ref: 'CMT-1', milestone: 'm', open: true, overdueDays: 5, machine: null }] }));
    expect(rec.tone).toBe('bad');
    expect(deadlineText(feature('x', 'stalled')).text).toBe('No date set');
  });

  it('formats a date-only value as that calendar day', () => {
    expect(fmtDate('2026-10-28')).toMatch(/28/);
    expect(verdictInfo('nonsense').label).toBe('Other');
  });
});

describe('timeline uses recorded dates only', () => {
  it('is empty when nothing is dated, and orders points otherwise', () => {
    expect(timeline(feature('x', null), NOW).empty).toBe(true);
    const t = timeline(feature('x', 'stalled', {
      transitions: [{ at: '2026-10-13T00:00:00Z', from: null, to: 'incubating', source: 'dark-flag', machine: 'Studio' }],
      deadlines: [{ date: '2026-10-20T00:00:00Z', source: 'dark-flag', ref: 'g', milestone: 'w', open: true, overdueDays: 10, machine: 'Studio' }],
    }), NOW);
    expect(t.empty).toBe(false);
    expect(t.points[0].kind).toBe('transition');
    expect(t.points.every((p, i, a) => i === 0 || a[i - 1].pct <= p.pct)).toBe(true);
    expect(t.todayPct).toBeCloseTo(100, 0);
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
    const { renderMaturation } = await import('../../dashboard/console/maturation-board.js');
    const main = document.getElementById('m')!;
    let q = search;
    await renderMaturation(main, { get: async () => (data instanceof Error ? { ok: false, reason: data.message } : { ok: true, data }) }, { read: () => q, write: (n: string) => { q = n; } });
    return main;
  }

  it('first view is a headline and five tiles, without the table', async () => {
    const main = await render(board([feature('a', 'stalled')]));
    expect(main.querySelectorAll('.mb-tile')).toHaveLength(5);
    expect(main.querySelector('.mb-list')).toBeNull();
    expect(main.querySelector('.page-title')!.textContent).toContain('Per the');
  });

  it('renders review text as text, never as markup', async () => {
    const hostile = feature('x.y', 'stalled', { title: '<img src=x onerror="window.pwned=1">' });
    const main = await render(board([hostile]), '?all=1');
    expect(main.querySelector('img')).toBeNull();
    expect(main.textContent).toContain('<img src=x onerror="window.pwned=1">');
    expect((dom.window as unknown as { pwned?: number }).pwned).toBeUndefined();
  });

  it('shows the switched-off state on 503', async () => {
    const main = await render(new Error('switched off on this agent'));
    expect(main.textContent).toContain('not switched on for this agent');
  });
});
