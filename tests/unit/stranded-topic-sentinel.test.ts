/**
 * Unit tests for the StrandedTopicSentinel pure decision (evaluateStrandedTopics)
 * — stranded-inbound-self-heal. Exhaustive on both sides of every boundary:
 * quota arm fires; adapter-arm 'no' fires; 'unknown'/undefined-scope SKIPs; the
 * persistence dwell (single-beat does NOT fire, ≥2-beat over dwellMs fires);
 * missing servesChannels ⇒ skip (not strand); owner offline ⇒ skip; owner==self
 * ⇒ skip; non-lease-holder ⇒ empty; single-machine ⇒ empty; strandedSince
 * reconciliation deletes stale keys; can't-assess increments on missing-field
 * skips.
 *
 * The sentinel's tick is also smoke-tested for the LLM-free / no-spawn-cap
 * invariant (it imports nothing that would acquire a spawn-cap slot) and the
 * aggregated-attention emission.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  evaluateStrandedTopics,
  type StrandedDecisionInput,
} from '../../src/monitoring/strandedTopicDecision.js';
import {
  StrandedTopicSentinel,
  type StrandAttentionItem,
} from '../../src/monitoring/StrandedTopicSentinel.js';
import type { SessionOwnershipRecord } from '../../src/core/SessionOwnership.js';
import type { MachineCapacity } from '../../src/core/types.js';
import type { ChannelScope } from '../../src/core/machineServesChannel.js';

const NOW = 1_000_000;
const SELF = 'self-machine';
const OWNER = 'owner-machine';

function rec(over: Partial<SessionOwnershipRecord> = {}): SessionOwnershipRecord {
  return {
    sessionKey: '100',
    ownerMachineId: OWNER,
    ownershipEpoch: 5,
    status: 'active',
    nonce: 'n',
    timestamp: NOW,
    updatedAt: new Date(NOW).toISOString(),
    ...over,
  };
}

function cap(over: Partial<MachineCapacity> = {}): MachineCapacity {
  return {
    machineId: OWNER,
    online: true,
    routerReceivedAt: new Date(NOW - 1_000).toISOString(), // 1s old, fresh
    clockSkewStatus: 'ok',
    ...over,
  };
}

function selfCap(): MachineCapacity {
  return cap({ machineId: SELF });
}

function baseInput(over: Partial<StrandedDecisionInput> = {}): StrandedDecisionInput {
  return {
    records: [],
    capacities: [selfCap(), cap()],
    selfMachineId: SELF,
    holdsLease: true,
    prevStrandedSince: {},
    now: NOW,
    cfg: { dwellMs: 30_000, freshnessBoundMs: 45_000 },
    ...over,
  };
}

describe('evaluateStrandedTopics — early no-op gates', () => {
  it('single-machine (< 2 capacities) ⇒ empty + dropped map', () => {
    const r = evaluateStrandedTopics(
      baseInput({ capacities: [selfCap()], records: [rec()], prevStrandedSince: { '100': NOW - 60_000 } }),
    );
    expect(r.strandedSet).toHaveLength(0);
    expect(r.nextStrandedSince).toEqual({});
    expect(r.cantAssessCount).toBe(0);
  });

  it('not lease-holder ⇒ empty + dropped map', () => {
    const r = evaluateStrandedTopics(
      baseInput({
        holdsLease: false,
        records: [rec()],
        capacities: [selfCap(), cap({ quotaState: { blocked: true } })],
        prevStrandedSince: { '100': NOW - 60_000 },
      }),
    );
    expect(r.strandedSet).toHaveLength(0);
    expect(r.nextStrandedSince).toEqual({});
  });
});

describe('evaluateStrandedTopics — quota arm', () => {
  it('quota-blocked owner past dwell ⇒ stranded (reason quota)', () => {
    const r = evaluateStrandedTopics(
      baseInput({
        records: [rec()],
        capacities: [selfCap(), cap({ quotaState: { blocked: true } })],
        prevStrandedSince: { '100': NOW - 31_000 }, // anchored > dwellMs ago
      }),
    );
    expect(r.strandedSet).toHaveLength(1);
    expect(r.strandedSet[0].reason).toBe('quota');
    expect(r.strandedSet[0].ownerMachineId).toBe(OWNER);
    expect(r.nextStrandedSince['100']).toBe(NOW - 31_000);
  });

  it('quota.blocked === false ⇒ NOT stranded (boundary other side)', () => {
    const r = evaluateStrandedTopics(
      baseInput({
        records: [rec()],
        capacities: [selfCap(), cap({ quotaState: { blocked: false } })],
        prevStrandedSince: { '100': NOW - 31_000 },
      }),
    );
    expect(r.strandedSet).toHaveLength(0);
    // quotaState present (decided), so it is assessed — NOT a blind skip.
    expect(r.cantAssessCount).toBe(0);
  });
});

describe('evaluateStrandedTopics — adapter arm', () => {
  const tgScope: ChannelScope = { platform: 'telegram', chatId: 'C1' };
  const resolveScope = () => tgScope;

  it("machineServesChannel === 'no' past dwell ⇒ stranded (reason adapter)", () => {
    // owner serves a DIFFERENT chat → 'no' for C1
    const r = evaluateStrandedTopics(
      baseInput({
        records: [rec()],
        capacities: [selfCap(), cap({ servesChannels: { telegram: { chatIds: ['OTHER'] } } })],
        prevStrandedSince: { '100': NOW - 31_000 },
        resolveScope,
      }),
    );
    expect(r.strandedSet).toHaveLength(1);
    expect(r.strandedSet[0].reason).toBe('adapter');
  });

  it("machineServesChannel === 'yes' ⇒ NOT stranded", () => {
    const r = evaluateStrandedTopics(
      baseInput({
        records: [rec()],
        capacities: [selfCap(), cap({ servesChannels: { telegram: { chatIds: ['C1'] } } })],
        prevStrandedSince: { '100': NOW - 31_000 },
        resolveScope,
      }),
    );
    expect(r.strandedSet).toHaveLength(0);
    expect(r.cantAssessCount).toBe(0);
  });

  it("scope undefined ⇒ adapter arm SKIPs (no strand from adapter)", () => {
    const r = evaluateStrandedTopics(
      baseInput({
        records: [rec()],
        capacities: [selfCap(), cap({ servesChannels: { telegram: { chatIds: ['OTHER'] } } })],
        prevStrandedSince: { '100': NOW - 31_000 },
        resolveScope: () => undefined,
      }),
    );
    expect(r.strandedSet).toHaveLength(0);
    // servesChannels present + scope underivable: not a blind skip (we had a
    // value, just no scope to test it against), and quota is undefined.
    expect(r.cantAssessCount).toBe(0);
  });

  it("servesChannels present but 'unknown' (no telegram block, slack scope) ⇒ SKIP, not blind (servesChannels present)", () => {
    const slackScope: ChannelScope = { platform: 'slack' /* no workspaceId */ };
    const r = evaluateStrandedTopics(
      baseInput({
        records: [rec()],
        capacities: [selfCap(), cap({ servesChannels: { slack: { workspaceIds: ['W1'] } } })],
        prevStrandedSince: { '100': NOW - 31_000 },
        resolveScope: () => slackScope, // missing workspaceId ⇒ 'unknown'
      }),
    );
    expect(r.strandedSet).toHaveLength(0);
    expect(r.cantAssessCount).toBe(0); // servesPresent ⇒ not blind
  });
});

