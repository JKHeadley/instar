/**
 * Tier 1 — the late-notice batch inside CheckInReminderReconciler (the stateful half).
 * Spec: docs/specs/overdue-promise-follow-through.md §3.2–§3.4.
 *
 * What can go wrong once real state and a transport are involved: a notice
 * sent twice, a stamp that lies, a handoff that claims the user was told before
 * they were, a burst that floods one person, a give-up that goes silent.
 */
import { describe, it, expect, vi } from 'vitest';
import { CheckInReminderReconciler, type CheckInSendIdentity } from '../../src/monitoring/CheckInReminderReconciler.js';
import type { Commitment } from '../../src/monitoring/CommitmentTracker.js';
import { LATE_NOTICE_MAX_ATTEMPTS } from '../../src/monitoring/lateNoticeCore.js';

const SELF = 'm_self';
const NOW = Date.parse('2026-11-17T22:00:00.000Z');
const PASSED = '2026-11-17T20:00:00.000Z';
const SOON = '2026-11-17T22:20:00.000Z';

function c(id: string, over: Partial<Commitment> = {}): Commitment {
  return {
    id,
    userRequest: `request ${id}`,
    agentResponse: `promise ${id}`,
    status: 'pending',
    topicId: 100,
    owner: 'agent',
    blockedOn: 'none',
    ownerMachineId: SELF,
    originMachineId: SELF,
    softDeadlineAt: PASSED,
    createdAt: '2026-11-17T01:00:00.000Z',
    ...over,
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

function make(initial: Commitment[], over: {
  dryRun?: boolean; send?: any; handOff?: any; epoch?: number | null; now?: number;
  perPass?: number; perHour?: number; cooldown?: number; noEpochStore?: boolean;
} = {}) {
  const tracker = fakeTracker(initial);
  const send = over.send ?? vi.fn(async () => undefined);
  let epoch: number | null = over.epoch === undefined ? NOW - 60 * 60_000 : over.epoch;
  const writeOnce = vi.fn((ms: number) => { if (epoch === null) epoch = ms; return epoch; });
  const handOffPromise = over.handOff;
  const r = new CheckInReminderReconciler(
    {
      tracker: tracker as any,
      send,
      now: () => over.now ?? NOW,
      log: () => {},
      timeZone: 'UTC',
      ...(over.noEpochStore ? {} : { lateEpoch: { read: () => epoch, writeOnce } }),
      ...(handOffPromise ? { handOffPromise } : {}),
    },
    {
      enabled: true,
      dryRun: over.dryRun ?? false,
      selfMachineId: SELF,
      ...(over.perPass !== undefined ? { maxLateTopicsPerPass: over.perPass } : {}),
      ...(over.perHour !== undefined ? { maxLateTopicsPerHour: over.perHour } : {}),
      ...(over.cooldown !== undefined ? { lateTopicCooldownMs: over.cooldown } : {}),
    },
  );
  return { r, tracker, send, writeOnce, getEpoch: () => epoch };
}

describe('case 1 — the overdue promise reaches the person', () => {
  it('sends one late message to the promise topic and stamps the time', async () => {
    const { r, tracker, send } = make([c('CMT-1876')]);
    const rep = await r.runPass();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toBe(100);
    expect(send.mock.calls[0][1]).toContain("That time has passed and it isn't marked done");
    expect(send.mock.calls[0][1]).toContain('promise CMT-1876');
    const row = tracker._rows.get('CMT-1876')!;
    expect(row.lateNoticeFor).toBe(PASSED);
    expect(row.lateNoticeCount).toBe(1);
    expect(row.lateNoticeSentAt).toBe(new Date(NOW).toISOString());
    expect(rep.late.topicsSent).toBe(1);
    expect(rep.late.rowsNoticed).toBe(1);
  });

  it('a second pass sends nothing (exactly once per promised time)', async () => {
    const { r, send } = make([c('CMT-1')]);
    await r.runPass();
    await r.runPass();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('moving the time re-arms exactly one new notice, with a NEW send identity', async () => {
    const { r, tracker, send } = make([c('CMT-1')], { cooldown: 0 });
    await r.runPass();
    const firstId = send.mock.calls[0][2] as CheckInSendIdentity;
    await tracker.mutate('CMT-1', (x) => ({ ...x, softDeadlineAt: '2026-11-17T21:30:00.000Z' }));
    await r.runPass();
    expect(send).toHaveBeenCalledTimes(2);
    const secondId = send.mock.calls[1][2] as CheckInSendIdentity;
    expect(JSON.stringify(secondId)).not.toBe(JSON.stringify(firstId));
    expect(tracker._rows.get('CMT-1')!.lateNoticeCount).toBe(2);
  });

  it('a delivered promise is never told late', async () => {
    const { r, send } = make([c('CMT-1', { status: 'delivered' })]);
    await r.runPass();
    expect(send).not.toHaveBeenCalled();
  });

  it('a row with only a check-in (promised-update shape) is left to the check-in path', async () => {
    const { r, send } = make([c('CMT-1', { softDeadlineAt: undefined, checkInAt: '2026-11-17T23:00:00.000Z' })]);
    const rep = await r.runPass();
    expect(send).not.toHaveBeenCalled();
    expect(rep.late.due).toBe(0);
  });
});

describe('one message per conversation, bounded across conversations', () => {
  it('two late promises in one topic → one message, both stamped', async () => {
    const { r, tracker, send } = make([c('CMT-1'), c('CMT-2', { softDeadlineAt: '2026-11-17T21:00:00.000Z' })]);
    await r.runPass();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][1]).toContain("These were due and aren't marked done");
    expect(tracker._rows.get('CMT-1')!.lateNoticeFor).toBe(PASSED);
    expect(tracker._rows.get('CMT-2')!.lateNoticeFor).toBe('2026-11-17T21:00:00.000Z');
    const id = send.mock.calls[0][2] as Extract<CheckInSendIdentity, { kind: 'late' }>;
    expect(id.kind).toBe('late');
    expect(id.rows.map((x) => x.id).sort()).toEqual(['CMT-1', 'CMT-2']);
  });

  it('per-topic cooldown: a topic told 10 min ago is held, then sent after the cooldown', async () => {
    const recent = new Date(NOW - 10 * 60_000).toISOString();
    const rows = [c('CMT-old', { lateNoticeFor: '2026-11-17T19:00:00.000Z', softDeadlineAt: '2026-11-17T19:00:00.000Z', lateNoticeSentAt: recent }), c('CMT-new')];
    const { r, send } = make(rows);
    const rep = await r.runPass();
    expect(send).not.toHaveBeenCalled();
    expect(rep.late.topicsHeld).toBe(1);
    const later = make(rows, { now: NOW + 51 * 60_000 });
    await later.r.runPass();
    expect(later.send).toHaveBeenCalledTimes(1);
  });

  it('burst: 200 late rows across 50 topics → at most 3 topics this pass, oldest first', async () => {
    const rows: Commitment[] = [];
    for (let t = 0; t < 50; t++) {
      for (let k = 0; k < 4; k++) {
        rows.push(c(`CMT-${t}-${k}`, { topicId: 1000 + t, softDeadlineAt: new Date(NOW - (t + 1) * 60_000 - k).toISOString() }));
      }
    }
    const { r, send } = make(rows);
    const rep = await r.runPass();
    expect(send).toHaveBeenCalledTimes(3);
    expect(rep.late.topicsHeld).toBe(47);
    // Oldest promised time first: topics 1049, 1048, 1047.
    expect(send.mock.calls.map((x: any[]) => x[0])).toEqual([1049, 1048, 1047]);
  });

  it('burst over an hour: never more than 12 topics per rolling hour', async () => {
    const rows: Commitment[] = [];
    for (let t = 0; t < 50; t++) rows.push(c(`CMT-${t}`, { topicId: 2000 + t }));
    const { r, tracker, send } = make(rows);
    let now = NOW;
    for (let pass = 0; pass < 12; pass++) {
      const rr = new CheckInReminderReconciler(
        { tracker: tracker as any, send, now: () => now, log: () => {}, lateEpoch: { read: () => NOW - 3600_000, writeOnce: (m: number) => m } },
        { enabled: true, dryRun: false, selfMachineId: SELF },
      );
      await rr.runPass();
      now += 5 * 60_000;
    }
    expect(send.mock.calls.length).toBe(12);
    void r;
  });
});

describe('order: attempt → send → stamp → handoff', () => {
  it('the handoff runs after the stamp, so "the user has been told" is true', async () => {
    const order: string[] = [];
    const send = vi.fn(async () => { order.push('send'); });
    const handOff = vi.fn(async (_t: number, text: string) => { order.push(`handoff:${text.slice(0, 16)}`); return true; });
    const { r, tracker } = make([c('CMT-1')], { send, handOff });
    tracker.mutate.mockImplementation(async (id: string, fn: any) => {
      const next = fn({ ...tracker._rows.get(id)! });
      if (next.lateNoticeFor && !tracker._rows.get(id)!.lateNoticeFor) order.push('stamp');
      tracker._rows.set(id, next);
      return next;
    });
    const rep = await r.runPass();
    expect(order).toEqual(['send', 'stamp', 'handoff:[promise overdue']);
    expect(rep.late.handoffsAccepted).toBe(1);
    expect(tracker._rows.get('CMT-1')!.lateHandoffFor).toBe(PASSED);
  });

  it('a handoff not accepted (no running session) is recorded; the person still got the notice; nothing retried', async () => {
    const handOff = vi.fn(async () => false);
    const { r, send } = make([c('CMT-1')], { handOff });
    const rep = await r.runPass();
    expect(send).toHaveBeenCalledTimes(1);
    expect(rep.late.handoffsNotAccepted).toBe(1);
    await r.runPass();
    expect(handOff).toHaveBeenCalledTimes(1);
  });

  it('no message text claims a pickup', async () => {
    const { r, send } = make([c('CMT-1')], { handOff: vi.fn(async () => true) });
    await r.runPass();
    expect(send.mock.calls[0][1]).not.toMatch(/picking it back up/i);
  });

  it('a row delivered between selection and send is dropped (predicate re-checked inside the CAS)', async () => {
    const { r, tracker, send } = make([c('CMT-1'), c('CMT-2')]);
    const orig = tracker.mutate.getMockImplementation()!;
    let first = true;
    tracker.mutate.mockImplementation(async (id: string, fn: any) => {
      if (first && id === 'CMT-1') { first = false; tracker._rows.set('CMT-1', { ...tracker._rows.get('CMT-1')!, status: 'delivered' }); }
      return orig(id, fn);
    });
    await r.runPass();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][1]).toContain('promise CMT-2');
    expect(send.mock.calls[0][1]).not.toContain('promise CMT-1');
  });
});

