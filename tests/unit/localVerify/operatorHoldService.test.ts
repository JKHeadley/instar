/**
 * Tier-1 tests for the operator HOLD inside LocalVerifyService (spec
 * docs/specs/local-verify-queue-controls.md, sections "What the controls remember", A and
 * "Who may use them, and the record"). Real fs in a temp state dir; the child process, gh,
 * the peer client, the lease and the clock are fakes (tests/helpers/operatorQueueHarness.ts).
 */

import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { QUEUE_PRIORITY, effectivePriority } from '../../../src/localVerify/LocalVerifyService.js';
import { LOCAL_VERIFY_LIMITS } from '../../../src/localVerify/policy.js';
import { OPERATOR_QUEUE_LIMITS } from '../../../src/localVerify/operatorQueue.js';
import { HOUR, MIN, T0, cleanupHarnessDirs, fillQueue, harness, headOf, sha, view } from '../../helpers/operatorQueueHarness.js';

afterEach(() => cleanupHarnessDirs());

const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
const BY = 'echo-increasing-throughput';
const hold = (h: ReturnType<typeof harness>, pr: number, over: { reason?: string; until?: number } = {}) =>
  h.svc.operatorHold({ pr, by: BY, reason: over.reason ?? `waiting on something (${pr})`, ...(over.until !== undefined ? { until: over.until } : {}) });
const release = (h: ReturnType<typeof harness>, pr: number) => h.svc.operatorRelease({ pr, by: BY });
/** Free the local slot and let the service start what it picks. */
const go = async (h: ReturnType<typeof harness>) => { h.setHolders([]); await h.svc.tick(); await h.settle(); };
const dueSignals = (h: ReturnType<typeof harness>) => h.signals.filter((s) => s.key.startsWith('local-verify:operator-hold-due:'));

describe('hold: a held change is out of the queue', () => {
  it('a queued change leaves the queue, its place is filled from the waiting list in its usual order, and it never starts', async () => {
    const h = harness({ prs: range(1, 12) });
    await fillQueue(h, 1);
    expect(await h.svc.request(11, { explicit: false })).toEqual({ ok: false, code: 'queue-full' }); // 11 waits
    const r = await hold(h, 5);
    expect(r).toEqual({ ok: true, pr: 5, held: true, alreadyHeld: false, running: false, removed: 'queue' });
    expect(h.queued()).toEqual([1, 2, 3, 4, 6, 7, 8, 9, 10]);
    // The hold is in the operator file with the entry it took out, whole; the queue file no longer has it.
    expect(h.operatorFile().records).toEqual([expect.objectContaining({ pr: 5, hold: expect.objectContaining({ by: BY, entry: expect.objectContaining({ headSha: headOf(5), firstQueuedAt: T0 }) }) })]);
    expect(h.queueFile().entries.map((e) => e.pr)).not.toContain(5);
    // The freed place goes to the PR refused earliest, not to whoever asks next.
    expect(await h.svc.request(12, { explicit: false })).toEqual({ ok: false, code: 'queue-full' });
    expect(await h.svc.request(11, { explicit: false })).toMatchObject({ ok: true, status: 'queued' });
    // A held change does not count toward the cap, and a request for it answers `held`.
    expect(await h.svc.request(5, { explicit: false })).toEqual({ ok: false, code: 'held' });
    expect(await h.svc.request(5, { explicit: true })).toEqual({ ok: false, code: 'held' });
    // Drain the queue: every other change runs, the held one never does.
    await go(h);
    for (let i = 0; i < 10; i++) await h.finishAs(i, 'success');
    expect(h.startedPrs()).toEqual([1, 2, 3, 4, 6, 7, 8, 9, 10, 11]);
    expect(h.auditsOf('operator-held-started')).toEqual([]);
    expect(h.auditsOf('operator-hold')).toEqual([expect.objectContaining({ pr: 5, by: BY, reason: 'waiting on something (5)', running: false })]);
  });

  it('a held change is never handed to a peer', async () => {
    const h = harness({ prs: [1, 2], peer: true });
    h.setHolders([9001]); // the local slot is busy: only the peer can take work
    await h.svc.request(1);
    await h.svc.request(2);
    await hold(h, 1);
    await h.runTimers();
    expect(h.peer.runs().map((r) => r.pr)).toEqual([2]);
    expect(h.spawned).toHaveLength(0);
    // The dispatch check itself refuses a held change, even one still sitting in the queue.
    const svc = h.svc as unknown as { queue: Array<{ pr: number }>; dispatchable(e: unknown, held: Set<number>): boolean; entryFromSaved(pr: number, s: unknown, ms: number): { pr: number } };
    const stray = svc.entryFromSaved(1, h.operatorFile().records[0].hold!.entry, 0);
    expect(svc.dispatchable(stray, new Set())).toBe(false);
  });

  it('a change may be held before it is queued; the watcher\'s request answers `held`, and the hold remembers it was asked for', async () => {
    const h = harness({ prs: [7] });
    expect(await hold(h, 7)).toMatchObject({ ok: true, held: true, running: false, removed: null });
    expect(await h.svc.request(7, { explicit: false })).toEqual({ ok: false, code: 'held' });
    expect(h.operatorFile().records[0].hold).toMatchObject({ wanted: 'watcher' });
    expect(await h.svc.request(7, { explicit: true })).toEqual({ ok: false, code: 'held' });
    expect(h.operatorFile().records[0].hold).toMatchObject({ wanted: 'explicit' });
    expect(h.queued()).toEqual([]);
    expect(h.spawned).toHaveLength(0);
    // Released: it was asked for while held, so it is admitted, and it runs.
    expect(await release(h, 7)).toMatchObject({ ok: true, released: true, placed: 'queue' });
    expect(h.startedPrs()).toEqual([7]);
    expect(h.operatorFile().records).toEqual([]);
  });

  it('holding twice keeps what the first hold took out and updates who, why and until', async () => {
    const h = harness({ prs: [1] });
    h.setHolders([9001]);
    await h.svc.request(1);
    await hold(h, 1, { reason: 'first reason' });
    h.advance(10 * MIN);
    const again = await h.svc.operatorHold({ pr: 1, by: 'justin', reason: 'second reason', until: T0 + 5 * HOUR });
    expect(again).toMatchObject({ ok: true, alreadyHeld: true, removed: null });
    expect(h.operatorFile().records[0].hold).toMatchObject({ by: 'justin', reason: 'second reason', at: T0, until: T0 + 5 * HOUR, entry: { headSha: headOf(1) } });
    expect(await release(h, 1)).toMatchObject({ placed: 'queue' });
    expect(await release(h, 1)).toEqual({ ok: false, code: 'not-held' });
  });

  it('a closed held change is dropped when a request finds it closed', async () => {
    const h = harness({ prs: [1] });
    await hold(h, 1);
    h.open[1] = false;
    expect(await h.svc.request(1, { explicit: false })).toEqual({ ok: false, code: 'pr-closed' });
    expect(h.operatorFile().records).toEqual([]);
    expect(h.auditsOf('operator-record-dropped')).toEqual([expect.objectContaining({ pr: 1, reason: 'closed' })]);
  });
});