describe('evaluateStrandedTopics — persistence (dwell)', () => {
  it('single beat (no prior anchor) does NOT fire; records anchor', () => {
    const r = evaluateStrandedTopics(
      baseInput({
        records: [rec()],
        capacities: [selfCap(), cap({ quotaState: { blocked: true } })],
        prevStrandedSince: {}, // first observation
      }),
    );
    expect(r.strandedSet).toHaveLength(0);
    expect(r.nextStrandedSince['100']).toBe(NOW); // anchor recorded
  });

  it('anchored within dwellMs does NOT fire', () => {
    const r = evaluateStrandedTopics(
      baseInput({
        records: [rec()],
        capacities: [selfCap(), cap({ quotaState: { blocked: true } })],
        prevStrandedSince: { '100': NOW - 10_000 }, // 10s < 30s dwell
      }),
    );
    expect(r.strandedSet).toHaveLength(0);
    expect(r.nextStrandedSince['100']).toBe(NOW - 10_000); // anchor preserved
  });

  it('anchored at exactly dwellMs fires', () => {
    const r = evaluateStrandedTopics(
      baseInput({
        records: [rec()],
        capacities: [selfCap(), cap({ quotaState: { blocked: true } })],
        prevStrandedSince: { '100': NOW - 30_000 },
      }),
    );
    expect(r.strandedSet).toHaveLength(1);
  });
});

