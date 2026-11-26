/**
 * A check-in reminder or late-promise line reaches the person, and a held one is never counted as told.
 * Spec: docs/specs/overdue-promise-follow-through.md §3.5.
 *
 * The live check on 2026-11-18 (CMT-1951): the reconciler reported the late line sent, stamped
 * lateNoticeSentAt and told the session "the user has been told". But Quiet by Default had recorded it,
 * because the send carried routes.ts's 'uncategorized' envelope. The person never saw it.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NotificationSelectivityGate } from '../../src/messaging/NotificationSelectivityGate.js';
import { notificationStamper } from '../../src/messaging/notificationStampers.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { CONVERSATION_CATEGORIES, PROTECTED_DELIVERY_CATEGORIES, categoryForProducer, isNotificationCategory } from '../../src/messaging/notificationCategories.js';
import { CheckInReminderReconciler } from '../../src/monitoring/CheckInReminderReconciler.js';
import type { Commitment } from '../../src/monitoring/CommitmentTracker.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const c of cleanup.splice(0)) await c(); });

function gate() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'promise-notice-'));
  const g = new NotificationSelectivityGate(root, 'machine-a', () => ({ enabled: true, dryRun: false }));
  cleanup.push(async () => { await g.close(); SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'tests/unit/promise-notice-delivery.test.ts' }); });
  return g;
}

const QUIET = { delivered: false, recorded: true, quietId: 'q-1', topicId: 144400 };

function fakeTracker(initial: Commitment[]) {
  const rows = new Map(initial.map((r) => [r.id, { ...r }]));
  return {
    getAll: () => [...rows.values()],
    mutate: vi.fn(async (id: string, fn: (r: Commitment) => Commitment) => {
      const next = fn({ ...rows.get(id)! });
      rows.set(id, next);
      return next;
    }),
    _rows: rows,
  };
}

describe('promise-notice category', () => {
  it('is registered and protected, is not a conversation category, and no producer request maps to it', () => {
    expect(isNotificationCategory('promise-notice')).toBe(true);
    expect(PROTECTED_DELIVERY_CATEGORIES.has('promise-notice')).toBe(true);
    expect(CONVERSATION_CATEGORIES.has('promise-notice')).toBe(false);
    for (const producer of ['promise-notice', 'commitment-checkin-reminder', 'telegram-server']) {
      expect(categoryForProducer(producer)).not.toBe('promise-notice');
    }
  });

  it("routes.ts's named promise-notice stamper carries the category; its module stamper stays uncategorized", () => {
    expect(notificationStamper('src/server/routes.ts', 'promise-notice')()).toMatchObject({ origin: 'automated', category: 'promise-notice' });
    expect(notificationStamper('src/server/routes.ts')()).toMatchObject({ category: 'uncategorized' });
  });

  it('delivers under Quiet by Default, where the old uncategorized envelope was recorded (the CMT-1951 decision)', () => {
    const g = gate();
    expect(g.decide(144400, notificationStamper('src/server/routes.ts')())).toMatchObject({ decision: 'record', reason: 'quiet-default' });
    expect(g.decide(144400, notificationStamper('src/server/routes.ts', 'promise-notice')())).toMatchObject({ decision: 'deliver', reason: 'promise-notice' });
  });

  it('caps a looping sender at 6 per topic per 10 minutes, per topic', () => {
    const g = gate();
    const env = notificationStamper('src/server/routes.ts', 'promise-notice')();
    for (let i = 0; i < 6; i++) expect(g.decide(7, env).decision).toBe('deliver');
    expect(g.decide(7, env)).toMatchObject({ decision: 'record', reason: 'promise-notice-budget' });
    expect(g.decide(8, env).decision).toBe('deliver');
  });

  it('the reminder send in routes.ts is stamped with the promise-notice stamper (wiring)', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src/server/routes.ts'), 'utf8');
    const at = src.indexOf("producerId = 'commitment-checkin-reminder'");
    expect(at).toBeGreaterThan(0);
    const before = src.slice(at - 1200, at);
    expect(before).toContain('withNotificationEnvelope(stampPromiseNotice(), async () => (telegram)!.sendToTopic(topicId, text))');
  });
});

describe('a held send is not counted as told', () => {
  it('late notice: a quiet receipt leaves the row unstamped, counts a failure, and hands nothing to the session', async () => {
    const now = Date.parse('2026-11-18T15:44:49.000Z');
    const tracker = fakeTracker([{
      id: 'CMT-1951', userRequest: 'TEST', agentResponse: 'Test: a short summary', status: 'pending', topicId: 144400,
      owner: 'agent', blockedOn: 'none', ownerMachineId: 'm_self', originMachineId: 'm_self',
      softDeadlineAt: '2026-11-18T15:42:45Z', createdAt: '2026-11-18T15:34:45.191Z',
    } as Commitment]);
    const handOffPromise = vi.fn(async () => true);
    const send = vi.fn(async () => QUIET);
    const r = new CheckInReminderReconciler(
      { tracker: tracker as any, send, now: () => now, log: () => {}, timeZone: 'UTC',
        lateEpoch: { read: () => now - 3_600_000, writeOnce: (ms: number) => ms }, handOffPromise },
      { enabled: true, dryRun: false, selfMachineId: 'm_self' },
    );
    const rep = await r.runPass();
    expect(send).toHaveBeenCalledTimes(1);
    expect(rep.late.topicsSent).toBe(0);
    expect(rep.late.failed).toBe(1);
    expect(rep.errors.some((e) => /held-not-delivered/.test(e.error))).toBe(true);
    const row = tracker._rows.get('CMT-1951')!;
    expect(row.lateNoticeSentAt).toBeUndefined();
    expect(row.lateAttempts).toBe(1);
    expect(handOffPromise).not.toHaveBeenCalled();
  });

  it('check-in reminder: a quiet receipt leaves checkInReminderSentAt unset', async () => {
    const now = Date.parse('2026-07-25T12:00:00.000Z');
    const tracker = fakeTracker([{ id: 'CMT-1', userRequest: 'report back', status: 'pending', topicId: 33368, checkInAt: '2026-07-25T11:00:00.000Z' } as Commitment]);
    const r = new CheckInReminderReconciler(
      { tracker: tracker as any, send: vi.fn(async () => QUIET), now: () => now, log: () => {} },
      { enabled: true, dryRun: false },
    );
    const rep = await r.runPass();
    expect(rep.sent).toBe(0);
    expect(rep.failed).toBe(1);
    expect(tracker._rows.get('CMT-1')!.checkInReminderSentAt).toBeUndefined();
  });

  it('a delivered send result (not a quiet receipt) still counts as sent', async () => {
    const now = Date.parse('2026-07-25T12:00:00.000Z');
    const tracker = fakeTracker([{ id: 'CMT-1', userRequest: 'report back', status: 'pending', topicId: 33368, checkInAt: '2026-07-25T11:00:00.000Z' } as Commitment]);
    const r = new CheckInReminderReconciler(
      { tracker: tracker as any, send: vi.fn(async () => ({ messageId: 5 })), now: () => now, log: () => {} },
      { enabled: true, dryRun: false },
    );
    const rep = await r.runPass();
    expect(rep.sent).toBe(1);
    expect(tracker._rows.get('CMT-1')!.checkInReminderSentAt).toBeDefined();
  });
});
