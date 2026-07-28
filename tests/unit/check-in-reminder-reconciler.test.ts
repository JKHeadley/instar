/**
 * Tier 1 — the check-in reminder reconciler (the stateful half).
 * Spec: docs/specs/dated-commitment-reminder.md (ACT-724).
 *
 * The pure due-predicate is covered in check-in-reminder-core.test.ts. What is
 * tested HERE is everything that can go wrong once real state and a real
 * transport are involved: exactly-once under repetition, the stamp-before-send
 * ordering, what happens when the send fails, and the bounded blast radius.
 */
import { describe, it, expect, vi } from 'vitest';
import { CheckInReminderReconciler } from '../../src/monitoring/CheckInReminderReconciler.js';
import type { Commitment } from '../../src/monitoring/CommitmentTracker.js';
import { CHECK_IN_MAX_ATTEMPTS } from '../../src/monitoring/checkInReminderCore.js';

const NOW = Date.parse('2026-07-25T12:00:00.000Z');
const PAST = '2026-07-25T11:00:00.000Z';
const FUTURE = '2026-07-25T13:00:00.000Z';

function commitment(over: Partial<Commitment> = {}): Commitment {
  return {
    id: 'CMT-1',
    userRequest: 'report back on the benchmark refresh',
    status: 'pending',
    topicId: 33368,
    checkInAt: PAST,
    ...over,
  } as Commitment;
}

/** A store with the real CAS shape: mutate applies fn and persists. */
function fakeTracker(initial: Commitment[]) {
  const rows = new Map(initial.map((c) => [c.id, { ...c }]));
  return {
    getAll: () => [...rows.values()],
    mutate: vi.fn(async (id: string, fn: (c: Commitment) => Commitment) => {
      const cur = rows.get(id);
      if (!cur) throw new Error(`no such commitment ${id}`);
      const next = fn({ ...cur });
      rows.set(id, next);
      return next;
    }),
    _rows: rows,
  };
}

function make(
  initial: Commitment[],
  over: { dryRun?: boolean; enabled?: boolean; maxPerPass?: number; send?: any } = {},
) {
  const tracker = fakeTracker(initial);
  const send = over.send ?? vi.fn(async () => undefined);
  const r = new CheckInReminderReconciler(
    { tracker: tracker as any, send, now: () => NOW, log: () => {} },
    {
      enabled: over.enabled ?? true,
      dryRun: over.dryRun ?? false,
      ...(over.maxPerPass !== undefined ? { maxPerPass: over.maxPerPass } : {}),
    },
  );
  return { r, tracker, send };
}