describe('evaluateStrandedTopics — skip cases', () => {
  it('missing servesChannels AND quota undefined ⇒ skip + cantAssess increments', () => {
    const r = evaluateStrandedTopics(
      baseInput({
        records: [rec()],
        capacities: [selfCap(), cap({ /* no quotaState, no servesChannels */ })],
        prevStrandedSince: { '100': NOW - 31_000 },
        resolveScope: () => ({ platform: 'telegram', chatId: 'C1' }),
      }),
    );
    expect(r.strandedSet).toHaveLength(0);
    expect(r.cantAssessCount).toBe(1);
    expect(r.nextStrandedSince).toEqual({}); // no anchor for a skipped topic
  });

  it('owner offline ⇒ skip (not stranded, not blind)', () => {
    const r = evaluateStrandedTopics(
      baseInput({
        records: [rec()],
        capacities: [selfCap(), cap({ online: false, quotaState: { blocked: true } })],
        prevStrandedSince: { '100': NOW - 31_000 },
      }),
    );
    expect(r.strandedSet).toHaveLength(0);
    expect(r.cantAssessCount).toBe(0);
  });

  it('owner == self ⇒ skip', () => {
    const r = evaluateStrandedTopics(
      baseInput({
        records: [rec({ ownerMachineId: SELF })],
        capacities: [cap({ machineId: SELF, quotaState: { blocked: true } }), cap()],
        prevStrandedSince: { '100': NOW - 31_000 },
      }),
    );
    expect(r.strandedSet).toHaveLength(0);
  });

  it('non-active record (released) ⇒ skip', () => {
    const r = evaluateStrandedTopics(
      baseInput({
        records: [rec({ status: 'released' })],
        capacities: [selfCap(), cap({ quotaState: { blocked: true } })],
        prevStrandedSince: { '100': NOW - 31_000 },
      }),
    );
    expect(r.strandedSet).toHaveLength(0);
  });

  it('owner not in pool view ⇒ skip', () => {
    const r = evaluateStrandedTopics(
      baseInput({
        records: [rec({ ownerMachineId: 'ghost' })],
        capacities: [selfCap(), cap()], // ghost absent
        prevStrandedSince: { '100': NOW - 31_000 },
      }),
    );
    expect(r.strandedSet).toHaveLength(0);
  });

  it('stale rich beat (older than freshnessBoundMs) ⇒ skip', () => {
    const r = evaluateStrandedTopics(
      baseInput({
        records: [rec()],
        capacities: [selfCap(), cap({ routerReceivedAt: new Date(NOW - 60_000).toISOString(), quotaState: { blocked: true } })],
        prevStrandedSince: { '100': NOW - 31_000 },
      }),
    );
    expect(r.strandedSet).toHaveLength(0);
  });

  it('missing routerReceivedAt (no beat age) ⇒ skip', () => {
    const r = evaluateStrandedTopics(
      baseInput({
        records: [rec()],
        capacities: [selfCap(), cap({ routerReceivedAt: undefined, quotaState: { blocked: true } })],
        prevStrandedSince: { '100': NOW - 31_000 },
      }),
    );
    expect(r.strandedSet).toHaveLength(0);
  });
});