describe('hold: the moment of decision', () => {
  it('local start, the hold first: a hold that arrives during the base read stops the start', async () => {
    const h = harness({ prs: [1] });
    h.setHolders([9001]);
    await h.svc.request(1);
    h.advance(6 * MIN); // the entry re-reads its base before it starts
    h.holdBase();
    h.setHolders([]);
    await h.svc.tick(); // picked; now waiting on the base read
    expect(h.spawned).toHaveLength(0);
    expect((h.svc as unknown as { starting: { pr: number } | null }).starting?.pr).toBe(1);
    const r = await hold(h, 1);
    expect(r).toMatchObject({ ok: true, running: false, removed: 'queue' });
    await h.releaseBase();
    await go(h);
    expect(h.spawned).toHaveLength(0); // the picked entry was not started
    expect(h.queued()).toEqual([]);
    expect(h.auditsOf('operator-held-started')).toEqual([]);
  });

  it('local start, the start first: the run is left alone and the answer says it is running', async () => {
    const h = harness({ prs: [1] });
    await h.svc.request(1);
    expect(h.startedPrs()).toEqual([1]);
    const r = await hold(h, 1);
    expect(r).toEqual({ ok: true, pr: 1, held: true, alreadyHeld: false, running: true, where: 'here', removed: null });
    expect(h.svc.snapshot().inFlight).toMatchObject({ pr: 1 }); // not cancelled
    expect(h.auditsOf('cancel')).toEqual([]);
    // It ends with a result: nothing comes back to the queue, and it stays held for the next request.
    await h.finishAs(0, 'failure');
    expect(h.queued()).toEqual([]);
    expect(await h.svc.request(1, { explicit: true })).toEqual({ ok: false, code: 'held' });
  });

  it('peer reservation, the hold first: a hold during the base read before a reservation means no hand-off', async () => {
    const h = harness({ prs: [1], peer: true });
    h.setHolders([9001]);
    await h.svc.request(1);
    await h.runTimers(); // the first dispatch pass reserves it; give it back so the next pass re-reads its base
    expect(h.peer.runs()).toHaveLength(1);
    h.peer.setResult(() => ({ state: 'unknown' }));
    h.advance(6 * MIN);
    await h.svc.tick(); // the peer forgot the attempt: abandoned, the entry is unreserved again
    expect(h.svc.snapshot().peers.reserved).toEqual([]);
    h.holdBase();
    await h.runTimers(); // picked for the peer; now waiting on the base read
    expect((h.svc as unknown as { dispatching: { pr: number } | null }).dispatching?.pr).toBe(1);
    const r = await hold(h, 1);
    expect(r).toMatchObject({ ok: true, running: false, removed: 'queue' });
    await h.releaseBase();
    await h.runTimers();
    expect(h.peer.runs()).toHaveLength(1); // no second hand-off
    expect(h.queued()).toEqual([]);
  });

  it('peer reservation, the reservation first: the peer run is left alone (running on a peer)', async () => {
    const h = harness({ prs: [1], peer: true });
    h.setHolders([9001]);
    await h.svc.request(1);
    await h.runTimers();
    expect(h.peer.runs().map((r) => r.pr)).toEqual([1]);
    const r = await hold(h, 1);
    expect(r).toEqual({ ok: true, pr: 1, held: true, alreadyHeld: false, running: true, where: 'peer', removed: null });
    expect(h.peer.cancels()).toEqual([]);
    expect(h.svc.snapshot().peers.reserved).toEqual([expect.objectContaining({ pr: 1 })]);
  });
});

