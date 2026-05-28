/**
 * Wiring-integrity tests for createHandoffReceiverWiring (spec §8 G3d/G3e).
 *
 * Proves the incoming-machine binding composes correctly with a real
 * HandoffReceiver: a begin manifest drives a caught-up ack whose echo matches the
 * outgoing's flush ONLY when this machine's synced history hashes the same, and a
 * yield drives the lease CAS with the begin's originating machine id — never on
 * the ack alone.
 */

import { describe, it, expect, vi } from 'vitest';
import { createHandoffReceiverWiring, hashTopicHistory } from '../../src/core/handoffReceiverWiring.js';
import type { HandoffAck } from '../../src/core/HandoffSentinel.js';
import type { ThreadEntry } from '../../src/core/handoffReceiverWiring.js';

const history: Record<number, ThreadEntry[]> = {
  42: [
    { timestamp: '2026-05-27T00:00:00Z', text: 'hello' },
    { timestamp: '2026-05-27T00:01:00Z', text: 'world' },
  ],
};
const getTopicHistory = (topic: number) => history[topic] ?? [];

function manifest(overrides: Partial<{ tailSeq: number; threadHistoryHash: string; topic: number }> = {}) {
  return {
    tailSeq: overrides.tailSeq ?? 7,
    ingressPosition: { platform: 'telegram', cursor: 555, capturedAt: '2026-05-27T00:02:00Z' },
    // Outgoing's own hash of topic 42 — what a caught-up incoming must reproduce.
    threadHistoryHash: overrides.threadHistoryHash ?? hashTopicHistory(getTopicHistory, 42),
    topic: overrides.topic ?? 42,
  };
}

describe('createHandoffReceiverWiring', () => {
  it('begin → builds a caught-up ack echoing tailSeq + ingressPosition + a matching hash', async () => {
    let sent: HandoffAck | null = null;
    const wiring = createHandoffReceiverWiring({
      sendAck: async (ack) => { sent = ack; return true; },
      acquireLeaseOnConsent: async () => true,
      getTopicHistory,
    });

    const m = manifest();
    wiring.onBegin(m, 'm_outgoing');
    // onBeginHandoff is async (build + send) — let microtasks flush.
    await vi.waitFor(() => expect(sent).not.toBeNull());

    expect(sent!.tailSeq).toBe(7);
    expect(sent!.ingressPosition.cursor).toBe(555);
    // Caught-up: our recomputed hash equals what the outgoing flushed.
    expect(sent!.threadHistoryHash).toBe(m.threadHistoryHash);
    expect(wiring.receiver.state).toBe('ack_sent');
  });

  it('NOT caught up → the recomputed hash differs from the manifest, so the echo will not verify', async () => {
    let sent: HandoffAck | null = null;
    // This machine's history for topic 42 is missing the second message.
    const staleHistory: Record<number, ThreadEntry[]> = { 42: [{ timestamp: '2026-05-27T00:00:00Z', text: 'hello' }] };
    const wiring = createHandoffReceiverWiring({
      sendAck: async (ack) => { sent = ack; return true; },
      acquireLeaseOnConsent: async () => true,
      getTopicHistory: (t: number) => staleHistory[t] ?? [],
    });

    const m = manifest(); // hash computed over the FULL history
    wiring.onBegin(m, 'm_outgoing');
    await vi.waitFor(() => expect(sent).not.toBeNull());

    expect(sent!.threadHistoryHash).not.toBe(m.threadHistoryHash);
  });

  it('yield → drives acquireLeaseOnConsent with the begin originator, only after an ack', async () => {
    const acquire = vi.fn(async () => true);
    const wiring = createHandoffReceiverWiring({
      sendAck: async () => true,
      acquireLeaseOnConsent: acquire,
      getTopicHistory,
    });

    // A bare yield with no handoff in progress is ignored (no CAS).
    wiring.yieldHandler();
    await Promise.resolve();
    expect(acquire).not.toHaveBeenCalled();

    // Begin → ack_sent, THEN yield → CAS with the originating machine id.
    wiring.onBegin(manifest(), 'm_outgoing');
    await vi.waitFor(() => expect(wiring.receiver.state).toBe('ack_sent'));
    wiring.yieldHandler();
    await vi.waitFor(() => expect(acquire).toHaveBeenCalledWith('m_outgoing'));
    await vi.waitFor(() => expect(wiring.receiver.state).toBe('acquired'));
  });
});
