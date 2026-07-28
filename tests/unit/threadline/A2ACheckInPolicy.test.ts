/**
 * Unit tests for the Layer 4 check-in decision core (A2ACheckInPolicy).
 * Both sides of every boundary: salience wins, the silence-breaker heartbeat fires only after
 * the full interval of silence while active + enabled, and otherwise we stay quiet.
 */
import { describe, it, expect } from 'vitest';
import {
  decideCheckIn,
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  type CheckInDecisionInput,
} from '../../../src/threadline/A2ACheckInPolicy.js';

const base: CheckInDecisionInput = {
  conversationActive: true,
  hasSalientEvent: false,
  lastSurfaceAt: 0,
  now: 10 * 60_000, // 10 min
  heartbeatIntervalMs: DEFAULT_HEARTBEAT_INTERVAL_MS, // 7 min
  heartbeatEnabled: true,
};

describe('decideCheckIn — Layer 4 check-in policy', () => {
  it('salience always surfaces, even right after a previous surface', () => {
    const d = decideCheckIn({ ...base, hasSalientEvent: true, lastSurfaceAt: base.now - 1_000 });
    expect(d.kind).toBe('salience');
  });

  it('salience surfaces even when the heartbeat is disabled', () => {
    const d = decideCheckIn({ ...base, hasSalientEvent: true, heartbeatEnabled: false });
    expect(d.kind).toBe('salience');
  });

  it('fires the silence-breaker heartbeat after the full interval of silence (active + enabled)', () => {
    // 10 min of silence > 7 min interval
    const d = decideCheckIn({ ...base, lastSurfaceAt: 0, now: 10 * 60_000 });
    expect(d.kind).toBe('heartbeat');
  });

  it('does NOT heartbeat if a surface happened within the interval (resets on surface)', () => {
    // last surface 2 min ago, interval 7 min
    const d = decideCheckIn({ ...base, lastSurfaceAt: 8 * 60_000, now: 10 * 60_000 });
    expect(d.kind).toBe('none');
    expect(d.reason).toMatch(/recently surfaced/);
  });

  it('does NOT heartbeat when the conversation is no longer active', () => {
    const d = decideCheckIn({ ...base, conversationActive: false, lastSurfaceAt: 0, now: 10 * 60_000 });
    expect(d.kind).toBe('none');
    expect(d.reason).toMatch(/not active/);
  });

  it('does NOT heartbeat when the heartbeat is disabled (default-off)', () => {
    const d = decideCheckIn({ ...base, heartbeatEnabled: false, lastSurfaceAt: 0, now: 10 * 60_000 });
    expect(d.kind).toBe('none');
    expect(d.reason).toMatch(/disabled/);
  });

  it('fires exactly at the interval boundary (>=)', () => {
    const d = decideCheckIn({ ...base, lastSurfaceAt: 0, now: DEFAULT_HEARTBEAT_INTERVAL_MS });
    expect(d.kind).toBe('heartbeat');
  });

  it('stays quiet one ms before the interval boundary', () => {
    const d = decideCheckIn({ ...base, lastSurfaceAt: 0, now: DEFAULT_HEARTBEAT_INTERVAL_MS - 1 });
    expect(d.kind).toBe('none');
  });
});
