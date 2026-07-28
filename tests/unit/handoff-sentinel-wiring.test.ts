/**
 * Wiring-integrity tests for createHandoffSentinelWiring (spec §8 G3e).
 *
 * Proves the outgoing-machine binding composes correctly with a real
 * HandoffSentinel: a verified, validated ack drives the full
 * flush → ack → yield → demote sequence, while a mismatched echo or an absent
 * ack ABORTS and the machine stays awake (the lease is never yielded unverified).
 */

import { describe, it, expect, vi } from 'vitest';
import { createHandoffSentinelWiring } from '../../src/core/handoffSentinelWiring.js';
import type { FlushManifest, HandoffAck } from '../../src/core/HandoffSentinel.js';
import type { ThreadEntry } from '../../src/core/handoffReceiverWiring.js';

const history: Record<number, ThreadEntry[]> = {
  42: [
    { timestamp: '2026-05-27T00:00:00Z', text: 'hello' },
    { timestamp: '2026-05-27T00:01:00Z', text: 'world' },
  ],
};
const getTopicHistory = (topic: number) => history[topic] ?? [];

function baseDeps(overrides: Partial<Parameters<typeof createHandoffSentinelWiring>[0]> = {}) {
  let captured: (FlushManifest & { topic?: number }) | null = null;
  const calls = { pushTick: 0, yield: 0, demote: 0 };
  const deps = {
    pushTick: async () => { calls.pushTick++; },
    getIngressPosition: () => ({ platform: 'telegram', cursor: 100, capturedAt: '2026-05-27T00:02:00Z' }),
    getTopicHistory,
    activeTopic: () => 42 as number | undefined,
    lastTailSeq: () => 5,
    postBegin: async (m: FlushManifest & { topic?: number }) => { captured = m; return true; },
    // default: echo the captured manifest exactly → ackMatches passes
    awaitAck: async (): Promise<HandoffAck | null> =>
      captured && { tailSeq: captured.tailSeq, ingressPosition: captured.ingressPosition, threadHistoryHash: captured.threadHistoryHash },
    sendYield: async () => { calls.yield++; return true; },
    demoteSelf: () => { calls.demote++; },
    handoffAckTimeoutMs: 1000,
    minHandoffIntervalMs: 0,
    ...overrides,
  };
  return { deps, calls, getCaptured: () => captured };
}

describe('createHandoffSentinelWiring', () => {
  it('verified + validated ack → flush, yield, demote, handed-off', async () => {
    const { deps, calls, getCaptured } = baseDeps();
    const { initiate } = createHandoffSentinelWiring(deps);

    const outcome = await initiate();

    expect(outcome).toBe('handed-off');
    expect(calls.pushTick).toBe(1);
    expect(calls.yield).toBe(1);
    expect(calls.demote).toBe(1);
    // The flushed manifest carries the active topic + a hash of its history.
    expect(getCaptured()!.topic).toBe(42);
    expect(getCaptured()!.threadHistoryHash).toHaveLength(64);
  });

  it('mismatched ack echo → abort, stay awake, NEVER yields', async () => {
    const { deps, calls } = baseDeps({
      awaitAck: async () => ({
        tailSeq: 5,
        ingressPosition: { platform: 'telegram', cursor: 100, capturedAt: 'x' },
        threadHistoryHash: 'not-the-flushed-hash', // standby was not caught up
      }),
    });
    const { initiate } = createHandoffSentinelWiring(deps);

    const outcome = await initiate();

    expect(outcome).toBe('aborted-stay-awake');
    expect(calls.yield).toBe(0);
    expect(calls.demote).toBe(0);
  });

  it('no ack within the timeout → abort, stay awake, NEVER yields', async () => {
    const { deps, calls } = baseDeps({ awaitAck: async () => null });
    const { initiate } = createHandoffSentinelWiring(deps);

    const outcome = await initiate();

    expect(outcome).toBe('aborted-stay-awake');
    expect(calls.yield).toBe(0);
    expect(calls.demote).toBe(0);
  });

  it('a failed validation → abort, stay awake, NEVER yields', async () => {
    const { deps, calls } = baseDeps({ validate: async () => false });
    const { initiate } = createHandoffSentinelWiring(deps);

    const outcome = await initiate();

    expect(outcome).toBe('aborted-stay-awake');
    expect(calls.yield).toBe(0);
    expect(calls.demote).toBe(0);
  });

  it('a begin POST that no peer accepts → flush throws → failed, no yield', async () => {
    const { deps, calls } = baseDeps({ postBegin: async () => false });
    const { initiate } = createHandoffSentinelWiring(deps);

    const outcome = await initiate();

    expect(outcome).toBe('failed');
    expect(calls.yield).toBe(0);
    expect(calls.demote).toBe(0);
  });
});