describe('failure is never silent', () => {
  it('a failed send counts an attempt and stamps nothing', async () => {
    const send = vi.fn(async () => { throw new Error('telegram down'); });
    const { r, tracker } = make([c('CMT-1')], { send });
    const rep = await r.runPass();
    const row = tracker._rows.get('CMT-1')!;
    expect(row.lateNoticeFor).toBeUndefined();
    expect(row.lateAttempts).toBe(1);
    expect(row.lateAttemptsFor).toBe(PASSED);
    expect(rep.late.failed).toBe(1);
  });

  it(`after ${LATE_NOTICE_MAX_ATTEMPTS} failures it gives up loudly (gaveUp, failure stamp)`, async () => {
    const send = vi.fn(async () => { throw new Error('telegram down'); });
    const { r, tracker } = make([c('CMT-1', { lateAttemptsFor: PASSED, lateAttempts: LATE_NOTICE_MAX_ATTEMPTS - 1 })], { send });
    const rep = await r.runPass();
    expect(rep.gaveUp).toBe(1);
    expect(rep.late.gaveUp).toBe(1);
    expect(tracker._rows.get('CMT-1')!.lateNoticeFailedAt).toBeDefined();
  });

  it('a row whose attempts ran out with no outcome (crash) is stamped failed and counted', async () => {
    const { r, tracker, send } = make([c('CMT-1', { lateAttemptsFor: PASSED, lateAttempts: LATE_NOTICE_MAX_ATTEMPTS })]);
    const rep = await r.runPass();
    expect(send).not.toHaveBeenCalled();
    expect(rep.gaveUp).toBe(1);
    expect(tracker._rows.get('CMT-1')!.lateNoticeFailedAt).toBeDefined();
  });

  it('a moved time after a give-up gets a fresh budget (old failure stamp cleared)', async () => {
    const { r, tracker, send } = make([c('CMT-1', {
      softDeadlineAt: '2026-11-17T21:30:00.000Z', lateAttemptsFor: PASSED, lateAttempts: LATE_NOTICE_MAX_ATTEMPTS, lateNoticeFailedAt: '2026-11-17T20:30:00.000Z',
    })]);
    await r.runPass();
    expect(send).toHaveBeenCalledTimes(1);
    const row = tracker._rows.get('CMT-1')!;
    expect(row.lateNoticeFailedAt).toBeUndefined();
    expect(row.lateAttempts).toBe(1);
  });

  it('a late-batch error never takes the check-in batch down', async () => {
    const { r } = make([c('CMT-1')]);
    (r as any).runLatePass = async () => { throw new Error('boom'); };
    const rep = await r.runPass();
    expect(rep.ran).toBe(true);
    expect(rep.errors.some((e) => e.id === 'late-pass')).toBe(true);
  });
});

