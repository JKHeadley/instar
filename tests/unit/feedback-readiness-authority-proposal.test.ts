/**
 * The server-computed readiness authority proposal (feedback-factory-operating-drain §2).
 *
 * The operator approves from the dashboard and never types technical fields, so the
 * proposal must carry exactly the values the drain tick (canAgentMutateReadiness) and the
 * arbiter (prompt/schema/decision point + resolved provider/model) later compare. Both
 * sides of every decision are covered: approvable vs blocked, and each status → action.
 */
import { describe, it, expect } from 'vitest';
import {
  buildReadinessAuthorityProposal,
  reportedModelFor,
  envelopeProblems,
  plainSummary,
  READINESS_AUTHORITY_ID,
} from '../../src/feedback-factory/drain/readinessAuthorityProposal.js';
import {
  FeedbackReadinessArbiter,
  FEEDBACK_READINESS_DECISION_POINT,
  FEEDBACK_READINESS_PROMPT_ID,
  FEEDBACK_READINESS_SCHEMA_ID,
} from '../../src/feedback-factory/drain/FeedbackReadinessArbiter.js';
import { resolveCliModelFlag } from '../../src/providers/adapters/openai-codex/models.js';
import type { AuthorityRecord } from '../../src/feedback-factory/drain/FeedbackDrainStore.js';
import type { IntelligenceOptions } from '../../src/core/types.js';

const BASE = {
  agentId: 'echo',
  binding: { ownerMachineId: 'm_owner', ownerEpoch: 3 },
  route: { framework: 'codex-cli' as const, model: 'gpt-5.5' },
  current: null,
};

function record(over: Partial<AuthorityRecord> = {}): AuthorityRecord {
  return {
    authorityId: READINESS_AUTHORITY_ID, agentId: 'echo', ownerMachineId: 'm_owner', ownerEpoch: 3,
    provider: 'codex-cli', modelFamily: 'gpt-5.5', promptVersion: FEEDBACK_READINESS_PROMPT_ID,
    schemaVersion: FEEDBACK_READINESS_SCHEMA_ID, decisionPointId: FEEDBACK_READINESS_DECISION_POINT,
    maxBatch: 50, maxTokens: 1200, maxDailySpendUsd: 5, generation: 1, revoked: false, ...over,
  };
}

describe('buildReadinessAuthorityProposal', () => {
  it('fresh machine: proposes a create bound to this machine with the approved 50 / $5 envelope', () => {
    const p = buildReadinessAuthorityProposal(BASE);
    expect(p.status).toBe('none');
    expect(p.approveAction).toBe('create');
    expect(p.blockers).toEqual([]);
    expect(p.proposal).toEqual({
      authorityId: 'feedback-readiness-default', agentId: 'echo', ownerMachineId: 'm_owner', ownerEpoch: 3,
      provider: 'codex-cli', modelFamily: 'gpt-5.5',
      promptVersion: FEEDBACK_READINESS_PROMPT_ID, schemaVersion: FEEDBACK_READINESS_SCHEMA_ID,
      decisionPointId: FEEDBACK_READINESS_DECISION_POINT, maxBatch: 50, maxTokens: 1200, maxDailySpendUsd: 5,
    });
    expect(p.summary).toBe('Let the sorting model decide which feedback reports become work items: up to 50 reports per batch, at most $5 per day. Anything outside that comes to you. An answer that fails the checks is set aside and retried; it pauses itself only at the daily cap, if a different model answers, or after three runs in a row with no usable answer.');
  });

  it('no operated host configured → blocked, no action', () => {
    const p = buildReadinessAuthorityProposal({ ...BASE, binding: { ownerMachineId: null, ownerEpoch: 1 } });
    expect(p.proposal).toBeNull();
    expect(p.approveAction).toBeNull();
    expect(p.blockers.join(' ')).toMatch(/No machine is configured/);
  });

  it('no model route → blocked, no action', () => {
    const p = buildReadinessAuthorityProposal({ ...BASE, route: null });
    expect(p.approveAction).toBeNull();
    expect(p.blockers.join(' ')).toMatch(/No model is currently available/);
  });

  it('out-of-range envelope → blocked with the plain reason', () => {
    const p = buildReadinessAuthorityProposal({ ...BASE, envelope: { maxBatch: 51 } });
    expect(p.approveAction).toBeNull();
    expect(p.blockers).toContain('Batch size must be a whole number from 1 to 50.');
  });

  it('active and matching → nothing to approve (Revoke is the only change)', () => {
    const p = buildReadinessAuthorityProposal({ ...BASE, current: record(), currentMode: 'active' });
    expect(p.status).toBe('active');
    expect(p.current?.matchesProposal).toBe(true);
    expect(p.approveAction).toBeNull();
  });

  it('active but the owner epoch moved → replace (the tick would 403 on the stale record)', () => {
    const p = buildReadinessAuthorityProposal({ ...BASE, current: record({ ownerEpoch: 2 }), currentMode: 'active' });
    expect(p.current?.matchesProposal).toBe(false);
    expect(p.approveAction).toBe('replace');
  });

  it('active record keeps its envelope unless the operator edits it', () => {
    const kept = buildReadinessAuthorityProposal({ ...BASE, current: record({ maxBatch: 20, maxDailySpendUsd: 2 }), currentMode: 'active' });
    expect(kept.proposal).toMatchObject({ maxBatch: 20, maxDailySpendUsd: 2 });
    expect(kept.approveAction).toBeNull();
    const edited = buildReadinessAuthorityProposal({ ...BASE, current: record({ maxBatch: 20 }), currentMode: 'active', envelope: { maxBatch: 30 } });
    expect(edited.proposal?.maxBatch).toBe(30);
    expect(edited.approveAction).toBe('replace');
  });

  it('demoted by a safety brake (proposal-only) → replace makes a fresh active generation', () => {
    const p = buildReadinessAuthorityProposal({ ...BASE, current: record(), currentMode: 'proposal-only', currentModeReason: 'readiness-authority-repeated-invocation-failure' });
    expect(p.status).toBe('proposal-only');
    expect(p.pausedBecause).toBe('Three runs in a row produced no usable answer (timeouts, provider errors, or answers that failed the checks).');
    expect(buildReadinessAuthorityProposal({ ...BASE, current: record() }).pausedBecause).toBeNull();
    expect(p.approveAction).toBe('replace');
  });

  it('revoked → restore first (the store refuses replace on a revoked record)', () => {
    const p = buildReadinessAuthorityProposal({ ...BASE, current: record({ revoked: true, generation: 2 }) });
    expect(p.status).toBe('revoked');
    expect(p.approveAction).toBe('restore');
  });
});

