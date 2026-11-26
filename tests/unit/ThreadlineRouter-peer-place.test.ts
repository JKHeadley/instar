/**
 * ThreadlineRouter — another agent's place (docs/specs/memory-privacy-agent-places.md §2-§5).
 *
 * On a multi-person agent with memory privacy on, a peer's message runs in the peer's own
 * place: the thread belongs to the authenticated sender, a thread it does not own moves to a
 * fresh id, nothing runs without an authenticated fingerprint or an admission, peer text
 * never reaches a session outside that place, and the prompt names the reply script.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ThreadlineRouter, peerPlaceAudienceKey, type PeerPlacePolicy, type RelayMessageContext, type ThreadlineRouterConfig } from '../../src/threadline/ThreadlineRouter.js';
import type { MessageEnvelope, AgentMessage } from '../../src/messaging/types.js';
import { AGENT_SESSIONS_REFUSED_REASON } from '../../src/users/peerPlaceAdmission.js';

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const placeOf = (fp: string) => `agent:${fp}`;

/** A resume map with the real ownership rules (claimOwner is write-once, legacy adoption by exact fp). */
function fakeResumeMap() {
  const entries = new Map<string, any>();
  return {
    entries,
    get: vi.fn((id: string) => entries.get(id) ?? null),
    save: vi.fn((id: string, entry: any) => {
      const prev = entries.get(id);
      const next = { ...prev, ...entry };
      if (prev?.peerFingerprint) next.peerFingerprint = prev.peerFingerprint; // write-once
      entries.set(id, next);
    }),
    remove: vi.fn(),
    resolve: vi.fn(),
    getByRemoteAgent: vi.fn().mockReturnValue([]),
    ownership: vi.fn((id: string) => ({ owner: entries.get(id)?.peerFingerprint ?? null, claimedAt: entries.get(id)?.ownerClaimedAt ?? null })),
    clearTranscript: vi.fn((id: string) => { const e = entries.get(id); if (e) { e.uuid = ''; delete e.audienceKey; } }),
    claimOwner: vi.fn((id: string, fp: string, opts: { hasStoredMessages: boolean }) => {
      const e = entries.get(id);
      if (e?.peerFingerprint) return { owner: e.peerFingerprint, claimed: false };
      if (e && e.remoteAgent !== fp) return { owner: null, claimed: false };
      if (!e && opts.hasStoredMessages) return { owner: null, claimed: false };
      entries.set(id, { ...(e ?? { remoteAgent: fp, messageCount: 0, state: 'active', pinned: false, uuid: '', sessionName: '' }), peerFingerprint: fp, ownerClaimedAt: new Date(Date.now() - 1000).toISOString() });
      return { owner: fp, claimed: true };
    }),
  };
}

function envelope(from: string, threadId: string, body = 'hello'): MessageEnvelope {
  return {
    message: {
      id: 'msg-' + Math.random().toString(36).slice(2, 8),
      from: { agent: from, machine: 'remote' },
      to: { agent: 'LocalAgent', machine: 'local' },
      threadId, subject: 'hi', body,
      createdAt: new Date().toISOString(), priority: 'normal',
    } as AgentMessage,
  } as MessageEnvelope;
}

function relay(fp: string): RelayMessageContext {
  return { trust: { kind: 'plaintext-tofu', senderFingerprint: fp }, senderFingerprint: fp, senderName: 'peer', trustLevel: 'verified' };
}

const config: ThreadlineRouterConfig = { localAgent: 'LocalAgent', localMachine: 'local', maxHistoryMessages: 20 };

