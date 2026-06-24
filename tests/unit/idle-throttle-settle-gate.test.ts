/**
 * Tier-1 tests for the DARK-FLAGGED idle-monitor throttle settle-gate decision
 * (CMT-1785 follow-up to the false-ratelimit-recovery fix). `nextIdleThrottleAction` is
 * the pure decision the SessionManager idle path consults BEHIND the flag: instead of
 * emitting `rateLimitedAtIdle` on a single glance at a throttle string (which false-fires
 * on a stale/transient line), it requires the throttle to SETTLE (present AND pane
 * byte-identical across polls — a working session animates its spinner, so an unchanged
 * pane proves the turn ended on the throttle). Strictly more conservative: emit LESS,
 * never more. Pure + clock-injected → no tmux needed.
 */
import { describe, it, expect } from 'vitest';
import { nextIdleThrottleAction, type ThrottleSettleState } from '../../src/monitoring/rateLimitDetection.js';

const THROTTLE = 'Server is temporarily limiting requests (not your usage limit) · Rate limited';
const settleMs = 10_000;
const opts = { settleMs };

describe('nextIdleThrottleAction (idle-throttle settle-gate decision)', () => {
  it('no throttle in the snapshot → fall-through (let the caller continue to its error check), no state', () => {
    const r = nextIdleThrottleAction('all calm, working normally', undefined, 1_000, opts);
    expect(r.action).toBe('fall-through');
    expect(r.nextState).toBeUndefined();
  });

  it('throttle present, FIRST sighting → wait (start the settle clock), never emit on a single glance', () => {
    const r = nextIdleThrottleAction(`...\n${THROTTLE}\n`, undefined, 1_000, opts);
    expect(r.action).toBe('wait');
    expect(r.nextState).toBeDefined();
    expect(r.nextState!.since).toBe(1_000);
  });

  it('throttle present, pane UNCHANGED for >= settleMs → emit (genuinely settled, hand to recovery)', () => {
    const snap = `...\n${THROTTLE}\n`;
    const first = nextIdleThrottleAction(snap, undefined, 1_000, opts);
    const r = nextIdleThrottleAction(snap, first.nextState, 1_000 + settleMs, opts);
    expect(r.action).toBe('emit');
    expect(r.nextState).toBeUndefined();
  });

  it('throttle present, pane unchanged but NOT settled long enough → wait (carry state)', () => {
    const snap = `...\n${THROTTLE}\n`;
    const first = nextIdleThrottleAction(snap, undefined, 1_000, opts);
    const r = nextIdleThrottleAction(snap, first.nextState, 1_000 + settleMs - 1, opts);
    expect(r.action).toBe('wait');
    expect(r.nextState!.since).toBe(1_000); // clock NOT restarted — same pane
  });

  it('throttle present but pane CHANGED since last poll → wait + RESTART the settle clock (a working session)', () => {
    const prev: ThrottleSettleState = { sig: 'old-signature', since: 1_000 };
    const r = nextIdleThrottleAction(`...\n${THROTTLE}\n some NEW output line\n`, prev, 9_999, opts);
    expect(r.action).toBe('wait');
    expect(r.nextState!.since).toBe(9_999); // restarted because the pane changed
  });

  it('a transient throttle that CLEARS before settling never emits (the false-fire this fixes)', () => {
    const throttled = `...\n${THROTTLE}\n`;
    const first = nextIdleThrottleAction(throttled, undefined, 1_000, opts);       // wait
    expect(first.action).toBe('wait');
    const cleared = nextIdleThrottleAction('resumed — working again', first.nextState, 1_000 + settleMs, opts);
    expect(cleared.action).toBe('fall-through'); // throttle gone → never emitted
    expect(cleared.nextState).toBeUndefined();
  });
});
