/**
 * Tier-1 tests for the four queue-control routes (spec docs/specs/local-verify-queue-controls.md,
 * "Who may use them, and the record"): strict bodies, `by` on all four and `reason` on hold and
 * front, the 404 with the switch off, the 409 without the lease, `blockMerge` calling the
 * merge-side hold and the answer naming which of the two holds applied. The router is the real
 * one over a real LocalVerifyService; the child process, gh and the clock are fakes.
 */

import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { parseQueueControlBody, registerLocalVerifyRoutes, statusForQueueControlRefusal, statusForResult } from '../../../src/localVerify/localVerifyRoutes.js';
import { cleanupHarnessDirs, fillQueue, harness, T0 } from '../../helpers/operatorQueueHarness.js';

afterEach(() => cleanupHarnessDirs());

const BY = 'echo-increasing-throughput';
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

function app(o: Parameters<typeof harness>[0] & { holdsLease?: boolean; mergeHold?: ((pr: number, reason: string) => Promise<{ ok: boolean; detail?: string }>) | null } = {}) {
  const h = harness(o);
  const mergeCalls: Array<{ pr: number; reason: string }> = [];
  const a = express();
  a.use(express.json());
  const router = express.Router();
  registerLocalVerifyRoutes(router, {
    service: () => h.svc,
    lease: { holdsLease: () => o.holdsLease ?? true, holderMachineId: () => 'm_studio' },
    ...(o.mergeHold === null ? {} : {
      applyMergeHold: async (pr: number, reason: string) => { mergeCalls.push({ pr, reason }); return (o.mergeHold ?? (async () => ({ ok: true })))(pr, reason); },
    }),
  });
  a.use(router);
  const post = (route: string, body: unknown) => request(a).post(`/local-verify/queue/${route}`).send(body as object);
  return { a, h, post, mergeCalls };
}

describe('parseQueueControlBody', () => {
  it('hold: pr, by and reason required; until a date; blockMerge a boolean; nothing else', () => {
    expect(parseQueueControlBody({ pr: 7, by: BY, reason: 'waiting on 120' }, 'hold')).toEqual({ ok: true, pr: 7, by: BY, reason: 'waiting on 120' });
    expect(parseQueueControlBody({ pr: 7, by: BY, reason: 'r', until: '2026-12-01T18:00:00Z', blockMerge: true }, 'hold'))
      .toEqual({ ok: true, pr: 7, by: BY, reason: 'r', until: Date.parse('2026-12-01T18:00:00Z'), blockMerge: true });
    expect(parseQueueControlBody({ pr: 7, by: BY, reason: 'r', blockMerge: false }, 'hold')).toEqual({ ok: true, pr: 7, by: BY, reason: 'r' });
    for (const bad of [
      null, [], 'x', {},
      { pr: 7, reason: 'r' }, // no by
      { pr: 7, by: '', reason: 'r' },
      { pr: 7, by: BY }, // no reason
      { pr: 7, by: BY, reason: '   ' },
      { pr: 7, by: BY, reason: 'x'.repeat(501) }, // refused, never cut
      { pr: 7, by: 'b'.repeat(101), reason: 'r' },
      { pr: '7', by: BY, reason: 'r' },
      { pr: 0, by: BY, reason: 'r' },
      { pr: 7.5, by: BY, reason: 'r' },
      { pr: 7, by: BY, reason: 'r', until: 'next week' },
      { pr: 7, by: BY, reason: 'r', until: 1e300 }, // a date outside what a Date can hold
      { pr: 7, by: BY, reason: 'r', until: -1 },
      { pr: 7, by: BY, reason: 'r', blockMerge: 'yes' },
      { pr: 7, by: BY, reason: 'r', force: true }, // unknown field
    ]) expect(parseQueueControlBody(bad, 'hold'), JSON.stringify(bad)?.slice(0, 80)).toMatchObject({ ok: false });
    expect(parseQueueControlBody({ pr: 7, by: BY, reason: 'x'.repeat(500) }, 'hold')).toMatchObject({ ok: true });
  });

  it('front: pr, by and reason; release and unfront: pr and by only', () => {
    expect(parseQueueControlBody({ pr: 7, by: BY, reason: 'unblocks 14' }, 'front')).toEqual({ ok: true, pr: 7, by: BY, reason: 'unblocks 14' });
    expect(parseQueueControlBody({ pr: 7, by: BY }, 'front')).toMatchObject({ ok: false });
    expect(parseQueueControlBody({ pr: 7, by: BY, reason: 'r', until: '2026-12-01' }, 'front')).toMatchObject({ ok: false });
    for (const kind of ['release', 'unfront'] as const) {
      expect(parseQueueControlBody({ pr: 7, by: BY }, kind)).toEqual({ ok: true, pr: 7, by: BY });
      expect(parseQueueControlBody({ pr: 7 }, kind)).toMatchObject({ ok: false });
      expect(parseQueueControlBody({ pr: 7, by: BY, reason: 'r' }, kind)).toMatchObject({ ok: false });
    }
  });

  it('maps each refusal to its status', () => {
    expect(statusForQueueControlRefusal('disabled')).toBe(404);
    expect(statusForQueueControlRefusal('not-held')).toBe(409);
    expect(statusForQueueControlRefusal('not-fronted')).toBe(409);
    expect(statusForQueueControlRefusal('front-limit')).toBe(409);
    expect(statusForQueueControlRefusal('overflow-full')).toBe(429);
    expect(statusForQueueControlRefusal('operator-file-full')).toBe(429);
    expect(statusForQueueControlRefusal('pr-closed')).toBe(409);
    expect(statusForQueueControlRefusal('pr-unreadable')).toBe(502);
    expect(statusForQueueControlRefusal('untrusted-head')).toBe(403);
    expect(statusForQueueControlRefusal('stopping')).toBe(503);
    expect(statusForQueueControlRefusal('state-unwritable')).toBe(500);
    expect(statusForQueueControlRefusal('invalid-time')).toBe(400);
    // POST /local-verify for a held change, and an operator admission that found everything full.
    expect(statusForResult({ ok: false, code: 'held' })).toBe(409);
    expect(statusForResult({ ok: false, code: 'overflow-full' })).toBe(429);
  });
});