describe('dry-run and rollout', () => {
  it('dry-run sends, stamps and hands off nothing, and does not set the epoch', async () => {
    const handOff = vi.fn(async () => true);
    const { r, tracker, send, writeOnce } = make([c('CMT-1'), c('CMT-2', { softDeadlineAt: SOON })], { dryRun: true, handOff, epoch: null });
    const rep = await r.runPass();
    expect(send).not.toHaveBeenCalled();
    expect(handOff).not.toHaveBeenCalled();
    expect(writeOnce).not.toHaveBeenCalled();
    expect(tracker.mutate).not.toHaveBeenCalled();
    expect(rep.late.wouldSendTopics).toBe(1);
  });

  it('the first live pass writes the epoch; a 3-day-old overdue row is backlog and gets nothing', async () => {
    const old = c('CMT-old', { softDeadlineAt: '2026-11-14T20:00:00.000Z' });
    const { r, send, writeOnce, getEpoch } = make([old], { epoch: null });
    const rep = await r.runPass();
    expect(writeOnce).toHaveBeenCalledWith(NOW);
    expect(getEpoch()).toBe(NOW);
    expect(send).not.toHaveBeenCalled();
    expect(rep.late.skippedByReason['before-window']).toBe(1);
  });

  it('no epoch store wired → the late batch does not run (cannot bound its backlog)', async () => {
    const { r, send } = make([c('CMT-1')], { noEpochStore: true });
    const rep = await r.runPass();
    expect(send).not.toHaveBeenCalled();
    expect(rep.late.ran).toBe(false);
  });
});