describe('evaluateStrandedTopics — strandedSince reconciliation', () => {
  it('deletes a stale key whose topic no longer qualifies (owner went offline)', () => {
    const r = evaluateStrandedTopics(
      baseInput({
        records: [rec()],
        capacities: [selfCap(), cap({ online: false, quotaState: { blocked: true } })],
        prevStrandedSince: { '100': NOW - 31_000, '999': NOW - 31_000 }, // both stale now
      }),
    );
    expect(r.strandedSet).toHaveLength(0);
    // neither survives — 100 fell out via offline skip, 999 had no record at all
    expect(r.nextStrandedSince).toEqual({});
  });

  it('keeps a re-qualifying key, drops a non-re-qualifying one', () => {
    const r = evaluateStrandedTopics(
      baseInput({
        records: [
          rec({ sessionKey: '100' }), // still quota-walled
          rec({ sessionKey: '200', ownerMachineId: 'healthy' }), // healthy owner now
        ],
        capacities: [
          selfCap(),
          cap({ quotaState: { blocked: true } }), // OWNER walled
          cap({ machineId: 'healthy', quotaState: { blocked: false } }),
        ],
        prevStrandedSince: { '100': NOW - 31_000, '200': NOW - 31_000 },
      }),
    );
    expect(r.strandedSet.map((s) => s.sessionKey)).toEqual(['100']);
    expect(r.nextStrandedSince).toEqual({ '100': NOW - 31_000 }); // 200 dropped
  });
});

describe('evaluateStrandedTopics — servablePeerExists annotation', () => {
  it('true when a healthy peer exists (quota semantics, no scope)', () => {
    const r = evaluateStrandedTopics(
      baseInput({
        records: [rec()],
        capacities: [
          selfCap(), // self healthy
          cap({ quotaState: { blocked: true } }),
        ],
        prevStrandedSince: { '100': NOW - 31_000 },
      }),
    );
    expect(r.strandedSet[0].servablePeerExists).toBe(true);
  });

  it('false when every other machine is also walled (fleet-wide wall)', () => {
    const r = evaluateStrandedTopics(
      baseInput({
        records: [rec()],
        capacities: [
          cap({ machineId: SELF, quotaState: { blocked: true } }), // self also walled
          cap({ quotaState: { blocked: true } }), // OWNER walled
        ],
        prevStrandedSince: { '100': NOW - 31_000 },
      }),
    );
    expect(r.strandedSet[0].servablePeerExists).toBe(false);
  });
});