describe('hold: a run that comes back without a result goes to held, not back to the queue', () => {
  it('an error re-run', async () => {
    const h = harness({ prs: [1] });
    await h.svc.request(1);
    await hold(h, 1);
    await h.finish(0, null); // the run child crashed: an error record, and one automatic re-run
    expect(h.auditsOf('error-auto-retry')).toHaveLength(1);
    expect(h.spawned).toHaveLength(1); // the re-run did not start
    expect(h.queued()).toEqual([]);
    expect(h.operatorFile().records[0].hold).toMatchObject({ entry: { headSha: headOf(1), errorRetries: 1 } });
    // Released: the re-run it carried comes back and starts.
    expect(await release(h, 1)).toMatchObject({ placed: 'queue' });
    expect(h.startedPrs()).toEqual([1, 1]);
  });

  it('an interruption by a server stop, across the restart', async () => {
    const h = harness({ prs: [1, 2] });
    await h.svc.request(1);
    await h.svc.request(2);
    await hold(h, 1);
    h.svc.shutdown(); // kills the run; it would go back to the head of the queue
    expect(h.queueFile().entries.map((e) => e.pr)).toEqual([2]);
    expect(h.operatorFile().records[0].hold).toMatchObject({ entry: { interruptions: 1, resumeFirst: true } });
    const b = harness({ stateDir: h.stateDir, prs: [1, 2] });
    await b.svc.boot();
    await go(b);
    expect(b.startedPrs()).toEqual([2]);
    expect(b.svc.snapshot().operator?.held.map((x) => x.pr)).toEqual([1]);
  });

  it('a server that died mid-run (no clean stop): the restored entry goes to held at boot', async () => {
    const h = harness({ prs: [1] });
    await h.svc.request(1);
    await hold(h, 1);
    expect(h.queueFile().entries).toEqual([expect.objectContaining({ pr: 1, inFlight: true })]);
    const b = harness({ stateDir: h.stateDir, prs: [1] });
    await b.svc.boot();
    await go(b);
    expect(b.spawned).toHaveLength(0);
    expect(b.queued()).toEqual([]);
    expect(b.operatorFile().records[0].hold).toMatchObject({ entry: { headSha: headOf(1), interruptions: 1 } });
    expect(b.auditsOf('operator-held-out')).toEqual([expect.objectContaining({ pr: 1, from: 'queue', why: 'found-queued' })]);
  });

  it('an abandoned peer attempt', async () => {
    const h = harness({ prs: [1], peer: true });
    h.setHolders([9001]);
    await h.svc.request(1);
    await h.runTimers();
    await hold(h, 1);
    h.peer.setResult(() => ({ state: 'unknown' })); // the peer restarted and no longer knows the attempt
    h.advance(3 * MIN);
    await h.svc.tick();
    await h.runTimers();
    expect(h.auditsOf('peer-attempt-abandoned')).toHaveLength(1);
    expect(h.peer.runs()).toHaveLength(1); // not offered again
    expect(h.queued()).toEqual([]);
    expect(h.operatorFile().records[0].hold).toMatchObject({ entry: { headSha: headOf(1), remoteAttempts: 1 } });
  });
});

describe('release: puts back exactly what the hold took out', () => {
  it('restores the first-queued time, and held time does not count as waiting', async () => {
    const h = harness({ prs: [1] });
    h.setHolders([9001]);
    await h.svc.request(1);
    h.advance(10 * MIN);
    await hold(h, 1);
    h.advance(2 * HOUR); // held
    expect(await release(h, 1)).toEqual({ ok: true, pr: 1, released: true, placed: 'queue' });
    const e = h.svc.snapshot().queue.find((x) => x.pr === 1)!;
    expect(e.firstQueuedAt).toBe(T0);
    expect(e.pausedMs).toBe(2 * HOUR);
    // 130 minutes since it queued, 120 of them held: it has waited 10 and is not aged to the throughput level.
    expect(effectivePriority(e, h.now())).toBe(QUEUE_PRIORITY.ordinary);
    expect(effectivePriority({ ...e, pausedMs: 0 }, h.now())).toBe(QUEUE_PRIORITY.mergeThroughput);
    expect(h.auditsOf('operator-release')).toEqual([expect.objectContaining({ pr: 1, by: BY, restores: 'queue-entry' })]);
  });

  it('into a full queue: admitted over the cap within the operator overflow, audited', async () => {
    const h = harness({ prs: range(1, 11) });
    await fillQueue(h, 1);
    await hold(h, 3);
    expect(await h.svc.request(11)).toMatchObject({ ok: true, status: 'queued' }); // the queue is full again
    expect(await release(h, 3)).toEqual({ ok: true, pr: 3, released: true, placed: 'queue', overCap: true });
    expect(h.queued()).toHaveLength(LOCAL_VERIFY_LIMITS.queueCap + 1);
    expect(h.auditsOf('release-admitted-over-cap')).toEqual([expect.objectContaining({ pr: 3, used: 1, max: 5 })]);
    expect(h.svc.snapshot().operator?.overflow).toEqual({ used: 1, max: 5 });
  });

  it('the overflow used up: the head of the waiting list, so it takes the next free place', async () => {
    const h = harness({ prs: range(1, 17) });
    await fillQueue(h, 1);
    for (const pr of range(1, 6)) await hold(h, pr);
    for (const pr of range(11, 16)) expect((await h.svc.request(pr)).ok).toBe(true);
    expect(await h.svc.request(17, { explicit: false })).toEqual({ ok: false, code: 'queue-full' }); // an ordinary waiter
    for (const pr of range(1, 5)) expect(await release(h, pr)).toMatchObject({ placed: 'queue', overCap: true });
    expect(h.queued()).toHaveLength(15);
    h.advance(MIN);
    // The saved entry (and a re-test it carried) cannot ride on the waiting list: the answer and the audit row say so.
    expect(await release(h, 6)).toEqual({ ok: true, pr: 6, released: true, placed: 'waiting-list', detail: 'placed on the waiting list; the saved re-test was not kept' });
    expect(h.auditsOf('operator-release-placed').at(-1)).toMatchObject({ pr: 6, placed: 'waiting-list', savedEntryDropped: true });
    expect(h.auditsOf('operator-release-placed').filter((a) => a.savedEntryDropped)).toHaveLength(1); // the five admitted over the cap kept theirs
    expect(h.waitingFile().waiters.map((w) => w.pr)).toEqual([6, 17]); // ahead of the waiter refused before it
    expect(h.queued()).toHaveLength(15);
    expect(h.operatorFile().records).toEqual([]);
  });

  it('a new push while held changes nothing; released, it is tested at its newest commit in its old place', async () => {
    const h = harness({ prs: [1, 2] });
    h.setHolders([9001]);
    await h.svc.request(1);
    h.advance(MIN);
    await h.svc.request(2);
    await hold(h, 1);
    h.views[1] = view(1, { headRefOid: sha('9') });
    expect(await h.svc.request(1, { explicit: false })).toEqual({ ok: false, code: 'held' });
    expect(h.operatorFile().records[0].hold).toMatchObject({ entry: { headSha: headOf(1) } }); // the hold is untouched
    await release(h, 1);
    const e = h.svc.snapshot().queue.find((x) => x.pr === 1)!;
    expect(e.headSha).toBe(sha('9'));
    expect(e.firstQueuedAt).toBe(T0);
  });

  it('a failed change with a saved re-test against a newer base gets that re-test back, once; one with nothing pending gets nothing', async () => {
    const h = harness({ prs: [1, 2] });
    await h.svc.request(1);
    await h.finishAs(0, 'failure');
    await h.svc.request(2);
    await h.finishAs(1, 'failure');
    // main moved: an explicit request re-tests the failed PR 1 against the newer base (its one re-run for that base).
    h.setBase('main', sha('c'));
    h.setHolders([9001]);
    expect(await h.svc.request(1, { explicit: true })).toMatchObject({ ok: true, status: 'queued' });
    await hold(h, 1);
    await hold(h, 2);
    expect(h.operatorFile().records.find((r) => r.pr === 1)!.hold).toMatchObject({ entry: { baseSha: sha('c') } });
    expect(h.operatorFile().records.find((r) => r.pr === 2)!.hold).not.toHaveProperty('entry');
    const queuedRows = h.auditsOf('queued').length;
    // Release decides from the saved entry alone, never from whether a result exists.
    expect(await release(h, 1)).toMatchObject({ released: true, placed: 'queue' });
    expect(h.svc.snapshot().queue.filter((x) => x.pr === 1)).toEqual([expect.objectContaining({ baseSha: sha('c') })]);
    expect(await release(h, 1)).toEqual({ ok: false, code: 'not-held' }); // restored once
    expect(h.svc.snapshot().queue.filter((x) => x.pr === 1)).toHaveLength(1);
    // PR 2 failed too, but nothing was pending for it: the release only ends the hold.
    expect(await release(h, 2)).toEqual({ ok: true, pr: 2, released: true, placed: 'none' });
    expect(h.queued()).toEqual([1]);
    expect(h.auditsOf('queued')).toHaveLength(queuedRows);
    await go(h);
    expect(h.inputOf(2)).toMatchObject({ pr: 1, baseSha: sha('c') });
  });

  it('a release never causes a test by itself: a never-requested change and a change with a current result request nothing', async () => {
    const h = harness({ prs: [3, 4] });
    await h.svc.request(4);
    await h.finishAs(0, 'success');
    await hold(h, 3);
    await hold(h, 4);
    const before = h.audits().length;
    expect(await release(h, 3)).toEqual({ ok: true, pr: 3, released: true, placed: 'none' });
    expect(await release(h, 4)).toEqual({ ok: true, pr: 4, released: true, placed: 'none' });
    expect(h.queued()).toEqual([]);
    expect(h.spawned).toHaveLength(1);
    expect(h.audits().slice(before).map((a) => a.event).filter((e) => e === 'queued' || e === 'started' || e === 'refused')).toEqual([]);
    expect(h.auditsOf('operator-release').map((a) => a.restores)).toEqual(['nothing', 'nothing']);
  });

  it('a held waiter comes back with its first refusal', async () => {
    const h = harness({ prs: range(1, 11) });
    await fillQueue(h, 1);
    expect(await h.svc.request(11, { explicit: false })).toEqual({ ok: false, code: 'queue-full' });
    expect(await hold(h, 11)).toMatchObject({ removed: 'waiting-list' });
    expect(h.svc.snapshot().waiting).toEqual([]);
    h.advance(30 * MIN);
    // Released into the still-full queue: admitted over the cap, carrying the time it was first refused.
    expect(await release(h, 11)).toMatchObject({ placed: 'queue', overCap: true });
    expect(h.svc.snapshot().queue.find((x) => x.pr === 11)).toMatchObject({ firstRefusedAt: T0, pausedMs: 30 * MIN });
  });
});