describe('ThreadlineRouter — another agent\'s place', () => {
  let spawnManager: { evaluate: ReturnType<typeof vi.fn>; handleDenial: ReturnType<typeof vi.fn> };
  let resumeMap: ReturnType<typeof fakeResumeMap>;
  let messageRouter: { getThread: ReturnType<typeof vi.fn> };
  let delivery: { deliverToSession: ReturnType<typeof vi.fn> };
  let policy: PeerPlacePolicy & { [k: string]: any };
  let topicHandler: { tryRouteReplyToTopic: ReturnType<typeof vi.fn> };
  let router: ThreadlineRouter;

  const sessionAudience = new Map<string, string>();

  beforeEach(() => {
    sessionAudience.clear();
    spawnManager = {
      evaluate: vi.fn().mockResolvedValue({ approved: true, sessionId: 'sid', tmuxSession: 'echo-msg-place-1', reason: 'ok' }),
      handleDenial: vi.fn(),
    };
    resumeMap = fakeResumeMap();
    messageRouter = { getThread: vi.fn().mockResolvedValue({ messages: [] }) };
    delivery = { deliverToSession: vi.fn().mockResolvedValue({ success: true }) };
    policy = {
      active: vi.fn(() => true),
      admit: vi.fn((fp: string | null) => (fp ? { kind: 'place', placeKey: placeOf(fp), fingerprint: fp } : { kind: 'refused', reason: AGENT_SESSIONS_REFUSED_REASON, cause: 'no-identity' })),
      linkedPeerReplies: vi.fn(() => 'deliver'),
      topicAudienceKind: vi.fn(() => 'owner'),
      sessionAudienceKey: vi.fn((name: string) => sessionAudience.get(name) ?? null),
      hasStoredMessages: vi.fn(async () => false),
      livePlaceSession: vi.fn(() => null),
      postLinkedReplyToTopic: vi.fn(async () => {}),
    } as any;
    topicHandler = { tryRouteReplyToTopic: vi.fn().mockResolvedValue({ kind: 'routed', deliveryMode: 'live-inject' }) };
    router = new ThreadlineRouter(messageRouter as any, spawnManager as any, resumeMap as any, {} as any, config, null, delivery as any);
    router.setPeerPlacePolicy(policy);
  });

  it('without the policy active, nothing changes: no memoryPeer on the spawn', async () => {
    policy.active = vi.fn(() => false);
    await router.handleInboundMessage(envelope(A, 't1'), relay(A), { memoryPeerFingerprint: A });
    const req = spawnManager.evaluate.mock.calls[0][0];
    expect(req.memoryPeer).toBeUndefined();
    expect(req.context).toContain('threadline_send');
  });

  it('refuses a message with no authenticated fingerprint, and spawns nothing', async () => {
    const result = await router.handleInboundMessage(envelope('some-name', 't1'), relay(A));
    expect(result.handled).toBe(false);
    expect(result.error).toBe(AGENT_SESSIONS_REFUSED_REASON);
    expect(spawnManager.evaluate).not.toHaveBeenCalled();
  });

  it('refuses when admission refuses (no grant): spawns nothing, writes nothing, ends any live place', async () => {
    policy.admit = vi.fn(() => ({ kind: 'refused', reason: AGENT_SESSIONS_REFUSED_REASON, cause: 'no-grant' })) as any;
    policy.endPlace = vi.fn();
    const result = await router.handleInboundMessage(envelope(A, 't1'), relay(A), { memoryPeerFingerprint: A });
    expect(result.handled).toBe(false);
    expect(spawnManager.evaluate).not.toHaveBeenCalled();
    expect(resumeMap.claimOwner).not.toHaveBeenCalled();
    expect(resumeMap.entries.has('t1')).toBe(false);
    expect(policy.endPlace).toHaveBeenCalledWith(A);
  });

  it('a thread re-pointed at the live place session loses its old transcript id', async () => {
    policy.livePlaceSession = vi.fn(() => 'place-session') as any;
    sessionAudience.set('place-session', peerPlaceAudienceKey(placeOf(A)));
    resumeMap.entries.set('old', { remoteAgent: A, peerFingerprint: A, sessionName: '', uuid: 'owner-reach-uuid', audienceKey: 'owner:me', messageCount: 1, state: 'idle', pinned: false });
    await router.handleInboundMessage(envelope(A, 'old'), relay(A), { memoryPeerFingerprint: A });
    expect(resumeMap.clearTranscript).toHaveBeenCalledWith('old');
    expect(resumeMap.entries.get('old').uuid).toBe('');
  });

  it('spawns in the peer\'s place: memoryPeer + interactive, the reply script, no threadline_send, no topic hint', async () => {
    const result = await router.handleInboundMessage(envelope(A, 't1'), relay(A), { memoryPeerFingerprint: A });
    expect(result.handled).toBe(true);
    const req = spawnManager.evaluate.mock.calls[0][0];
    expect(req.memoryPeer).toBe(A);
    expect(req.interactive).toBe(true);
    expect(req.context).toContain('threadline-reply.sh --thread t1');
    expect(req.context).not.toContain('threadline_send');
    const saved = resumeMap.entries.get('t1');
    expect(saved.peerFingerprint).toBe(A);
    expect(saved.audienceKey).toBe(peerPlaceAudienceKey(placeOf(A)));
  });

  it('a thread owned by another peer is never reused: the message moves to a fresh id', async () => {
    resumeMap.entries.set('victim', { remoteAgent: B, peerFingerprint: B, sessionName: 'b-session', uuid: 'u', messageCount: 3, state: 'idle', pinned: false });
    sessionAudience.set('b-session', peerPlaceAudienceKey(placeOf(B)));
    const result = await router.handleInboundMessage(envelope(A, 'victim'), relay(A), { memoryPeerFingerprint: A });
    expect(result.threadId).not.toBe('victim');
    expect(delivery.deliverToSession).not.toHaveBeenCalled();
    expect(resumeMap.entries.get('victim').peerFingerprint).toBe(B);
    expect(spawnManager.evaluate.mock.calls[0][0].resumeSessionId).toBeUndefined();
  });

  it('an expired thread with stored messages is never adopted, and its history never loads', async () => {
    policy.hasStoredMessages = vi.fn(async (id: string) => id === 'old') as any;
    messageRouter.getThread.mockImplementation(async (id: string) => (id === 'old'
      ? { messages: [{ message: { from: { agent: B }, createdAt: new Date().toISOString(), body: 'B-SECRET' } }] }
      : { messages: [] }));
    const result = await router.handleInboundMessage(envelope(A, 'old'), relay(A), { memoryPeerFingerprint: A });
    expect(result.threadId).not.toBe('old');
    expect(spawnManager.evaluate.mock.calls[0][0].context).not.toContain('B-SECRET');
  });

  it('loads only history stored after the thread was claimed', async () => {
    const claimedAt = new Date(Date.now() - 60_000).toISOString();
    resumeMap.entries.set('t1', { remoteAgent: A, peerFingerprint: A, ownerClaimedAt: claimedAt, uuid: '', sessionName: '', messageCount: 2, state: 'idle', pinned: false });
    resumeMap.get.mockReturnValue(null); // no live entry: a fresh spawn in the place
    messageRouter.getThread.mockResolvedValue({ messages: [
      { message: { from: { agent: A }, createdAt: new Date(Date.now() - 120_000).toISOString(), body: 'BEFORE-CLAIM' } },
      { message: { from: { agent: A }, createdAt: new Date().toISOString(), body: 'AFTER-CLAIM' } },
    ] });
    await router.handleInboundMessage(envelope(A, 't1'), relay(A), { memoryPeerFingerprint: A });
    const prompt = spawnManager.evaluate.mock.calls[0][0].context as string;
    expect(prompt).toContain('AFTER-CLAIM');
    expect(prompt).not.toContain('BEFORE-CLAIM');
  });

  it('injects into the thread\'s live session only when it runs in this peer\'s place', async () => {
    resumeMap.entries.set('t1', { remoteAgent: A, peerFingerprint: A, sessionName: 'owner-session', uuid: 'u', messageCount: 1, state: 'active', pinned: false, audienceKey: 'owner:me' });
    sessionAudience.set('owner-session', 'owner:me');
    await router.handleInboundMessage(envelope(A, 't1'), relay(A), { memoryPeerFingerprint: A });
    expect(delivery.deliverToSession).not.toHaveBeenCalled();
    // ...and the owner-reach transcript is not resumed into the place.
    expect(spawnManager.evaluate.mock.calls[0][0].resumeSessionId).toBeUndefined();

    spawnManager.evaluate.mockClear();
    resumeMap.entries.set('t2', { remoteAgent: A, peerFingerprint: A, sessionName: 'place-session', uuid: 'u2', messageCount: 1, state: 'active', pinned: false, audienceKey: peerPlaceAudienceKey(placeOf(A)) });
    sessionAudience.set('place-session', peerPlaceAudienceKey(placeOf(A)));
    const result = await router.handleInboundMessage(envelope(A, 't2'), relay(A), { memoryPeerFingerprint: A });
    expect(result.injected).toBe(true);
    expect(delivery.deliverToSession).toHaveBeenCalledWith('place-session', expect.anything());
    const injectedBody = delivery.deliverToSession.mock.calls[0][1].message.body as string;
    expect(injectedBody).toContain('threadline-reply.sh --thread t2');
  });

  it('a second thread from the same peer goes into the peer\'s live place session', async () => {
    policy.livePlaceSession = vi.fn(() => 'place-session') as any;
    sessionAudience.set('place-session', peerPlaceAudienceKey(placeOf(A)));
    const result = await router.handleInboundMessage(envelope(A, 'new-thread'), relay(A), { memoryPeerFingerprint: A });
    expect(result.injected).toBe(true);
    expect(spawnManager.evaluate).not.toHaveBeenCalled();
    expect(resumeMap.entries.get('new-thread').sessionName).toBe('place-session');
  });

  it('resumes only a transcript written in this same place', async () => {
    resumeMap.entries.set('t1', { remoteAgent: A, peerFingerprint: A, sessionName: '', uuid: 'place-uuid', messageCount: 1, state: 'idle', pinned: false, audienceKey: peerPlaceAudienceKey(placeOf(A)) });
    await router.handleInboundMessage(envelope(A, 't1'), relay(A), { memoryPeerFingerprint: A });
    expect(spawnManager.evaluate.mock.calls[0][0].resumeSessionId).toBe('place-uuid');
    expect(spawnManager.evaluate.mock.calls[0][0].memoryPeer).toBe(A);
  });

  describe('topic linkage (§3)', () => {
    beforeEach(() => {
      (router as any).topicLinkageHandler = topicHandler;
      resumeMap.entries.set('linked', { remoteAgent: A, peerFingerprint: A, sessionName: '', uuid: '', messageCount: 1, state: 'active', pinned: false, originTopicId: 42 });
    });

    it('delivers into an owner topic under deliver', async () => {
      await router.handleInboundMessage(envelope(A, 'linked'), relay(A), { memoryPeerFingerprint: A });
      expect(topicHandler.tryRouteReplyToTopic).toHaveBeenCalled();
      expect(policy.postLinkedReplyToTopic).not.toHaveBeenCalled();
    });

    it('never types into a shared or person topic: posts it, and the peer\'s place gets it', async () => {
      policy.topicAudienceKind = vi.fn(() => 'place') as any;
      await router.handleInboundMessage(envelope(A, 'linked', 'answer'), relay(A), { memoryPeerFingerprint: A });
      expect(topicHandler.tryRouteReplyToTopic).not.toHaveBeenCalled();
      expect(policy.postLinkedReplyToTopic).toHaveBeenCalledWith(42, 'peer', 'answer');
      expect(spawnManager.evaluate.mock.calls[0][0].memoryPeer).toBe(A);
    });

    it('under post-only, even an owner topic only gets a post', async () => {
      policy.linkedPeerReplies = vi.fn(() => 'post-only') as any;
      await router.handleInboundMessage(envelope(A, 'linked'), relay(A), { memoryPeerFingerprint: A });
      expect(topicHandler.tryRouteReplyToTopic).not.toHaveBeenCalled();
      expect(policy.postLinkedReplyToTopic).toHaveBeenCalled();
    });

    it('a thread adopted from before this version never reaches the topic', async () => {
      resumeMap.entries.get('linked').ownerAdopted = true;
      await router.handleInboundMessage(envelope(A, 'linked'), relay(A), { memoryPeerFingerprint: A });
      expect(topicHandler.tryRouteReplyToTopic).not.toHaveBeenCalled();
    });

    it('an open topic audience is not enough', async () => {
      policy.topicAudienceKind = vi.fn(() => 'open') as any;
      await router.handleInboundMessage(envelope(A, 'linked'), relay(A), { memoryPeerFingerprint: A });
      expect(topicHandler.tryRouteReplyToTopic).not.toHaveBeenCalled();
    });

    it('a different peer on a linked thread never reaches the topic', async () => {
      await router.handleInboundMessage(envelope(B, 'linked'), relay(B), { memoryPeerFingerprint: B });
      expect(topicHandler.tryRouteReplyToTopic).not.toHaveBeenCalled();
      expect(spawnManager.evaluate.mock.calls[0][0].memoryPeer).toBe(B);
    });
  });
});