describe('due-soon nudge — session only, running sessions only', () => {
  it('hands the promise to the session 20 min before, never sends to the person', async () => {
    const handOff = vi.fn(async () => true);
    const { r, tracker, send } = make([c('CMT-1', { softDeadlineAt: SOON })], { handOff });
    const rep = await r.runPass();
    expect(send).not.toHaveBeenCalled();
    expect(handOff).toHaveBeenCalledTimes(1);
    expect(handOff.mock.calls[0][1]).toContain('[promise due soon: CMT-1');
    expect(rep.late.nudged).toBe(1);
    expect(tracker._rows.get('CMT-1')!.dueSoonNudgeFor).toBe(SOON);
  });

  it('stamped even when no session took it, so it is never repeated', async () => {
    const handOff = vi.fn(async () => false);
    const { r } = make([c('CMT-1', { softDeadlineAt: SOON })], { handOff });
    await r.runPass();
    await r.runPass();
    expect(handOff).toHaveBeenCalledTimes(1);
  });

  it('no handoff wired → no nudge at all', async () => {
    const { r, send } = make([c('CMT-1', { softDeadlineAt: SOON })]);
    const rep = await r.runPass();
    expect(rep.late.nudged).toBe(0);
    expect(send).not.toHaveBeenCalled();
  });
});