describe('hold: alarms, the reminder and the record bound', () => {
  it('the starved alarm ignores a held change, and a runnable change that really waited still raises', async () => {
    const h = harness({ prs: [1, 2] });
    h.setHolders([9001]);
    await h.svc.request(1);
    h.advance(MIN);
    await h.svc.request(2);
    await hold(h, 1);
    h.advance(LOCAL_VERIFY_LIMITS.starvedAfterMs + 5 * MIN);
    await h.svc.tick();
    expect(h.starved.map((s) => s.pr)).toEqual([2]);
  });

  it('one reminder per hold, at `until` or at 24 hours, holds due at the same check in one item, never repeated; a closed one is dropped', async () => {
    const h = harness({});
    await hold(h, 1);
    await hold(h, 2, { until: T0 + 2 * HOUR });
    await hold(h, 3);
    await hold(h, 4);
    await h.svc.tick();
    h.advance(HOUR);
    await h.svc.tick();
    expect(dueSignals(h)).toEqual([]);
    h.advance(HOUR + MIN); // past PR 2's date
    await h.svc.tick();
    expect(dueSignals(h)).toHaveLength(1);
    expect(dueSignals(h)[0].detail.holds).toEqual([expect.objectContaining({ pr: 2, by: BY })]);
    expect(dueSignals(h)[0].key).toBe(`local-verify:operator-hold-due:${new Date(h.now()).toISOString()}`); // the id carries the check time
    expect(String(dueSignals(h)[0].detail.note)).toContain('PR #2');
    // 24 hours with no date: PRs 1 and 3 are due at the same check and share one item; PR 4 has closed and is dropped.
    h.open[4] = false;
    h.advance(23 * HOUR);
    await h.svc.tick();
    expect(dueSignals(h)).toHaveLength(2);
    expect((dueSignals(h)[1].detail.holds as Array<{ pr: number }>).map((x) => x.pr)).toEqual([1, 3]);
    expect(h.operatorFile().records.map((r) => r.pr)).toEqual([1, 2, 3]);
    // Never again for the same holds.
    for (let i = 0; i < 3; i++) { h.advance(24 * HOUR); await h.svc.tick(); }
    expect(dueSignals(h)).toHaveLength(2);
    expect(h.auditsOf('operator-hold-due').map((a) => a.pr)).toEqual([2, 1, 3]);
    expect(h.svc.snapshot().operator?.held.map((x) => [x.pr, x.reminded])).toEqual([[1, true], [2, true], [3, true]]);
  });

  it('the 201st record: refused while 200 live records remain, admitted once a closed one can be dropped', async () => {
    const h = harness({});
    fs.writeFileSync(h.operatorPath, JSON.stringify({
      v: 1, savedAt: T0, nextOrder: 1, overCap: [],
      records: range(1, OPERATOR_QUEUE_LIMITS.maxRecords).map((pr) => ({ pr, hold: { by: BY, reason: 'seeded', at: T0 } })),
    }));
    expect(await hold(h, 999)).toEqual({ ok: false, code: 'operator-file-full' });
    expect(h.operatorFile().records).toHaveLength(200); // existing records are kept
    expect(await h.svc.operatorFront({ pr: 998, by: BY, reason: 'r' })).toEqual({ ok: false, code: 'operator-file-full' });
    h.open[5] = false; // GitHub reports PR 5 closed
    expect(await hold(h, 999)).toMatchObject({ ok: true, held: true });
    const prs = h.operatorFile().records.map((r) => r.pr);
    expect(prs).toHaveLength(200);
    expect(prs).not.toContain(5);
    expect(prs).toContain(999);
  });
});

