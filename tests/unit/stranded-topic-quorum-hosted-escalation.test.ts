/**
 * U4.2 R-r2-1 — `no-lease-holder-escalation-hosted-on-any-quorum-member`.
 *
 * The composition that motivated it: an EXHAUSTED churn breaker with a DEAD
 * preferred captain leaves NO lease holder — so with the legacy gate there is
 * no claim, no escalation, AND no sentinel (its not-lease-holder early no-op).
 * With `escalationQuorumHosted`, ANY machine observing a MAJORITY partition
 * may DETECT + ESCALATE (episode-keyed items P17-coalesce pool-wide); the
 * CLAIM stays lease-holder-only (OwnershipReconciler/engine — asserted there).
 * Default false = today's behavior byte-for-byte.
 */
import { describe, it, expect } from 'vitest';
import { evaluateStrandedTopics, type StrandedDecisionInput } from '../../src/monitoring/strandedTopicDecision.js';
import type { SessionOwnershipRecord } from '../../src/core/SessionOwnership.js';
import type { MachineCapacity } from '../../src/core/types.js';
import type { ChannelScope } from '../../src/core/machineServesChannel.js';

const NOW = 1_000_000;
const SELF = 'self-machine';
const OWNER = 'owner-machine';
const THIRD = 'third-machine';
const tgScope: ChannelScope = { platform: 'telegram', chatId: 'C1' };

function rec(): SessionOwnershipRecord {
  return { sessionKey: '100', ownerMachineId: OWNER, ownershipEpoch: 5, status: 'active', nonce: 'n', timestamp: NOW, updatedAt: new Date(NOW).toISOString() };
}
function cap(over: Partial<MachineCapacity> = {}): MachineCapacity {
  return { machineId: OWNER, online: true, routerReceivedAt: new Date(NOW - 1_000).toISOString(), clockSkewStatus: 'ok', ...over };
}
/** A world where topic 100's owner serves a DIFFERENT chat → stranded (adapter arm). */
function strandedWorld(over: Partial<StrandedDecisionInput> = {}): StrandedDecisionInput {
  return {
    records: [rec()],
    capacities: [
      cap({ machineId: SELF }),
      cap({ machineId: THIRD }),
      cap({ servesChannels: { telegram: { chatIds: ['OTHER'] } } }),
    ],
    selfMachineId: SELF,
    holdsLease: true,
    prevStrandedSince: { '100': NOW - 31_000 },
    now: NOW,
    cfg: { dwellMs: 30_000, freshnessBoundMs: 45_000 },
    resolveScope: () => tgScope,
    ...over,
  };
}

describe('strandedTopicDecision — quorum-hosted escalation (R-r2-1)', () => {
  it('DEFAULT (flag off/absent): not-lease-holder stays an early no-op — today byte-for-byte', () => {
    const r = evaluateStrandedTopics(strandedWorld({ holdsLease: false }));
    expect(r.strandedSet).toHaveLength(0);
    expect(r.nextStrandedSince).toEqual({});
    const r2 = evaluateStrandedTopics(strandedWorld({ holdsLease: false, escalationQuorumHosted: false }));
    expect(r2.strandedSet).toHaveLength(0);
  });

  it('no-lease-holder-escalation-hosted-on-any-quorum-member: a quorum member DETECTS without the lease', () => {
    const r = evaluateStrandedTopics(strandedWorld({ holdsLease: false, escalationQuorumHosted: true }));
    expect(r.strandedSet).toHaveLength(1);
    expect(r.strandedSet[0].reason).toBe('adapter');
    expect(r.strandedSet[0].ownerMachineId).toBe(OWNER);
  });

  it('OUTSIDE a majority partition the relaxation does NOT apply (quorum-gated, fail closed)', () => {
    // Only SELF online of 3 → 1×2 > 3 is false → no quorum → early no-op holds.
    const r = evaluateStrandedTopics(
      strandedWorld({
        holdsLease: false,
        escalationQuorumHosted: true,
        capacities: [
          cap({ machineId: SELF }),
          cap({ machineId: THIRD, online: false }),
          cap({ online: false, servesChannels: { telegram: { chatIds: ['OTHER'] } } }),
        ],
      }),
    );
    expect(r.strandedSet).toHaveLength(0);
  });

  it('the lease-holder path is unchanged when the flag is on (no double behavior)', () => {
    const r = evaluateStrandedTopics(strandedWorld({ holdsLease: true, escalationQuorumHosted: true }));
    expect(r.strandedSet).toHaveLength(1);
  });

  it('single-machine stays a strict no-op even with the flag on', () => {
    const r = evaluateStrandedTopics(
      strandedWorld({ holdsLease: false, escalationQuorumHosted: true, capacities: [cap({ machineId: SELF })] }),
    );
    expect(r.strandedSet).toHaveLength(0);
  });
});
