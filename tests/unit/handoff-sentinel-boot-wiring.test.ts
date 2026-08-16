/**
 * Wiring-integrity tests for createHandoffSentinelBootWiring (spec §8 G3e / §10).
 *
 * Per TESTING-INTEGRITY-SPEC Category 1: for a dependency-injected component,
 * prove (1) it is constructed non-null, (2) it is not a no-op, (3) it delegates
 * to the real components. Here that means: the boot wiring composes a real
 * HandoffSentinel; a full initiate() drives the real flush→verify→yield→demote
 * sequence against stub live components; and the glue (active-topic selection)
 * behaves correctly on both sides of its boundary.
 */

import { describe, it, expect } from 'vitest';
import {
  createHandoffSentinelBootWiring,
  pickActiveTopic,
  type SentinelBootTelegram,
} from '../../src/core/handoffSentinelBootWiring.js';
import type { HandoffAck } from '../../src/core/HandoffSentinel.js';
import type { ThreadEntry } from '../../src/core/handoffReceiverWiring.js';
import { hashTopicHistory } from '../../src/core/handoffReceiverWiring.js';

const HISTORY: ThreadEntry[] = [
  { timestamp: '2026-05-27T10:00:00Z', text: 'hello' },
  { timestamp: '2026-05-27T10:01:00Z', text: 'world' },
];

function telegramStub(history: ThreadEntry[], topics: number[] = [42]): SentinelBootTelegram {
  return {
    getIngressPosition: () => ({ platform: 'telegram', cursor: 999, capturedAt: '2026-05-27T10:02:00Z' }),
    getTopicHistory: () => history,
    getKnownTopicIds: () => topics,
  };
}

describe('pickActiveTopic', () => {
  it('picks the topic whose latest message is most recent', () => {
    const histories: Record<number, ThreadEntry[]> = {
      10: [{ timestamp: '2026-05-27T08:00:00Z', text: 'old' }],
      20: [{ timestamp: '2026-05-27T12:00:00Z', text: 'newest' }],
      30: [{ timestamp: '2026-05-27T09:30:00Z', text: 'mid' }],
    };
    const topic = pickActiveTopic(
      () => [10, 20, 30],
      (id) => histories[id] ?? [],
    );
    expect(topic).toBe(20);
  });

  it('falls back to the first known topic when histories are empty', () => {
    const topic = pickActiveTopic(() => [7, 8], () => []);
    expect(topic).toBe(7);
  });

  it('returns undefined when there are no known topics', () => {
    const topic = pickActiveTopic(() => [], () => []);
    expect(topic).toBeUndefined();
  });
});

describe('createHandoffSentinelBootWiring — wiring integrity', () => {
  it('constructs a non-null sentinel + initiate (not dead code)', () => {
    const wiring = createHandoffSentinelBootWiring({
      telegram: telegramStub(HISTORY),
      coordinator: { demoteToStandby: () => {} },
      liveTailSource: { pushTick: async () => 0 },
      wire: { sendBegin: async () => true, awaitAck: async () => null, sendYield: async () => true },
      handoffAckTimeoutMs: 1000,
      minHandoffIntervalMs: 0,
    });
    expect(wiring.sentinel).toBeDefined();
    expect(typeof wiring.initiate).toBe('function');
    expect(wiring.sentinel.inProgress).toBe(false);
  });

  it('initiate() delegates through all live components on the happy path', async () => {
    const calls: string[] = [];
    let begunManifest: { tailSeq: number; ingressPosition: HandoffAck['ingressPosition']; threadHistoryHash: string } | null = null;

    const wiring = createHandoffSentinelBootWiring({
      telegram: telegramStub(HISTORY),
      coordinator: { demoteToStandby: (reason) => { calls.push(`demote:${reason}`); } },
      liveTailSource: { pushTick: async () => { calls.push('pushTick'); return 1; } },
      wire: {
        sendBegin: async (m) => {
          calls.push('sendBegin');
          begunManifestCapture(m);
          return true;
        },
        // The incoming echoes the manifest verbatim (tailSeq + ingressPosition)
        // and recomputes the SAME hash from identical history → ackMatches passes.
        awaitAck: async () => {
          calls.push('awaitAck');
          return {
            tailSeq: begunManifest!.tailSeq,
            ingressPosition: begunManifest!.ingressPosition,
            threadHistoryHash: begunManifest!.threadHistoryHash,
          };
        },
        sendYield: async () => { calls.push('sendYield'); return true; },
      },
      handoffAckTimeoutMs: 1000,
      minHandoffIntervalMs: 0,
    });

    function begunManifestCapture(m: unknown): void {
      begunManifest = m as typeof begunManifest;
    }

    const outcome = await wiring.initiate();
    expect(outcome).toBe('handed-off');
    // Proves it is NOT a no-op and delegates to each real dependency, in order.
    expect(calls).toEqual(['pushTick', 'sendBegin', 'awaitAck', 'sendYield', 'demote:planned handoff: yielded to peer']);
    // The manifest hashed the active topic's history with the canonical fn.
    expect(begunManifest!.threadHistoryHash).toBe(hashTopicHistory(() => HISTORY, 42));
  });

  it('initiate() aborts (stay awake) and NEVER yields/demotes when the echo mismatches', async () => {
    const calls: string[] = [];
    const wiring = createHandoffSentinelBootWiring({
      telegram: telegramStub(HISTORY),
      coordinator: { demoteToStandby: () => { calls.push('demote'); } },
      liveTailSource: { pushTick: async () => 0 },
      wire: {
        sendBegin: async () => true,
        // A non-matching echo (wrong hash) → the sentinel must abort.
        awaitAck: async (): Promise<HandoffAck> => ({
          tailSeq: 0,
          ingressPosition: { platform: 'telegram', cursor: 999, capturedAt: '2026-05-27T10:02:00Z' },
          threadHistoryHash: 'totally-different-hash',
        }),
        sendYield: async () => { calls.push('yield'); return true; },
      },
      handoffAckTimeoutMs: 1000,
      minHandoffIntervalMs: 0,
    });

    const outcome = await wiring.initiate();
    expect(outcome).toBe('aborted-stay-awake');
    expect(calls).toEqual([]); // no yield, no demote — the no-two-holders invariant
  });
});