describe('hold: survival across a restart, the unreadable file, the switch and the lease', () => {
  it('holds are still in force after a restart', async () => {
    const h = harness({ prs: [1, 2] });
    h.setHolders([9001]);
    await h.svc.request(1);
    await hold(h, 1, { reason: 'known wrong', until: T0 + 6 * HOUR });
    await hold(h, 2); // never requested
    const b = harness({ stateDir: h.stateDir, prs: [1, 2] });
    await b.svc.boot();
    expect(b.svc.snapshot().operator?.held).toEqual([
      expect.objectContaining({ pr: 1, reason: 'known wrong', by: BY, until: new Date(T0 + 6 * HOUR).toISOString(), savedEntry: true }),
      expect.objectContaining({ pr: 2, until: null, savedEntry: false }),
    ]);
    expect(await b.svc.request(1, { explicit: true })).toEqual({ ok: false, code: 'held' });
    expect(await b.svc.request(2, { explicit: false })).toEqual({ ok: false, code: 'held' });
    await go(b);
    expect(b.spawned).toHaveLength(0);
    expect(await release(b, 1)).toMatchObject({ placed: 'queue' });
    expect(b.startedPrs()).toEqual([1]);
  });

  it('a restart after a release reached the waiting list but before "releasing" was cleared: one entry, its place kept', async () => {
    const h = harness({ prs: [30, 31] });
    fs.writeFileSync(h.operatorPath, JSON.stringify({
      v: 1, savedAt: T0, nextOrder: 1, overCap: [],
      records: [{ pr: 30, hold: { by: BY, reason: 'r', at: T0 - 5 * HOUR, wanted: 'explicit', releasing: { by: BY, at: T0 - MIN } } }],
    }));
    fs.writeFileSync(path.join(h.lvDir, 'waiting.json'), JSON.stringify({ v: 1, savedAt: T0, pausedSince: null, waiters: [
      { pr: 30, firstRefusedAt: T0 - 2 * HOUR, lastOfferedAt: T0, refusals: 1 },
      { pr: 31, firstRefusedAt: T0 - HOUR, lastOfferedAt: T0, refusals: 3 },
    ] }));
    await h.svc.boot();
    expect(h.svc.snapshot().waiting.map((w) => [w.pr, w.firstRefusedAt])).toEqual([[30, T0 - 2 * HOUR], [31, T0 - HOUR]]);
    expect(h.queued()).toEqual([]);
    expect(h.operatorFile().records).toEqual([]); // the release is finished
    expect(h.auditsOf('operator-release-placed')).toEqual([expect.objectContaining({ pr: 30, placed: 'waiting-list' })]);
    // No longer held: the next offer takes its place in line as usual.
    expect(await h.svc.request(30, { explicit: false })).toMatchObject({ ok: true, status: 'queued' });
  });

  it('an unreadable file with a good previous copy: reported at once, the restored holds named, the newest change missing', async () => {
    const h = harness({ prs: [1, 2] });
    await hold(h, 1, { reason: 'the first hold' });
    await hold(h, 2, { reason: 'the newest hold' });
    fs.writeFileSync(h.operatorPath, '{"v":1,"records":[{"pr":1,"ho');
    const b = harness({ stateDir: h.stateDir, prs: [1, 2] });
    await b.svc.boot();
    const sig = b.signals.filter((s) => s.key.startsWith('local-verify:operator-file-unreadable:'));
    expect(sig).toHaveLength(1);
    expect(String(sig[0].detail.note)).toContain('PR #1 (the first hold)');
    expect(String(sig[0].detail.note)).toContain('most recent hold, release or front may be missing');
    expect(b.auditsOf('operator-file-unreadable')).toEqual([expect.objectContaining({ used: 'previous-copy', held: [1] })]);
    expect(await b.svc.request(1, { explicit: true })).toEqual({ ok: false, code: 'held' });
    expect(await b.svc.request(2, { explicit: true })).toMatchObject({ ok: true }); // its hold was the write that is missing
    await b.svc.tick();
    expect(b.signals.filter((s) => s.key.startsWith('local-verify:operator-file-unreadable:'))).toHaveLength(1); // once
  });

  it('neither copy readable: the service continues with no holds and says so at once', async () => {
    const h = harness({ prs: [1] });
    await hold(h, 1);
    await hold(h, 2);
    fs.writeFileSync(h.operatorPath, 'garbage');
    fs.writeFileSync(`${h.operatorPath}.prev`, 'garbage too');
    const b = harness({ stateDir: h.stateDir, prs: [1] });
    await b.svc.boot();
    const sig = b.signals.filter((s) => s.key.startsWith('local-verify:operator-file-unreadable:'));
    expect(sig).toHaveLength(1);
    expect(String(sig[0].detail.note)).toContain('No change is held');
    expect(b.auditsOf('operator-file-unreadable')).toEqual([expect.objectContaining({ used: 'nothing' })]);
    expect(b.svc.snapshot().operator?.held).toEqual([]);
    expect(await b.svc.request(1, { explicit: true })).toMatchObject({ ok: true }); // starting on an unknown is chosen over stopping the line
  });

  it('switch off: a held change that was queued is put back through ordinary admission; on again: it is held again', async () => {
    const h = harness({ prs: [1, 2] });
    h.setHolders([9001]);
    await h.svc.request(1);
    await hold(h, 1);
    await hold(h, 2); // never asked for: nothing to put back
    h.advance(20 * MIN);
    h.setControls(false);
    await h.svc.tick();
    expect(h.queued()).toEqual([1]); // nothing stranded outside the queue, though no watcher offers it
    expect(h.svc.snapshot().queue[0]).toMatchObject({ firstQueuedAt: T0, pausedMs: 20 * MIN });
    expect(h.svc.snapshot()).not.toHaveProperty('operator');
    // The records are kept, not applied: a request is answered as before the controls existed.
    expect(h.operatorFile().records.map((r) => r.pr)).toEqual([1, 2]);
    expect(h.operatorFile().records[0].hold).not.toHaveProperty('entry');
    expect(await h.svc.request(1, { explicit: true })).toMatchObject({ ok: true, status: 'already-queued' });
    expect(await hold(h, 3)).toEqual({ ok: false, code: 'disabled' });
    expect(await release(h, 1)).toEqual({ ok: false, code: 'disabled' });
    expect(h.auditsOf('operator-readmitted-switch-off')).toEqual([expect.objectContaining({ pr: 1, placed: 'queue' })]);
    // On again: the queued entry of the held change moves back to held.
    h.setControls(true);
    await h.svc.tick();
    expect(h.queued()).toEqual([]);
    expect(h.operatorFile().records[0].hold).toMatchObject({ entry: { headSha: headOf(1), firstQueuedAt: T0 } });
    expect(h.svc.snapshot().operator?.held.map((x) => x.pr)).toEqual([1, 2]);
    await go(h);
    expect(h.spawned).toHaveLength(0);
  });

  it('switch off from the start: no effect at all, and the operator file is never written', async () => {
    const h = harness({ prs: [1], controls: false });
    expect(await hold(h, 1)).toEqual({ ok: false, code: 'disabled' });
    expect(await h.svc.operatorFront({ pr: 1, by: BY, reason: 'r' })).toEqual({ ok: false, code: 'disabled' });
    expect(h.svc.operatorUnfront({ pr: 1, by: BY })).toEqual({ ok: false, code: 'disabled' });
    expect(await h.svc.request(1)).toMatchObject({ ok: true, status: 'queued' });
    await h.svc.tick();
    expect(h.svc.operatorQueue()).toBeNull();
    expect(fs.existsSync(h.operatorPath)).toBe(false);
  });

  it('a lease loss with holds present: one notice listing each held and fronted change with its reason', async () => {
    const h = harness({ prs: [1, 2], peer: true });
    h.setHolders([9001]);
    await hold(h, 1, { reason: 'waiting on PR 120' });
    expect(await h.svc.operatorFront({ pr: 2, by: BY, reason: 'unblocks fourteen others' })).toMatchObject({ ok: true, status: 'admitted' });
    const moved = () => h.signals.filter((s) => s.key.startsWith('local-verify:operator-lease-moved:'));
    await h.svc.tick();
    expect(moved()).toEqual([]);
    h.setLease({ holds: false, holder: 'm5' });
    await h.svc.tick();
    expect(moved()).toEqual([]); // one odd read tells nobody
    await h.svc.tick();
    expect(moved()).toHaveLength(1);
    const note = String(moved()[0].detail.note);
    expect(note).toContain('PR #1 (waiting on PR 120; set by echo-increasing-throughput)');
    expect(note).toContain('PR #2 (unblocks fourteen others; set by echo-increasing-throughput)');
    expect(note).toContain('m5');
    for (let i = 0; i < 4; i++) await h.svc.tick();
    expect(moved()).toHaveLength(1); // one notice
    expect(h.auditsOf('operator-lease-lost')).toEqual([expect.objectContaining({ holder: 'm5', held: [1], fronted: [2], announcedTo: 'attention', why: 'no-operating-session-set' })]);
    // The lease comes back: the records from the earlier period are kept, and one audit row lists them.
    h.setLease({ holds: true, holder: 'm1' });
    await h.svc.tick();
    expect(h.auditsOf('operator-records-kept')).toEqual([expect.objectContaining({ held: [1], fronted: [2] })]);
    expect(h.svc.snapshot().operator?.held.map((x) => x.pr)).toEqual([1]);
    // A lease acquired after another machine held it (the reconcile loop reports that): one more row, the records kept.
    h.svc.onLeaseAcquired({ foreignHolder: true, epoch: 9 });
    expect(h.auditsOf('operator-records-kept')).toHaveLength(2);
    h.svc.onLeaseAcquired({ foreignHolder: false, epoch: 10 }); // this machine's own re-acquisition: nothing to say
    expect(h.auditsOf('operator-records-kept')).toHaveLength(2);
    expect(h.svc.snapshot().operator?.held.map((x) => x.pr)).toEqual([1]);
    // A machine that restarts without the lease and still holds records sends the notice then.
    const b = harness({ prs: [1, 2] });
    await hold(b, 1, { reason: 'left behind' });
    const c = harness({ stateDir: b.stateDir, prs: [1, 2], peer: true });
    c.setLease({ holds: false, holder: 'm5' });
    await c.svc.boot();
    await c.svc.tick();
    await c.svc.tick();
    expect(c.signals.filter((s) => s.key.startsWith('local-verify:operator-lease-moved:'))).toHaveLength(1);
  });
});

