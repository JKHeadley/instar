/**
 * The synthesiser must not commit the failure it exists to detect.
 *
 * Instar notices things in three stores and never reads across them, so one
 * problem gets noticed dozens of times and closed zero times. This reader groups
 * them. The danger in building it is obvious in hindsight and easy to miss in the
 * moment: a synthesiser that reads two of three stores and reports "nothing
 * recurring" is a MORE expensive version of the original defect, because it
 * carries the authority of having looked.
 *
 * So the tests below spend most of their effort on what the reader REFUSES to
 * say, not on what it says.
 */
import { describe, it, expect } from 'vitest';
import {
  recurrenceKey,
  buildRecurrenceReport,
  significantClusters,
  type Observation,
  type Coverage,
} from '../../src/core/RecurrenceReader.js';

const COMPLETE: Coverage = {
  read: ['attention', 'actions', 'sentinel'],
  unreadable: [],
  completeness: 'complete',
};

const obs = (p: Partial<Observation> & { title: string }): Observation => ({
  store: 'attention', open: true, ...p,
});

describe('recurrence key — many noticings collapse to one problem', () => {
  it('groups items that differ only by counts or ids', () => {
    // The real shape from the live queue: the same stranded-topic problem
    // reported with different counts and different machine hashes.
    expect(recurrenceKey('inbound stranded on laptop (3 topics)'))
      .toBe(recurrenceKey('inbound stranded on laptop (17 topics)'));
    expect(recurrenceKey('topics look stranded on m_cc2ec651a91f03f8'))
      .toBe(recurrenceKey('topics look stranded on m_91afbe33d0c7e112'));
  });

  it('does NOT group genuinely different problems', () => {
    expect(recurrenceKey('credential rebalancer'))
      .not.toBe(recurrenceKey('quota readings contradict'));
  });
});

describe('the finding is the SHAPE, not the count', () => {
  it('reports the noticing ratio — 371 items can be 49 problems', () => {
    // Scaled-down replica of the live distribution: one dominant cluster plus a
    // long tail. The ratio is what makes "we have 371 problems" visibly false.
    const items: Observation[] = [
      ...Array.from({ length: 177 }, (_, i) =>
        obs({ title: `credential rebalancer`, id: `a${i}`, source: 'credential-rebalancer' })),
      ...Array.from({ length: 14 }, (_, i) =>
        obs({ title: `quota readings contradict for user${i > 6 ? 'A' : 'B'}@x.io`, id: `q${i}` })),
      obs({ title: 'something seen exactly once' }),
    ];
    const r = buildRecurrenceReport(items, COMPLETE);

    expect(r.observationsConsidered).toBe(192);
    expect(r.clusters.length).toBeLessThan(10);
    expect(r.noticingRatio).toBeGreaterThan(20);
    // The dominant cluster leads, because that is the actionable fact.
    expect(r.clusters[0].count).toBe(177);
  });

  it('no clusters → noticingRatio is null, never 0', () => {
    // A ratio over no denominator is a measurement never taken. Reporting 0
    // would read as "excellent, no recurrence" — the flattering wrong answer.
    const r = buildRecurrenceReport([], COMPLETE);
    expect(r.noticingRatio).toBeNull();
    expect(r.verdict).toBe('no-recurrence');
  });

  it('resolved observations do not inflate recurrence', () => {
    const r = buildRecurrenceReport(
      [obs({ title: 'x' }), obs({ title: 'x', open: false }), obs({ title: 'x', open: false })],
      COMPLETE,
    );
    expect(r.observationsConsidered).toBe(1);
  });
});

describe('REFUSAL: a partial read may never present as a clean bill', () => {
  it('omits the verdict entirely when a store could not be read', () => {
    // THE test. A synthesiser that read 2 of 3 stores and said "no recurrence"
    // would be the original defect wearing a badge. The field is ABSENT — not
    // hedged — so a caller cannot render it as an answer by accident.
    const partial: Coverage = {
      read: ['attention'],
      unreadable: [
        { store: 'actions', reason: 'evolution store unreadable: ENOENT' },
        { store: 'sentinel', reason: 'log absent' },
      ],
      completeness: 'partial',
    };
    const r = buildRecurrenceReport([obs({ title: 'lonely' })], partial);

    expect(r.verdict, 'a partial read produced a verdict — it must not').toBeUndefined();
    expect(r.coverage.completeness).toBe('partial');
    expect(r.coverage.unreadable).toHaveLength(2);
    // The reason travels with it, so the caller can say WHY it could not look.
    expect(r.coverage.unreadable[0].reason).toMatch(/ENOENT/);
  });

  it('still reports what it DID see on a partial read', () => {
    // Refusing a verdict is not refusing to work. Partial data is still useful;
    // what is forbidden is presenting it as complete.
    const partial: Coverage = {
      read: ['attention'],
      unreadable: [{ store: 'actions', reason: 'unreadable' }],
      completeness: 'partial',
    };
    const r = buildRecurrenceReport(
      [obs({ title: 'dupe' }), obs({ title: 'dupe' })],
      partial,
    );
    expect(r.clusters[0].count).toBe(2);
    expect(r.verdict).toBeUndefined();
  });

  it('an EMPTY complete read is distinguishable from an unreadable one', () => {
    // "Nothing there" and "could not look" must never produce the same report.
    const empty = buildRecurrenceReport([], COMPLETE);
    const blind = buildRecurrenceReport([], {
      read: [], unreadable: [
        { store: 'attention', reason: 'x' },
        { store: 'actions', reason: 'x' },
        { store: 'sentinel', reason: 'x' },
      ], completeness: 'partial',
    });

    expect(empty.verdict).toBe('no-recurrence');
    expect(blind.verdict).toBeUndefined();
    expect(empty).not.toEqual(blind);
  });
});

describe('noticed many times, never turned into work', () => {
  it('flags the untracked recurrers — the sharpest available signal', () => {
    const items: Observation[] = [
      ...Array.from({ length: 5 }, () => obs({ title: 'nobody owns this' })),
      obs({ title: 'somebody owns this' }),
      obs({ title: 'somebody owns this', store: 'actions' }),
    ];
    const r = buildRecurrenceReport(items, COMPLETE);

    const untracked = significantClusters(r, { untrackedOnly: true });
    expect(untracked).toHaveLength(1);
    expect(untracked[0].exemplar).toBe('nobody owns this');
    expect(untracked[0].count).toBe(5);

    // The owned one IS recurring, but somebody committed to it — a materially
    // different state, so it must not appear in the untracked view.
    const all = significantClusters(r);
    expect(all.map((c) => c.tracked)).toContain(true);
  });

  it('a single observation is not yet recurrence', () => {
    const r = buildRecurrenceReport([obs({ title: 'once' })], COMPLETE);
    expect(significantClusters(r)).toHaveLength(0);
    expect(r.verdict).toBe('no-recurrence');
  });

  it('cross-store sightings are recorded, because they are stronger evidence', () => {
    const r = buildRecurrenceReport([
      obs({ title: 'seen everywhere', store: 'attention' }),
      obs({ title: 'seen everywhere', store: 'sentinel' }),
      obs({ title: 'seen everywhere', store: 'actions' }),
    ], COMPLETE);
    expect(r.clusters[0].stores.sort()).toEqual(['actions', 'attention', 'sentinel']);
    expect(r.clusters[0].tracked).toBe(true);
  });
});
