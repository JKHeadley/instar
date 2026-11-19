/**
 * Tier-1 tests for the operator FRONT inside LocalVerifyService (spec
 * docs/specs/local-verify-queue-controls.md, section B): the next change to start, admission
 * into a full queue within the operator overflow, at most three marks, the mark's life (ended
 * by a result, not by a start), and the turn between the `main` verify and changes, which
 * front never changes. Real fs in a temp state dir; the child process, gh, the peer client and
 * the clock are fakes (tests/helpers/operatorQueueHarness.ts).
 */

import fs from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { MAIN_FAIR_SHARE_MS, MERGE_THROUGHPUT_LABEL } from '../../../src/localVerify/LocalVerifyService.js';
import { LOCAL_VERIFY_LIMITS } from '../../../src/localVerify/policy.js';
import { MAIN_VERIFY_LIMITS } from '../../../src/localVerify/mainHealth.js';
import { MIN, T0, cleanupHarnessDirs, fillQueue, harness, headOf, record, sha, view } from '../../helpers/operatorQueueHarness.js';

afterEach(() => cleanupHarnessDirs());

const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
const BY = 'echo-increasing-throughput';
type H = ReturnType<typeof harness>;
const front = (h: H, pr: number, reason = `promised (${pr})`) => h.svc.operatorFront({ pr, by: BY, reason });
const unfront = (h: H, pr: number) => h.svc.operatorUnfront({ pr, by: BY });
const go = async (h: H) => { h.setHolders([]); await h.svc.tick(); await h.settle(); };
const fronted = (h: H) => h.svc.snapshot().operator?.fronted.map((f) => f.pr) ?? [];
const MAIN_HEAD = sha('e');
/** A stored age for the unverified main head: first seen at T0, so the main verify is due 90 minutes later. */
const KNOWN_AGE = { oldestUnverifiedAt: T0 };

describe('front: the named change is the next change to start', () => {
  it('goes ahead of labelled and aged changes, and the most recently fronted goes first', async () => {
    const h = harness({ prs: [1, 2, 3, 4] });
    h.views[2] = view(2, { labels: [{ name: MERGE_THROUGHPUT_LABEL }] });
    h.setHolders([9001]);
    await h.svc.request(1); // will have aged to the throughput level
    h.advance(95 * MIN);
    await h.svc.request(2); // labelled
    await h.svc.request(3);
    await h.svc.request(4);
    expect(await front(h, 3)).toMatchObject({ ok: true, pr: 3, status: 'fronted', order: 1 });
    expect(await front(h, 4)).toMatchObject({ ok: true, pr: 4, status: 'fronted', order: 2 });
    // Nothing is written into an entry's priority field.
    expect(h.svc.snapshot().queue.find((e) => e.pr === 4)!.priority).toBe(0);
    await go(h);
    await h.finishAs(0, 'success');
    await h.finishAs(1, 'success');
    await h.finishAs(2, 'success');
    expect(h.startedPrs()).toEqual([4, 3, 1, 2]); // then the aged and the labelled change, first come first served
    expect(h.auditsOf('operator-front').map((a) => [a.pr, a.by, a.reason, a.state])).toEqual([[3, BY, 'promised (3)', 'queued'], [4, BY, 'promised (4)', 'queued']]);
  });

  it('the mark survives a re-request, a new push and a restart', async () => {
    const h = harness({ prs: [1, 2, 3] });
    h.setHolders([9001]);
    for (const pr of [1, 2, 3]) await h.svc.request(pr);
    await front(h, 3);
    expect(await h.svc.request(3, { explicit: false })).toMatchObject({ ok: true, status: 'already-queued' }); // overwrites the entry's priority
    expect(fronted(h)).toEqual([3]);
    h.views[3] = view(3, { headRefOid: sha('9') }); // a new push rebuilds the entry
    expect(await h.svc.request(3, { explicit: false })).toMatchObject({ ok: true, status: 'queued' });
    expect(fronted(h)).toEqual([3]);
    const b = harness({ stateDir: h.stateDir, views: h.views });
    b.setHolders([9001]);
    await b.svc.boot();
    expect(fronted(b)).toEqual([3]);
    await go(b);
    expect(b.inputOf(0)).toMatchObject({ pr: 3, headSha: sha('9') }); // first, at its newest commit
  });

  it('unfront ends the mark and the entry stays queued at its ordinary place', async () => {
    const h = harness({ prs: [1, 2, 3] });
    h.setHolders([9001]);
    for (const pr of [1, 2, 3]) await h.svc.request(pr);
    await front(h, 3);
    expect(unfront(h, 3)).toEqual({ ok: true, pr: 3, unfronted: true });
    expect(unfront(h, 3)).toEqual({ ok: false, code: 'not-fronted' });
    expect(h.operatorFile().records).toEqual([]);
    await go(h);
    await h.finishAs(0, 'success');
    await h.finishAs(1, 'success');
    expect(h.startedPrs()).toEqual([1, 2, 3]);
    expect(h.auditsOf('operator-unfront')).toEqual([expect.objectContaining({ pr: 3, by: BY })]);
  });
});