describe('the lease-loss notice goes to the session that operates the line', () => {
  /** A machine with one hold that then loses the lease (two readable reads). */
  async function loseLease(notifier: ((m: { subject: string; body: string }) => Promise<{ sent: boolean; phase?: string | null }>) | null) {
    const h = harness({ prs: [1], peer: true });
    if (notifier) h.svc.setOperatorNotifier(notifier);
    await hold(h, 1, { reason: 'waiting on PR 120' });
    h.setLease({ holds: false, holder: 'm5' });
    await h.svc.tick();
    await h.svc.tick();
    await h.settle();
    for (let i = 0; i < 3; i++) await h.svc.tick();
    await h.settle();
    return h;
  }
  const attention = (h: ReturnType<typeof harness>) => h.signals.filter((s) => s.key.startsWith('local-verify:operator-lease-moved:'));

  it('an operating session is set and the message is sent: one agent message listing the holds, no attention item', async () => {
    const sent: Array<{ subject: string; body: string }> = [];
    const h = await loseLease(async (m) => { sent.push(m); return { sent: true, phase: 'delivered' }; });
    expect(sent).toHaveLength(1); // once
    expect(sent[0].body).toContain('PR #1 (waiting on PR 120; set by echo-increasing-throughput)');
    expect(sent[0].body).toContain('m5');
    expect(attention(h)).toEqual([]);
    expect(h.auditsOf('operator-lease-lost')).toEqual([expect.objectContaining({ held: [1], announcedTo: 'operating-session', phase: 'delivered' })]);
  });

  it('queued for a session that is not running, no session set, or a failed send: the attention item is the fallback, once', async () => {
    // Only a delivered message counts: one that is merely queued may never be read.
    const queuedOnly = await loseLease(async () => ({ sent: false, phase: 'queued' }));
    expect(attention(queuedOnly)).toHaveLength(1);
    expect(queuedOnly.auditsOf('operator-lease-lost')).toEqual([expect.objectContaining({ announcedTo: 'attention', why: 'not-delivered', phase: 'queued' })]);
    const unset = await loseLease(async () => ({ sent: false, phase: 'no-session-set' }));
    expect(attention(unset)).toHaveLength(1);
    expect(String(attention(unset)[0].detail.note)).toContain('PR #1 (waiting on PR 120');
    expect(unset.auditsOf('operator-lease-lost')).toEqual([expect.objectContaining({ announcedTo: 'attention', why: 'not-delivered', phase: 'no-session-set' })]);
    const failing = await loseLease(async () => { throw new Error('session not found'); });
    expect(attention(failing)).toHaveLength(1);
    expect(failing.auditsOf('operator-lease-lost')).toEqual([expect.objectContaining({ announcedTo: 'attention', why: 'send-failed: session not found' })]);
  });

  it('the production sender: the session name is read live from the config, and only a delivered message counts as sent', async () => {
    const { wireLocalVerifyOperatorNotice } = await import('../../../src/localVerify/localVerifyWiring.js');
    const values: Record<string, unknown> = {};
    const calls: Array<{ session: string; subject: string; body: string }> = [];
    let phase: string | null = 'delivered';
    let notifier: ((m: { subject: string; body: string }) => Promise<{ sent: boolean; phase?: string | null }>) | null = null;
    wireLocalVerifyOperatorNotice({ setOperatorNotifier: (fn) => { notifier = fn; } }, {
      liveConfig: { get: <T,>(k: string, fb: T): T => (k in values ? (values[k] as T) : fb) },
      send: async (session, subject, body) => { calls.push({ session, subject, body }); return phase === null ? null : { phase }; },
    });
    const say = () => notifier!({ subject: 's', body: 'b' });
    expect(await say()).toEqual({ sent: false, phase: 'no-session-set' }); // absent: not set, nothing sent
    values['monitoring.localVerify.operatorSession'] = '   ';
    expect(await say()).toEqual({ sent: false, phase: 'no-session-set' });
    values['monitoring.localVerify.operatorSession'] = 42;
    expect(await say()).toEqual({ sent: false, phase: 'no-session-set' });
    expect(calls).toEqual([]);
    values['monitoring.localVerify.operatorSession'] = ' echo-increasing-throughput ';
    expect(await say()).toEqual({ sent: true, phase: 'delivered' });
    expect(calls).toEqual([{ session: 'echo-increasing-throughput', subject: 's', body: 'b' }]);
    // Every phase short of a completed delivery is not sent, and the phase is reported for the audit row.
    for (const notYet of ['queued', 'sent', 'received', 'created', 'undelivered', 'failed', 'dead-lettered', 'expired']) {
      phase = notYet;
      expect(await say(), notYet).toEqual({ sent: false, phase: notYet });
    }
    phase = null;
    expect(await say()).toEqual({ sent: false, phase: null });
    phase = 'read'; // past delivered
    expect(await say()).toEqual({ sent: true, phase: 'read' });
  });
});

