/**
 * Layer-0 heartbeat-freshness gate (speaker-election-owner-liveness). The coarse
 * pool-refresh loop must NOT re-record a dead peer's stale git-synced heartbeat
 * (which would keep its `online` fresh forever), yet must ALWAYS re-record a
 * genuinely-live peer (writes every ~30 min) so it is never flapped dark.
 */
import { describe, it, expect } from 'vitest';
import { heartbeatFreshEnoughToRerecord, DEFAULT_HEARTBEAT_INTERVAL_MS } from '../../src/core/MachineHeartbeat.js';

const NOW = 1_800_000_000_000; // fixed clock
const iso = (ageMs: number) => new Date(NOW - ageMs).toISOString();

describe('heartbeatFreshEnoughToRerecord (Layer 0)', () => {
  it('a live peer mid-interval (~just-written) is re-recorded → stays online', () => {
    expect(heartbeatFreshEnoughToRerecord(iso(1_000), NOW)).toBe(true);
  });

  it('a live-but-mesh-unreachable git-syncing peer (~30 min old, one cadence) is STILL re-recorded — never flapped dark', () => {
    expect(heartbeatFreshEnoughToRerecord(iso(DEFAULT_HEARTBEAT_INTERVAL_MS + 1000), NOW)).toBe(true);
  });

  it('a genuinely-dead peer (>2× cadence, ~61 min) is NOT re-recorded → its online expires', () => {
    expect(heartbeatFreshEnoughToRerecord(iso(2 * DEFAULT_HEARTBEAT_INTERVAL_MS + 60_000), NOW)).toBe(false);
  });

  it('an unparseable or absent lastHeartbeatAt is treated as stale (fail toward not-refreshing)', () => {
    expect(heartbeatFreshEnoughToRerecord('not-a-date', NOW)).toBe(false);
    expect(heartbeatFreshEnoughToRerecord(undefined, NOW)).toBe(false);
    expect(heartbeatFreshEnoughToRerecord(null, NOW)).toBe(false);
  });

  it('the boundary is exactly 2× the write cadence (≤ passes, > fails)', () => {
    expect(heartbeatFreshEnoughToRerecord(iso(2 * DEFAULT_HEARTBEAT_INTERVAL_MS), NOW)).toBe(true);
    expect(heartbeatFreshEnoughToRerecord(iso(2 * DEFAULT_HEARTBEAT_INTERVAL_MS + 1), NOW)).toBe(false);
  });
});
