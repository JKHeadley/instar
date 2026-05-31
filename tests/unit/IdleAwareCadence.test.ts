/**
 * IdleAwareCadence — runs work on a SHORT interval while active and a LONG
 * interval while idle, re-evaluating idle state on every reschedule. Safety:
 * isIdle() throwing ⇒ ACTIVE (never backs off on ambiguity); tick() throwing ⇒
 * the loop survives.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { IdleAwareCadence } from '../../src/monitoring/IdleAwareCadence.js';

describe('IdleAwareCadence', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

  const ACTIVE = 1_000;
  const IDLE = 10_000;

  it('uses the ACTIVE interval while not idle', async () => {
    const tick = vi.fn();
    const c = new IdleAwareCadence({ activeMs: ACTIVE, idleMs: IDLE, isIdle: () => false, tick });
    c.start();
    await vi.advanceTimersByTimeAsync(ACTIVE);
    expect(tick).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(ACTIVE);
    expect(tick).toHaveBeenCalledTimes(2);
    c.stop();
  });

  it('uses the IDLE interval while idle (no tick before idleMs)', async () => {
    const tick = vi.fn();
    const c = new IdleAwareCadence({ activeMs: ACTIVE, idleMs: IDLE, isIdle: () => true, tick });
    c.start();
    await vi.advanceTimersByTimeAsync(ACTIVE * 5); // 5s < idleMs(10s)
    expect(tick).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(IDLE - ACTIVE * 5);
    expect(tick).toHaveBeenCalledTimes(1);
    c.stop();
  });

  it('re-evaluates idle state on every reschedule (active → idle backs off)', async () => {
    let idle = false;
    const tick = vi.fn();
    const c = new IdleAwareCadence({ activeMs: ACTIVE, idleMs: IDLE, isIdle: () => idle, tick });
    c.start();
    await vi.advanceTimersByTimeAsync(ACTIVE);        // tick#1 (active)
    expect(tick).toHaveBeenCalledTimes(1);
    idle = true;                                       // activity stops mid-active-interval
    await vi.advanceTimersByTimeAsync(ACTIVE);        // tick#2 fires (its reschedule was still active)
    expect(tick).toHaveBeenCalledTimes(2);
    // tick#2's reschedule sampled idle=true ⇒ next is the LONG interval.
    await vi.advanceTimersByTimeAsync(ACTIVE * 3);    // 3s < idleMs(10s) ⇒ no tick (backed off)
    expect(tick).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(IDLE);          // idle interval elapses ⇒ tick#3
    expect(tick).toHaveBeenCalledTimes(3);
    c.stop();
  });

  it('treats an isIdle() THROW as active (never backs off on ambiguity)', async () => {
    const tick = vi.fn();
    const c = new IdleAwareCadence({ activeMs: ACTIVE, idleMs: IDLE, isIdle: () => { throw new Error('boom'); }, tick });
    c.start();
    await vi.advanceTimersByTimeAsync(ACTIVE);
    expect(tick).toHaveBeenCalledTimes(1); // fired at active, not idle
    c.stop();
  });

  it('survives a tick() that throws (loop keeps going)', async () => {
    const tick = vi.fn(() => { throw new Error('tick boom'); });
    const c = new IdleAwareCadence({ activeMs: ACTIVE, idleMs: IDLE, isIdle: () => false, tick });
    c.start();
    await vi.advanceTimersByTimeAsync(ACTIVE);
    await vi.advanceTimersByTimeAsync(ACTIVE);
    expect(tick).toHaveBeenCalledTimes(2);
    c.stop();
  });

  it('stop() halts all further ticks', async () => {
    const tick = vi.fn();
    const c = new IdleAwareCadence({ activeMs: ACTIVE, idleMs: IDLE, isIdle: () => false, tick });
    c.start();
    await vi.advanceTimersByTimeAsync(ACTIVE);
    expect(tick).toHaveBeenCalledTimes(1);
    c.stop();
    await vi.advanceTimersByTimeAsync(ACTIVE * 10);
    expect(tick).toHaveBeenCalledTimes(1); // no more
  });

  it('currentIntervalMs reflects the live idle state', () => {
    let idle = false;
    const c = new IdleAwareCadence({ activeMs: ACTIVE, idleMs: IDLE, isIdle: () => idle, tick: () => {} });
    expect(c.currentIntervalMs()).toBe(ACTIVE);
    idle = true;
    expect(c.currentIntervalMs()).toBe(IDLE);
  });
});
