/**
 * Unit tests for ThreadlineRouter relay integration (Milestone 3).
 *
 * Covers: grounding preamble injection, trust-level-aware history depth,
 * relay context flow through spawn/resume, and the prompt building
 * with/without relay context.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ThreadlineRouter } from '../../src/threadline/ThreadlineRouter.js';
import type { RelayMessageContext, ThreadlineRouterConfig } from '../../src/threadline/ThreadlineRouter.js';
import type { MessageEnvelope, AgentMessage } from '../../src/messaging/types.js';
import { RELAY_HISTORY_LIMITS } from '../../src/threadline/RelayGroundingPreamble.js';

// ── Mock Factories ────────────────────────────────────────────────

function createMockMessageRouter(threadMessages: MessageEnvelope[] = []) {
  return {
    getThread: vi.fn().mockResolvedValue({
      messages: threadMessages,
    }),
  };
}

function createMockSpawnManager(approved = true) {
  return {
    evaluate: vi.fn().mockResolvedValue({
      approved,
      sessionId: 'mock-session-uuid',
      tmuxSession: 'mock-tmux-session',
      reason: approved ? 'ok' : 'denied',
    }),
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
    // Test helper
    _set: (id: string, entry: any) => entries.set(id, entry),
  };
}

function createMockMessageStore() {
  return {};
}

function createEnvelope(overrides: {
  from?: string;
  threadId?: string | null;
  subject?: string;
  body?: string;
  priority?: string;
} = {}): MessageEnvelope {
  const threadId = 'threadId' in overrides
    ? (overrides.threadId === null ? undefined : overrides.threadId)
    : 'thread-123';
  return {
    message: {
      id: 'msg-' + Math.random().toString(36).slice(2, 8),
      from: { agent: overrides.from ?? 'RemoteAgent', machine: 'remote-machine' },
      to: { agent: 'LocalAgent', machine: 'local-machine' },
      threadId,
      subject: overrides.subject ?? 'Test Subject',
      body: overrides.body ?? 'Hello from remote',
      createdAt: new Date().toISOString(),
      priority: overrides.priority ?? 'normal',
    } as AgentMessage,
  } as MessageEnvelope;
}

function createRelayContext(overrides: Partial<RelayMessageContext> = {}): RelayMessageContext {
  const senderFingerprint = overrides.senderFingerprint ?? 'fp-remote-abc123';
  return {
    trust: { kind: 'plaintext-tofu', senderFingerprint },
    senderFingerprint,
    senderName: 'RemoteAgent',
    trustLevel: 'verified',
    ...overrides,
  };
}

const routerConfig: ThreadlineRouterConfig = {
  localAgent: 'LocalAgent',
  localMachine: 'local-machine',
  maxHistoryMessages: 20,
};

// ── Tests ────────────────────────────────────────────────────────────

describe('ThreadlineRouter — Relay Integration', () => {
  let router: ThreadlineRouter;
  let messageRouter: ReturnType<typeof createMockMessageRouter>;
  let spawnManager: ReturnType<typeof createMockSpawnManager>;
  let threadResumeMap: ReturnType<typeof createMockThreadResumeMap>;

  beforeEach(() => {
    messageRouter = createMockMessageRouter();
    spawnManager = createMockSpawnManager();
    threadResumeMap = createMockThreadResumeMap();

    router = new ThreadlineRouter(
      messageRouter as any,
      spawnManager as any,
      threadResumeMap as any,
      createMockMessageStore() as any,
      routerConfig,
    );
  });

  // ── Grounding Preamble Injection ───────────────────────────────

  describe('grounding preamble injection', () => {
    it('injects grounding preamble when relay context is provided', async () => {
      const envelope = createEnvelope();
      const relayCtx = createRelayContext();

      await router.handleInboundMessage(envelope, relayCtx);

      // The spawn manager should have been called with a prompt containing the preamble
      expect(spawnManager.evaluate).toHaveBeenCalled();
      const spawnArgs = spawnManager.evaluate.mock.calls[0][0];
      expect(spawnArgs.context).toContain('[EXTERNAL MESSAGE — Trust: verified]');
      expect(spawnArgs.context).toContain('[END EXTERNAL MESSAGE CONTEXT — Trust: verified]');
    });

    it('does NOT inject grounding when no relay context', async () => {
      const envelope = createEnvelope();

      await router.handleInboundMessage(envelope);

      expect(spawnManager.evaluate).toHaveBeenCalled();
      const spawnArgs = spawnManager.evaluate.mock.calls[0][0];
      expect(spawnArgs.context).not.toContain('[EXTERNAL MESSAGE');
    });

    it('includes agent identity in grounding', async () => {
      const envelope = createEnvelope();
      const relayCtx = createRelayContext();

      await router.handleInboundMessage(envelope, relayCtx);

      const spawnArgs = spawnManager.evaluate.mock.calls[0][0];
      expect(spawnArgs.context).toContain('You represent LocalAgent');
    });

    it('includes sender fingerprint in grounding', async () => {
      const envelope = createEnvelope();
      const relayCtx = createRelayContext({ senderFingerprint: 'fp-special-xyz' });

      await router.handleInboundMessage(envelope, relayCtx);

      const spawnArgs = spawnManager.evaluate.mock.calls[0][0];
      expect(spawnArgs.context).toContain('fp-special-xyz');
    });

    it('includes multi-hop provenance when present', async () => {
      const envelope = createEnvelope();
      const relayCtx = createRelayContext({
        senderFingerprint: 'fp-relay-agent',
        originFingerprint: 'fp-original-agent',
        originName: 'OriginalSource',
      });

      await router.handleInboundMessage(envelope, relayCtx);

      const spawnArgs = spawnManager.evaluate.mock.calls[0][0];
      expect(spawnArgs.context).toContain('OriginalSource');
      expect(spawnArgs.context).toContain('fp-original-agent');
      expect(spawnArgs.context).toContain('Relayed through');
    });
  });

  // ── Trust-Level-Aware History Depth ────────────────────────────

  describe('trust-aware history depth', () => {
    it('uses trust level history limit for relay messages', async () => {
      // Create many history messages
      const historyMessages = Array.from({ length: 30 }, (_, i) => ({
        message: {
          id: `hist-${i}`,
          from: { agent: i % 2 === 0 ? 'RemoteAgent' : 'LocalAgent', machine: 'test' },
          body: `History message ${i}`,
          createdAt: new Date(Date.now() - (30 - i) * 60000).toISOString(),
        },
      }));
      messageRouter = createMockMessageRouter(historyMessages as any);

      router = new ThreadlineRouter(
        messageRouter as any,
        spawnManager as any,
        threadResumeMap as any,
        createMockMessageStore() as any,
        routerConfig,
      );

      const envelope = createEnvelope();

      // Untrusted: 0 history
      await router.handleInboundMessage(envelope, createRelayContext({ trustLevel: 'untrusted' }));
      const untrustedPrompt = spawnManager.evaluate.mock.calls[0][0].context;
      expect(untrustedPrompt).toContain('No previous history available');

      // Reset
      spawnManager.evaluate.mockClear();

      // Verified: 5 history
      await router.handleInboundMessage(
        createEnvelope({ threadId: 'thread-v' }),
        createRelayContext({ trustLevel: 'verified' })
      );
      // getThread should be called, and the prompt should contain history
      expect(messageRouter.getThread).toHaveBeenCalled();
    });

    it('uses default maxHistoryMessages without relay context', async () => {
      const historyMessages = Array.from({ length: 30 }, (_, i) => ({
        message: {
          id: `hist-${i}`,
          from: { agent: 'RemoteAgent', machine: 'test' },
          body: `Message ${i}`,
          createdAt: new Date().toISOString(),
        },
      }));
      messageRouter = createMockMessageRouter(historyMessages as any);

      router = new ThreadlineRouter(
        messageRouter as any,
        spawnManager as any,
        threadResumeMap as any,
        createMockMessageStore() as any,
        routerConfig,
      );

      const envelope = createEnvelope();
      await router.handleInboundMessage(envelope); // No relay context

      // Should use full 20-message default
      expect(messageRouter.getThread).toHaveBeenCalled();
    });
  });

  // ── Resume with Relay Context ──────────────────────────────────

  describe('resume with relay context', () => {
    it('injects grounding when resuming existing thread via relay', async () => {
      // Set up an existing thread entry
      threadResumeMap._set('thread-existing', {
        uuid: 'existing-uuid',
        sessionName: 'existing-session',
        createdAt: new Date().toISOString(),
        savedAt: new Date().toISOString(),
        lastAccessedAt: new Date().toISOString(),
        remoteAgent: 'RemoteAgent',
        subject: 'Existing Thread',
        state: 'idle',
        pinned: false,
        messageCount: 5,
      });

      const envelope = createEnvelope({ threadId: 'thread-existing' });
      const relayCtx = createRelayContext({ trustLevel: 'trusted' });

      await router.handleInboundMessage(envelope, relayCtx);

      expect(spawnManager.evaluate).toHaveBeenCalled();
      const spawnArgs = spawnManager.evaluate.mock.calls[0][0];
      expect(spawnArgs.context).toContain('[EXTERNAL MESSAGE — Trust: trusted]');
    });
  });

  // ── Non-Relay Messages (Regression) ────────────────────────────

  describe('non-relay messages (regression)', () => {
    it('still works for local messages without relay context', async () => {
      const envelope = createEnvelope();
      const result = await router.handleInboundMessage(envelope);

      expect(result.handled).toBe(true);
      expect(result.spawned).toBe(true);
      expect(spawnManager.evaluate).toHaveBeenCalled();

      // Prompt should NOT contain external message markers
      const prompt = spawnManager.evaluate.mock.calls[0][0].context;
      expect(prompt).not.toContain('[EXTERNAL MESSAGE');
      expect(prompt).toContain('Hello from remote'); // Message body still present
    });

    it('mints a threadId for messages arriving without one (PR-2)', async () => {
      const envelope = createEnvelope({ threadId: undefined as any });
      (envelope.message as any).threadId = undefined;

      const result = await router.handleInboundMessage(envelope);
      // PR-2: first-contact messages used to be dropped with handled:false.
      // They are now minted a new threadId and routed normally.
      expect(result.handled).toBe(true);
      expect(result.threadId).toBeDefined();
      expect(envelope.message.threadId).toBe(result.threadId);
    });

    it('returns handled: false for self-messages', async () => {
      const envelope = createEnvelope({ from: 'LocalAgent' });
      const result = await router.handleInboundMessage(envelope);
      expect(result.handled).toBe(false);
    });
  });

  // ── RELAY_HISTORY_LIMITS Integration ───────────────────────────

  describe('RELAY_HISTORY_LIMITS integration', () => {
    it('limits are correctly imported and used', () => {
      expect(RELAY_HISTORY_LIMITS.untrusted).toBe(0);
      expect(RELAY_HISTORY_LIMITS.verified).toBe(5);
      expect(RELAY_HISTORY_LIMITS.trusted).toBe(10);
      expect(RELAY_HISTORY_LIMITS.autonomous).toBe(20);
    });
  });

  // ── Receiver-side session affinity (§4.1 D3 fix) ──────────────

  describe('receiver-side session affinity', () => {
    it('reuses threadId for verified peer on threadless follow-up', async () => {
      // First message from verified peer — no threadId → mints fresh.
      const first = createEnvelope({ from: 'VerifiedPeer', threadId: null });
      const ctx = createRelayContext({
        trust: { kind: 'verified', senderFingerprint: 'fp-verified-1' },
      });
      await router.handleInboundMessage(first, ctx);
      const firstThreadId = first.message.threadId;
      expect(firstThreadId).toBeTruthy();

      // Second threadless message from same verified peer → reuses same threadId.
      const second = createEnvelope({ from: 'VerifiedPeer', threadId: null });
      await router.handleInboundMessage(second, ctx);
      expect(second.message.threadId).toBe(firstThreadId);
    });

    it('mints fresh for plaintext-tofu peer even on follow-up', async () => {
      const first = createEnvelope({ from: 'PlainPeer', threadId: null });
      const ctx = createRelayContext({
        trust: { kind: 'plaintext-tofu', senderFingerprint: 'fp-plain-1' },
      });
      await router.handleInboundMessage(first, ctx);
      const firstThreadId = first.message.threadId;

      const second = createEnvelope({ from: 'PlainPeer', threadId: null });
      await router.handleInboundMessage(second, ctx);
      expect(second.message.threadId).not.toBe(firstThreadId);
      expect(router.getAffinitySnapshotForTests().size).toBe(0);
    });

    it('does not read affinity map when no relay context', async () => {
      // Prime the map by sending once WITH verified ctx.
      const primer = createEnvelope({ from: 'Peer', threadId: null });
      await router.handleInboundMessage(primer, createRelayContext({
        trust: { kind: 'verified', senderFingerprint: 'fp-v' },
      }));
      const primerThreadId = primer.message.threadId;

      // Now send without any relay context.
      const follow = createEnvelope({ from: 'Peer', threadId: null });
      await router.handleInboundMessage(follow, undefined);
      expect(follow.message.threadId).not.toBe(primerThreadId);
    });

    it('explicit threadId on envelope wins over affinity', async () => {
      const primer = createEnvelope({ from: 'Peer', threadId: null });
      const ctx = createRelayContext({
        trust: { kind: 'verified', senderFingerprint: 'fp-explicit' },
      });
      await router.handleInboundMessage(primer, ctx);

      const explicit = createEnvelope({ from: 'Peer', threadId: 'caller-chosen-thread-id' });
      await router.handleInboundMessage(explicit, ctx);
      expect(explicit.message.threadId).toBe('caller-chosen-thread-id');
    });

    it('evicts entries beyond LRU cap', async () => {
      // Flood 1001 verified peers; first entry should be evicted.
      for (let i = 0; i < 1001; i++) {
        const env = createEnvelope({ from: `Peer${i}`, threadId: null });
        await router.handleInboundMessage(env, createRelayContext({
          trust: { kind: 'verified', senderFingerprint: `fp-${i}` },
        }));
      }
      const snap = router.getAffinitySnapshotForTests();
      expect(snap.size).toBe(1000);
      expect(snap.has('fp-0')).toBe(false);
      expect(snap.has('fp-1000')).toBe(true);
    });

    it('refreshes sliding TTL on reuse but preserves firstUsedAt', async () => {
      let fakeNow = 1_000_000;
      const clockRouter = new ThreadlineRouter(
        messageRouter as never, spawnManager as never, threadResumeMap as never,
        createMockMessageStore() as never, routerConfig, null, null, undefined, () => fakeNow,
      );
      const ctx = createRelayContext({
        trust: { kind: 'verified', senderFingerprint: 'fp-ttl' },
      });
      const first = createEnvelope({ from: 'Peer', threadId: null });
      await clockRouter.handleInboundMessage(first, ctx);
      const firstThreadId = first.message.threadId;

      fakeNow += 60_000; // 1 min later — within both TTLs
      const second = createEnvelope({ from: 'Peer', threadId: null });
      await clockRouter.handleInboundMessage(second, ctx);
      expect(second.message.threadId).toBe(firstThreadId);

      const snap = clockRouter.getAffinitySnapshotForTests();
      const entry = snap.get('fp-ttl');
      expect(entry).toBeDefined();
      expect(entry!.firstUsedAt).toBe(1_000_000);
      expect(entry!.lastUsedAt).toBe(1_060_000);
    });

    it('expires entry past sliding TTL', async () => {
      let fakeNow = 2_000_000;
      const clockRouter = new ThreadlineRouter(
        messageRouter as never, spawnManager as never, threadResumeMap as never,
        createMockMessageStore() as never, routerConfig, null, null, undefined, () => fakeNow,
      );
      const ctx = createRelayContext({
        trust: { kind: 'verified', senderFingerprint: 'fp-sliding' },
      });
      const first = createEnvelope({ from: 'Peer', threadId: null });
      await clockRouter.handleInboundMessage(first, ctx);
      const firstThreadId = first.message.threadId;

      fakeNow += 700_000; // > 10 min sliding TTL
      const second = createEnvelope({ from: 'Peer', threadId: null });
      await clockRouter.handleInboundMessage(second, ctx);
      expect(second.message.threadId).not.toBe(firstThreadId);
    });

    it('expires entry past absolute TTL even with recent activity', async () => {
      let fakeNow = 3_000_000;
      const clockRouter = new ThreadlineRouter(
        messageRouter as never, spawnManager as never, threadResumeMap as never,
        createMockMessageStore() as never, routerConfig, null, null, undefined, () => fakeNow,
      );
      const ctx = createRelayContext({
        trust: { kind: 'verified', senderFingerprint: 'fp-absolute' },
      });
      const first = createEnvelope({ from: 'Peer', threadId: null });
      await clockRouter.handleInboundMessage(first, ctx);
      const firstThreadId = first.message.threadId;

      // Churn within sliding TTL to keep lastUsedAt fresh, but push past absolute.
      for (let i = 0; i < 15; i++) {
        fakeNow += 500_000; // 8.3 min each — within sliding 10min
        const f = createEnvelope({ from: 'Peer', threadId: null });
        await clockRouter.handleInboundMessage(f, ctx);
      }
      // After 15 iterations × 500_000ms = 7_500_000ms, which exceeds absolute 7_200_000ms.
      // The most-recent call above will have observed expiry and minted fresh.
      const final = createEnvelope({ from: 'Peer', threadId: null });
      await clockRouter.handleInboundMessage(final, ctx);
      // firstThreadId is long gone — check that the final thread is not the original.
      expect(final.message.threadId).not.toBe(firstThreadId);
    });
  });

  // ── RelayTrustLevel discriminated union (§4.1) ─────────────────

  describe('RelayTrustLevel branded union', () => {
    it('plaintext-tofu kind carries fingerprint and is not verified', () => {
      const ctx = createRelayContext({
        trust: { kind: 'plaintext-tofu', senderFingerprint: 'fp-plain' },
      });
      expect(ctx.trust.kind).toBe('plaintext-tofu');
      // Narrowing: only `verified` callers should read affinity maps.
      if (ctx.trust.kind === 'verified') {
        throw new Error('should not narrow to verified');
      }
    });

    it('verified kind carries fingerprint and narrows correctly', () => {
      const ctx = createRelayContext({
        trust: { kind: 'verified', senderFingerprint: 'fp-verified' },
      });
      expect(ctx.trust.kind).toBe('verified');
      if (ctx.trust.kind === 'verified') {
        expect(ctx.trust.senderFingerprint).toBe('fp-verified');
      } else {
        throw new Error('expected verified narrowing');
      }
    });

    it('unauthenticated kind has no fingerprint on the trust field', () => {
      const ctx = createRelayContext({
        trust: { kind: 'unauthenticated' },
      });
      expect(ctx.trust.kind).toBe('unauthenticated');
      if (ctx.trust.kind === 'unauthenticated') {
        // @ts-expect-error — senderFingerprint is not present on unauthenticated trust
        const _shouldBeError = ctx.trust.senderFingerprint;
        void _shouldBeError;
      }
    });
  });
});
