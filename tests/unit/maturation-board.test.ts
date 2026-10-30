import { describe, it, expect } from 'vitest';
import {
  buildMaturationBoard,
  parseReviewJson,
  parseReviewMarkdown,
  pickLatest,
  historySeries,
  normalizeVerdict,
  commitmentLabel,
  type BoardInput,
  type OwnerEntry,
  type ParsedReview,
  type CommitmentFact,
} from '../../src/monitoring/MaturationBoard.js';

const NOW = Date.parse('2026-10-30T16:00:00Z');

function reviewDoc(date: string, features: Array<Record<string, unknown>>) {
  return JSON.stringify({ schema: 'maturation-review/1', date, features });
}

function row(id: string, verdict: string, extra: Record<string, unknown> = {}) {
  return { id, verdict, evidence: 'read the log', evidenceReadToday: true, commitments: [], ...extra };
}

function parsed(date: string, features: Array<Record<string, unknown>>): ParsedReview {
  const r = parseReviewJson(`${date}.json`, reviewDoc(date, features), NOW);
  if (!r.ok) throw new Error(r.reason);
  return r.review;
}

function input(over: Partial<BoardInput> = {}): BoardInput {
  return {
    now: NOW,
    reviews: [],
    reviewMachine: 'Studio',
    owners: [],
    commitments: new Map(),
    linkedInitiatives: [],
    sources: [],
    scope: 'local',
    ...over,
  };
}

describe('review JSON contract (§2)', () => {
  it('accepts a valid review and normalises verdicts', () => {
    const r = parseReviewJson('2026-10-30.json', reviewDoc('2026-10-30', [row('a.b', 'stalled'), row('c', 'Retire')]), NOW);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.review.rows.map(x => x.verdict)).toEqual(['stalled', 'retire-pending']);
      expect(r.review.rows[1].verdictRaw).toBe('Retire');
    }
  });

  it('rejects a file whose date is later than tomorrow', () => {
    const r = parseReviewJson('2099-01-01.json', reviewDoc('2099-01-01', [row('a', 'live')]), NOW);
    expect(r).toEqual({ ok: false, fileName: '2099-01-01.json', reason: 'date-in-future' });
  });

  it('accepts tomorrow (clock skew allowance) but not the day after', () => {
    expect(parseReviewJson('2026-10-31.json', reviewDoc('2026-10-31', [row('a', 'live')]), NOW).ok).toBe(true);
    expect(parseReviewJson('2026-11-01.json', reviewDoc('2026-11-01', [row('a', 'live')]), NOW).ok).toBe(false);
  });

  it('rejects a date that does not match the file name', () => {
    const r = parseReviewJson('2026-10-29.json', reviewDoc('2026-10-30', [row('a', 'live')]), NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('date-mismatch');
  });

  it('rejects the wrong schema, a bad id, bad commitment ids and bad dates', () => {
    expect(parseReviewJson('2026-10-30.json', JSON.stringify({ schema: 'x', date: '2026-10-30', features: [row('a', 'live')] }), NOW).ok).toBe(false);
    expect(parseReviewJson('2026-10-30.json', reviewDoc('2026-10-30', [row('bad<id>', 'live')]), NOW).ok).toBe(false);
    expect(parseReviewJson('2026-10-30.json', reviewDoc('2026-10-30', [row('a', 'live', { commitments: ['ACT-1'] })]), NOW).ok).toBe(false);
    expect(parseReviewJson('2026-10-30.json', reviewDoc('2026-10-30', [row('a', 'live', { expectedBy: 'soon' })]), NOW).ok).toBe(false);
    expect(parseReviewJson('2026-10-30.json', 'not json', NOW).ok).toBe(false);
  });

  it('drops a duplicate id and counts it', () => {
    const r = parseReviewJson('2026-10-30.json', reviewDoc('2026-10-30', [row('a', 'live'), row('a', 'stalled')]), NOW);
    expect(r.ok && r.review.rows.length).toBe(1);
    expect(r.ok && r.review.duplicatesDropped).toBe(1);
  });

  it('caps long text fields', () => {
    const r = parseReviewJson('2026-10-30.json', reviewDoc('2026-10-30', [row('a', 'live', { evidence: 'x'.repeat(10_000) })]), NOW);
    expect(r.ok && r.review.rows[0].evidence!.length).toBe(4000);
  });

  it('maps an unknown verdict to other and keeps the raw text', () => {
    expect(normalizeVerdict('regressed (checker)')).toBe('regressed');
    expect(normalizeVerdict('mystery')).toBe('other');
  });
});

