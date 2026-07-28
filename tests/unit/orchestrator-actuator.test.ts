/**
 * OrchestratorActuator — Tier-1 unit tests (spec: llm-seamlessness-orchestrator.md, Phase 2/3).
 * Covers the actuation guards (yield-to-failure, pins, provenance, fail-closed revalidate,
 * disk-byte budget), audit-BEFORE-actuate ordering, dryRun-actuates-nothing, the live fetch
 * path + coordinator-refusal handling, and the placement-signal (never a move) path.
 */
import { describe, it, expect, vi } from 'vitest';
import { OrchestratorActuator, type ActuatorDeps, type ActuationAuditEntry, type TopicPlacementView } from '../../src/core/OrchestratorActuator.js';
import type { OrchestratorProposal } from '../../src/core/SeamlessOrchestratorEngine.js';

const OK_VIEW: TopicPlacementView = { pinned: false, recentlyUserMoved: false, inFailureEpisode: false };

const preload = (topic = 1): OrchestratorProposal => ({
  action: 'preload-artifact', targetTopic: topic, detail: 'reports/x.md',
  authorityLevel: 'auto-prefetch', rankedBy: 'deterministic', dedupeKey: `${topic}+preload-artifact+reports/x.md`, score: 1,
});
const signal = (topic = 1): OrchestratorProposal => ({
  action: 'placement-signal', targetTopic: topic, detail: 'home=m-B focus=slack',
  authorityLevel: 'placement-signal', rankedBy: 'deterministic', dedupeKey: `${topic}+placement-signal+x`, score: 1,
});

function mkDeps(over: Partial<ActuatorDeps> = {}, audit: ActuationAuditEntry[] = []): ActuatorDeps {
  return {
    revalidate: () => OK_VIEW,
    budgetRemainingBytes: () => 10_000_000,
    estimatedBytes: () => 1000,
    fetchWorkingSet: async () => ({ ok: true, bytes: 1000 }),
    recordPlacementSignal: () => {},
    audit: (e) => audit.push(e),
    now: () => '2026-07-05T12:00:00.000Z',
    log: () => {},
    config: { dryRun: true },
    ...over,
  };
}

describe('actuation guards (yield-to-failure / pins / provenance / fail-closed)', () => {
  it('yields to a failure episode (refused, never actuates)', async () => {
    const audit: ActuationAuditEntry[] = [];
    const fetchWorkingSet = vi.fn(async () => ({ ok: true }));
    const act = new OrchestratorActuator(mkDeps({ revalidate: () => ({ ...OK_VIEW, inFailureEpisode: true }), fetchWorkingSet, config: { dryRun: false } }, audit));
    const r = await act.actuate(preload());
    expect(r.decision).toBe('refused');
    expect(r.refusalReason).toBe('yield-to-failure-movement');
    expect(fetchWorkingSet).not.toHaveBeenCalled();
    expect(audit[0].decision).toBe('refused');
  });
  it('respects a pin', async () => {
    const act = new OrchestratorActuator(mkDeps({ revalidate: () => ({ ...OK_VIEW, pinned: true }) }));
    expect((await act.actuate(preload())).refusalReason).toBe('topic-pinned');
  });
  it('respects recent user provenance', async () => {
    const act = new OrchestratorActuator(mkDeps({ revalidate: () => ({ ...OK_VIEW, recentlyUserMoved: true }) }));
    expect((await act.actuate(preload())).refusalReason).toBe('respect-user-provenance');
  });
  it('fails CLOSED when re-validation throws', async () => {
    const act = new OrchestratorActuator(mkDeps({ revalidate: () => { throw new Error('boom'); } }));
    const r = await act.actuate(preload());
    expect(r.decision).toBe('refused');
    expect(r.refusalReason).toMatch(/^revalidate-failed:/);
  });
  it('refuses when the disk-byte budget is exhausted', async () => {
    const act = new OrchestratorActuator(mkDeps({ budgetRemainingBytes: () => 500, estimatedBytes: () => 1000 }));
    expect((await act.actuate(preload())).refusalReason).toBe('disk-byte-budget-exhausted');
  });
});

describe('dryRun vs live (P3 soak + audit-before-actuate)', () => {
  it('dryRun logs would-actuate and actuates NOTHING', async () => {
    const audit: ActuationAuditEntry[] = [];
    const fetchWorkingSet = vi.fn(async () => ({ ok: true }));
    const act = new OrchestratorActuator(mkDeps({ fetchWorkingSet, config: { dryRun: true } }, audit));
    const r = await act.actuate(preload());
    expect(r.decision).toBe('would-actuate');
    expect(fetchWorkingSet).not.toHaveBeenCalled();
    expect(audit[0]).toMatchObject({ decision: 'would-actuate', dryRun: true });
  });
  it('live: AUDITS before the fetch (crash-mid-action leaves a trace)', async () => {
    const order: string[] = [];
    const audit = (e: ActuationAuditEntry) => order.push(`audit:${e.decision}`);
    const fetchWorkingSet = async () => { order.push('fetch'); return { ok: true, bytes: 1000 }; };
    const act = new OrchestratorActuator(mkDeps({ audit, fetchWorkingSet, config: { dryRun: false } }));
    const r = await act.actuate(preload());
    expect(r.decision).toBe('actuated');
    expect(order).toEqual(['audit:actuated', 'fetch']); // audit strictly BEFORE fetch
  });
  it('live: a coordinator refusal (secretFlagged/tooLarge) is a bounded no-op', async () => {
    const act = new OrchestratorActuator(mkDeps({ fetchWorkingSet: async () => ({ ok: false, skipReason: 'secretFlagged' }), config: { dryRun: false } }));
    const r = await act.actuate(preload());
    expect(r.decision).toBe('refused');
    expect(r.refusalReason).toBe('fetch-skip:secretFlagged');
  });
});

describe('placement-signal never moves anything', () => {
  it('dryRun records would-signal, no planner write', async () => {
    const recordPlacementSignal = vi.fn();
    const act = new OrchestratorActuator(mkDeps({ recordPlacementSignal, config: { dryRun: true } }));
    const r = await act.actuate(signal());
    expect(r.decision).toBe('would-signal');
    expect(recordPlacementSignal).not.toHaveBeenCalled();
  });
  it('live writes structured evidence to the planner (never a fetch/move)', async () => {
    const recordPlacementSignal = vi.fn();
    const fetchWorkingSet = vi.fn(async () => ({ ok: true }));
    const act = new OrchestratorActuator(mkDeps({ recordPlacementSignal, fetchWorkingSet, config: { dryRun: false } }));
    const r = await act.actuate(signal());
    expect(r.decision).toBe('signal-recorded');
    expect(recordPlacementSignal).toHaveBeenCalledOnce();
    expect(fetchWorkingSet).not.toHaveBeenCalled(); // NEVER moves
  });
});