describe('the happy path', () => {
  it('sends one reminder to the commitment topic and stamps it', async () => {
    const { r, tracker, send } = make([commitment()]);
    const rep = await r.runPass();

    expect(rep.ran).toBe(true);
    expect(rep.due).toBe(1);
    expect(rep.sent).toBe(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toBe(33368);
    expect(send.mock.calls[0][1]).toContain('report back on the benchmark refresh');
    expect(tracker._rows.get('CMT-1')?.checkInReminderSentAt).toBe(new Date(NOW).toISOString());
  });
});

describe('exactly once — the property the whole feature rests on', () => {
  it('a second pass over the same state sends nothing', async () => {
    const { r, send } = make([commitment()]);
    await r.runPass();
    const second = await r.runPass();

    expect(send).toHaveBeenCalledTimes(1);
    expect(second.sent).toBe(0);
    expect(second.due).toBe(0);
    expect(second.skippedByReason['already-reminded']).toBe(1);
  });

  it('ten consecutive passes still send exactly one', async () => {
    const { r, send } = make([commitment()]);
    for (let i = 0; i < 10; i++) await r.runPass();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('a commitment already stamped by another machine is never re-sent', async () => {
    const { r, send } = make([commitment({ checkInReminderSentAt: '2026-07-25T11:30:00.000Z' })]);
    const rep = await r.runPass();
    expect(send).not.toHaveBeenCalled();
    expect(rep.sent).toBe(0);
  });

  it('a crash between send and stamp re-sends, and the relay absorbs the duplicate', async () => {
    // The cost of send-then-stamp, stated honestly: the reminder can be sent
    // twice if the process dies before stamping. That is ACCEPTED here because
    // the relay's content dedup drops an identical message to the same topic
    // inside its window — the platform already solves it. What must NOT happen
    // is the reverse trade: a failed send marked as delivered.
    const { r, tracker, send } = make([commitment()]);
    // First pass: send succeeds, stamping fails (the crash window).
    tracker.mutate
      .mockImplementationOnce(async (id: string, fn: any) => {
        const cur = tracker._rows.get(id)!;
        const next = fn({ ...cur });
        tracker._rows.set(id, next);
        return next;
      }) // attempts++
      .mockImplementationOnce(async () => {
        throw new Error('died before stamping');
      });
    const first = await r.runPass();
    expect(send).toHaveBeenCalledTimes(1);
    expect(first.sent).toBe(1);
    expect(first.errors.some((e) => e.error.includes('sent-but-unstamped'))).toBe(true);

    // Second pass re-sends because no stamp exists — correct, and deduped downstream.
    await r.runPass();
    expect(send).toHaveBeenCalledTimes(2);
  });
});

describe('teardown needs no teardown', () => {
  it.each(['delivered', 'withdrawn', 'expired'] as const)(
    'a %s commitment past its date is never reminded',
    async (status) => {
      const { r, send } = make([commitment({ status: status as any })]);
      const rep = await r.runPass();
      expect(send).not.toHaveBeenCalled();
      expect(rep.skippedByReason['not-open']).toBe(1);
    },
  );

  it('a future-dated commitment waits', async () => {
    const { r, send } = make([commitment({ checkInAt: FUTURE })]);
    const rep = await r.runPass();
    expect(send).not.toHaveBeenCalled();
    expect(rep.skippedByReason['not-yet-due']).toBe(1);
  });
});

describe('when the send fails', () => {
  it('does NOT mark it sent — the failure that would silently drop the promise', async () => {
    // THE regression test for the review finding. An earlier draft stamped
    // before sending, so a transport failure left the commitment marked
    // delivered and permanently ineligible: a reminder the user never got,
    // recorded as one they did.
    const send = vi.fn(async () => {
      throw new Error('telegram down');
    });
    const { r, tracker } = make([commitment()], { send });
    const rep = await r.runPass();

    expect(rep.failed).toBe(1);
    expect(rep.sent).toBe(0);
    const row = tracker._rows.get('CMT-1')!;
    expect(row.checkInReminderSentAt, 'a failed send must NEVER read as sent').toBeUndefined();
    expect(row.checkInReminderAttempts).toBe(1);
    expect(row.checkInReminderFailedAt, 'not given up yet — retries remain').toBeUndefined();
  });

  it('retries on later passes, then gives up LOUDLY at the cap', async () => {
    const send = vi.fn(async () => {
      throw new Error('telegram down');
    });
    const lines: string[] = [];
    const tracker = fakeTracker([commitment()]);
    const r = new CheckInReminderReconciler(
      { tracker: tracker as any, send, now: () => NOW, log: (l) => lines.push(l) },
      { enabled: true, dryRun: false },
    );

    for (let i = 0; i < CHECK_IN_MAX_ATTEMPTS; i++) await r.runPass();

    expect(send).toHaveBeenCalledTimes(CHECK_IN_MAX_ATTEMPTS);
    const row = tracker._rows.get('CMT-1')!;
    expect(row.checkInReminderAttempts).toBe(CHECK_IN_MAX_ATTEMPTS);
    expect(row.checkInReminderFailedAt, 'exhaustion is recorded, not hidden').toBeTruthy();
    expect(row.checkInReminderSentAt, 'still never claims delivery').toBeUndefined();
    expect(lines.some((l) => l.includes('GIVING UP') && l.includes('UNDELIVERED'))).toBe(true);

    // And it stops — a broken transport is not hammered forever.
    const after = await r.runPass();
    expect(send).toHaveBeenCalledTimes(CHECK_IN_MAX_ATTEMPTS);
    expect(after.skippedByReason['retries-exhausted']).toBe(1);
  });

  it('a transient failure followed by success delivers, and marks sent only then', async () => {
    let calls = 0;
    const send = vi.fn(async () => {
      calls++;
      if (calls === 1) throw new Error('blip');
      return undefined;
    });
    const { r, tracker } = make([commitment()], { send });
    await r.runPass();
    expect(tracker._rows.get('CMT-1')?.checkInReminderSentAt).toBeUndefined();
    const second = await r.runPass();
    expect(second.sent).toBe(1);
    expect(tracker._rows.get('CMT-1')?.checkInReminderSentAt).toBeTruthy();
  });

  it('one failing commitment does not strand the others in the batch', async () => {
    const send = vi.fn(async (topicId: number) => {
      if (topicId === 1) throw new Error('boom');
      return undefined;
    });
    const { r } = make(
      [
        commitment({ id: 'A', topicId: 1 }),
        commitment({ id: 'B', topicId: 2 }),
        commitment({ id: 'C', topicId: 3 }),
      ],
      { send },
    );
    const rep = await r.runPass();
    expect(rep.sent).toBe(2);
    expect(rep.failed).toBe(1);
    expect(send).toHaveBeenCalledTimes(3);
  });

  it('a mutate failure is contained and reported, never thrown out of the pass', async () => {
    const { r, tracker, send } = make([commitment({ id: 'A' }), commitment({ id: 'B', topicId: 2 })]);
    tracker.mutate.mockImplementationOnce(async () => {
      throw new Error('store locked');
    });
    const rep = await r.runPass();
    expect(rep.errors.some((e) => e.error.includes('store locked'))).toBe(true);
    // B still gets its reminder.
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe('bounded blast radius', () => {
  it('caps a pass and says so, deferring the rest', async () => {
    const many = Array.from({ length: 10 }, (_, i) =>
      commitment({ id: `CMT-${i}`, topicId: 1000 + i }),
    );
    const { r, send } = make(many, { maxPerPass: 3 });
    const rep = await r.runPass();
    expect(rep.sent).toBe(3);
    expect(rep.capped).toBe(7);
    expect(send).toHaveBeenCalledTimes(3);
  });

  it('the deferred remainder is picked up by later passes, each exactly once', async () => {
    const many = Array.from({ length: 5 }, (_, i) => commitment({ id: `CMT-${i}`, topicId: 1000 + i }));
    const { r, send } = make(many, { maxPerPass: 2 });
    await r.runPass();
    await r.runPass();
    await r.runPass();
    expect(send).toHaveBeenCalledTimes(5);
    const ids = send.mock.calls.map((c: any[]) => c[0]).sort();
    expect(new Set(ids).size).toBe(5); // no duplicates
  });
});

describe('gating', () => {
  it('disabled: does nothing at all', async () => {
    const { r, send } = make([commitment()], { enabled: false });
    const rep = await r.runPass();
    expect(rep.ran).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it('dryRun: decides and counts, but sends nothing and stamps nothing', async () => {
    const { r, tracker, send } = make([commitment()], { dryRun: true });
    const rep = await r.runPass();
    expect(rep.ran).toBe(true);
    expect(rep.dryRun).toBe(true);
    expect(rep.wouldSend).toBe(1);
    expect(rep.sent).toBe(0);
    expect(send).not.toHaveBeenCalled();
    // Critically: no stamp, so flipping dryRun off later still delivers.
    expect(tracker._rows.get('CMT-1')?.checkInReminderSentAt).toBeUndefined();
  });
});