describe('front: admission, the limit of three and the overflow', () => {
  it('a change outside a full queue is admitted by the call, over the cap; the fourth front is refused and names the three', async () => {
    const h = harness({ prs: [...range(1, 10), 21, 22, 23, 24] });
    await fillQueue(h, 1);
    expect(await h.svc.request(21, { explicit: false })).toEqual({ ok: false, code: 'queue-full' }); // an ordinary request is refused
    expect(await front(h, 21)).toMatchObject({ ok: true, pr: 21, status: 'admitted', overCap: true });
    expect(await front(h, 22)).toMatchObject({ ok: true, status: 'admitted', overCap: true });
    expect(await front(h, 23)).toMatchObject({ ok: true, status: 'admitted', overCap: true });
    const fourth = await front(h, 24);
    expect(fourth).toMatchObject({ ok: false, code: 'front-limit' });
    expect((fourth as { fronted: Array<{ pr: number; reason: string; by: string }> }).fronted.map((f) => [f.pr, f.reason, f.by]))
      .toEqual([[23, 'promised (23)', BY], [22, 'promised (22)', BY], [21, 'promised (21)', BY]]);
    expect(h.queued()).toHaveLength(LOCAL_VERIFY_LIMITS.queueCap + 3);
    expect(h.queued()).not.toContain(24);
    expect(h.auditsOf('front-admitted-over-cap').map((a) => [a.pr, a.used])).toEqual([[21, 1], [22, 2], [23, 3]]);
    expect(h.svc.snapshot().operator?.overflow).toEqual({ used: 3, max: 5 });
    // Fronting one of the three again is not a fourth: it only moves it to the very front.
    expect(await front(h, 21)).toMatchObject({ ok: true, status: 'fronted' });
    expect(fronted(h)).toEqual([21, 23, 22]);
    await go(h);
    expect(h.startedPrs()).toEqual([21]); // started next
  });

  it('the overflow is shared and counted while the entries are queued: when it is used up a front answers overflow-full', async () => {
    const h = harness({ prs: [...range(1, 10), ...range(21, 26)] });
    await fillQueue(h, 1);
    for (const pr of [21, 22, 23]) expect((await front(h, pr)).ok).toBe(true);
    unfront(h, 21);
    unfront(h, 22); // their entries stay queued, still over the cap
    for (const pr of [24, 25]) expect(await front(h, pr)).toMatchObject({ status: 'admitted', overCap: true });
    unfront(h, 24);
    expect(await front(h, 26)).toEqual({ ok: false, code: 'overflow-full' });
    expect(h.queued()).toHaveLength(15);
    expect(h.queued()).not.toContain(26);
    expect(fronted(h)).toEqual([25, 23]); // the refused change keeps no mark
  });

  it('a crash after the first write (front, admitting): the admission is finished at boot, and the change is first', async () => {
    const h = harness({ prs: [...range(1, 10), 21] });
    await fillQueue(h, 1);
    h.holdView(21); // the admission is reading the change when the server dies
    void front(h, 21);
    await h.flush();
    expect(h.operatorFile().records).toEqual([expect.objectContaining({ pr: 21, front: expect.objectContaining({ admitting: true, order: 1 }) })]);
    expect(h.queueFile().entries.map((e) => e.pr)).not.toContain(21);
    const b = harness({ stateDir: h.stateDir, prs: [...range(1, 10), 21] });
    b.setHolders([9001]);
    await b.svc.boot();
    expect(b.queued()).toContain(21);
    expect(b.queued()).toHaveLength(11);
    expect(b.operatorFile().records[0].front).not.toHaveProperty('admitting');
    expect(b.auditsOf('front-admitted-over-cap')).toEqual([expect.objectContaining({ pr: 21 })]);
    await go(b);
    expect(b.startedPrs()).toEqual([21]);
  });

  it('a crash after the second write (the entry is queued, "admitting" not cleared): one entry, still first', async () => {
    const h = harness({ prs: [...range(1, 10), 21] });
    await fillQueue(h, 1);
    h.holdView(21);
    void front(h, 21);
    await h.flush();
    const afterFirstWrite = fs.readFileSync(h.operatorPath, 'utf-8'); // "front, admitting"
    await h.releaseView(21);
    await h.settle();
    expect(h.queueFile().entries.map((e) => e.pr)).toContain(21); // the second write happened
    fs.writeFileSync(h.operatorPath, afterFirstWrite); // the third write (clearing "admitting") never reached the disk
    const b = harness({ stateDir: h.stateDir, prs: [...range(1, 10), 21] });
    b.setHolders([9001]);
    await b.svc.boot();
    expect(b.queued().filter((pr) => pr === 21)).toEqual([21]);
    expect(b.queued()).toHaveLength(11);
    expect(b.operatorFile().records[0].front).not.toHaveProperty('admitting');
    await go(b);
    expect(b.startedPrs()).toEqual([21]);
  });

  it('a change with a current passing result has nothing to test: no mark is kept', async () => {
    const h = harness({ prs: [1] });
    await h.svc.request(1);
    await h.finishAs(0, 'success');
    expect(await front(h, 1)).toEqual({ ok: true, pr: 1, status: 'recorded' });
    expect(fronted(h)).toEqual([]);
    expect(h.spawned).toHaveLength(1);
  });

  it('a closed change is refused and keeps no mark', async () => {
    const h = harness({ prs: [1] });
    h.open[1] = false;
    expect(await front(h, 1)).toEqual({ ok: false, code: 'pr-closed' });
    expect(fronted(h)).toEqual([]);
  });
});

