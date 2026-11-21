/**
 * First parts beside the queue controls (specs local-verify-likely-failing-first.md and
 * local-verify-queue-controls.md): a held change keeps its one group assignment through hold and
 * release. Real fs in a temp state
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
