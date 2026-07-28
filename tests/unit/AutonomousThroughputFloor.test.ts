import { describe, expect, it, vi } from 'vitest';
import { AutonomousThroughputFloor, deterministicHoldAllowed, hasMeaningfulDeliverableDelta, type DeliverableSnapshot, type ThroughputFloorRunState, type ThroughputRun } from '../../src/monitoring/AutonomousThroughputFloor.js';

const run: ThroughputRun = { signalRunId: 'topic:1:start', topicId: 1, startedAt: 1_000, telegramBacked: true, registeredMachineCount: 1, midMove: false };
const snap = (head: string, tree = head, descendsPrevious = false): DeliverableSnapshot => ({ merged: [], open: [{ number: 1, headSha: head, treeSha: tree, descendsPrevious }], digest: `${head}:${tree}` });

describe('AutonomousThroughputFloor PULL/AUDIT-only', () => {
  it('counts only merge identities or head+tree movement as deliverable output', () => {
    expect(hasMeaningfulDeliverableDelta(snap('a'), snap('a'))).toBe(false);
    expect(hasMeaningfulDeliverableDelta(snap('a', 'tree'), snap('b', 'tree'))).toBe(false);
    expect(hasMeaningfulDeliverableDelta(snap('a', 'tree-a'), snap('b', 'tree-b'))).toBe(false);
    expect(hasMeaningfulDeliverableDelta(snap('a', 'tree-a'), snap('b', 'tree-b', true))).toBe(true);
    expect(hasMeaningfulDeliverableDelta(snap('a'), { ...snap('a'), merged: [{ number: 2, mergeCommitSha: 'm' }] })).toBe(true);
  });

  it('preserves deterministic HOLD without claiming missing lane truth', () => {
    expect(deterministicHoldAllowed({ openApprovalGate: true, allNonGatedLanesSaturated: true })).toBe(true);
    expect(deterministicHoldAllowed({ openApprovalGate: true, allNonGatedLanesSaturated: false })).toBe(false);
  });

  it('audits a dual flatline without any action seam', async () => {
    let now = 10_000_000;
    const states = new Map<string, ThroughputFloorRunState>();
    states.set(run.signalRunId, { version: 1, signalRunId: run.signalRunId, lastSnapshot: snap('a'), lastDeliverableDeltaAt: now - 76 * 60_000, lastManagerOutboundAt: now - 76 * 60_000, consecutiveSweepFailures: 0, nextSweepAt: 0 });
    const audit = vi.fn();
    const floor = new AutonomousThroughputFloor({ listRuns: () => [run], sweep: async () => ({ status: 'ok', snapshot: snap('a'), meaningfulDelta: false }), observeOutbound: () => ({ coverage: 'proven' }), loadState: id => states.get(id) ?? null, saveState: (id, state) => states.set(id, state), audit, now: () => now }, { enabled: true });
    await floor.tick();
    expect(floor.status()).toMatchObject({ mode: 'pull-audit-only' });
    expect(floor.status().runs[0]).toMatchObject({ decision: 'flatline-observed', reason: 'dual-flatline' });
    expect(states.get(run.signalRunId)?.flatlineObservedAt).toBe(now);
  });

  it('persists exponential read backoff and opens a restart-safe breaker', async () => {
    let now = 20_000_000;
    const states = new Map<string, ThroughputFloorRunState>();
    const make = () => new AutonomousThroughputFloor({ listRuns: () => [run], sweep: async () => ({ status: 'unknown', failure: 'github-read' }), observeOutbound: () => ({ coverage: 'proven' }), loadState: id => states.get(id) ?? null, saveState: (id, state) => states.set(id, state), audit: () => {}, now: () => now }, { enabled: true });
    for (let i = 0; i < 4; i += 1) { const floor = make(); await floor.tick(); now = states.get(run.signalRunId)!.nextSweepAt; }
    const state = states.get(run.signalRunId)!;
    expect(state.consecutiveSweepFailures).toBe(4);
    expect(state.breakerOpenUntil).toBeGreaterThan(now - 1);
    now -= 1;
    const sweep = vi.fn();
    const restarted = new AutonomousThroughputFloor({ listRuns: () => [run], sweep, observeOutbound: () => ({ coverage: 'proven' }), loadState: () => state, saveState: () => {}, audit: () => {}, now: () => now }, { enabled: true });
    await restarted.tick();
    expect(sweep).not.toHaveBeenCalled();
  });

  it('does not infer historical flatline from a missing state file', async () => {
    const saved: ThroughputFloorRunState[] = [];
    const floor = new AutonomousThroughputFloor({ listRuns: () => [run], sweep: async () => ({ status: 'ok', snapshot: snap('a'), meaningfulDelta: false }), observeOutbound: () => ({ coverage: 'proven' }), loadState: () => null, saveState: (_id, state) => saved.push(state), audit: () => {}, now: () => 10_000_000 }, { enabled: true });
    await floor.tick();
    expect(floor.status().runs[0].decision).toBe('baseline');
    expect(saved[0].lastDeliverableDeltaAt).toBe(10_000_000);
  });

  it('fails closed on a corrupt sidecar instead of silently minting a baseline', async () => {
    const sweep = vi.fn();
    const save = vi.fn();
    const floor = new AutonomousThroughputFloor({ listRuns: () => [run], sweep, observeOutbound: () => ({ coverage: 'proven' }), loadState: () => ({ corrupt: true }), saveState: save, audit: () => {}, now: () => 10_000_000 }, { enabled: true });
    await floor.tick();
    expect(floor.status().runs[0]).toMatchObject({ decision: 'unknown', reason: 'state-corrupt' });
    expect(sweep).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });
});
