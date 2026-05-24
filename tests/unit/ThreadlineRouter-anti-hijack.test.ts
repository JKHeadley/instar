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
});
