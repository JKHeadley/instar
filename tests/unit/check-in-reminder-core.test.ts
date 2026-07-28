/**
 * Tier 1 — the dated-commitment check-in reminder's decision.
 * Spec: docs/specs/dated-commitment-reminder.md (ACT-724).
 *
 * "Is this commitment due for its reminder?" is an INVARIANT — arithmetic over
 * durable state — so every clause is tested on BOTH sides with realistic input.
 * The failure this feature fixes was an absent mechanism, so the tests that
 * matter most are the ones proving a reminder is sent exactly once and never
 * for a promise that has been closed.
 */
import { describe, it, expect } from 'vitest';
import {
  isCheckInReminderDue,
  selectDueCommitments,
  buildCheckInReminderText,
  formatCheckInDate,
  OPEN_COMMITMENT_STATUSES,
  CHECK_IN_TEXT_MAX,
} from '../../src/monitoring/checkInReminderCore.js';
import type { CommitmentStatus } from '../../src/monitoring/CommitmentTracker.js';

const NOW = Date.parse('2026-07-25T12:00:00.000Z');
const PAST = '2026-07-25T11:00:00.000Z';
const FUTURE = '2026-07-25T13:00:00.000Z';

function c(over: Partial<Parameters<typeof isCheckInReminderDue>[0]['commitment']> = {}) {
  return {
    status: 'pending' as CommitmentStatus,
    checkInAt: PAST,
    topicId: 33368,
    ...over,
  };
}

const verdict = (over = {}) => isCheckInReminderDue({ commitment: c(over), nowMs: NOW });

describe('isCheckInReminderDue — the due clause', () => {
  it('a due, open, unreminded, routed commitment IS due', () => {
    expect(verdict()).toEqual({ due: true });
  });

  it('exactly at the boundary counts as due (<= now, not < now)', () => {
    expect(
      isCheckInReminderDue({ commitment: c({ checkInAt: new Date(NOW).toISOString() }), nowMs: NOW }),
    ).toEqual({ due: true });
  });

  it('one millisecond early is NOT due', () => {
    expect(
      isCheckInReminderDue({ commitment: c({ checkInAt: new Date(NOW + 1).toISOString() }), nowMs: NOW }),
    ).toEqual({ due: false, reason: 'not-yet-due' });
  });
});

describe('isCheckInReminderDue — every reason for NOT sending', () => {
  it('no date at all — undefined and empty-string alike', () => {
    // An empty string is ABSENCE, not a malformed date: it reports
    // no-check-in-date. Either way it never fires, which is the property that
    // matters; the distinction just keeps the skip reason honest.
    expect(verdict({ checkInAt: undefined })).toEqual({ due: false, reason: 'no-check-in-date' });
    expect(verdict({ checkInAt: '' })).toEqual({ due: false, reason: 'no-check-in-date' });
    expect(verdict({ checkInAt: '   ' })).not.toEqual({ due: true });
  });

  it('a future date', () => {
    expect(verdict({ checkInAt: FUTURE })).toEqual({ due: false, reason: 'not-yet-due' });
  });

  it('already reminded — the idempotency stamp', () => {
    expect(verdict({ checkInReminderSentAt: '2026-07-25T11:30:00.000Z' })).toEqual({
      due: false,
      reason: 'already-reminded',
    });
  });

  it('nowhere to send it', () => {
    expect(verdict({ topicId: undefined })).toEqual({ due: false, reason: 'no-topic' });
    expect(verdict({ topicId: Number.NaN })).toEqual({ due: false, reason: 'no-topic' });
  });

  it('an unparseable date fails CLOSED, never "infinitely overdue"', () => {
    // The trap: Date.parse('') is NaN; coercing that to 0 would make the
    // commitment look overdue since 1970 and fire immediately — the exact shape
    // of the scheduler boot-fire bug this feature had to fix first.
    for (const bad of ['not a date', 'Friday', '2026-13-45T99:99:99Z']) {
      expect(verdict({ checkInAt: bad }), `'${bad}' must not fire`).toEqual({
        due: false,
        reason: 'unparseable-check-in-date',
      });
    }
  });
});