describe('front: the mark ends at a result, not at a start', () => {
  it('still marked while it runs; back at the front after an error re-run; ended by the result', async () => {
    const h = harness({ prs: [1, 2, 3] });
    h.setHolders([9001]);
    for (const pr of [1, 2, 3]) await h.svc.request(pr);
    await front(h, 3);
    await go(h);
    expect(h.startedPrs()).toEqual([3]);
    expect(fronted(h)).toEqual([3]); // a start does not end the mark
    await h.finish(0, null); // the run child crashed: an error record and one automatic re-run
    expect(h.startedPrs()).toEqual([3, 3]); // the re-run came back first, ahead of 1 and 2
    expect(fronted(h)).toEqual([3]);
    await h.finishAs(1, 'failure'); // a result, pass or fail, ends it
    expect(fronted(h)).toEqual([]);
    expect(h.auditsOf('operator-front-ended')).toEqual([expect.objectContaining({ pr: 3, why: 'result:failure' })]);
    expect(h.startedPrs()).toEqual([3, 3, 1]);
  });

  it('a derived result (no run) ends the mark too', async () => {
    const h = harness({ prs: [1, 2] });
    h.views[2] = view(2, { headRefOid: headOf(1) }); // the same merge inputs as PR 1
    await h.svc.request(2); // running
    await h.svc.request(1); // queued behind it
    expect(await front(h, 1)).toMatchObject({ ok: true, status: 'fronted' });
    await h.finishAs(0, 'success'); // PR 2's run gives PR 1 a derived record: a result without a run
    expect(h.auditsOf('record').map((a) => [a.pr, a.source])).toEqual([[2, 'run'], [1, 'derived']]);
    expect(h.startedPrs()).toEqual([2]);
    expect(fronted(h)).toEqual([]);
    expect(h.auditsOf('operator-front-ended')).toEqual([expect.objectContaining({ pr: 1, why: 'result:success' })]);
  });

  it('back at the front after an interruption by a server stop', async () => {
    const h = harness({ prs: [1, 2, 3] });
    h.setHolders([9001]);
    for (const pr of [1, 2, 3]) await h.svc.request(pr);
    await front(h, 3);
    await go(h);
    expect(h.startedPrs()).toEqual([3]);
    h.svc.shutdown();
    const b = harness({ stateDir: h.stateDir, prs: [1, 2, 3] });
    await b.svc.boot();
    expect(fronted(b)).toEqual([3]);
    await go(b);
    expect(b.startedPrs()).toEqual([3]);
  });

  it('the hand-off to a peer uses the same order, and an abandoned peer attempt comes back first', async () => {
    const h = harness({ prs: [1, 2, 3], peer: true });
    h.setHolders([9001]); // only the peer can take work
    for (const pr of [1, 2, 3]) await h.svc.request(pr);
    await front(h, 3);
    await h.runTimers();
    expect(h.peer.runs().map((r) => r.pr)).toEqual([3]); // not PR 1, which queued first
    expect(fronted(h)).toEqual([3]); // a reservation is not a result
    h.peer.setResult(() => ({ state: 'unknown' })); // the peer restarted and lost the attempt
    h.advance(3 * MIN);
    await h.svc.tick();
    await h.runTimers();
    expect(h.auditsOf('peer-attempt-abandoned')).toHaveLength(1);
    expect(h.peer.runs().map((r) => r.pr)).toEqual([3, 3]); // offered again, still ahead of PR 1
    expect(fronted(h)).toEqual([3]);
  });

  it('a change fronted during the base read before a peer reservation takes the reservation: the picked entry gives way', async () => {
    const h = harness({ prs: [1, 2], peer: true });
    h.setHolders([9001]);
    await h.svc.request(1);
    h.advance(6 * MIN); // PR 1 re-reads its base before it is reserved
    await h.svc.request(2);
    h.holdBase();
    await h.runTimers(); // PR 1 picked for the peer; waiting on the base read
    expect((h.svc as unknown as { dispatching: { pr: number } | null }).dispatching?.pr).toBe(1);
    expect((await front(h, 2)).ok).toBe(true); // fronted during the wait
    await h.releaseBase();
    await h.runTimers();
    expect(h.peer.runs().map((r) => r.pr)).toEqual([2]);
    expect(h.svc.snapshot().queue.find((e) => e.pr === 1)?.remote).toBeUndefined();
  });

  it('a change fronted during the base read before a local start starts first: the picked entry gives way', async () => {
    const h = harness({ prs: [1, 2] });
    h.setHolders([9001]);
    await h.svc.request(1);
    await h.svc.request(2);
    h.advance(6 * MIN); // both re-read their base before a start
    h.holdBase();
    h.setHolders([]);
    await h.svc.tick(); // PR 1 picked (it queued first); waiting on the base read
    expect(h.spawned).toHaveLength(0);
    expect((h.svc as unknown as { starting: { pr: number } | null }).starting?.pr).toBe(1);
    expect(await front(h, 2)).toMatchObject({ ok: true, status: 'fronted' }); // fronted during the wait
    await h.releaseBase();
    await h.settle();
    expect(h.startedPrs()).toEqual([2]); // the choice was made again at the point of starting
  });
});

