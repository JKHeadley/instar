/**
 * OrchestratorPoller — Tier-1 unit tests (spec: llm-seamlessness-orchestrator.md, P1/P3).
 * Covers: drives every proposal through the actuator, records per-topic actuation (cooldown
 * feed), reentrancy guard, idle-backoff bookkeeping, and the coarse error breaker.
 */
import { describe, it, expect, vi } from 'vitest';
import { OrchestratorPoller, type OrchestratorPollerOptions } from '../../src/monitoring/OrchestratorPoller.js';
import type { OrchestratorPassResult, OrchestratorProposal } from '../../src/core/SeamlessOrchestratorEngine.js';
import type { ActuationResult } from '../../src/core/OrchestratorActuator.js';

const proposal = (topic: number, detail = 'a.md'): OrchestratorProposal => ({
  action: 'preload-artifact', targetTopic: topic, detail, authorityLevel: 'auto-prefetch',
  rankedBy: 'deterministic', dedupeKey: `${topic}+preload-artifact+${detail}`, score: 1,
});
const pass = (proposals: OrchestratorProposal[], over: Partial<OrchestratorPassResult> = {}): OrchestratorPassResult => ({
  ranProposePath: true, suspended: false, candidateCount: proposals.length, proposals, llmInvoked: false, reason: 'ok', ...over,
});

function mkPoller(over: Partial<OrchestratorPollerOptions> = {}) {
  const actuate = vi.fn(async (): Promise<ActuationResult> => ({ decision: 'would-actuate' }));
  const recordActuated = vi.fn();
  const opts: OrchestratorPollerOptions = {
    engine: { pass: async () => pass([]) },
    actuator: { actuate },
    recordActuated,
    now: () => 1000,
    log: () => {},
    ...over,
  };
  return { poller: new OrchestratorPoller(opts), actuate, recordActuated };
}

describe('OrchestratorPoller drive + record', () => {
  it('actuates every proposal + records per-topic actuation (cooldown feed)', async () => {
    const { poller, actuate, recordActuated } = mkPoller({
      engine: { pass: async () => pass([proposal(1), proposal(2)]) },
    });
    const r = await poller.tick();
    expect(actuate).toHaveBeenCalledTimes(2);
    expect(r).toMatchObject({ proposalCount: 2, actuated: 2, refused: 0 });
    expect(recordActuated).toHaveBeenCalledWith(1, 1000);
    expect(recordActuated).toHaveBeenCalledWith(2, 1000);
  });

  it('a refused proposal counts as refused + does NOT record actuation', async () => {
    const actuate = vi.fn(async (): Promise<ActuationResult> => ({ decision: 'refused', refusalReason: 'topic-pinned' }));
    const { poller, recordActuated } = mkPoller({
      engine: { pass: async () => pass([proposal(1)]) },
      actuator: { actuate },
    });
    const r = await poller.tick();
    expect(r).toMatchObject({ actuated: 0, refused: 1 });
    expect(recordActuated).not.toHaveBeenCalled();
  });

  it('a standby/suspended pass (no proposals) drives nothing', async () => {
    const { poller, actuate } = mkPoller({
      engine: { pass: async () => pass([], { ranProposePath: false, reason: 'not-lease-holder' }) },
    });
    const r = await poller.tick();
    expect(actuate).not.toHaveBeenCalled();
    expect(r).toMatchObject({ ranProposePath: false, proposalCount: 0, reason: 'not-lease-holder' });
  });
});

describe('OrchestratorPoller safety (reentrancy + breaker)', () => {
  it('reentrancy guard: a second tick while one is running is a no-op', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const engine = { pass: vi.fn(async () => { await gate; return pass([proposal(1)]); }) };
    const { poller } = mkPoller({ engine });
    const first = poller.tick();
    const second = await poller.tick(); // runs while first is still awaiting the gate
    expect(second).toBeNull();
    expect(engine.pass).toHaveBeenCalledTimes(1);
    release();
    await first;
  });

  it('opens the breaker after N consecutive tick errors (never throws)', async () => {
    const engine = { pass: vi.fn(async () => { throw new Error('boom'); }) };
    const { poller } = mkPoller({ engine, errorTicksToBreak: 3, onError: () => {} } as Partial<OrchestratorPollerOptions>);
    expect(await poller.tick()).toBeNull();
    expect(await poller.tick()).toBeNull();
    expect(poller.isBreakerOpen()).toBe(false);
    expect(await poller.tick()).toBeNull(); // 3rd error → breaker opens
    expect(poller.isBreakerOpen()).toBe(true);
  });

  it('a successful tick after errors closes the breaker + resets error count', async () => {
    let fail = true;
    const engine = { pass: vi.fn(async () => { if (fail) throw new Error('x'); return pass([]); }) };
    const { poller } = mkPoller({ engine, errorTicksToBreak: 1, onError: () => {} } as Partial<OrchestratorPollerOptions>);
    await poller.tick();
    expect(poller.isBreakerOpen()).toBe(true);
    fail = false;
    await poller.tick();
    expect(poller.isBreakerOpen()).toBe(false);
  });
});
