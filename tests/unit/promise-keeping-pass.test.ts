/**
 * Tier 1 — the stateful promise-keeping pass
 * (docs/specs/promise-keeping-before-the-deadline.md §3.1, §3.3–§3.7).
 *
 * What can go wrong once real state is involved: the person messaged on a
 * pickup, a start awaited by the pass, a held start counted as a failure, a
 * superseded result stamped onto a new time, a flood of starts or messages, a
 * finished session never released (or the wrong one released).
 */
import { describe, it, expect, vi } from 'vitest';
import type { Commitment } from '../../src/monitoring/CommitmentTracker.js';
import { PromiseKeepingPass, emptyPromiseKeepingReport, type PickupOutcome, type PickupRequest } from '../../src/monitoring/promiseKeepingPass.js';

const SELF = 'm_self';
const H = 60 * 60_000;
const NOW = Date.parse('2026-11-18T20:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();
const T = NOW - 10 * 60_000;

function row(id: string, over: Partial<Commitment> = {}): Commitment {
  return {
    id, userRequest: `request ${id}`, agentResponse: `promise ${id}`, status: 'pending', topicId: 100,
    owner: 'agent', blockedOn: 'none', ownerMachineId: SELF, originMachineId: SELF, type: 'one-time-action',
    createdAt: iso(T - 2 * H), softDeadlineAt: iso(T), ...over,
  } as Commitment;
}

function tracker(initial: Commitment[]) {
  const rows = new Map(initial.map((r) => [r.id, { ...r }]));
  return {
    getAll: () => [...rows.values()],
    mutate: vi.fn(async (id: string, fn: (r: Commitment) => Commitment) => {
      const cur = rows.get(id);
      if (!cur) throw new Error(`no ${id}`);
      const next = fn({ ...cur });
      rows.set(id, next);
      return next;
    }),
    rows,
  };
}

function make(initial: Commitment[], over: {
  pickUp?: (req: PickupRequest) => Promise<PickupOutcome>;
  send?: ReturnType<typeof vi.fn>;
  working?: number;
  maxSessions?: number;
  findAttemptSession?: (id: string) => { session: string } | null;
  hasLiveSession?: (t: number) => boolean;
  listPromiseWorkSessions?: () => Array<{ tmuxSession: string; commitmentIds: string[]; idleSince?: string }>;
  releaseIfAllowed?: (t: string) => boolean;
} = {}) {
  const tr = tracker(initial);
  const send = over.send ?? vi.fn(async () => undefined);
  const pass = new PromiseKeepingPass(
    {
      tracker: tr as never,
      ...(over.pickUp ? { pickUp: over.pickUp } : {}),
      ...(over.findAttemptSession ? { findAttemptSession: over.findAttemptSession } : {}),
      workingPromiseSessions: () => over.working ?? 0,
      maxSessions: over.maxSessions ?? 10,
      sendLastResort: send as never,
      timeZone: 'UTC',
      log: () => {},
      ...(over.hasLiveSession ? { hasLiveSession: over.hasLiveSession } : {}),
      ...(over.listPromiseWorkSessions ? { listPromiseWorkSessions: over.listPromiseWorkSessions } : {}),
      ...(over.releaseIfAllowed ? { releaseIfAllowed: over.releaseIfAllowed } : {}),
    },
    { selfMachineId: SELF, epochMs: NOW - H },
  );
  const run = async (now = NOW) => { const rep = emptyPromiseKeepingReport(); await pass.run(now, rep); return rep; };
  return { tr, send, run };
}

describe('pickup, never a message', () => {
  it('a running session is notified; the person gets nothing; the row is stamped picked up', async () => {
    const pickUp = vi.fn(async () => ({ kind: 'notified' as const }));
    const { tr, send, run } = make([row('CMT-1')], { pickUp });
    const rep = await run();
    expect(send).not.toHaveBeenCalled();
    expect(pickUp).toHaveBeenCalledTimes(1);
    expect(pickUp.mock.calls[0][0].bootstrap).toContain('stage overdue');
    const r = tr.rows.get('CMT-1')!;
    expect(r.pickupFor).toBe(iso(T));
    expect(r.pickups).toBe(1);
    expect(r.lateNoticeFor).toBeUndefined();
    expect(r.pendingAttempt).toBeUndefined();
    expect(rep.pickedUp).toBe(1);
  });

  it('a launched start is not awaited: the attempt stays pending until it settles, then is stamped', async () => {
    let settle!: (o: Exclude<PickupOutcome, { kind: 'pending' }>) => void;
    const pickUp = vi.fn(async (req: PickupRequest) => { settle = req.onSettled; return { kind: 'pending' as const }; });
    const { tr, run } = make([row('CMT-1')], { pickUp });
    const rep = await run();
    expect(rep.pending).toBe(1);
    expect(tr.rows.get('CMT-1')!.pendingAttempt?.gen).toBe(iso(T));
    settle({ kind: 'started', session: 'echo-topic-100' });
    await vi.waitFor(() => expect(tr.rows.get('CMT-1')!.pickups).toBe(1));
    expect(tr.rows.get('CMT-1')!.pendingAttempt).toBeUndefined();
  });

  it('a late result for a superseded time is a no-op on the row (generation check)', async () => {
    let settle!: (o: Exclude<PickupOutcome, { kind: 'pending' }>) => void;
    const pickUp = vi.fn(async (req: PickupRequest) => { settle = req.onSettled; return { kind: 'pending' as const }; });
    const { tr, run } = make([row('CMT-1')], { pickUp });
    await run();
    await tr.mutate('CMT-1', (r) => ({ ...r, softDeadlineAt: iso(NOW + 5 * H) }));
    settle({ kind: 'started', session: 's' });
    await vi.waitFor(() => expect(tr.rows.get('CMT-1')!.pendingAttempt).toBeUndefined());
    expect(tr.rows.get('CMT-1')!.pickups).toBeUndefined();
  });

  it('held is recorded by reason and never counted as failed', async () => {
    const pickUp = vi.fn(async () => ({ kind: 'held' as const, reason: 'capacity' as const }));
    const { tr, run } = make([row('CMT-1')], { pickUp });
    await run();
    await run(NOW + 5 * 60_000);
    const r = tr.rows.get('CMT-1')!;
    expect(r.heldCounts).toEqual({ capacity: 2 });
    expect(r.failedAttempts ?? 0).toBe(0);
  });

  it('several missed promises in one conversation go to the session as ONE notice', async () => {
    const pickUp = vi.fn(async () => ({ kind: 'notified' as const }));
    const { run } = make([row('CMT-1'), row('CMT-2', { softDeadlineAt: iso(T - 60_000) })], { pickUp });
    await run();
    expect(pickUp).toHaveBeenCalledTimes(1);
    expect(pickUp.mock.calls[0][0].bootstrap).toContain('CMT-1');
    expect(pickUp.mock.calls[0][0].bootstrap).toContain('CMT-2');
  });
});

describe('start budget (§3.6)', () => {
  it('mayStart turns false after 3 starts in a pass', async () => {
    const rows = Array.from({ length: 6 }, (_, i) => row(`CMT-${i}`, { topicId: 200 + i }));
    const seen: boolean[] = [];
    const pickUp = vi.fn(async (req: PickupRequest) => { seen.push(req.mayStart); return req.mayStart ? { kind: 'pending' as const } : { kind: 'held' as const, reason: 'promise-limit' as const }; });
    const { run } = make(rows, { pickUp });
    await run();
    expect(seen.filter(Boolean)).toHaveLength(3);
  });
  it('working sessions plus pending starts at a third of maxSessions → no more starts', async () => {
    const seen: boolean[] = [];
    const pickUp = vi.fn(async (req: PickupRequest) => { seen.push(req.mayStart); return { kind: 'held' as const, reason: 'promise-limit' as const }; });
    const { run } = make([row('CMT-1')], { pickUp, working: 3, maxSessions: 10 });
    await run();
    expect(seen).toEqual([false]);
  });
});

describe('crash safety (§3.1)', () => {
  it('a timed-out start keeps its slot for the hold window (no pile-up of starts)', async () => {
    const seen: boolean[] = [];
    const pickUp = vi.fn(async (req: PickupRequest) => { seen.push(req.mayStart); return { kind: 'held' as const, reason: 'promise-limit' as const }; });
    const hung = Array.from({ length: 3 }, (_, i) => row(`HUNG-${i}`, { topicId: 500 + i, pendingAttempt: { id: `p${i}`, stage: 'overdue', gen: iso(T), at: iso(NOW - 20 * 60_000), timedOutAt: iso(NOW - 10 * 60_000) } }));
    const { run } = make([...hung, row('CMT-NEW', { topicId: 600 })], { pickUp, maxSessions: 10 });
    await run();
    expect(seen.every((m) => m === false)).toBe(true);
  });
  it('a failed pre-deadline check does not count toward the overdue ladder', async () => {
    const pickUp = vi.fn(async () => ({ kind: 'failed' as const, error: 'x' }));
    const { tr, run } = make([row('CMT-1', { createdAt: iso(NOW - 2 * H), softDeadlineAt: iso(NOW + 2 * H) })], { pickUp });
    await run();
    await run(NOW + 5 * 60_000);
    expect(tr.rows.get('CMT-1')!.failedAttempts ?? 0).toBe(0);
  });
  it('a pending attempt older than the timeout reconciles to started when the registry has its session', async () => {
    const { tr, run } = make([row('CMT-1', { pendingAttempt: { id: 'pk-a', stage: 'overdue', gen: iso(T), at: iso(NOW - 10 * 60_000) } })], {
      pickUp: vi.fn(async () => ({ kind: 'notified' as const })),
      findAttemptSession: (id) => (id === 'pk-a' ? { session: 'echo-topic-100' } : null),
    });
    const rep = await run();
    expect(rep.reconciledPending).toBe(1);
    expect(tr.rows.get('CMT-1')!.pickups).toBe(1);
  });
  it('none in the registry → failed for the ladder, slot stays reserved (timedOutAt), no double start', async () => {
    const pickUp = vi.fn(async () => ({ kind: 'notified' as const }));
    const { tr, run } = make([row('CMT-1', { pendingAttempt: { id: 'pk-a', stage: 'overdue', gen: iso(T), at: iso(NOW - 10 * 60_000) } })], {
      pickUp, findAttemptSession: () => null,
    });
    await run();
    const r = tr.rows.get('CMT-1')!;
    expect(r.failedAttempts).toBe(1);
  });
});

describe('last resort (§3.5)', () => {
  it('two pickups with no movement → one fixed message, stamped, then backoff', async () => {
    const pickUp = vi.fn(async () => ({ kind: 'notified' as const }));
    const send = vi.fn(async () => undefined);
    const { tr, run } = make([row('CMT-1', { pickupFor: iso(T), pickups: 2, pickedUpAt: iso(NOW - 3 * H) })], { pickUp, send });
    const rep = await run();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][1]).toContain("I picked this up twice and it still isn't done.");
    expect(send.mock.calls[0][1]).not.toMatch(/reply|let me know/i);
    const r = tr.rows.get('CMT-1')!;
    expect(r.lateNoticeFor).toBe(iso(T));
    expect(r.backoffStep).toBe(1);
    expect(Date.parse(r.nextAttemptAt!)).toBeGreaterThan(NOW);
    expect(rep.lastResortByVariant['not-moving']).toBe(1);
    // A later pass never sends a second message for the same time.
    await run(NOW + 30 * 24 * H);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('a held (quiet) send is a failure: nothing stamped as told', async () => {
    const send = vi.fn(async () => { throw new Error('held-not-delivered'); });
    const { tr, run } = make([row('CMT-1', { pickupFor: iso(T), pickups: 2, pickedUpAt: iso(NOW - 3 * H) })], { pickUp: vi.fn(async () => ({ kind: 'notified' as const })), send });
    await run();
    expect(tr.rows.get('CMT-1')!.lateNoticeFor).toBeUndefined();
    expect(tr.rows.get('CMT-1')!.lateAttempts).toBe(1);
  });

  it('burst: 50 conversations reach the last resort together → at most 3 messages this pass', async () => {
    const rows = Array.from({ length: 50 }, (_, i) => row(`CMT-${i}`, { topicId: 300 + i, pickupFor: iso(T), pickups: 2, pickedUpAt: iso(NOW - 3 * H) }));
    const send = vi.fn(async () => undefined);
    const { run } = make(rows, { pickUp: vi.fn(async () => ({ kind: 'notified' as const })), send });
    const rep = await run();
    expect(send).toHaveBeenCalledTimes(3);
    expect(rep.lastResortHeldByCap).toBe(47);
  });

  it('after 7 days parked the row is handed to the review once', async () => {
    const { tr, run } = make([row('CMT-1', { lateNoticeFor: iso(T), parkedAt: iso(NOW - 8 * 24 * H), nextAttemptAt: iso(NOW + H) })]);
    const rep = await run();
    expect(rep.parkedHandedToReview).toBe(1);
    expect(tr.rows.get('CMT-1')!.parkReviewHandedAt).toBe(iso(NOW));
    expect((await run()).parkedHandedToReview).toBe(0);
  });
});

describe('pre-deadline checks', () => {
  it('a midpoint check notifies and stamps; it is not repeated', async () => {
    const pickUp = vi.fn(async () => ({ kind: 'notified' as const }));
    const { tr, run } = make([row('CMT-1', { createdAt: iso(NOW - 2 * H), softDeadlineAt: iso(NOW + 2 * H) })], { pickUp });
    await run();
    expect(pickUp.mock.calls[0][0].bootstrap).toContain('stage midpoint');
    expect(tr.rows.get('CMT-1')!.midpointCheckFor).toBe(iso(NOW + 2 * H));
    await run(NOW + 10 * 60_000);
    expect(pickUp).toHaveBeenCalledTimes(1);
  });
  it('a held check is retried on the next pass', async () => {
    const pickUp = vi.fn(async () => ({ kind: 'held' as const, reason: 'capacity' as const }));
    const { tr, run } = make([row('CMT-1', { createdAt: iso(NOW - 2 * H), softDeadlineAt: iso(NOW + 2 * H) })], { pickUp });
    await run();
    await run(NOW + 5 * 60_000);
    expect(pickUp).toHaveBeenCalledTimes(2);
    expect(tr.rows.get('CMT-1')!.midpointCheckFor).toBeUndefined();
  });
});

describe('no-time lane (§3.7)', () => {
  it('asks a running session only, never starts, at most twice per promise', async () => {
    const pickUp = vi.fn(async (req: PickupRequest) => { expect(req.mayStart).toBe(false); return { kind: 'notified' as const }; });
    const { tr, run } = make([row('CMT-1', { softDeadlineAt: undefined })], { pickUp, hasLiveSession: () => true });
    await run();
    expect(pickUp.mock.calls[0][0].bootstrap).toContain('stage no-time');
    expect(tr.rows.get('CMT-1')!.timeAskedCount).toBe(1);
    await run(NOW + H);
    expect(pickUp).toHaveBeenCalledTimes(1); // spaced 24 h
    await run(NOW + 25 * H);
    await run(NOW + 50 * H);
    expect(pickUp).toHaveBeenCalledTimes(2);
  });
  it('no live session → no ask', async () => {
    const pickUp = vi.fn(async () => ({ kind: 'notified' as const }));
    const { run } = make([row('CMT-1', { softDeadlineAt: undefined })], { pickUp, hasLiveSession: () => false });
    await run();
    expect(pickUp).not.toHaveBeenCalled();
  });
  it('behavioral rows and Slack conversations are left to the review', async () => {
    const pickUp = vi.fn(async () => ({ kind: 'notified' as const }));
    const { run } = make([row('CMT-1', { softDeadlineAt: undefined, type: 'behavioral' } as Partial<Commitment>), row('CMT-2', { softDeadlineAt: undefined, topicId: -4 })], { pickUp, hasLiveSession: () => true });
    await run();
    expect(pickUp).not.toHaveBeenCalled();
  });
});

describe('release (§3.6)', () => {
  it('a finished promise-work session idle 30 min is offered for release; an unfinished one is not', async () => {
    const releaseIfAllowed = vi.fn(() => true);
    const { run } = make([row('CMT-1', { status: 'delivered' }), row('CMT-2')], {
      listPromiseWorkSessions: () => [
        { tmuxSession: 'a', commitmentIds: ['CMT-1'], idleSince: iso(NOW - 31 * 60_000) },
        { tmuxSession: 'b', commitmentIds: ['CMT-2'], idleSince: iso(NOW - 31 * 60_000) },
        { tmuxSession: 'c', commitmentIds: ['CMT-1'], idleSince: iso(NOW - 10 * 60_000) },
      ],
      releaseIfAllowed,
    });
    const rep = await run();
    expect(releaseIfAllowed.mock.calls.map((x) => x[0])).toEqual(['a']);
    expect(rep.released).toBe(1);
  });
});