describe('markdown review (older format)', () => {
  const md = [
    '# Feature maturation review — 2026-10-28',
    '',
    '## Full table',
    '',
    '| Feature | Verdict | Evidence | Decision | Action |',
    '|---|---|---|---|---|',
    '| `a.one` | stalled | Read today: nothing moved. | improve | CMT-1117, builder x. |',
    '| `b.two` | live (carried) | Carried from the audit. | keep | none |',
    '| not-backticked | live | x | y | z |',
    '| `c.three` | blind | four cells only | none |',
    '',
    '## Something else',
    '| `d.four` | live | x | y | z |',
  ].join('\n');

  it('reads only five-cell backticked rows of the Full table section', () => {
    const r = parseReviewMarkdown('2026-10-28.md', md, NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.review.rows.map(x => x.id)).toEqual(['a.one', 'b.two']);
    expect(r.review.unparsedRows).toBe(2);
    expect(r.review.rows[0].commitments).toEqual(['CMT-1117']);
    expect(r.review.rows[0].evidenceReadToday).toBe(true);
    expect(r.review.rows[1].evidenceReadToday).toBe(false);
  });

  it('takes commitment ids only from the action cell', () => {
    const only = '## Full table\n| `x` | stalled | evidence mentions CMT-9 | decision CMT-8 | none |\n';
    const r = parseReviewMarkdown('2026-10-28.md', only, NOW);
    expect(r.ok && r.review.rows[0].commitments).toEqual([]);
  });

  it('refuses a markdown review without a Full table', () => {
    expect(parseReviewMarkdown('2026-10-28.md', '# nothing', NOW).ok).toBe(false);
  });
});

describe('latest review selection', () => {
  it('picks the newest date and prefers JSON on a tie', () => {
    const a = parsed('2026-10-28', [row('a', 'live')]);
    const b = parsed('2026-10-30', [row('a', 'stalled')]);
    const mdTie: ParsedReview = { ...b, format: 'md', fileName: '2026-10-30.md' };
    expect(pickLatest([a, mdTie, b])).toBe(b);
    expect(historySeries([b, a, mdTie]).map(r => r.date)).toEqual(['2026-10-28', '2026-10-30']);
  });
});

describe('progress is the review verdict, verbatim (§4)', () => {
  it('passes the verdict through and adds no board judgement', () => {
    const board = buildMaturationBoard(input({ reviews: [parsed('2026-10-30', [row('a', 'blind')])] }));
    expect(board.features[0].review!.verdict).toBe('blind');
    expect(board.advisory).toBe(true);
    expect(board.authority).toBe('none');
    expect(board.schema).toBe('maturation-board/1');
  });

  it('counts unchanged reviews only across freshly read rows', () => {
    const reviews = [
      parsed('2026-10-25', [row('a', 'stalled')]),
      parsed('2026-10-28', [row('a', 'stalled')]),
      parsed('2026-10-30', [row('a', 'stalled')]),
    ];
    expect(buildMaturationBoard(input({ reviews })).features[0].unchangedReviews).toBe(3);

    const carried = [
      parsed('2026-10-25', [row('a', 'stalled')]),
      parsed('2026-10-28', [row('a', 'stalled', { evidenceReadToday: false })]),
      parsed('2026-10-30', [row('a', 'stalled')]),
    ];
    const f = buildMaturationBoard(input({ reviews: carried })).features[0];
    expect(f.unchangedReviews).toBe(1);
  });

  it('flags carried evidence and an evidence-free positive verdict', () => {
    const f = buildMaturationBoard(input({ reviews: [parsed('2026-10-30', [
      row('a', 'live', { evidenceReadToday: false }),
      row('b', 'ready', { evidence: null }),
      row('c', 'stalled', { evidence: null }),
    ])] })).features;
    expect(f[0].flags).toContain('carried-evidence');
    expect(f[1].flags).toContain('no-evidence');
    expect(f[2].flags).not.toContain('no-evidence');
  });
});

