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

  it('U4.1 §2E: hard pin to a NOT-YET-SUSTAINED machine QUEUES (never re-routes) — fulfilment hysteresis', () => {
    const gated = new PlacementExecutor(undefined, { sustainedOnline: (m) => m !== 'mini' });
    const tp: TopicPlacement = { preferredMachine: 'mini', pinned: true };
    const d = gated.decide(req({ topicMetadata: tp, machineRegistry: [machine('mini'), machine('other')] }));
    // The flapped-back-on pinned machine reads as unavailable: queued-never-rerouted.
    expect(d).toMatchObject({ chosenMachine: null, outcome: 'queued', reason: 'hard-pin-unavailable', escalationReason: 'hard-pin-unsatisfiable' });
  });

  it('U4.1 §2E: hard pin to a SUSTAINED machine places; absent seam = today\'s exact behavior', () => {
    const gated = new PlacementExecutor(undefined, { sustainedOnline: () => true });
    const tp: TopicPlacement = { preferredMachine: 'mini', pinned: true };
    expect(gated.decide(req({ topicMetadata: tp, machineRegistry: [machine('mini'), machine('other')] })).chosenMachine).toBe('mini');
    // Seam absent (default construction) — plain-online eligibility, unchanged.
    expect(exec.decide(req({ topicMetadata: tp, machineRegistry: [machine('mini')] })).chosenMachine).toBe('mini');
    // A throwing seam fails toward placement (plain-online), never toward a wedge.
    const throwing = new PlacementExecutor(undefined, { sustainedOnline: () => { throw new Error('tracker down'); } });
    expect(throwing.decide(req({ topicMetadata: tp, machineRegistry: [machine('mini')] })).chosenMachine).toBe('mini');
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

// ── Quota-aware placement (2026-06-05) ─────────────────────────────────
// The EXO-topic failure: the pool placed (and stickily kept) a topic on a
// machine whose LLM account was rate-limited — the user saw silence. The
// quota gate drops blocked machines from the candidate pool, with a
// place-somewhere fallback and a pin-wins exception.
describe('PlacementExecutor.decide — quota gate', () => {
  const blocked = { blocked: true, blockedUntil: '2099-01-01T00:00:00Z', reason: '5-hour window at 100%' };

  it('avoids a quota-blocked machine even when it is least-loaded', () => {
    const d = exec.decide(req({
      machineRegistry: [
        machine('limited', { loadAvg: 0.1, quotaState: blocked }),
        machine('working', { loadAvg: 5 }),
      ],
    }));
    expect(d.outcome).toBe('placed');
    expect(d.chosenMachine).toBe('working');
    expect(d.escalationReason).toBeUndefined();
  });

  it('avoids a machine blocked by an OPEN llm-circuit (the new cause flows through to placement)', () => {
    // The live-test finding: a circuit-open machine is least-loaded but cannot serve. The
    // selfQuotaState fix now reports {blocked:true, reason:'llm-circuit-open'} for it, and
    // placement must steer off it exactly as it does for an account-quota block.
    const circuitBlocked = { blocked: true, reason: 'llm-circuit-open' };
    const d = exec.decide(req({
      machineRegistry: [
        machine('rate-limited-mini', { loadAvg: 0.1, quotaState: circuitBlocked }),
        machine('healthy-laptop', { loadAvg: 5 }),
      ],
    }));
    expect(d.outcome).toBe('placed');
    expect(d.chosenMachine).toBe('healthy-laptop');
    expect(d.escalationReason).toBeUndefined();
  });

  it('a quota-blocked current owner loses stickiness (the topic moves off the silent machine)', () => {
    const d = exec.decide(req({
      currentOwner: 'limited',
      machineRegistry: [
        machine('limited', { loadAvg: 0.1, quotaState: blocked }),
        machine('working', { loadAvg: 5 }),
      ],
    }));
    expect(d.chosenMachine).toBe('working');
  });

  it('falls back to placing on a blocked machine when EVERY machine is blocked — with the escalation note', () => {
    const d = exec.decide(req({
      machineRegistry: [
        machine('a', { loadAvg: 3, quotaState: blocked }),
        machine('b', { loadAvg: 1, quotaState: blocked }),
      ],
    }));
    expect(d.outcome).toBe('placed');
    expect(d.chosenMachine).toBe('b'); // still least-loaded among them
    expect(d.escalationReason).toBe('all-machines-quota-blocked');
  });

  it('a HARD PIN to a quota-blocked machine is still honored, flagged via escalationReason', () => {
    const d = exec.decide(req({
      topicMetadata: { pinned: true, preferredMachine: 'limited' },
      machineRegistry: [
        machine('limited', { quotaState: blocked }),
        machine('working'),
      ],
    }));
    expect(d.outcome).toBe('placed');
    expect(d.chosenMachine).toBe('limited');
    expect(d.reason).toBe('hard-pin');
    expect(d.escalationReason).toBe('pinned-machine-quota-blocked');
  });

  it('a SOFT preference for a quota-blocked machine degrades to a working one', () => {
    const d = exec.decide(req({
      topicMetadata: { preferredMachine: 'limited' },
      machineRegistry: [
        machine('limited', { quotaState: blocked }),
        machine('working'),
      ],
    }));
    expect(d.chosenMachine).toBe('working');
  });

  it('absent quotaState (older heartbeats) is treated as not blocked', () => {
    const d = exec.decide(req({
      machineRegistry: [machine('legacy', { loadAvg: 0.1 }), machine('other', { loadAvg: 5 })],
    }));
    expect(d.chosenMachine).toBe('legacy');
  });

  it('quotaState.blocked === false is eligible as usual', () => {
    const d = exec.decide(req({
      machineRegistry: [
        machine('fine', { loadAvg: 0.1, quotaState: { blocked: false } }),
        machine('other', { loadAvg: 5 }),
      ],
    }));
    expect(d.chosenMachine).toBe('fine');
  });

  it('hard pin to a blocked machine still respects required capabilities (capability check is never quota-blind)', () => {
    const d = exec.decide(req({
      topicMetadata: { pinned: true, preferredMachine: 'limited', requiredCapabilities: ['gpu'] },
      machineRegistry: [
        machine('limited', { quotaState: blocked, capabilities: ['sessions'] }), // lacks gpu
        machine('working', { capabilities: ['gpu', 'sessions'] }),
      ],
    }));
    expect(d.outcome).toBe('queued');
    expect(d.reason).toBe('hard-pin-unavailable');
  });
});

describe('PlacementExecutor.decide — platform/workspace-aware serve filter (placement-platform-workspace-aware)', () => {
  const sl = (ws: string[]) => ({ servesChannels: { slack: { workspaceIds: ws } } });
  const tg = (cs: string[]) => ({ servesChannels: { telegram: { chatIds: cs } } });

  it('slack: places on the machine that serves the workspace, not the one that does not (the live-test bug)', () => {
    const d = exec.decide(req({
      reason: 'failover',
      channel: { platform: 'slack', workspaceId: 'W-LIVE', channelId: 'C1' },
      machineRegistry: [machine('laptop', { ...sl(['W-LIVE']), loadAvg: 5 }), machine('mini', { ...sl(['W-OTHER']), loadAvg: 0 })],
    }));
    expect(d.outcome).toBe('placed');
    expect(d.chosenMachine).toBe('laptop'); // mini is load-cheaper but cannot serve W-LIVE
  });

  it('yes ranks ABOVE unknown: a known-reachable machine wins over an old (unknown) peer even when the peer is cheaper', () => {
    const d = exec.decide(req({
      channel: { platform: 'slack', workspaceId: 'W1', channelId: 'C1' },
      machineRegistry: [machine('known', { ...sl(['W1']), loadAvg: 5 }), machine('oldpeer', { loadAvg: 0 })], // oldpeer has no servesChannels → unknown
    }));
    expect(d.chosenMachine).toBe('known'); // unknown must not outrank yes by load
  });

  it('all machines structurally cannot serve → queued + no-machine-serves-channel (never a black-hole pick)', () => {
    const d = exec.decide(req({
      channel: { platform: 'slack', workspaceId: 'W-LIVE', channelId: 'C1' },
      machineRegistry: [machine('a', sl(['W-OTHER'])), machine('b', sl(['W-OTHER2']))],
    }));
    expect(d.outcome).toBe('queued');
    expect(d.reason).toBe('no-machine-serves-channel');
    expect(d.escalationReason).toBe('no-machine-serves-channel');
    expect(d.chosenMachine).toBeNull();
  });

  it('telegram shared chat: both machines are yes (no exclusion) → normal least-loaded', () => {
    const d = exec.decide(req({
      channel: { platform: 'telegram', chatId: '-100SHARED', channelId: '5' },
      machineRegistry: [machine('a', { ...tg(['-100SHARED']), loadAvg: 5 }), machine('b', { ...tg(['-100SHARED']), loadAvg: 0 })],
    }));
    expect(d.chosenMachine).toBe('b');
  });

  it('fail-open: all machines absent signal (unknown) → places normally (rolling deploy)', () => {
    const d = exec.decide(req({
      channel: { platform: 'slack', workspaceId: 'W1', channelId: 'C1' },
      machineRegistry: [machine('a', { loadAvg: 5 }), machine('b', { loadAvg: 0 })],
    }));
    expect(d.outcome).toBe('placed');
    expect(d.chosenMachine).toBe('b');
  });

  it('absent req.channel (legacy caller) → filter no-ops (unchanged behavior)', () => {
    const d = exec.decide(req({
      machineRegistry: [machine('a', sl(['W-OTHER'])), machine('b', sl(['W-OTHER2']))], // would be all-no IF channel were set
    }));
    expect(d.outcome).toBe('placed'); // no channel → no filter → normal placement
  });

  it('hard-pin to a machine that structurally CANNOT serve → hard-pin-unsatisfiable (not honored onto a non-serving machine)', () => {
    const tp: TopicPlacement = { preferredMachine: 'mini', pinned: true };
    const d = exec.decide(req({
      topicMetadata: tp,
      channel: { platform: 'slack', workspaceId: 'W-LIVE', channelId: 'C1' },
      machineRegistry: [machine('mini', sl(['W-OTHER'])), machine('laptop', sl(['W-LIVE']))],
    }));
    expect(d.outcome).toBe('queued');
    expect(d.escalationReason).toBe('hard-pin-unsatisfiable');
  });

  it('hard-pin to an UNKNOWN (absent-signal) machine → still honored (fail-open)', () => {
    const tp: TopicPlacement = { preferredMachine: 'oldpeer', pinned: true };
    const d = exec.decide(req({
      topicMetadata: tp,
      channel: { platform: 'slack', workspaceId: 'W-LIVE', channelId: 'C1' },
      machineRegistry: [machine('oldpeer', { loadAvg: 1 }), machine('laptop', sl(['W-LIVE']))], // oldpeer unknown
    }));
    expect(d).toMatchObject({ chosenMachine: 'oldpeer', outcome: 'placed', reason: 'hard-pin' });
  });
});