describe('the four routes', () => {
  it('hold, front, unfront and release answer 200 with the switch on, and GET /local-verify lists held and fronted changes', async () => {
    const { a, h, post } = app({ prs: [1, 2, 3] });
    h.setHolders([9001]);
    for (const pr of [1, 2, 3]) await h.svc.request(pr);
    const held = await post('hold', { pr: 1, by: BY, reason: 'waiting on PR 120', until: '2026-11-19T18:00:00Z' });
    expect(held.status).toBe(200);
    expect(held.body).toEqual({ ok: true, pr: 1, held: true, alreadyHeld: false, running: false, removed: 'queue', queueHold: true, mergeHold: 'not-requested' });
    const fr = await post('front', { pr: 3, by: BY, reason: 'unblocks fourteen others' });
    expect(fr.status).toBe(200);
    expect(fr.body).toMatchObject({ ok: true, pr: 3, status: 'fronted', order: 1 });
    const view = await request(a).get('/local-verify');
    expect(view.status).toBe(200);
    expect(view.body.operator).toMatchObject({
      enabled: true,
      held: [{ pr: 1, reason: 'waiting on PR 120', by: BY, at: new Date(T0).toISOString(), until: '2026-11-19T18:00:00.000Z', wanted: true, savedEntry: true }],
      fronted: [{ pr: 3, reason: 'unblocks fourteen others', by: BY, order: 1, queued: true, held: false }],
      overflow: { used: 0, max: 5 },
    });
    expect(view.body.queue.map((e: { pr: number }) => e.pr)).toEqual([2, 3]);
    const un = await post('unfront', { pr: 3, by: BY });
    expect(un.status).toBe(200);
    expect(un.body).toEqual({ ok: true, pr: 3, unfronted: true });
    const rel = await post('release', { pr: 1, by: BY });
    expect(rel.status).toBe(200);
    expect(rel.body).toMatchObject({ ok: true, pr: 1, released: true, placed: 'queue', mergeHold: 'not-removed' }); // a release never removes the merge-side marker
    expect((await request(a).get('/local-verify')).body.operator).toMatchObject({ held: [], fronted: [] });
    // Every hold and every front has an audit row saying who and why.
    expect(h.auditsOf('operator-hold')).toEqual([expect.objectContaining({ pr: 1, by: BY, reason: 'waiting on PR 120' })]);
    expect(h.auditsOf('operator-front')).toEqual([expect.objectContaining({ pr: 3, by: BY, reason: 'unblocks fourteen others' })]);
    expect(h.auditsOf('operator-unfront')).toEqual([expect.objectContaining({ pr: 3, by: BY })]);
    expect(h.auditsOf('operator-release')).toEqual([expect.objectContaining({ pr: 1, by: BY })]);
  });

  it('a bad body answers 400 and changes nothing', async () => {
    const { h, post } = app({ prs: [1] });
    for (const [route, body] of [
      ['hold', { pr: 1, reason: 'no by' }], ['hold', { pr: 1, by: BY }], ['hold', { pr: 1, by: BY, reason: 'r', extra: 1 }],
      ['front', { pr: 1, by: BY }], ['release', { pr: 1 }], ['unfront', { pr: 'one', by: BY }],
    ] as const) {
      const r = await post(route, body);
      expect(r.status, `${route} ${JSON.stringify(body)}`).toBe(400);
      expect(typeof r.body.error).toBe('string');
    }
    expect(h.svc.snapshot().operator).toMatchObject({ held: [], fronted: [] });
    expect(h.audits().filter((x) => x.event.startsWith('operator-'))).toEqual([]);
  });

  it('a date outside the calendar is refused with 400 before anything is stored, and the queue view keeps working', async () => {
    const { a, h, post } = app({ prs: [1] });
    const r = await post('hold', { pr: 1, by: BY, reason: 'r', until: 1e300 });
    expect(r.status).toBe(400);
    expect(typeof r.body.error).toBe('string');
    expect(h.audits().filter((x) => x.event.startsWith('operator-'))).toEqual([]);
    expect((await request(a).get('/local-verify')).status).toBe(200);
    // The service refuses it too when called directly, with nothing stored.
    expect(await h.svc.operatorHold({ pr: 1, by: BY, reason: 'r', until: 1e300 })).toEqual({ ok: false, code: 'invalid-time' });
    expect(h.svc.snapshot().operator).toMatchObject({ held: [] });
    // A front answers its place among the fronted changes: 1 = the next change to start.
    h.setHolders([9001]);
    await h.svc.request(1);
    expect((await post('front', { pr: 1, by: BY, reason: 'r' })).body).toMatchObject({ status: 'fronted', rank: 1 });
  });

  it('refusals carry their code: not-held, not-fronted, front-limit naming the three, overflow-full, a closed change', async () => {
    const { h, post } = app({ prs: [...range(1, 10), ...range(21, 27)] });
    expect((await post('release', { pr: 1, by: BY })).status).toBe(409);
    expect((await post('release', { pr: 1, by: BY })).body).toEqual({ ok: false, code: 'not-held' });
    expect((await post('unfront', { pr: 1, by: BY })).body).toEqual({ ok: false, code: 'not-fronted' });
    await fillQueue(h, 1);
    for (const pr of [21, 22, 23]) expect((await post('front', { pr, by: BY, reason: `r${pr}` })).body).toMatchObject({ ok: true, status: 'admitted', overCap: true });
    const fourth = await post('front', { pr: 24, by: BY, reason: 'one too many' });
    expect(fourth.status).toBe(409);
    expect(fourth.body.code).toBe('front-limit');
    expect(fourth.body.fronted.map((f: { pr: number }) => f.pr)).toEqual([23, 22, 21]);
    // Use up the shared overflow of 5, then a front of a change outside the full queue answers overflow-full.
    await post('unfront', { pr: 21, by: BY });
    await post('unfront', { pr: 22, by: BY });
    for (const pr of [24, 25]) expect((await post('front', { pr, by: BY, reason: 'r' })).status).toBe(200);
    await post('unfront', { pr: 24, by: BY });
    const full = await post('front', { pr: 26, by: BY, reason: 'r' });
    expect(full.status).toBe(429);
    expect(full.body).toEqual({ ok: false, code: 'overflow-full' });
    h.open[27] = false;
    await post('unfront', { pr: 23, by: BY });
    const closed = await post('front', { pr: 27, by: BY, reason: 'r' });
    expect(closed.status).toBe(409);
    expect(closed.body).toEqual({ ok: false, code: 'pr-closed' });
  });

  it('the switch off: every route answers 404, nothing is recorded, and GET /local-verify has no operator block', async () => {
    const { a, h, post } = app({ prs: [1], controls: false });
    for (const [route, body] of [
      ['hold', { pr: 1, by: BY, reason: 'r' }], ['release', { pr: 1, by: BY }], ['front', { pr: 1, by: BY, reason: 'r' }], ['unfront', { pr: 1, by: BY }],
    ] as const) {
      const r = await post(route, body);
      expect(r.status, route).toBe(404);
      expect(r.body.error).toBe('queue-controls-off');
    }
    expect((await request(a).get('/local-verify')).body).not.toHaveProperty('operator');
    expect(h.audits().filter((x) => x.event.startsWith('operator-'))).toEqual([]);
    // Turned on live, with no restart: the same route answers.
    h.setControls(true);
    expect((await post('hold', { pr: 1, by: BY, reason: 'r' })).status).toBe(200);
  });

  it('a machine without the lease answers 409 naming the holder, and holds nothing', async () => {
    const { h, post } = app({ prs: [1], holdsLease: false });
    for (const [route, body] of [
      ['hold', { pr: 1, by: BY, reason: 'r' }], ['release', { pr: 1, by: BY }], ['front', { pr: 1, by: BY, reason: 'r' }], ['unfront', { pr: 1, by: BY }],
    ] as const) {
      const r = await post(route, body);
      expect(r.status, route).toBe(409);
      expect(r.body).toEqual({ error: 'not-lease-holder', holderMachineId: 'm_studio' });
    }
    expect(h.svc.snapshot().operator).toMatchObject({ held: [], fronted: [] });
  });
});

