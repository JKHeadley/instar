/**
 * Tier-1 tests for planRebalance (§L4 Stage-3 load rebalance): proposes bounded
 * transfers off over-saturated machines, only for non-pinned, low-priority,
 * off-cooldown sessions; never cascades; no move when nothing qualifies.
 */
import { describe, it, expect } from 'vitest';
import { planRebalance, type RebalanceInput, type RebalanceSession } from '../../src/core/RebalancePlanner.js';
import { PlacementExecutor } from '../../src/core/PlacementExecutor.js';
import type { MachineCapacity } from '../../src/core/types.js';

const exec = new PlacementExecutor();
function cap(id: string, over: Partial<MachineCapacity> = {}): MachineCapacity {
  return { machineId: id, online: true, clockSkewStatus: 'ok', loadAvg: 1, activeSessionCount: 0, maxSessions: 10, memPressure: 'low', capabilities: ['sessions'], ...over };
}
function sess(key: string, owner: string, over: Partial<RebalanceSession> = {}): RebalanceSession {
  return { sessionKey: key, ownerMachineId: owner, ...over };
}
function input(over: Partial<RebalanceInput> = {}): RebalanceInput {
  return { machines: [], sessions: [], rebalanceThresholdPercent: 0.85, placementCooldownMs: 300_000, now: 10_000_000, ...over };
}

describe('planRebalance (§L4 Stage-3)', () => {
  it('moves a low-priority session off a saturated machine to a free one', () => {
    const moves = planRebalance(input({
      machines: [cap('busy', { activeSessionCount: 9, loadAvg: 9 }), cap('free', { activeSessionCount: 0, loadAvg: 0 })],
      sessions: [sess('s1', 'busy')],
    }), exec);
    expect(moves).toHaveLength(1);
    expect(moves[0]).toMatchObject({ sessionKey: 's1', fromMachine: 'busy', toMachine: 'free', reason: 'load-rebalance' });
  });

  it('does NOT move when no machine is over the threshold', () => {
    const moves = planRebalance(input({
      machines: [cap('a', { activeSessionCount: 5 }), cap('b', { activeSessionCount: 4 })],
      sessions: [sess('s1', 'a')],
    }), exec);
    expect(moves).toEqual([]);
  });

  it('never moves a pinned or hard-pinned session', () => {
    const moves = planRebalance(input({
      machines: [cap('busy', { activeSessionCount: 9 }), cap('free', { activeSessionCount: 0 })],
      sessions: [sess('s1', 'busy', { pinned: true }), sess('s2', 'busy', { topicMetadata: { preferredMachine: 'busy', pinned: true } })],
    }), exec);
    expect(moves).toEqual([]);
  });

  it('never moves a session still within its transfer cool-down', () => {
    const moves = planRebalance(input({
      machines: [cap('busy', { activeSessionCount: 9 }), cap('free', { activeSessionCount: 0 })],
      sessions: [sess('s1', 'busy', { lastTransferredAt: 10_000_000 - 1000 })], // moved 1s ago, cooldown 5m
    }), exec);
    expect(moves).toEqual([]);
  });

  it('never proactively moves a non-low-priority (critical) session', () => {
    const moves = planRebalance(input({
      machines: [cap('busy', { activeSessionCount: 9 }), cap('free', { activeSessionCount: 0 })],
      sessions: [sess('s1', 'busy', { lowPriority: false })],
    }), exec);
    expect(moves).toEqual([]);
  });

  it('caps at one move per source per cycle (no cascade)', () => {
    const moves = planRebalance(input({
      machines: [cap('busy', { activeSessionCount: 10 }), cap('free', { activeSessionCount: 0 })],
      sessions: [sess('s1', 'busy'), sess('s2', 'busy'), sess('s3', 'busy')],
    }), exec);
    expect(moves).toHaveLength(1); // one source → one move, even with 3 candidates
  });

  it('spreads moves across free targets (the working-copy update prevents pile-on; 2026-05-29 review #10)', () => {
    const moves = planRebalance(input({
      // Two saturated sources + TWO equally-free targets. The working-copy +1 after the
      // first move must make the second move pick the OTHER free machine, not pile on.
      machines: [cap('busy1', { activeSessionCount: 10 }), cap('busy2', { activeSessionCount: 10 }), cap('freeA', { activeSessionCount: 0 }), cap('freeB', { activeSessionCount: 0 })],
      sessions: [sess('s1', 'busy1'), sess('s2', 'busy2')],
    }), exec);
    expect(moves).toHaveLength(2);
    expect(new Set(moves.map(m => m.sessionKey)).size).toBe(2); // distinct sessions
    // The pile-on guard: the two moves land on DIFFERENT free machines.
    expect(new Set(moves.map(m => m.toMachine)).size).toBe(2);
  });

  it('is pure — same inputs → same output', () => {
    const i = input({ machines: [cap('busy', { activeSessionCount: 9 }), cap('free', { activeSessionCount: 0 })], sessions: [sess('s1', 'busy')] });
    expect(planRebalance(i, exec)).toEqual(planRebalance(i, exec));
  });
});
