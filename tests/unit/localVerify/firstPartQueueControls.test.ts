/**
 * First parts beside the queue controls (specs local-verify-likely-failing-first.md and
 * local-verify-queue-controls.md): a held change keeps its one group assignment through hold and
 * release, and a fronted change never starts beside a comparison run. Real fs in a temp state
 * dir; the child process, gh and the clock are fakes (tests/helpers/operatorQueueHarness.ts).
 */

import { afterEach, describe, expect, it } from 'vitest';
import type { VerifyRunInput, VerifyRunResult } from '../../../src/localVerify/orchestrator.js';
import type { FirstPartSummary } from '../../../src/localVerify/firstPart.js';
import { cleanupHarnessDirs, harness, ok, record } from '../../helpers/operatorQueueHarness.js';

afterEach(() => cleanupHarnessDirs());

const BY = 'echo-increasing-throughput';
type H = ReturnType<typeof harness>;
const inputOf = (h: H, i: number) => h.spawned[i].input as unknown as VerifyRunInput;
const go = async (h: H) => { h.setHolders([]); await h.svc.tick(); await h.settle(); };
const summary: FirstPartSummary = {
  setting: 'alternate', group: 'with', active: true, endedInFirstPart: false,
  lanes: [{ lane: 'unit', files: 2, fromChange: 1, fromPrevious: 0, fromList: 1, partners: 0, ms: 4000, endedHere: false }],
};

describe('the group assignment and the operator hold', () => {
  it('hold then release keeps the same group: drawn once at the first enqueue, never again', async () => {
    const h = harness({ prs: [1, 2] });
    let draw = 0.9; // `without`
    h.seams.random = () => draw;
    h.svc.setLikelyFailingFirst(() => 'alternate');
    h.setHolders([9001]); // nothing starts yet
    await h.svc.request(1);
    await h.svc.request(2);
    expect(h.svc.firstPartFor(1).group).toBe('without');
    expect((await h.svc.operatorHold({ pr: 1, by: BY, reason: 'waiting on a dependency' })).ok).toBe(true);
    await h.settle();
    expect(h.queued()).toEqual([2]); // taken out of the queue
    draw = 0.1; // a draw made now would say `with`
    expect(await h.svc.operatorRelease({ pr: 1, by: BY })).toMatchObject({ ok: true, released: true, placed: 'queue' });
    await h.settle();
    expect(h.queued()).toContain(1);
    expect(h.svc.firstPartFor(1).group).toBe('without');
    await go(h);
    // Whichever of the two starts first, PR 1's run input carries the group it was first given.
    for (let i = 0; h.startedPrs().indexOf(1) < 0 && i < 3; i++) { await h.finishAs(h.spawned.length - 1, 'success'); await go(h); }
    const run = h.spawned.findIndex((s) => s.input.pr === 1);
    expect(run).toBeGreaterThanOrEqual(0);
    expect(inputOf(h, run).likelyFailingFirst).toMatchObject({ setting: 'alternate', group: 'without' });
    expect(h.auditsOf('first-part-assigned').filter((a) => a.pr === 1)).toEqual([expect.objectContaining({ pr: 1, group: 'without' })]);
  });

  it('a change held before it was ever queued gets its group when release first queues it, once', async () => {
    const h = harness({ prs: [1] });
    h.seams.random = () => 0.1;
    h.svc.setLikelyFailingFirst(() => 'alternate');
    h.setHolders([9001]);
    expect((await h.svc.operatorHold({ pr: 1, by: BY, reason: 'not yet' })).ok).toBe(true);
    await h.svc.request(1); // asked for while held: not queued
    await h.settle();
    expect(h.queued()).toEqual([]);
    await h.svc.operatorRelease({ pr: 1, by: BY });
    await h.settle();
    await go(h);
    expect(h.startedPrs()).toEqual([1]);
    expect(inputOf(h, 0).likelyFailingFirst).toMatchObject({ group: 'with' });
    expect(h.auditsOf('first-part-assigned')).toHaveLength(1);
  });
});

describe('a fronted change and a running comparison', () => {
  it('a fronted change does not start beside a comparison run; it starts first when the comparison ends', async () => {
    const h = harness({ prs: [1, 2, 3] });
    h.seams.random = () => 0.1; // every pull request `with`
    h.svc.setLikelyFailingFirst(() => 'alternate');
    await h.svc.request(1);
    await h.settle();
    expect(h.startedPrs()).toEqual([1]);
    const first = inputOf(h, 0);
    const done: VerifyRunResult = { ...ok(record({ pr: 1, headSha: first.headSha, baseSha: first.baseSha, startedAt: new Date(h.now() - 60_000).toISOString(), finishedAt: new Date(h.now()).toISOString() })), firstPart: summary, fileOutcomes: { 'tests/unit/a.test.ts': 'passed' } };
    await h.finish(0, done);
    await h.settle();
    // The comparison run of PR 1 is what is running now; nothing is "in flight" as a verify.
    expect(h.spawned).toHaveLength(2);
    expect(inputOf(h, 1)).toMatchObject({ pr: 1, variant: 'compare' });
    expect(h.svc.snapshot().inFlight).toBeNull();
    expect(h.svc.snapshot().likelyFailingFirst.trial.comparing).toMatchObject({ pr: 1 });
    await h.svc.request(2);
    await h.svc.request(3);
    expect(await h.svc.operatorFront({ pr: 3, by: BY, reason: 'promised today' })).toMatchObject({ ok: true, status: 'fronted' });
    await go(h);
    await h.runTimers();
    expect(h.spawned).toHaveLength(2); // neither the fronted change nor the other started beside the comparison
    expect(h.svc.snapshot().operator?.fronted.map((f) => f.pr)).toEqual([3]);
    // The comparison ends: the fronted change is the next to start.
    await h.finish(1, { ...ok(record({ pr: 1, headSha: first.headSha, baseSha: first.baseSha })), fileOutcomes: { 'tests/unit/a.test.ts': 'passed' } });
    await h.settle();
    expect(h.spawned).toHaveLength(3);
    expect(inputOf(h, 2)).toMatchObject({ pr: 3 });
    expect(inputOf(h, 2).variant).toBeUndefined();
    // The snapshot carries both features' sections.
    const snap = h.svc.snapshot();
    expect(snap.operator).toBeDefined();
    expect(snap.likelyFailingFirst).toMatchObject({ setting: 'alternate' });
  });
});