describe('deadlines (§4)', () => {
  const cmt = (over: Partial<CommitmentFact>): CommitmentFact => ({
    id: 'CMT-1', status: 'pending', createdAt: null, checkInAt: null, nextUpdateDueAt: null, resolvedAt: null, ...over,
  });

  it('reads checkInAt as the commitment deadline, never nextUpdateDueAt', () => {
    const reviews = [parsed('2026-10-30', [row('a', 'stalled', { commitments: ['CMT-1'] })])];
    const onlyNudge = buildMaturationBoard(input({ reviews, commitments: new Map([['CMT-1', cmt({ nextUpdateDueAt: '2026-10-01T00:00:00Z' })]]) }));
    expect(onlyNudge.features[0].deadlines).toEqual([]);
    expect(onlyNudge.features[0].followUp.items[0].nextCheckIn).toBe('2026-10-01T00:00:00Z');

    const promised = buildMaturationBoard(input({ reviews, commitments: new Map([['CMT-1', cmt({ checkInAt: '2026-10-20T00:00:00Z' })]]) }));
    expect(promised.features[0].deadlines[0]).toMatchObject({ source: 'commitment', open: true });
    expect(promised.features[0].deadlines[0].overdueDays).toBe(10);
  });

  it('a resolved or delivered commitment deadline is closed, and delivered reads "handed off"', () => {
    const reviews = [parsed('2026-10-30', [row('a', 'stalled', { commitments: ['CMT-1'] })])];
    const b = buildMaturationBoard(input({ reviews, commitments: new Map([['CMT-1', cmt({ status: 'delivered', checkInAt: '2026-10-20T00:00:00Z' })]]) }));
    expect(b.features[0].deadlines[0].open).toBe(false);
    expect(b.features[0].deadlines[0].overdueDays).toBeNull();
    expect(commitmentLabel(cmt({ status: 'delivered' }))).toBe('handed off');
    expect(b.features[0].followUp.items[0].label).toBe('handed off');
  });

  it('a review expectedBy closes once the verdict is live or ready', () => {
    const open = buildMaturationBoard(input({ reviews: [parsed('2026-10-30', [row('a', 'stalled', { expectedBy: '2026-10-25' })])] }));
    expect(open.features[0].deadlines[0]).toMatchObject({ source: 'review', open: true, overdueDays: 4 });
    const done = buildMaturationBoard(input({ reviews: [parsed('2026-10-30', [row('a', 'live', { expectedBy: '2026-10-25' })])] }));
    expect(done.features[0].deadlines[0]).toMatchObject({ open: false, overdueDays: null });
  });

  it('a future date is not past', () => {
    const b = buildMaturationBoard(input({ reviews: [parsed('2026-10-30', [row('a', 'stalled', { expectedBy: '2026-11-04' })])] }));
    expect(b.features[0].deadlines[0].overdueDays).toBeNull();
  });

  it('counts features with a date and past a date', () => {
    const b = buildMaturationBoard(input({ reviews: [parsed('2026-10-30', [
      row('a', 'stalled', { expectedBy: '2026-10-25' }), row('b', 'stalled', { expectedBy: '2026-11-25' }), row('c', 'stalled'),
    ])] }));
    expect(b.counts.withDate).toBe(2);
    expect(b.counts.pastDate).toBe(1);
  });
});