describe('front and hold together', () => {
  it('a held change may be fronted: it stays held, and is first when released', async () => {
    const h = harness({ prs: [1, 2, 3] });
    h.setHolders([9001]);
    for (const pr of [1, 2, 3]) await h.svc.request(pr);
    await h.svc.operatorHold({ pr: 3, by: BY, reason: 'waiting' });
    expect(await front(h, 3)).toMatchObject({ ok: true, pr: 3, status: 'held' });
    expect(h.queued()).toEqual([1, 2]);
    expect(h.svc.snapshot().operator?.fronted).toEqual([expect.objectContaining({ pr: 3, held: true, queued: false })]);
    await h.svc.operatorRelease({ pr: 3, by: BY });
    await go(h);
    expect(h.startedPrs()).toEqual([3]);
  });

  it('hold a change that was never requested, front it, release it into a full queue, across a restart: it is queued and first', async () => {
    const prs = [...range(1, 10), 20];
    const h = harness({ prs });
    expect(await h.svc.operatorHold({ pr: 20, by: BY, reason: 'not yet' })).toMatchObject({ ok: true, removed: null });
    expect(await front(h, 20)).toMatchObject({ ok: true, status: 'held' });
    await fillQueue(h, 1);
    const b = harness({ stateDir: h.stateDir, prs });
    b.setHolders([9001]);
    await b.svc.boot();
    expect(b.queued()).toHaveLength(10);
    expect(await b.svc.operatorRelease({ pr: 20, by: BY })).toEqual({ ok: true, pr: 20, released: true, placed: 'queue', overCap: true });
    expect(b.queued()).toHaveLength(11);
    expect(b.auditsOf('release-admitted-over-cap')).toEqual([expect.objectContaining({ pr: 20 })]);
    await go(b);
    expect(b.startedPrs()).toEqual([20]);
  });

  it('fronting a running change records the mark, which matters only if that run comes back without a result', async () => {
    const h = harness({ prs: [1, 2] });
    await h.svc.request(1);
    await h.svc.request(2);
    expect(await front(h, 1)).toMatchObject({ ok: true, pr: 1, status: 'running', where: 'here' });
    await h.finishAs(0, 'success');
    expect(fronted(h)).toEqual([]);
    expect(h.startedPrs()).toEqual([1, 2]);
  });

  it('a held and fronted change retargeted to another branch at the same commit: a late result for the old branch ends neither', async () => {
    const h = harness({ prs: [1] });
    await h.svc.request(1); // running against main
    await h.svc.operatorHold({ pr: 1, by: BY, reason: 'retargeting' });
    expect(await front(h, 1)).toMatchObject({ ok: true, status: 'running' });
    h.views[1] = view(1, { baseRefName: 'release' }); // same commit, another target branch
    h.setBase('release', sha('c'));
    await h.finishAs(0, 'success'); // the late result, for (PR 1, this commit, main)
    expect(h.svc.getRecord(1, headOf(1), 'main')?.outcome).toBe('success');
    expect(fronted(h)).toEqual([1]); // not this change's result any more: the mark stays
    expect(h.svc.snapshot().operator?.held.map((x) => x.pr)).toEqual([1]);
    expect(await h.svc.request(1, { explicit: true })).toEqual({ ok: false, code: 'held' });
    // Released: it is tested for its current target branch, first, and that result ends the mark.
    expect(await h.svc.operatorRelease({ pr: 1, by: BY })).toMatchObject({ released: true, placed: 'queue' });
    expect(h.inputOf(1)).toMatchObject({ pr: 1, headSha: headOf(1), baseRefName: 'release', baseSha: sha('c') });
    await h.finishAs(1, 'success');
    expect(fronted(h)).toEqual([]);
    expect(h.operatorFile().records).toEqual([]);
  });
});

