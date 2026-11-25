/**
 * Tier 1 — CheckInReminderReconciler's promise-keeping batch: the wiring
 * around PromiseKeepingPass (docs/specs/promise-keeping-before-the-deadline.md
 * §3, §3.8, §7). The ladder itself is covered by promise-keeping-pass.test.ts.
 */
import { describe, it, expect, vi } from 'vitest';
import { CheckInReminderReconciler } from '../../src/monitoring/CheckInReminderReconciler.js';
import type { Commitment } from '../../src/monitoring/CommitmentTracker.js';
import { PROMISED_UPDATE_KEY_PREFIX } from '../../src/monitoring/PromisedUpdateCapture.js';

const SELF = 'm_self';
const NOW = Date.parse('2026-11-17T22:00:00.000Z');
const PASSED = '2026-11-17T20:00:00.000Z';

function c(id: string, over: Partial<Commitment> = {}): Commitment {
  return {
    id, userRequest: `request ${id}`, agentResponse: `promise ${id}`, status: 'pending', topicId: 100,
    owner: 'agent', blockedOn: 'none', ownerMachineId: SELF, originMachineId: SELF,
    softDeadlineAt: PASSED, createdAt: '2026-11-17T01:00:00.000Z', ...over,
  } as Commitment;
}

function fakeTracker(initial: Commitment[]) {
  const rows = new Map(initial.map((r) => [r.id, { ...r }]));
  return {
    getAll: () => [...rows.values()],
    mutate: vi.fn(async (id: string, fn: (r: Commitment) => Commitment) => {
      const cur = rows.get(id);
      if (!cur) throw new Error(`no such commitment ${id}`);
      const next = fn({ ...cur });
      rows.set(id, next);
      return next;
    }),
    _rows: rows,
  };
}

function make(initial: Commitment[], over: { dryRun?: boolean; pickUp?: any; epoch?: number | null; noEpochStore?: boolean; send?: any } = {}) {
  const tracker = fakeTracker(initial);
  const send = over.send ?? vi.fn(async () => undefined);
  let epoch: number | null = over.epoch === undefined ? NOW - 60 * 60_000 : over.epoch;
  const writeOnce = vi.fn((ms: number) => { if (epoch === null) epoch = ms; return epoch; });
  const r = new CheckInReminderReconciler(
    {
      tracker: tracker as any, send, now: () => NOW, log: () => {}, timeZone: 'UTC',
      ...(over.noEpochStore ? {} : { lateEpoch: { read: () => epoch, writeOnce } }),
      ...(over.pickUp ? { pickUp: over.pickUp } : {}),
    },
    { enabled: true, dryRun: over.dryRun ?? false, selfMachineId: SELF },
  );
  return { r, tracker, send, writeOnce, getEpoch: () => epoch };
}

describe('the late batch runs the promise-keeping pass', () => {
  it('a missed promise is picked up, the person is not messaged', async () => {
    const pickUp = vi.fn(async () => ({ kind: 'notified' }));
    const { r, send, tracker } = make([c('CMT-1')], { pickUp });
    const rep = await r.runPass();
    expect(send).not.toHaveBeenCalled();
    expect(pickUp).toHaveBeenCalledTimes(1);
    expect(rep.late.keeping.pickedUp).toBe(1);
    expect(tracker._rows.get('CMT-1')!.pickups).toBe(1);
  });

  it('a delivered promise is left alone', async () => {
    const pickUp = vi.fn(async () => ({ kind: 'notified' }));
    const { r } = make([c('CMT-1', { status: 'delivered' })], { pickUp });
    await r.runPass();
    expect(pickUp).not.toHaveBeenCalled();
  });

  it('a late-batch error never takes the check-in batch down', async () => {
    const { r } = make([c('CMT-1')]);
    (r as any).runLatePass = async () => { throw new Error('boom'); };
    const rep = await r.runPass();
    expect(rep.ran).toBe(true);
    expect(rep.errors.some((e) => e.id === 'late-pass')).toBe(true);
  });
});

describe('dry-run and rollout (§7)', () => {
  it('dry-run notifies, starts, stamps and sends nothing, and does not set the epoch', async () => {
    const pickUp = vi.fn(async () => ({ kind: 'notified' }));
    const { r, tracker, send, writeOnce } = make([c('CMT-1')], { dryRun: true, pickUp, epoch: null });
    const rep = await r.runPass();
    expect(pickUp).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(writeOnce).not.toHaveBeenCalled();
    expect(tracker.mutate).not.toHaveBeenCalled();
    expect(rep.late.wouldAct).toBe(1);
  });

  it('the first live pass writes the epoch; a 3-day-old overdue row is backlog and gets nothing', async () => {
    const pickUp = vi.fn(async () => ({ kind: 'notified' }));
    const { r, writeOnce, getEpoch } = make([c('CMT-old', { softDeadlineAt: '2026-11-14T20:00:00.000Z' })], { epoch: null, pickUp });
    await r.runPass();
    expect(writeOnce).toHaveBeenCalledWith(NOW);
    expect(getEpoch()).toBe(NOW);
    expect(pickUp).not.toHaveBeenCalled();
  });

  it('no epoch store wired → the late batch does not run (cannot bound its backlog)', async () => {
    const pickUp = vi.fn(async () => ({ kind: 'notified' }));
    const { r } = make([c('CMT-1')], { noEpochStore: true, pickUp });
    const rep = await r.runPass();
    expect(pickUp).not.toHaveBeenCalled();
    expect(rep.late.ran).toBe(false);
  });
});

describe('promised updates are picked up first (§3.8)', () => {
  const pu = (over: Partial<Commitment> = {}) => c('CMT-PU', {
    softDeadlineAt: undefined,
    checkInAt: '2026-11-17T21:00:00.000Z',
    externalKey: `${PROMISED_UPDATE_KEY_PREFIX}100:1`,
    userRequest: 'next update promised for 1:00 PM',
    agentResponse: "I'll send the next update by 1 PM",
    ...over,
  } as Partial<Commitment>);

  it('a session takes it: no line to the person, stamped handled', async () => {
    const pickUp = vi.fn(async () => ({ kind: 'notified' }));
    const { r, send, tracker } = make([pu()], { pickUp });
    await r.runPass();
    expect(pickUp).toHaveBeenCalledTimes(1);
    expect(pickUp.mock.calls[0][0].bootstrap).toContain('promised UPDATE');
    expect(send).not.toHaveBeenCalled();
    expect(tracker._rows.get('CMT-PU')!.checkInReminderSentAt).toBeDefined();
  });

  it('no session can take it: retried, then on the third attempt one last-resort line', async () => {
    const pickUp = vi.fn(async () => ({ kind: 'held', reason: 'capacity' }));
    const { r, send, tracker } = make([pu()], { pickUp });
    await r.runPass();
    await r.runPass();
    expect(send).not.toHaveBeenCalled();
    await r.runPass();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][1]).toContain('My machine has been too busy to restart the work.');
    expect(send.mock.calls[0][1]).not.toMatch(/reply|let me know/i);
    expect(tracker._rows.get('CMT-PU')!.checkInReminderSentAt).toBeDefined();
  });
});
