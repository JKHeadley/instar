/**
 * The actuator's refusals matter more than its proposals.
 *
 * It exists to close the loop: a problem noticed 177 times and never turned into
 * work should become work. But two ways of doing that would make things worse
 * than leaving it alone, and both are easy to write by accident:
 *
 *   1. Proposing when the ACTION QUEUE could not be read. Then "has anyone
 *      already committed to this?" is unanswerable, every cluster looks
 *      untracked, and the actuator manufactures duplicates of existing work —
 *      the exact redundancy it exists to remove, under the banner of fixing it.
 *
 *   2. Proposing for all 69 qualifying clusters at once. That is a new backlog
 *      wearing a different hat.
 *
 * So most of what follows tests what it declines to do.
 */
import { describe, it, expect } from 'vitest';
import { planActuation } from '../../src/core/RecurrenceActuator.js';
import { buildRecurrenceReport, type Observation, type Coverage } from '../../src/core/RecurrenceReader.js';

const COMPLETE: Coverage = { read: ['attention', 'actions', 'sentinel'], unreadable: [], completeness: 'complete' };

const obs = (p: Partial<Observation> & { title: string }): Observation => ({
  store: 'attention', open: true, ...p,
});

/** n open observations sharing a title. */
const cluster = (title: string, n: number, store: Observation['store'] = 'attention') =>
  Array.from({ length: n }, () => obs({ title, store }));

describe('REFUSAL: the action queue is the one store whose absence forbids acting', () => {
  it('proposes NOTHING when the actions store is unreadable, and says why', () => {
    // THE test. Every cluster would look untracked, so every proposal would risk
    // duplicating work that already exists.
    const report = buildRecurrenceReport(cluster('something loud', 200), {
      read: ['attention', 'sentinel'],
      unreadable: [{ store: 'actions', reason: 'ENOENT: evolution store unreadable' }],
      completeness: 'partial',
    });
    const plan = planActuation(report);

    expect(plan.propose).toHaveLength(0);
    expect(plan.refused?.reason).toBe('actions-store-unreadable');
    expect(plan.refused?.detail).toMatch(/ENOENT/);
    // It still reports what it considered, so a caller can be honest about scope.
    expect(plan.consideredClusters).toBe(1);
  });

  it('DOES act when attention or sentinel is unreadable — those only understate counts', () => {
    // Deliberately NOT symmetric with the case above. A missing attention or
    // sentinel store means the reader saw FEWER observations, so a cluster that
    // still clears the threshold genuinely clears it. Treating all partial reads
    // identically would be lazy symmetry that needlessly blocks safe action.
    const report = buildRecurrenceReport(cluster('still loud', 40), {
      read: ['actions'],
      unreadable: [{ store: 'sentinel', reason: 'log absent' }],
      completeness: 'partial',
    });
    const plan = planActuation(report);

    expect(plan.refused).toBeUndefined();
    expect(plan.propose).toHaveLength(1);
  });
});

describe('REFUSAL: the fix must not become its own pile', () => {
  it('caps proposals per run and reports what it held back', () => {
    // 10 qualifying clusters must not become 10 action items in one pass.
    //
    // NOTE the titles are WORDS, not `problem 0..9`. My first version used digits
    // and produced ONE cluster, not ten — the recurrence key normalizes digits to
    // `N` by design, so `problem 0` and `problem 7` are the same key. The test was
    // naive, not the code; recorded because it is a live demonstration of the
    // over-merge trade the reader documents.
    const names = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliet'];
    const items = names.map((n) => cluster(`problem ${n}`, 50)).flat();
    const plan = planActuation(buildRecurrenceReport(items, COMPLETE), { maxPerRun: 3 });

    expect(plan.propose).toHaveLength(3);
    expect(plan.deferredByCap).toBe(7);
  });

  it('takes the densest clusters first, so the cap converges on what matters', () => {
    const items = [...cluster('minor', 12), ...cluster('enormous', 300), ...cluster('middling', 60)];
    const plan = planActuation(buildRecurrenceReport(items, COMPLETE), { maxPerRun: 1 });

    expect(plan.propose[0].observedCount).toBe(300);
    expect(plan.propose[0].title).toContain('enormous');
  });

  it('ignores clusters below the recurrence threshold', () => {
    // Seen three times is not yet a pattern worth spending a work item on.
    const plan = planActuation(buildRecurrenceReport(cluster('twice-ish', 3), COMPLETE), { minCount: 10 });
    expect(plan.propose).toHaveLength(0);
    expect(plan.refused?.reason).toBe('no-qualifying-clusters');
  });

  it('never proposes for something already tracked', () => {
    // A cluster with a member from the action queue means somebody already
    // committed. Proposing again is the duplicate this whole design avoids.
    const items = [...cluster('owned', 80), ...cluster('owned', 1, 'actions')];
    const plan = planActuation(buildRecurrenceReport(items, COMPLETE));
    expect(plan.propose).toHaveLength(0);
  });
});

describe('idempotence — the actuator must not become a source of repeated noticings', () => {
  it('derives a stable externalKey, so a re-run updates instead of duplicating', () => {
    const items = cluster('the same problem, 40 times', 40);
    const a = planActuation(buildRecurrenceReport(items, COMPLETE));
    const b = planActuation(buildRecurrenceReport(items, COMPLETE));

    expect(a.propose[0].externalKey).toBe(b.propose[0].externalKey);
    expect(a.propose[0].externalKey).toMatch(/^recurrence:/);
  });

  it('different problems get different keys', () => {
    const plan = planActuation(
      buildRecurrenceReport([...cluster('problem one', 40), ...cluster('problem two', 40)], COMPLETE),
      { maxPerRun: 2 },
    );
    expect(plan.propose[0].externalKey).not.toBe(plan.propose[1].externalKey);
  });
});

describe('the proposal is work, not a notification', () => {
  it('carries the evidence a reader needs to judge or dismiss it', () => {
    const items = [
      ...cluster('credential rebalancer', 177),
      ...cluster('credential rebalancer', 3, 'sentinel'),
    ];
    const plan = planActuation(buildRecurrenceReport(items, COMPLETE));
    const p = plan.propose[0];

    expect(p.title).toContain('Recurring, untracked');
    expect(p.description).toContain('180 times');
    expect(p.description).toContain('attention, sentinel');
    // Cancelling must be an explicitly blessed outcome — an explicit decision
    // beats silent accumulation, and if dismissal feels illegitimate the queue
    // just grows again.
    expect(p.description).toMatch(/Cancelling it IS a valid outcome/);
  });

  it('priority comes from volume alone — deterministic, no model', () => {
    const hi = planActuation(buildRecurrenceReport(cluster('huge', 150), COMPLETE));
    const mid = planActuation(buildRecurrenceReport(cluster('medium', 30), COMPLETE));
    const lo = planActuation(buildRecurrenceReport(cluster('small', 12), COMPLETE));

    expect(hi.propose[0].priority).toBe('high');
    expect(mid.propose[0].priority).toBe('medium');
    expect(lo.propose[0].priority).toBe('low');
  });
});