describe('front never changes whose turn it is between the main verify and changes', () => {
  /** A main verify and three changes queued while another suite holds the slot; PR 2 fronted. */
  async function scene(over: Parameters<typeof harness>[0] = {}) {
    const h = harness({ prs: [1, 2, 3], watermark: KNOWN_AGE, ...over });
    h.setHolders([9001]);
    h.svc.noteMainHead(MAIN_HEAD);
    for (const pr of [1, 2, 3]) await h.svc.request(pr);
    expect((await front(h, 2)).ok).toBe(true);
    return h;
  }

  it('before a waiting main verify that is not due: the fronted change starts', async () => {
    const h = await scene();
    h.advance(MAIN_FAIR_SHARE_MS - MIN); // one minute before the main verify is due
    await go(h);
    expect(h.startedPrs()).toEqual([2]);
  });

  it('a due main verify always gets the next start; the fronted change is first among changes after it', async () => {
    const h = await scene();
    h.advance(MAIN_FAIR_SHARE_MS); // exactly at the boundary: due
    await go(h);
    expect(h.startedPrs()).toEqual([0]); // main (pr 0), not the fronted change
    await h.finishAs(0, 'success');
    expect(h.startedPrs()).toEqual([0, 2]);
    await h.finishAs(1, 'success');
    expect(h.startedPrs()).toEqual([0, 2, 1]);
  });

  it('while the shared code is suspect the alternation stands: main, then the fronted change, then main again', async () => {
    const h = await scene({ watermark: { state: 'main-suspect', reason: 'unverified-too-long' } });
    await go(h);
    expect(h.startedPrs()).toEqual([0]); // main's turn first
    await h.finishAs(0, 'error'); // an error re-queues main with a backoff and decides nothing: still suspect
    expect(h.svc.mainHealth().state).toBe('main-suspect');
    expect(h.startedPrs()).toEqual([0, 2]); // the change's turn: the fronted one, not PR 1
    h.advance(MAIN_VERIFY_LIMITS.errorBackoffMs + MIN);
    await h.finishAs(1, 'success');
    expect(h.startedPrs()).toEqual([0, 2, 0]); // main's turn again, though PR 1 and PR 3 wait
  });

  it('on the peer\'s pick too: a due main verify is handed off first, and before that the fronted change is', async () => {
    const early = await scene({ peer: true, mainOnPeers: true });
    await early.runTimers();
    expect(early.peer.runs().map((r) => r.kind ?? r.pr)).toEqual([2]); // main not due: the fronted change takes the free peer

    const due = await scene({ peer: true, mainOnPeers: true });
    due.advance(MAIN_FAIR_SHARE_MS + MIN);
    await due.runTimers();
    expect(due.peer.runs().map((r) => r.kind ?? r.pr)).toEqual(['main']);
    expect(due.svc.snapshot().queue.some((e) => e.pr === 2 && !e.remote)).toBe(true); // the fronted change keeps its place
  });
});