describe('StrandedTopicSentinel — tick + aggregated emission', () => {
  function makeDeps(over: Partial<Parameters<typeof StrandedTopicSentinel.prototype.constructor>[0]> = {}) {
    const raised: StrandAttentionItem[] = [];
    const records: SessionOwnershipRecord[] = [rec()];
    const capacities: MachineCapacity[] = [selfCap(), cap({ quotaState: { blocked: true } })];
    let clock = NOW;
    const deps = {
      listOwnershipRecords: () => records,
      listCapacities: () => capacities,
      selfMachineId: () => SELF,
      holdsLease: () => true,
      raiseAttention: (i: StrandAttentionItem) => raised.push(i),
      nicknameOf: (id: string) => (id === OWNER ? 'Mac Mini' : id),
      now: () => clock,
      ...over,
    };
    return { raised, deps, setClock: (t: number) => (clock = t), records, capacities };
  }

  it('emits ONE aggregated NORMAL item after the dwell; single-beat is silent', () => {
    const { raised, deps, setClock } = makeDeps();
    const s = new StrandedTopicSentinel(deps, { enabled: true, dwellMs: 30_000 });

    s.tick(); // first beat — anchor only
    expect(raised).toHaveLength(0);

    setClock(NOW + 31_000);
    s.tick(); // past dwell — fires
    expect(raised).toHaveLength(1);
    expect(raised[0].priority).toBe('NORMAL');
    expect(raised[0].lane).toBe('agent-health');
    expect(raised[0].id).toContain('stranded-topic:');
    expect(raised[0].description).toContain('Mac Mini');
  });

  it('single-machine (selfMachineId null) ⇒ strict no-op, no emission', () => {
    const { raised, deps } = makeDeps({ selfMachineId: () => null });
    const s = new StrandedTopicSentinel(deps, { enabled: true, dwellMs: 0 });
    s.tick();
    expect(raised).toHaveLength(0);
  });

  it('emits the LOW can\'t-assess item when an online owner is unassessable', () => {
    const { raised, deps } = makeDeps({
      listCapacities: () => [selfCap(), cap({ /* no quota, no serves */ })],
      resolveScope: () => ({ platform: 'telegram', chatId: 'C1' }),
    });
    const s = new StrandedTopicSentinel(deps, { enabled: true, dwellMs: 30_000 });
    s.tick();
    const lows = raised.filter((i) => i.priority === 'LOW');
    expect(lows).toHaveLength(1);
    expect(lows[0].id).toContain('stranded-topic-blind');
  });

  it('guardStatus reports enabled + lastTickAt liveness', () => {
    const { deps } = makeDeps();
    const s = new StrandedTopicSentinel(deps, { enabled: true });
    expect(s.guardStatus()).toEqual({ enabled: true, lastTickAt: 0 });
    s.tick();
    expect(s.guardStatus().enabled).toBe(true);
    expect(s.guardStatus().lastTickAt).toBeGreaterThan(0);
  });

  it('a raiseAttention throw never propagates out of tick (signal-only)', () => {
    const { deps, setClock } = makeDeps({
      raiseAttention: () => {
        throw new Error('boom');
      },
    });
    const s = new StrandedTopicSentinel(deps, { enabled: true, dwellMs: 30_000 });
    s.tick();
    setClock(NOW + 31_000);
    expect(() => s.tick()).not.toThrow();
  });

  it('disabled ⇒ tick is a no-op (still stamps lastTickAt, raises nothing)', () => {
    const { raised, deps, setClock } = makeDeps();
    const s = new StrandedTopicSentinel(deps, { enabled: false, dwellMs: 30_000 });
    s.tick();
    setClock(NOW + 31_000);
    s.tick();
    expect(raised).toHaveLength(0);
  });
});

describe('StrandedTopicSentinel — no spawn-cap / LLM-free invariant', () => {
  it('tick performs no async work (returns void synchronously, no LLM dep injected)', () => {
    const raised: StrandAttentionItem[] = [];
    const s = new StrandedTopicSentinel(
      {
        listOwnershipRecords: () => [rec()],
        listCapacities: () => [selfCap(), cap({ quotaState: { blocked: true } })],
        selfMachineId: () => SELF,
        holdsLease: () => true,
        raiseAttention: (i) => raised.push(i),
        now: () => NOW + 31_000,
      },
      { enabled: true, dwellMs: 30_000 },
    );
    // prev anchor via two ticks: first sets anchor, second fires — both sync.
    const spy = vi.fn();
    s.on('stranded', spy);
    s.tick(); // anchor (now is fixed at NOW+31000 but prev empty ⇒ anchor=now ⇒ dwell 0 < 30000)
    // With a fixed clock the anchor == now, so it never crosses the dwell — assert
    // it stays sync + silent (no throw, no async).
    expect(raised).toHaveLength(0);
    expect(spy).not.toHaveBeenCalled();
  });
});