describe('follow-up is three-valued and explicit-link only (§5)', () => {
  const reviews = [parsed('2026-10-30', [row('a', 'stalled', { commitments: ['CMT-7'] }), row('b', 'stalled')])];

  it('linked when a named commitment exists', () => {
    const b = buildMaturationBoard(input({ reviews, commitments: new Map([['CMT-7', { id: 'CMT-7', status: 'pending', createdAt: null, checkInAt: null, nextUpdateDueAt: null, resolvedAt: null }]]) }));
    expect(b.features[0].followUp.state).toBe('linked');
  });

  it('none-linked only when every source answered', () => {
    const b = buildMaturationBoard(input({ reviews }));
    expect(b.features[1].followUp.state).toBe('none-linked');
    expect(b.counts.stalledRegressedBlindNoFollowUp).toBe(1);
  });

  it('unknown when commitments or initiatives could not be read', () => {
    const noCmt = buildMaturationBoard(input({ reviews, commitments: null }));
    expect(noCmt.features[0].followUp.state).toBe('unknown');
    const noIni = buildMaturationBoard(input({ reviews, linkedInitiatives: null }));
    expect(noIni.features[1].followUp.state).toBe('unknown');
    expect(noIni.counts.stalledRegressedBlindFollowUpUnknown).toBe(1);
  });

  it('an id the tracker does not know is reported, not dropped', () => {
    const b = buildMaturationBoard(input({ reviews }));
    expect(b.features[0].followUp.items[0]).toMatchObject({ ref: 'CMT-7', status: 'unknown-id' });
  });

  it('links an initiative only by id or flagPath, never by text', () => {
    const b = buildMaturationBoard(input({ reviews, linkedInitiatives: [
      { id: 'x', flagPath: 'b.enabled', title: 'mentions a in text', status: 'active', nextCheckAt: null },
    ] }));
    expect(b.features[0].followUp.state).toBe('linked'); // via CMT-7 unknown-id item
    expect(b.features[1].followUp.items.map(i => i.ref)).toEqual(['x']);
  });
});

