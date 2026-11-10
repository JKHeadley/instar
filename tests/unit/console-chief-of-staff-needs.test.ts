/**
 * The Chief of Staff entry in the console's one list of operator needs (chief-of-staff-topic.md §1.4, §5):
 * parked / breaker / waiting-on-user projects and the lease state become rows on Home; 503 (feature off)
 * is nothing waiting; a 200 without the shape is unreadable (never "nothing waiting"); no projects ⇒
 * no lease nag.
 */
import { describe, it, expect } from 'vitest';
import { chiefOfStaffNeedRows, NEED_SOURCES } from '../../dashboard/console/needs-model.js';

const NOW = Date.parse('2026-11-10T08:00:00Z');
const ok = (data) => ({ ok: true, status: 200, data });

describe('chiefOfStaffNeedRows', () => {
  it('is registered as a need source reading GET /chief-of-staff', () => {
    const s = NEED_SOURCES.find((x) => x.id === 'chief-of-staff');
    expect(s?.reads).toEqual({ cos: '/chief-of-staff' });
  });
  it('503 (feature off) ⇒ nothing waiting; a 500 or a shapeless 200 ⇒ unreadable', () => {
    expect(chiefOfStaffNeedRows({ ok: false, reason: 'switched off on this agent' }, NOW)).toEqual([]);
    expect(chiefOfStaffNeedRows({ ok: false, status: 503 }, NOW)).toEqual([]);
    expect(chiefOfStaffNeedRows({ ok: false, status: 500 }, NOW)).toBeNull();
    expect(chiefOfStaffNeedRows(ok({ hello: 1 }), NOW)).toBeNull();
  });
  it('parked, breaker and waiting projects become rows; a live lease with time left adds nothing', () => {
    const rows = chiefOfStaffNeedRows(ok({ lease: { live: true, expiresAt: '2026-11-13T08:00:00Z' }, projects: [
      { conversationKey: 'telegram:1', goal: 'Ship the thing', parked: true, restartsWithoutProgress: 3 },
      { conversationKey: 'telegram:2', goal: 'Docs', breakerTripped: true, parked: true },
      { conversationKey: 'telegram:3', goal: 'Site', lastVerdict: 'waiting-on-user' },
      { conversationKey: 'telegram:4', goal: 'Quiet', lastVerdict: 'moving' },
    ] }), NOW);
    expect(rows.map((r) => r.key)).toEqual(['need:cos:parked:telegram:1', 'need:cos:breaker:telegram:2', 'need:cos:waiting:telegram:3']);
    expect(rows[0].main).toContain('Ship the thing'); expect(rows[0].main).toContain('3 restarts');
  });
  it('a paused lease is one row; a lease expiring within a day is one row; no projects ⇒ no lease row', () => {
    const paused = chiefOfStaffNeedRows(ok({ lease: { live: false, expiresAt: null }, projects: [{ conversationKey: 'telegram:1', goal: 'g', lastVerdict: 'moving' }] }), NOW);
    expect(paused.map((r) => r.key)).toEqual(['need:cos:paused']);
    const soon = chiefOfStaffNeedRows(ok({ lease: { live: true, expiresAt: '2026-11-10T20:00:00Z' }, projects: [{ conversationKey: 'telegram:1', goal: 'g', lastVerdict: 'moving' }] }), NOW);
    expect(soon.map((r) => r.key)).toEqual(['need:cos:expiring']);
    expect(chiefOfStaffNeedRows(ok({ lease: { live: false, expiresAt: null }, projects: [] }), NOW)).toEqual([]);
  });
});