describe('a stored time no calendar can hold never breaks the queue view', () => {
  it('a file on disk with at: 1e300 is left out at load; snapshot and the hourly check do not throw, across restarts', async () => {
    const h = harness({ prs: [1] });
    fs.writeFileSync(h.operatorPath, JSON.stringify({ v: 1, savedAt: T0, nextOrder: 2, overCap: [], records: [
      { pr: 1, hold: { by: BY, reason: 'bad time', at: 1e300 } },
      { pr: 2, hold: { by: BY, reason: 'bad until', at: T0, until: 1e300 } },
      { pr: 3, hold: { by: BY, reason: 'good', at: T0 } },
      { pr: 4, front: { order: 1, by: BY, reason: 'bad front time', at: 1e300 } },
    ] }));
    await h.svc.boot();
    expect(() => h.svc.snapshot()).not.toThrow();
    expect(h.svc.snapshot().operator).toMatchObject({ held: [{ pr: 3, reason: 'good' }], fronted: [] });
    expect(h.auditsOf('operator-file-invalid-record').map((a) => [a.pr, a.what])).toEqual([[1, 'hold-dropped'], [2, 'hold-dropped'], [4, 'front-dropped']]);
    // A lost hold is never audit-only: one attention item names the changes that are no longer held.
    const told = h.signals.filter((s) => s.key.startsWith('local-verify:operator-file-unreadable:'));
    expect(told).toHaveLength(1);
    expect(String(told[0].detail.note)).toContain('A hold or front mark was lost for: PR #1, PR #2, PR #4');
    expect(h.auditsOf('operator-file-unreadable')).toEqual([expect.objectContaining({ used: 'file-in-part', lost: [1, 2, 4], savedLost: [] })]);
    h.advance(25 * HOUR);
    await h.svc.tick(); // the reminder builds dates too
    expect(dueSignals(h)).toHaveLength(1);
    expect(await h.svc.request(1, { explicit: true })).toMatchObject({ ok: true }); // the invalid hold is not in force
    const b = harness({ stateDir: h.stateDir, prs: [1] });
    await b.svc.boot();
    expect(() => b.svc.snapshot()).not.toThrow();
    expect(b.svc.snapshot().operator?.held.map((x) => x.pr)).toEqual([3]);
    expect(b.signals.filter((s) => s.key.startsWith('local-verify:operator-file-unreadable:'))).toEqual([]); // told once, not at every start
  });

  it('a hold whose saved entry is malformed stays in force without it, is told once, and a release goes by the wanted mark', async () => {
    const h = harness({ prs: [1, 2, 3, 4, 5] });
    const entry = { headSha: headOf(1), baseSha: sha('b'), baseRefName: 'main', firstQueuedAt: T0 - HOUR, attempts: 0, errorRetries: 0, starvedRaised: false };
    const bad = [{ baseRefName: '--upload-pack=x' }, { attempts: -5.5 }, { pausedMs: 'abc' }, { firstRefusedAt: 'zzz' }];
    fs.writeFileSync(h.operatorPath, JSON.stringify({ v: 1, savedAt: T0, nextOrder: 1, overCap: [], records: [
      ...bad.map((over, i) => ({ pr: i + 1, hold: { by: BY, reason: `probe ${i + 1}`, at: T0, ...(i === 0 ? { wanted: 'explicit' } : {}), entry: { ...entry, headSha: headOf(i + 1), ...over } } })),
      { pr: 5, hold: { by: BY, reason: 'good', at: T0, entry: { ...entry, headSha: headOf(5), baseRefName: 'release+1' } } },
    ] }));
    await h.svc.boot();
    // All five are still held; the four probes lost their saved entry, the valid one (an unusual but valid branch name) kept it.
    expect(h.svc.snapshot().operator?.held.map((x) => [x.pr, x.savedEntry])).toEqual([[1, false], [2, false], [3, false], [4, false], [5, true]]);
    for (const pr of [1, 2, 4]) expect(await h.svc.request(pr, { explicit: false })).toEqual({ ok: false, code: 'held' }); // PR 3 is never asked for
    expect(h.queued()).toEqual([]); // no malformed entry reached the queue
    expect(h.auditsOf('operator-file-invalid-record').map((a) => [a.pr, a.what])).toEqual([[1, 'saved-entry-dropped'], [2, 'saved-entry-dropped'], [3, 'saved-entry-dropped'], [4, 'saved-entry-dropped']]);
    const told = h.signals.filter((s) => s.key.startsWith('local-verify:operator-file-unreadable:'));
    expect(told).toHaveLength(1);
    expect(String(told[0].detail.note)).toContain('Still held, but what the hold had saved');
    expect(String(told[0].detail.note)).toContain('PR #1, PR #2, PR #3, PR #4');
    expect(String(told[0].detail.note)).not.toContain('PR #5');
    expect(h.auditsOf('operator-file-unreadable')).toEqual([expect.objectContaining({ used: 'file-in-part', lost: [], savedLost: [1, 2, 3, 4] })]);
    // Release goes by the wanted mark: PR 1 was asked for while held and is admitted at its real head; PR 3 was not, so nothing is requested.
    h.setHolders([9001]);
    expect(await release(h, 3)).toEqual({ ok: true, pr: 3, released: true, placed: 'none' });
    expect(await release(h, 1)).toMatchObject({ released: true, placed: 'queue' });
    expect(h.svc.snapshot().queue.map((e) => [e.pr, e.baseRefName])).toEqual([[1, 'main']]);
  });
});

