/**
 * Tier-1 tests for PlacementExecutor (Multi-Machine Session Pool §L4): the pure
 * placement decision across each boundary (capable/incapable, pinned/unpinned,
 * loaded/free, sticky, invalid metadata/policy), and decide() purity.
 */
import { describe, it, expect } from 'vitest';
import {
  PlacementExecutor,
  validatePlacementPolicy,
  DEFAULT_PLACEMENT_POLICY,
  type PlacementRequest,
  type TopicPlacement,
} from '../../src/core/PlacementExecutor.js';
import type { MachineCapacity } from '../../src/core/types.js';

function machine(id: string, over: Partial<MachineCapacity> = {}): MachineCapacity {
  return {
    machineId: id,
    online: true,
    clockSkewStatus: 'ok',
    loadAvg: 1,
    activeSessionCount: 1,
    maxSessions: 10,
    memPressure: 'low',
    capabilities: ['sessions'],
    ...over,
  };
}
function req(over: Partial<PlacementRequest> = {}): PlacementRequest {
  return { sessionKey: 's', topicMetadata: {}, machineRegistry: [], reason: 'new', ...over };
}

const exec = new PlacementExecutor();

describe('PlacementExecutor.decide (§L4)', () => {
  it('least-loaded: picks the lowest-scored eligible machine', () => {
    const d = exec.decide(req({
      machineRegistry: [machine('busy', { loadAvg: 8, activeSessionCount: 9 }), machine('free', { loadAvg: 0.2, activeSessionCount: 0 })],
    }));
    expect(d.outcome).toBe('placed');
    expect(d.chosenMachine).toBe('free');
    expect(d.reason).toBe('least-loaded');
  });

  it('excludes offline + clock-quarantined machines', () => {
    const d = exec.decide(req({
      machineRegistry: [machine('off', { online: false, loadAvg: 0 }), machine('skew', { clockSkewStatus: 'suspect-clock-removed', loadAvg: 0 }), machine('ok', { loadAvg: 3 })],
    }));
    expect(d.chosenMachine).toBe('ok');
  });

  it('hard pin: places on the pinned machine when online', () => {
    const tp: TopicPlacement = { preferredMachine: 'mini', pinned: true };
    const d = exec.decide(req({ topicMetadata: tp, machineRegistry: [machine('mini', { loadAvg: 9 }), machine('other', { loadAvg: 0 })] }));
    expect(d).toMatchObject({ chosenMachine: 'mini', outcome: 'placed', reason: 'hard-pin' });
  });

  it('hard pin: QUEUES + escalates when the pinned machine is offline (never re-routes)', () => {
    const tp: TopicPlacement = { preferredMachine: 'mini', pinned: true };
    const d = exec.decide(req({ topicMetadata: tp, machineRegistry: [machine('mini', { online: false }), machine('other')] }));
    expect(d).toMatchObject({ chosenMachine: null, outcome: 'queued', escalationReason: 'hard-pin-unsatisfiable' });
  });

  it('soft preference: places on the preferred machine if eligible, else degrades to least-loaded', () => {
    const pref: TopicPlacement = { preferredMachine: 'mini' };
    expect(exec.decide(req({ topicMetadata: pref, machineRegistry: [machine('mini', { loadAvg: 5 }), machine('x', { loadAvg: 0 })] }))).toMatchObject({ chosenMachine: 'mini', reason: 'preference' });
    // mini offline → degrade (NOT queued, since it's a soft preference).
    expect(exec.decide(req({ topicMetadata: pref, machineRegistry: [machine('mini', { online: false }), machine('x', { loadAvg: 0 })] }))).toMatchObject({ chosenMachine: 'x', outcome: 'placed' });
  });

  it('required capabilities: filters to capable; queues+escalates when none qualify', () => {
    const tp: TopicPlacement = { requiredCapabilities: ['gpu'] };
    expect(exec.decide(req({ topicMetadata: tp, machineRegistry: [machine('cpu'), machine('gpu1', { capabilities: ['sessions', 'gpu'] })] }))).toMatchObject({ chosenMachine: 'gpu1' });
    expect(exec.decide(req({ topicMetadata: tp, machineRegistry: [machine('cpu1'), machine('cpu2')] }))).toMatchObject({ chosenMachine: null, outcome: 'queued', escalationReason: 'capabilities-unsatisfiable' });
  });

  it('sticky: keeps the current owner unless a meaningfully-better machine exists; rebalance bypasses sticky', () => {
    const reg = [machine('cur', { loadAvg: 1 }), machine('slightlyBetter', { loadAvg: 0.95 })];
    // Within hysteresis (0.15) → stick.
    expect(exec.decide(req({ currentOwner: 'cur', machineRegistry: reg }))).toMatchObject({ chosenMachine: 'cur', reason: 'sticky' });
    // A much-better machine → move off.
    const reg2 = [machine('cur', { loadAvg: 9 }), machine('muchBetter', { loadAvg: 0 })];
    expect(exec.decide(req({ currentOwner: 'cur', machineRegistry: reg2 })).chosenMachine).toBe('muchBetter');
    // rebalance reason ignores stickiness.
    expect(exec.decide(req({ currentOwner: 'cur', reason: 'rebalance', machineRegistry: reg })).reason).toBe('least-loaded');
  });

  it('corrupt topic metadata → placement-blocked + escalation (never mis-placed)', () => {
    const bad = { pinned: 'yes' } as unknown as TopicPlacement;
    expect(exec.decide(req({ topicMetadata: bad, machineRegistry: [machine('x')] }))).toMatchObject({ chosenMachine: null, outcome: 'placement-blocked', escalationReason: 'pinned-not-boolean' });
    const badCap = { requiredCapabilities: ['rm -rf'] } as unknown as TopicPlacement;
    expect(exec.decide(req({ topicMetadata: badCap, machineRegistry: [machine('x')] })).outcome).toBe('placement-blocked');
  });

  it('a hard pin without a target machine is placement-blocked (pinned-without-target; 2026-05-29 review)', () => {
    const d = exec.decide(req({ topicMetadata: { pinned: true } as TopicPlacement, machineRegistry: [machine('x')] }));
    expect(d).toMatchObject({ outcome: 'placement-blocked', escalationReason: 'pinned-without-target' });
    // pinned:true WITH a target is fine (the normal hard pin).
    expect(exec.decide(req({ topicMetadata: { pinned: true, preferredMachine: 'x' }, machineRegistry: [machine('x')] })).outcome).toBe('placed');
  });

  it('no online machine → queued', () => {
    expect(exec.decide(req({ machineRegistry: [machine('off', { online: false })] }))).toMatchObject({ chosenMachine: null, outcome: 'queued' });
  });

  it('decide() is pure — same inputs → same output', () => {
    const r = req({ machineRegistry: [machine('a', { loadAvg: 2 }), machine('b', { loadAvg: 1 })] });
    expect(exec.decide(r)).toEqual(exec.decide(r));
  });
});

describe('validatePlacementPolicy (§L4)', () => {
  it('accepts the default policy', () => {
    expect(() => validatePlacementPolicy(DEFAULT_PLACEMENT_POLICY)).not.toThrow();
  });
  it('rejects an unknown weight key', () => {
    expect(() => validatePlacementPolicy({ ...DEFAULT_PLACEMENT_POLICY, weights: { ...DEFAULT_PLACEMENT_POLICY.weights, bogus: 1 } })).toThrow(/unknown key/);
  });
  it('rejects a non-numeric threshold', () => {
    expect(() => validatePlacementPolicy({ ...DEFAULT_PLACEMENT_POLICY, thresholds: { rebalanceThresholdPercent: 'x', placementHysteresisDelta: 0.1 } })).toThrow();
  });
  it('rejects an invalid ordering step', () => {
    expect(() => validatePlacementPolicy({ ...DEFAULT_PLACEMENT_POLICY, ordering: ['hard-constraint', 'wat'] })).toThrow(/ordering/);
  });
  it('the constructor refuses a malformed policy (router would refuse to act)', () => {
    expect(() => new PlacementExecutor({ ...DEFAULT_PLACEMENT_POLICY, capabilityWhitelist: [42] } as never)).toThrow();
  });
});
