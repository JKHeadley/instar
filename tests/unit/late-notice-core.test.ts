/**
 * Tier 1 — the shared helpers that stayed in lateNoticeCore: the person-facing
 * time format and the "ask once" date-missing hint. The overdue-promise stage
 * logic moved to promiseKeepingCore (tests/unit/promise-keeping-core.test.ts,
 * docs/specs/promise-keeping-before-the-deadline.md).
 */
import { describe, it, expect } from 'vitest';
import { buildDateMissingHint, formatPromisedTime } from '../../src/monitoring/lateNoticeCore.js';
import { detectPromisedTime } from '../../src/monitoring/promisedUpdateDetector.js';

const SELF = 'm_self';
const NOON_PT = '2026-11-17T20:00:00.000Z';

describe('formatPromisedTime', () => {
  it('weekday, date and time come from ONE zone (23:30 Pacific is still the same day there)', () => {
    // 2026-11-18T07:30Z = Tuesday 17 Nov 23:30 in Los Angeles, Wednesday in UTC.
    expect(formatPromisedTime('2026-11-18T07:30:00.000Z', 'America/Los_Angeles')).toBe('Tuesday 17 November, 11:30 PM');
    expect(formatPromisedTime('2026-11-18T07:30:00.000Z', 'UTC')).toBe('Wednesday 18 November, 7:30 AM');
  });
  it('across a DST change the local wall time is right', () => {
    // 2026-11-01 is the US fall-back day: 10:00 PST = 18:00Z after the change.
    expect(formatPromisedTime('2026-11-01T18:00:00.000Z', 'America/Los_Angeles')).toBe('Sunday 1 November, 10:00 AM');
    expect(formatPromisedTime('2026-10-31T17:00:00.000Z', 'America/Los_Angeles')).toBe('Saturday 31 October, 10:00 AM');
  });
  it('unparseable time → empty, never an invented one', () => {
    expect(formatPromisedTime('bad')).toBe('');
  });
});

describe('detectPromisedTime — the "ask once" guard (by/before only)', () => {
  const at = Date.parse('2026-11-17T17:00:00.000Z'); // 09:00 PT
  const tz = 'America/Los_Angeles';
  it('"done by noon" → today 12:00 PT', () => expect(new Date(detectPromisedTime("I'll have the run done by noon.", at, tz)!.dueAtMs).toISOString()).toBe('2026-11-17T20:00:00.000Z'));
  it('"by 8 PM today" → 20:00 PT', () => expect(new Date(detectPromisedTime('Both results by 8 PM today.', at, tz)!.dueAtMs).toISOString()).toBe('2026-11-18T04:00:00.000Z'));
  it('"before 9:30 AM tomorrow" → tomorrow', () => expect(new Date(detectPromisedTime('Fixed before 9:30 AM tomorrow.', at, tz)!.dueAtMs).toISOString()).toBe('2026-11-18T17:30:00.000Z'));
  it('"I said by noon" (retrospective) → null', () => expect(detectPromisedTime('I said by noon, sorry.', at, tz)).toBeNull());
  it('"finished at 5 PM" (past event, wrong preposition) → null', () => expect(detectPromisedTime('The run finished at 5 PM.', at, tz)).toBeNull());
  it('"by 7" (ambiguous count) → null', () => expect(detectPromisedTime('Down by 7 failures.', at, tz)).toBeNull());
});

describe('buildDateMissingHint', () => {
  const at = Date.parse('2026-11-17T17:00:00.000Z');
  const base = { id: 'CMT-5', topicId: 130715, agentResponse: "I'll have the laptop run done by noon.", originMachineId: SELF };
  it('a time in the words and no promised time → asks, with the PATCH to set it', () => {
    const h = buildDateMissingHint(base, at, detectPromisedTime, 'America/Los_Angeles');
    expect(h?.suggestedSoftDeadlineAt).toBe('2026-11-17T20:00:00.000Z');
    expect(h?.ask).toContain(`PATCH /commitments/CMT-5?origin=${SELF}`);
    expect(h?.suggestedLocal).toBe('Tuesday 17 November, 12:00 PM');
  });
  it('a soft deadline already set → no ask', () => expect(buildDateMissingHint({ ...base, softDeadlineAt: NOON_PT }, at, detectPromisedTime)).toBeNull());
  it('a check-in already set → no ask', () => expect(buildDateMissingHint({ ...base, checkInAt: NOON_PT }, at, detectPromisedTime)).toBeNull());
  it('a hardDeadlineAt does NOT suppress the ask (it is often synthetic)', () => {
    expect(buildDateMissingHint({ ...base, hardDeadlineAt: NOON_PT } as typeof base, at, detectPromisedTime, 'America/Los_Angeles')).not.toBeNull();
  });
  it('no topic → no ask', () => expect(buildDateMissingHint({ ...base, topicId: undefined }, at, detectPromisedTime)).toBeNull());
  it('no time in the words → no ask', () => expect(buildDateMissingHint({ ...base, agentResponse: 'I will look into it.' }, at, detectPromisedTime)).toBeNull());
});