describe('the boot row: why a restart happened', () => {
  it('carries the reason of the restart request consumed just before it, once; unknown otherwise', async () => {
    const h = harness({});
    await h.svc.boot();
    expect(h.auditsOf('boot')).toEqual([expect.objectContaining({ reason: 'unknown' })]);
    // A restart asked for with a reason (the consumers append every consumed request to this log).
    const at = new Date(h.now() + 4 * MIN).toISOString();
    fs.appendFileSync(path.join(h.stateDir, 'logs', 'restart-requests.jsonl'), JSON.stringify({
      at, consumer: 'supervisor', requestedBy: 'echo-increasing-throughput', attributed: true, reason: 'reorder: put PR 3489 first', targetVersion: null, requestedAt: at, writerPid: null,
    }) + '\n');
    const b = harness({ stateDir: h.stateDir });
    b.advance(5 * MIN);
    await b.svc.boot();
    expect(b.auditsOf('boot').at(-1)).toMatchObject({ reason: 'reorder: put PR 3489 first', requestedBy: 'echo-increasing-throughput', restartAt: at });
    // The server dies and comes back by itself: the same request does not explain this start.
    const c = harness({ stateDir: h.stateDir });
    c.advance(7 * MIN);
    await c.svc.boot();
    expect(c.auditsOf('boot').at(-1)).toEqual(expect.objectContaining({ reason: 'unknown' }));
    expect(c.auditsOf('boot').at(-1)).not.toHaveProperty('restartAt');
    expect(c.auditsOf('boot')).toHaveLength(3);
  });
});