describe('front passes no gate', () => {
  it('an update pause still holds every start, fronted or not', async () => {
    const h = harness({ prs: [1, 2] });
    h.setHolders([9001]);
    await h.svc.request(1);
    await h.svc.request(2);
    await front(h, 2);
    h.svc.setUpdatePendingProvider(() => ({ pending: true, pendingSinceMs: h.now(), otherBlockers: false }));
    await go(h);
    expect(h.spawned).toHaveLength(0);
    h.svc.setUpdatePendingProvider(() => null);
    await go(h);
    expect(h.startedPrs()).toEqual([2]);
  });

  it('the verifier hold still holds every start', async () => {
    const h = harness({ prs: [1, 2] });
    h.setHolders([9001]);
    await h.svc.request(1);
    await h.svc.request(2);
    await front(h, 2);
    (h.seams as { installedVerifierVersion?: () => string | null }).installedVerifierVersion = () => 'another-version';
    await go(h);
    expect(h.spawned).toHaveLength(0);
    expect(h.svc.snapshot().verifierHold).not.toBeNull();
  });

  it('the main-red hold still holds a fronted change that does not repair main', async () => {
    const h = harness({ prs: [1, 2] });
    for (const pr of [1, 2]) h.views[pr] = view(pr, { title: 'chore: unrelated', body: 'nothing', files: [{ path: 'src/core/Foo.ts' }] });
    const FILE = 'tests/unit/broken.test.ts';
    const red = (i: number) => h.finish(i, {
      kind: 'record', overlaps: [], keptWorktree: null, reasons: ['lane-failed:unit:1', `file-failed:${FILE}:1`],
      failures: [{ file: FILE, lane: 'unit', failed: 1, message: 'boom' }],
      record: record({ pr: 0, kind: 'main', headSha: MAIN_HEAD, baseSha: MAIN_HEAD, outcome: 'failure' }),
    } as never);
    h.svc.noteMainHead(MAIN_HEAD); // main's verify starts at once
    expect(h.startedPrs()).toEqual([0]);
    await h.svc.request(1, { explicit: true });
    await h.svc.request(2, { explicit: true });
    await front(h, 2);
    await red(0); // first failure: main-suspect, the re-run starts (main keeps its turn)
    expect(h.svc.mainHealth().state).toBe('main-suspect');
    await red(h.spawned.length - 1); // the re-run fails: main is red
    expect(h.svc.mainHealth().state).toBe('main-red');
    await go(h);
    expect(h.svc.snapshot().mainRedHold?.heldPrs).toEqual(expect.arrayContaining([1, 2]));
    expect(h.startedPrs().filter((pr) => pr !== 0)).toEqual([]); // the fronted change did not start
    expect(fronted(h)).toEqual([2]);
  });
});
