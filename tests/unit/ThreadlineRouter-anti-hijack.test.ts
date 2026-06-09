/**
 * Unit tests for the ThreadlineRouter anti-hijack guard — Threadline Phase 1
 * keystone (spec §2, acceptance criterion #8).
 *
 * A threadId is NOT a bearer token. An UNVERIFIED peer presenting a threadId
 * that resolves to a conversation owned by a DIFFERENT participant must NOT be
 * resumed into that owner session — it is isolated to a fresh first-contact
 * thread, leaving the victim's conversation untouched. Crypto-verified peers
 * and identity-matching peers resume normally (no regression).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ThreadlineRouter } from '../../src/threadline/ThreadlineRouter.js';
import type { RelayMessageContext, ThreadlineRouterConfig } from '../../src/threadline/ThreadlineRouter.js';
import type { MessageEnvelope, AgentMessage } from '../../src/messaging/types.js';

function createMockMessageRouter() {
  return { getThread: vi.fn().mockResolvedValue({ messages: [] }) };
}
function createMockSpawnManager() {
  return {
    evaluate: vi.fn().mockResolvedValue({ approved: true, sessionId: 'uuid', tmuxSession: 'tmux', reason: 'ok' }),
    handleDenial: vi.fn(),
  };
}
function createMockThreadResumeMap() {
  const entries = new Map<string, any>();
  return {
    get: vi.fn((id: string) => entries.get(id) ?? null),
    save: vi.fn((id: string, entry: any) => entries.set(id, entry)),
    remove: vi.fn((id: string) => entries.delete(id)),
    resolve: vi.fn(),
    getByRemoteAgent: vi.fn().mockReturnValue([]),
    _set: (id: string, entry: any) => entries.set(id, entry),
  };
}

function ownedEntry(remoteAgent: string) {
  const now = new Date().toISOString();
  return {
    uuid: 'victim-session-uuid', sessionName: 'victim-tmux', createdAt: now, savedAt: now,
    lastAccessedAt: now, remoteAgent, subject: 'Owned thread', state: 'idle',
    pinned: false, messageCount: 3,
  };
}

function envelopeFrom(agent: string, threadId: string): MessageEnvelope {
  return {
    message: {
      id: 'msg-' + Math.random().toString(36).slice(2, 8),
      from: { agent, machine: 'remote' },
      to: { agent: 'LocalAgent', machine: 'local' },
      threadId,
      subject: 'hi',
      body: 'hello',
      createdAt: new Date().toISOString(),
      priority: 'normal',
    } as AgentMessage,
  } as MessageEnvelope;
}

function relayCtx(overrides: Partial<RelayMessageContext>): RelayMessageContext {
  const senderFingerprint = overrides.senderFingerprint ?? 'fp-x';
  return {
    trust: { kind: 'plaintext-tofu', senderFingerprint },
    senderFingerprint,
    senderName: overrides.senderName ?? 'Someone',
    trustLevel: 'verified',
    ...overrides,
  };
}

const config: ThreadlineRouterConfig = { localAgent: 'LocalAgent', localMachine: 'local', maxHistoryMessages: 20 };

describe('ThreadlineRouter — anti-hijack guard', () => {
  let router: ThreadlineRouter;
  let spawnManager: ReturnType<typeof createMockSpawnManager>;
  let threadResumeMap: ReturnType<typeof createMockThreadResumeMap>;

  beforeEach(() => {
    spawnManager = createMockSpawnManager();
    threadResumeMap = createMockThreadResumeMap();
    router = new ThreadlineRouter(
      createMockMessageRouter() as any,
      spawnManager as any,
      threadResumeMap as any,
      {} as any,
      config,
    );
  });

  it('isolates an unverified sender presenting a threadId owned by a different participant', async () => {
    const victimThreadId = 'owned-thread-abc';
    threadResumeMap._set(victimThreadId, ownedEntry('codey'));

    // Attacker (unverified, different identity) presents the victim's threadId.
    const result = await router.handleInboundMessage(
      envelopeFrom('attacker-fp', victimThreadId),
      relayCtx({ senderName: 'attacker', senderFingerprint: 'attacker-fp' }),
    );

    // The presented threadId is NOT used — a fresh one is minted (isolation).
    expect(result.threadId).not.toBe(victimThreadId);
    // The spawn was a NEW thread (first-contact), NOT a resume of the victim's.
    const reason = spawnManager.evaluate.mock.calls[0][0].reason as string;
    expect(reason).toMatch(/^New thread/);
    expect(reason).not.toMatch(/Resume thread/);
    // The victim's entry is untouched (not overwritten under its threadId).
    expect(threadResumeMap.save).not.toHaveBeenCalledWith(victimThreadId, expect.anything());
  });

  it('resumes normally when the unverified sender identity MATCHES the thread participant', async () => {
    const threadId = 'shared-thread-xyz';
    threadResumeMap._set(threadId, ownedEntry('codey'));

    const result = await router.handleInboundMessage(
      envelopeFrom('codey-fp', threadId),
      relayCtx({ senderName: 'codey', senderFingerprint: 'codey-fp' }),
    );

    expect(result.threadId).toBe(threadId);
    const reason = spawnManager.evaluate.mock.calls[0][0].reason as string;
    expect(reason).toMatch(/^Resume thread/);
  });

  it('resumes normally for a crypto-verified peer even if the display name differs', async () => {
    const threadId = 'verified-thread';
    threadResumeMap._set(threadId, ownedEntry('codey'));

    const result = await router.handleInboundMessage(
      envelopeFrom('codey-fp', threadId),
      relayCtx({ trust: { kind: 'verified', senderFingerprint: 'codey-fp' }, senderName: 'codey-rotated-name', senderFingerprint: 'codey-fp' }),
    );

    expect(result.threadId).toBe(threadId);
    const reason = spawnManager.evaluate.mock.calls[0][0].reason as string;
    expect(reason).toMatch(/^Resume thread/);
  });

  // ── Regression: composite-address canonicalization (relay-send fix) ──
  // The relay path on a plaintext-tofu inbound has trust.kind !== 'verified',
  // so the guard falls through to the identity match. A known peer's reply over
  // the relay carries its FULL fingerprint as senderFingerprint and frequently
  // an EMPTY senderName. The thread owner must therefore be stored as that full
  // fingerprint for the reply to resume — which is exactly what the /threadline/
  // relay-send `captureOrigin` fix now does (store resolvedId, not the raw
  // "name:fpPrefix" target the caller typed).

  it('resumes when the stored owner is the peer full fingerprint and the reply presents that fingerprint with EMPTY senderName (the Dawn case, post-fix storage)', async () => {
    const threadId = 'fp-owned-thread';
    const peerFp = '8c7928aa9f04fbda947172a2f9b2d81a';
    threadResumeMap._set(threadId, ownedEntry(peerFp));

    const result = await router.handleInboundMessage(
      envelopeFrom(peerFp, threadId),
      relayCtx({ senderName: '', senderFingerprint: peerFp }),
    );

    expect(result.threadId).toBe(threadId);
    const reason = spawnManager.evaluate.mock.calls[0][0].reason as string;
    expect(reason).toMatch(/^Resume thread/);
  });

  it('isolates when the stored owner is a composite "name:fpPrefix" and the reply presents the bare full fingerprint (the bug the relay-send canonicalization prevents)', async () => {
    const threadId = 'composite-owned-thread';
    const peerFp = '8c7928aa9f04fbda947172a2f9b2d81a';
    // OLD buggy storage: the composite address was stored un-resolved, so the
    // guard cannot match it against the reply's bare full fingerprint.
    threadResumeMap._set(threadId, ownedEntry('Dawn-Workstation:8c7928aa'));

    const result = await router.handleInboundMessage(
      envelopeFrom(peerFp, threadId),
      relayCtx({ senderName: '', senderFingerprint: peerFp }),
    );

    // Isolation under the OLD storage proves WHY the send path must store the
    // resolved full fingerprint — with the fix the owner is `peerFp` and the
    // previous test resumes instead of cold-spawning.
    expect(result.threadId).not.toBe(threadId);
    const reason = spawnManager.evaluate.mock.calls[0][0].reason as string;
    expect(reason).toMatch(/^New thread/);
  });

  // ── Regression: same-machine local-delivery topic linkage (relay-agent fix) ──
  // The /messages/relay-agent route (same-machine only) previously called
  // handleInboundMessage with NO relayContext, so the guard saw the sender's
  // NAME as its only identity while the thread stores the peer FINGERPRINT —
  // a name-vs-fingerprint mismatch that isolated EVERY co-located reply to a
  // fresh thread (no originTopicId → fell to the hub topic). The fix resolves
  // the local sender's name -> registry fingerprint and passes a proper relay
  // context. These two tests model that context at the router boundary: with
  // the resolved fingerprint the co-located reply resumes (topic linkage holds);
  // without it (the pre-fix no-context shape) it still isolates — proving the
  // fix is what makes the difference, and that the strict guard is preserved.

  it('resumes a co-located peer reply when the route resolved its name to the owner fingerprint (the relay-agent fix)', async () => {
    const threadId = 'local-topic-thread';
    const peerFp = '1db85f00aa11bb22cc33dd44ee55ff66';
    // Owner stored as the peer's full fingerprint (captureOrigin on the send).
    threadResumeMap._set(threadId, ownedEntry(peerFp));

    // The fix's relay context: sender NAME from the envelope, FINGERPRINT
    // resolved from the local agent registry, honest plaintext-tofu trust.
    const result = await router.handleInboundMessage(
      envelopeFrom('sagemind', threadId),
      relayCtx({ senderName: 'sagemind', senderFingerprint: peerFp }),
    );

    expect(result.threadId).toBe(threadId);
    const reason = spawnManager.evaluate.mock.calls[0][0].reason as string;
    expect(reason).toMatch(/^Resume thread/);
  });

  it('still isolates a co-located reply when no fingerprint could be resolved (pre-fix no-context shape) — guard preserved', async () => {
    const threadId = 'local-topic-thread-2';
    const peerFp = '1db85f00aa11bb22cc33dd44ee55ff66';
    threadResumeMap._set(threadId, ownedEntry(peerFp));

    // Pre-fix shape: only the NAME is known (no relay context resolved the
    // fingerprint), so the name cannot match the fingerprint owner → isolate.
    const result = await router.handleInboundMessage(
      envelopeFrom('sagemind', threadId),
      relayCtx({ senderName: 'sagemind', senderFingerprint: 'sagemind' }),
    );

    expect(result.threadId).not.toBe(threadId);
    const reason = spawnManager.evaluate.mock.calls[0][0].reason as string;
    expect(reason).toMatch(/^New thread/);
  });
});