describe('reportedModelFor — the string the provider reports via onModel', () => {
  it('codex-cli uses the same resolver as CodexCliIntelligenceProvider', () => {
    expect(reportedModelFor('codex-cli', 'capable')).toBe(resolveCliModelFlag('capable'));
    expect(reportedModelFor('codex-cli', 'gpt-5.5')).toBe('gpt-5.5');
  });
  it('pi-cli reports its configured pattern and has no model without one', () => {
    expect(reportedModelFor('pi-cli', 'gpt-5.5', 'openai-codex/gpt-5.5')).toBe('openai-codex/gpt-5.5');
    expect(reportedModelFor('pi-cli', 'gpt-5.5')).toBeNull();
  });
});

describe('envelope checks mirror FeedbackDrainStore.mutateAuthority', () => {
  it('accepts the bounds and rejects just outside them', () => {
    expect(envelopeProblems({ maxBatch: 1, maxTokens: 128, maxDailySpendUsd: 0.01 })).toEqual([]);
    expect(envelopeProblems({ maxBatch: 50, maxTokens: 100_000, maxDailySpendUsd: 1000 })).toEqual([]);
    expect(envelopeProblems({ maxBatch: 0, maxTokens: 127, maxDailySpendUsd: 0 })).toHaveLength(3);
  });
  it('the plain summary follows the envelope', () => {
    expect(plainSummary({ maxBatch: 10, maxTokens: 1200, maxDailySpendUsd: 2 })).toContain('up to 10 reports per batch, at most $2 per day');
  });
});

/**
 * Replay of REAL recorded shapes (read-only, Mac Studio .instar/server-data/feature-metrics.db,
 * feature_metrics rows model='gpt-6-astra' framework='codex-cli' — 221 successful
 * StandardsConformanceReviewer 'capable' calls, latest 2026-09-30 02:45 UTC). The live
 * router resolves the arbiter's gate call to codex-cli (nature routing observe-only there),
 * so this is the (model, framework) the arbiter's onModel will carry. An authority built
 * from the proposal must pass the arbiter's provider/model check on that shape, and must
 * still refuse the retirement-fallback shape (gpt-5.6-sol) rather than accept drift.
 */
describe('proposal-built authority vs the arbiter, on recorded live shapes', () => {
  const candidate = { clusterId: 'c1', title: 'Scheduler crash', type: 'bug', reportCount: 3, firstSeenAt: 1, lastSeenAt: 2, evidenceIds: ['cluster:c1'] };
  const liveRoute = { framework: 'codex-cli' as const, model: 'capable' };
  const arbiterWith = (reported: { model: string; framework: string }) => new FeedbackReadinessArbiter({
    evaluate: async (_p: string, o?: IntelligenceOptions) => {
      o?.onModel?.(reported);
      return JSON.stringify({ decisions: [{ clusterId: 'c1', outcome: 'ready', confidence: 0.9, reasonCodes: ['coherent-recurrence'], evidenceIds: ['cluster:c1'] }] });
    },
  });
  const authority = (): AuthorityRecord => ({ ...buildReadinessAuthorityProposal({ ...BASE, route: liveRoute }).proposal!, generation: 1, revoked: false });

  it('recorded shape codex-cli/gpt-6-astra → the arbiter accepts and decides', async () => {
    expect(authority()).toMatchObject({ provider: 'codex-cli', modelFamily: 'gpt-6-astra' });
    const decisions = await arbiterWith({ model: 'gpt-6-astra', framework: 'codex-cli' }).decideBatch(authority(), [candidate]);
    expect(decisions[0]).toMatchObject({ clusterId: 'c1', outcome: 'ready' });
  });

  it('retirement-fallback shape codex-cli/gpt-5.6-sol → refused (model drift is not silently accepted)', async () => {
    await expect(arbiterWith({ model: 'gpt-5.6-sol', framework: 'codex-cli' }).decideBatch(authority(), [candidate]))
      .rejects.toThrow(/resolved model does not match/);
  });
});
