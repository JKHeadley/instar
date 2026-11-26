/**
 * planned-restart-keeps-lead §1 step 1 — the process-wide announce: resolves at once with no
 * subscriber or no renewal, waits for confirmation up to the module's deadline, coalesces, and never
 * throws into a writer.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  announceRestartRequested,
  announceRestartWithdrawn,
  onRestartRequested,
  onRestartWithdrawn,
  setRestartSignalDeadlineMs,
  _resetRestartSignalForTests,
} from '../../src/core/restartRequestSignal.js';

beforeEach(() => { _resetRestartSignalForTests(); vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); _resetRestartSignalForTests(); });

const announce = { requestedBy: 'role-change', reason: 'this machine took the lease', requestedAt: '2026-11-21T09:38:35.370Z' };

describe('announceRestartRequested', () => {
  it('resolves at once with no subscriber', async () => {
    await expect(announceRestartRequested(announce)).resolves.toBeNull();
  });
  it('resolves at once when the subscriber signs nothing (not the holder)', async () => {
    onRestartRequested(() => null);
    await expect(announceRestartRequested(announce)).resolves.toBeNull();
  });
  it('resolves with the confirmation when it lands before the deadline', async () => {
    onRestartRequested(() => new Promise((r) => setTimeout(() => r('confirmed'), 500)));
    const p = announceRestartRequested(announce);
    await vi.advanceTimersByTimeAsync(600);
    await expect(p).resolves.toBe('confirmed');
  });
  it('resolves unconfirmed at the module deadline when the subscriber is slower', async () => {
    setRestartSignalDeadlineMs(2_000);
    onRestartRequested(() => new Promise((r) => setTimeout(() => r('confirmed'), 10_000)));
    const p = announceRestartRequested(announce);
    await vi.advanceTimersByTimeAsync(2_100);
    await expect(p).resolves.toBe('unconfirmed');
  });
  it('coalesces an announce that arrives while one is in flight', async () => {
    let calls = 0;
    onRestartRequested(() => { calls++; return new Promise((r) => setTimeout(() => r('confirmed'), 300)); });
    const a = announceRestartRequested(announce);
    const b = announceRestartRequested({ ...announce, requestedBy: 'auto-updater' });
    expect(b).toBe(a);
    await vi.advanceTimersByTimeAsync(400);
    await expect(a).resolves.toBe('confirmed');
    expect(calls).toBe(1);
  });
  it('isolates a subscriber that throws: the writer sees null and the error reaches the sink', async () => {
    const errors: unknown[] = [];
    onRestartRequested(() => { throw new Error('ENOSPC'); }, { onError: (e) => errors.push(e) });
    await expect(announceRestartRequested(announce)).resolves.toBeNull();
    expect(errors).toHaveLength(1);
  });
  it('isolates a subscriber whose promise rejects: unconfirmed, error to the sink', async () => {
    const errors: unknown[] = [];
    onRestartRequested(() => Promise.reject(new Error('boom')), { onError: (e) => errors.push(e) });
    const p = announceRestartRequested(announce);
    await vi.advanceTimersByTimeAsync(10);
    await expect(p).resolves.toBe('unconfirmed');
    expect(errors).toHaveLength(1);
  });
  it('a detached subscriber is not called', async () => {
    const detach = onRestartRequested(() => Promise.resolve('confirmed'));
    detach();
    await expect(announceRestartRequested(announce)).resolves.toBeNull();
  });
});

describe('announceRestartWithdrawn', () => {
  it('reaches the withdraw subscriber and never throws', () => {
    let seen = 0;
    onRestartWithdrawn(() => { seen++; });
    announceRestartWithdrawn();
    expect(seen).toBe(1);
    onRestartWithdrawn(() => { throw new Error('x'); });
    expect(() => announceRestartWithdrawn()).not.toThrow();
  });
});