describe('hold with blockMerge: do not test and do not merge', () => {
  it('applies the merge-side hold through the injected function, with the reason cleaned the way that route cleans it', async () => {
    const { post, mergeCalls } = app({ prs: [1] });
    const r = await post('hold', { pr: 1, by: BY, reason: 'known wrong] see\nPR 120', blockMerge: true });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, held: true, queueHold: true, mergeHold: 'applied' });
    expect(mergeCalls).toEqual([{ pr: 1, reason: 'known wrong  see PR 120' }]);
  });

  it('without blockMerge the merge-side hold is not touched', async () => {
    const { post, mergeCalls } = app({ prs: [1] });
    expect((await post('hold', { pr: 1, by: BY, reason: 'r' })).body).toMatchObject({ queueHold: true, mergeHold: 'not-requested' });
    expect((await post('hold', { pr: 1, by: BY, reason: 'r', blockMerge: false })).body).toMatchObject({ mergeHold: 'not-requested' });
    expect(mergeCalls).toEqual([]);
  });

  it('GitHub refuses: the queue hold still applies and the answer says the merge-side hold failed', async () => {
    const { h, post } = app({ prs: [1], mergeHold: async () => ({ ok: false, detail: 'gh failed to apply the hold marker' }) });
    const r = await post('hold', { pr: 1, by: BY, reason: 'r', blockMerge: true });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, held: true, queueHold: true, mergeHold: 'failed', mergeHoldDetail: 'gh failed to apply the hold marker' });
    expect(h.svc.snapshot().operator?.held.map((x) => x.pr)).toEqual([1]);
    // A function that throws is a failed merge-side hold too, never a failed request.
    const t = app({ prs: [1], mergeHold: async () => { throw new Error('network down'); } });
    expect((await t.post('hold', { pr: 1, by: BY, reason: 'r', blockMerge: true })).body).toMatchObject({ queueHold: true, mergeHold: 'failed', mergeHoldDetail: 'network down' });
  });

  it('no merge watcher on this machine: the answer says the merge-side hold is unavailable', async () => {
    const { post } = app({ prs: [1], mergeHold: null });
    expect((await post('hold', { pr: 1, by: BY, reason: 'r', blockMerge: true })).body).toMatchObject({ ok: true, queueHold: true, mergeHold: 'unavailable' });
  });
});