describe('owners, joins and conflicts (§1, §4)', () => {
  const guard = (machine: string, key: string, effective: string): OwnerEntry => ({ machine, source: 'guard', ownerId: key, facts: { effective }, at: null });

  it('one feature seen by several owners on several machines is one row', () => {
    const reviews = [parsed('2026-10-30', [row('m.x', 'live')])];
    const owners: OwnerEntry[] = [
      guard('Studio', 'm.x.enabled', 'on-confirmed'),
      guard('Mama PC', 'm.x.enabled', 'on-confirmed'),
      { machine: 'Studio', source: 'd7', ownerId: 'm-x', aliases: ['m.x'], facts: { status: 'ready' }, at: null },
    ];
    const b = buildMaturationBoard(input({ reviews, owners }));
    expect(b.features).toHaveLength(1);
    expect(b.features[0].owners).toHaveLength(3);
    expect(b.features[0].flags).not.toContain('ambiguous-join');
  });

  it('two owner ids from the same machine and source for one review id are ambiguous', () => {
    const reviews = [parsed('2026-10-30', [row('m.x', 'live')])];
    const owners = [guard('Studio', 'm.x', 'on-confirmed'), guard('Studio', 'm.x.enabled', 'off')];
    const b = buildMaturationBoard(input({ reviews, owners }));
    expect(b.features[0].flags).toContain('ambiguous-join');
    expect(b.excluded.ambiguousJoins).toBe(1);
  });

  it('C1: review says live while a guard is errored — per machine', () => {
    const reviews = [parsed('2026-10-30', [row('m.x', 'live')])];
    const b = buildMaturationBoard(input({ reviews, owners: [guard('Mac Mini', 'm.x.enabled', 'errored'), guard('Studio', 'm.x.enabled', 'on-confirmed')] }));
    expect(b.features[0].conflicts).toEqual([{ rule: 'C1', machine: 'Mac Mini', a: 'review: live', b: 'guard: errored' }]);
  });

  it('C1 does not fire for a stalled verdict', () => {
    const reviews = [parsed('2026-10-30', [row('m.x', 'stalled')])];
    expect(buildMaturationBoard(input({ reviews, owners: [guard('Studio', 'm.x', 'errored')] })).features[0].conflicts).toEqual([]);
  });

  it('C2: review live vs rollout dark only on the review machine', () => {
    const reviews = [parsed('2026-10-30', [row('f', 'live')])];
    const ro = (machine: string): OwnerEntry => ({ machine, source: 'rollout', ownerId: 'f', aliases: ['f.flag'], facts: { stage: 'dark' }, at: null });
    expect(buildMaturationBoard(input({ reviews, owners: [ro('Studio')] })).features[0].conflicts[0].rule).toBe('C2');
    expect(buildMaturationBoard(input({ reviews, owners: [ro('Mama PC')] })).features[0].conflicts).toEqual([]);
  });

  it('C3 and C4 compare the review with D7; hold vs on-track is not a conflict', () => {
    const d7 = (status: string): OwnerEntry => ({ machine: 'Studio', source: 'd7', ownerId: 'f', facts: { status }, at: null });
    const r = (v: string) => [parsed('2026-10-30', [row('f', v)])];
    expect(buildMaturationBoard(input({ reviews: r('blind'), owners: [d7('ready')] })).features[0].conflicts[0].rule).toBe('C3');
    expect(buildMaturationBoard(input({ reviews: r('ready'), owners: [d7('hold')] })).features[0].conflicts[0].rule).toBe('C4');
    expect(buildMaturationBoard(input({ reviews: r('on-track'), owners: [d7('hold')] })).features[0].conflicts).toEqual([]);
  });

  it('dark-flag deadline and dated history feed the timeline; rollout records add no transitions', () => {
    const reviews = [parsed('2026-10-30', [row('g.y', 'blind')])];
    const owners: OwnerEntry[] = [
      { machine: 'Studio', source: 'dark-flag', ownerId: 'g.y.enabled', facts: { state: 'expired-unproven' }, at: null,
        deadline: { date: '2026-10-20T00:00:00Z', open: true, milestone: 'dark-flag window (7 d)' },
        transitions: [{ at: '2026-10-13T00:00:00Z', from: null, to: 'incubating' }, { at: '2026-10-20T00:00:00Z', from: 'incubating', to: 'expired-unproven' }] },
      { machine: 'Studio', source: 'rollout', ownerId: 'g-y', aliases: ['g.y.enabled'], facts: { stage: 'dark' }, at: null,
        transitions: [{ at: '2026-01-01T00:00:00Z', from: null, to: 'phase' }] },
    ];
    const f = buildMaturationBoard(input({ reviews, owners })).features[0];
    expect(f.transitions.map(t => t.to)).toEqual(['incubating', 'expired-unproven']);
    expect(f.deadlines[0]).toMatchObject({ source: 'dark-flag', overdueDays: 10, machine: 'Studio' });
  });

  it('lists owner-tracked features absent from the latest review, flagged', () => {
    const reviews = [parsed('2026-10-30', [row('a', 'live')])];
    const owners: OwnerEntry[] = [{ machine: 'Studio', source: 'd7', ownerId: 'new-feature', facts: { status: 'hold' }, at: null }];
    const b = buildMaturationBoard(input({ reviews, owners }));
    const extra = b.features.find(f => f.id === 'new-feature')!;
    expect(extra.review).toBeNull();
    expect(extra.flags).toContain('not-in-latest-review');
  });

  it('a bare guard row is not a feature on its own', () => {
    const b = buildMaturationBoard(input({ reviews: [], owners: [guard('Studio', 'some.guard', 'on-confirmed')] }));
    expect(b.features).toEqual([]);
  });
});

describe('review state', () => {
  it('reports none, ok, cached and unavailable honestly', () => {
    expect(buildMaturationBoard(input({ reviews: [] })).reviewState).toBe('none');
    const reviews = [parsed('2026-10-30', [row('a', 'live')])];
    expect(buildMaturationBoard(input({ reviews })).reviewState).toBe('ok');
    expect(buildMaturationBoard(input({ reviews, reviewCachedAt: '2026-10-30T10:00:00Z' })).reviewState).toBe('cached');
    expect(buildMaturationBoard(input({ reviews: [], reviewUnavailable: { machine: 'Studio', since: null } })).reviewState).toBe('unavailable');
  });
});