describe('teardown is a status check — nothing to delete or disable', () => {
  const terminal: CommitmentStatus[] = ['delivered', 'withdrawn', 'expired', 'violated', 'verified'];

  it.each(terminal)('a %s commitment is never reminded, even when overdue', (status) => {
    expect(verdict({ status })).toEqual({ due: false, reason: 'not-open' });
  });

  it('only `pending` is open — an unknown status defaults to NOT sending', () => {
    expect([...OPEN_COMMITMENT_STATUSES]).toEqual(['pending']);
    expect(verdict({ status: 'some-future-status' as CommitmentStatus })).toEqual({
      due: false,
      reason: 'not-open',
    });
  });

  it('delivering before the date means no reminder ever fires', () => {
    // The graduation criterion's third clause, as a unit test.
    const before = isCheckInReminderDue({
      commitment: c({ status: 'delivered', checkInAt: FUTURE }),
      nowMs: NOW,
    });
    const after = isCheckInReminderDue({
      commitment: c({ status: 'delivered', checkInAt: FUTURE }),
      nowMs: Date.parse(FUTURE) + 60_000,
    });
    expect(before.due).toBe(false);
    expect(after.due).toBe(false);
  });
});

describe('selectDueCommitments — batch partition', () => {
  it('splits a realistic mixed batch and explains every skip', () => {
    const batch = [
      { id: 'C1', ...c() }, // due
      { id: 'C2', ...c({ checkInAt: FUTURE }) },
      { id: 'C3', ...c({ status: 'delivered' as CommitmentStatus }) },
      { id: 'C4', ...c({ checkInReminderSentAt: PAST }) },
      { id: 'C5', ...c({ checkInAt: undefined }) },
      { id: 'C6', ...c() }, // due
    ];
    const { due, skipped } = selectDueCommitments(batch, NOW);
    expect(due.map((d) => d.id)).toEqual(['C1', 'C6']);
    expect(skipped).toEqual([
      { id: 'C2', reason: 'not-yet-due' },
      { id: 'C3', reason: 'not-open' },
      { id: 'C4', reason: 'already-reminded' },
      { id: 'C5', reason: 'no-check-in-date' },
    ]);
  });

  it('an empty batch is not an error', () => {
    expect(selectDueCommitments([], NOW)).toEqual({ due: [], skipped: [] });
  });

  it('a second pass over the SAME batch, once stamped, selects nothing', () => {
    // Idempotency at the batch level: this is what makes a crashed-and-retried
    // pass safe, and it is the property "exactly one reminder" rests on.
    const batch = [{ id: 'C1', ...c() }];
    expect(selectDueCommitments(batch, NOW).due).toHaveLength(1);
    const stamped = [{ id: 'C1', ...c({ checkInReminderSentAt: new Date(NOW).toISOString() }) }];
    expect(selectDueCommitments(stamped, NOW).due).toHaveLength(0);
  });
});

describe('the reminder text is a fixed template over quoted data', () => {
  it('states the promise and the date, and claims nothing about progress', () => {
    const text = buildCheckInReminderText({
      userRequest: 'report back on the benchmark refresh',
      checkInAt: '2026-07-31T09:00:00.000Z',
    });
    expect(text).toContain('report back on the benchmark refresh');
    expect(text).toContain('Friday');
    // It must NOT imply the work happened — that is the lie a reminder is
    // uniquely positioned to tell. Assert the CLAIM shape, not the word: the
    // template legitimately contains "done" inside its own disclaimer.
    const lower = text.toLowerCase();
    for (const claim of ["i've completed", 'is complete', 'i finished', "i've done", 'this is done.']) {
      expect(lower, `a reminder must not assert completion ("${claim}")`).not.toContain(claim);
    }
    expect(text).toContain('Nothing here says the work happened');
  });

  it('clamps a hostile / enormous promise instead of relaying it whole', () => {
    const text = buildCheckInReminderText({
      userRequest: 'x'.repeat(5000),
      checkInAt: '2026-07-31T09:00:00.000Z',
    });
    expect(text.length).toBeLessThan(CHECK_IN_TEXT_MAX + 400);
  });

  it('collapses whitespace so a multi-line promise cannot reshape the message', () => {
    const text = buildCheckInReminderText({
      userRequest: 'line one\n\n\nline    two',
      checkInAt: '2026-07-31T09:00:00.000Z',
    });
    expect(text).toContain('line one line two');
  });

  it('degrades to a dateless sentence rather than printing garbage', () => {
    const text = buildCheckInReminderText({ userRequest: 'something', checkInAt: 'nonsense' });
    expect(text).toContain('something');
    expect(text).not.toContain('Invalid');
    expect(text).not.toContain('NaN');
  });

  it('formatCheckInDate never throws and never invents a date', () => {
    expect(formatCheckInDate('nonsense')).toBe('');
    expect(formatCheckInDate('')).toBe('');
    expect(formatCheckInDate('2026-07-31T09:00:00.000Z')).toContain('Friday');
  });
});
