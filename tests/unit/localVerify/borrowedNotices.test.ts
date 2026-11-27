/**
 * Tier-1: helper events and who is told (docs/specs/local-verify-borrowed-slices-count.md, F "Who
 * is told"): every wrong pass and lapse goes to the audit log and the line's session; the owner
 * hears only of a pass that made main red or of a third fault lapse in 7 days (ordinary lapses
 * never count); a peer's event list is parsed strictly; each id is told once.
 */
import { describe, expect, it } from 'vitest';
import { HELPER_EVENT_LIMITS, eventText, parseHelperEvent, parseHelperEvents, untold, whoIsTold, type HelperEvent } from '../../../src/localVerify/borrowedNotices.js';

const DAY = 24 * 60 * 60_000;
const T0 = Date.parse('2026-11-19T08:00:00.000Z');
let n = 0;
const ev = (over: Partial<HelperEvent> = {}): HelperEvent => ({ id: (n++).toString(16).padStart(32, '0'), at: T0, runMachineId: 'm_m5', helper: 'm_winpc', lane: 'integration', kind: 'wrong-pass', file: 'tests/integration/a.test.ts', ...over });
const faultLapse = (at: number, over: Partial<HelperEvent> = {}) => ev({ kind: 'lapse', reason: 'invalid-answers', fault: true, file: undefined, at, ...over });
const ordinaryLapse = (at: number) => ev({ kind: 'lapse', reason: 'image-changed', fault: false, file: undefined, at });

describe('whoIsTold', () => {
  it('a confirmed wrong pass and a lapse go to the audit log and the line\'s session, not to the owner', () => {
    expect(whoIsTold(ev(), [])).toEqual({ audit: true, line: true, owner: false, ownerReason: null });
    expect(whoIsTold(faultLapse(T0), [])).toEqual({ audit: true, line: true, owner: false, ownerReason: null });
    expect(whoIsTold(ordinaryLapse(T0), [])).toEqual({ audit: true, line: true, owner: false, ownerReason: null });
    // A suspension is neither: it appears in the audit log and the report.
    expect(whoIsTold(ev({ kind: 'suspended', file: undefined }), [])).toEqual({ audit: true, line: false, owner: false, ownerReason: null });
  });

  it('the owner hears when a helper\'s pass let a change merge that made main red', () => {
    expect(whoIsTold(ev({ kind: 'main-red-after-pass', change: '3501' }), [])).toEqual({ audit: true, line: true, owner: true, ownerReason: 'main-red-after-pass' });
  });

  it('the owner hears of the third fault lapse within 7 days, not of the second, and not when the first is older than 7 days', () => {
    const a = faultLapse(T0);
    const b = faultLapse(T0 + DAY);
    const c = faultLapse(T0 + 7 * DAY);
    expect(whoIsTold(b, [a, b]).owner).toBe(false);
    expect(whoIsTold(c, [a, b, c])).toMatchObject({ owner: true, ownerReason: 'three-fault-lapses' });
    const late = faultLapse(T0 + 7 * DAY + 1);
    expect(whoIsTold(late, [a, b, late]).owner).toBe(false); // `a` is more than 7 days before it
    // The event itself is counted once, whether or not the history already holds it.
    expect(whoIsTold(c, [a, b]).owner).toBe(true);
    expect(whoIsTold(c, [a, c, c]).owner).toBe(false);
  });

  it('ordinary lapses never count toward the owner\'s notice, and another helper\'s faults do not either', () => {
    const third = faultLapse(T0 + 2 * DAY);
    expect(whoIsTold(third, [ordinaryLapse(T0), ordinaryLapse(T0 + DAY), third]).owner).toBe(false);
    expect(whoIsTold(third, [faultLapse(T0), ordinaryLapse(T0 + DAY), third]).owner).toBe(false);
    expect(whoIsTold(third, [faultLapse(T0, { helper: 'm_laptop' }), faultLapse(T0 + DAY, { helper: 'm_laptop' }), third]).owner).toBe(false);
    // An ordinary lapse as the event itself is never the owner's, whatever came before.
    expect(whoIsTold(ordinaryLapse(T0 + 3 * DAY), [faultLapse(T0), faultLapse(T0 + DAY), faultLapse(T0 + 2 * DAY)]).owner).toBe(false);
  });
});

describe('a peer\'s event list', () => {
  it('parses strictly: known keys, bounded values, and the fault flag derived from the reason, never taken on the sender\'s word', () => {
    const good = faultLapse(T0);
    expect(parseHelperEvent(JSON.parse(JSON.stringify(good)))).toEqual(JSON.parse(JSON.stringify(good)));
    expect(parseHelperEvent({ ...good, fault: false })).toBeNull(); // a fault reason claimed ordinary
    expect(parseHelperEvent({ ...ordinaryLapse(T0), fault: true })).toBeNull();
    expect(parseHelperEvent({ ...good, id: 'short' })).toBeNull();
    expect(parseHelperEvent({ ...good, lane: 'smoke' })).toBeNull();
    expect(parseHelperEvent({ ...good, kind: 'promotion' })).toBeNull();
    expect(parseHelperEvent({ ...good, reason: 'because' })).toBeNull();
    expect(parseHelperEvent({ ...good, extra: 1 })).toBeNull();
    expect(parseHelperEvent({ ...ev(), reason: 'invalid-answers' })).toBeNull(); // a reason on a wrong pass
    expect(parseHelperEvent({ ...ev(), file: 'x'.repeat(301) })).toBeNull();
    expect(parseHelperEvent({ ...ev(), change: 'PR 12; rm -rf' })).toBeNull();
    expect(parseHelperEvent(null)).toBeNull();
  });

  it('a list is taken only whole, only about the peer that sent it, and only up to its bound', () => {
    const a = ev();
    const b = faultLapse(T0);
    expect(parseHelperEvents([a, b], 'm_m5')).toEqual([a, b]);
    expect(parseHelperEvents([a, { ...b, id: 'x' }], 'm_m5')).toBeNull(); // one malformed entry drops the list
    expect(parseHelperEvents([a, b], 'm_studio')).toBeNull(); // events about another run machine
    expect(parseHelperEvents(Array.from({ length: HELPER_EVENT_LIMITS.perStatus + 1 }, () => ev()), 'm_m5')).toBeNull();
    expect(parseHelperEvents('events', 'm_m5')).toBeNull();
    expect(parseHelperEvents([], 'm_m5')).toEqual([]);
  });

  it('each id is told once: the untold are those whose id is not remembered, oldest first, a repeated id once', () => {
    const a = ev({ at: T0 + 2 });
    const b = ev({ at: T0 + 1 });
    const c = ev({ at: T0 + 3 });
    expect(untold([a, b, c, a], new Set([c.id])).map((e) => e.id)).toEqual([b.id, a.id]);
    expect(untold([a, b], new Set([a.id, b.id]))).toEqual([]);
  });

  it('every event has a plain-words text that names the helper, the lane and the run machine', () => {
    for (const e of [ev({ change: '3501' }), faultLapse(T0), ev({ kind: 'suspended', file: undefined }), ev({ kind: 'main-red-after-pass' })]) {
      const t = eventText(e);
      expect(t).toContain('m_winpc');
      expect(t).toContain('integration');
      expect(t).toContain('m_m5');
    }
  });
});
