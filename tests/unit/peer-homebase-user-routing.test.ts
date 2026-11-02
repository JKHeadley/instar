/**
 * peer-conversation-homebase-topic §2.6 — the operator's rule (2026-10-31): "all messages from
 * an agent that are intended for the user show up in that topic".
 *
 * Both sides of every boundary of the destination decision, the relay that posts an unbound
 * conversation's user-meant message, and the topic-linked reply surface.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { resolvePeerUserTopic, makePeerUserTopicResolver } from '../../src/threadline/peerHomebase.js';
import { PeerHomebaseRelay, formatRelayPost, RELAY_BODY_CAP } from '../../src/threadline/peerHomebaseRelay.js';
import { SalienceGate } from '../../src/threadline/SalienceGate.js';
import { CommitmentTracker } from '../../src/monitoring/CommitmentTracker.js';
import { LiveConfig } from '../../src/config/LiveConfig.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { TopicResumeMap } from '../../src/core/TopicResumeMap.js';
import { ThreadResumeMap } from '../../src/threadline/ThreadResumeMap.js';
import { TopicLinkageHandler, type TopicLinkageDeps } from '../../src/threadline/TopicLinkageHandler.js';
import type { MessageEnvelope } from '../../src/messaging/types.js';

describe('resolvePeerUserTopic', () => {
  it('an OPERATOR binding wins over the homebase', () => {
    expect(resolvePeerUserTopic({ boundTopicId: 7, boundTopicSource: 'operator', homebaseTopicId: 50 })).toEqual({ topicId: 7, via: 'operator-binding' });
  });
  it('an origin-inherited binding does NOT win — the homebase does', () => {
    expect(resolvePeerUserTopic({ boundTopicId: 7, boundTopicSource: 'origin-inherited', homebaseTopicId: 50 })).toEqual({ topicId: 50, via: 'homebase' });
  });
  it('an unknown-provenance binding does NOT decide either', () => {
    expect(resolvePeerUserTopic({ boundTopicId: 7, homebaseTopicId: 50 })).toEqual({ topicId: 50, via: 'homebase' });
  });
  it('no binding + homebase → homebase', () => {
    expect(resolvePeerUserTopic({ homebaseTopicId: 50 })).toEqual({ topicId: 50, via: 'homebase' });
  });
  it('no homebase → existing routing (with or without an existing topic)', () => {
    expect(resolvePeerUserTopic({ boundTopicId: 7, boundTopicSource: 'origin-inherited', existingTopicId: 7 })).toEqual({ topicId: 7, via: 'existing' });
    expect(resolvePeerUserTopic({})).toEqual({ topicId: null, via: 'existing' });
  });
  it('operator source without a topic id falls through to the homebase', () => {
    expect(resolvePeerUserTopic({ boundTopicSource: 'operator', homebaseTopicId: 50 })).toEqual({ topicId: 50, via: 'homebase' });
  });
});

describe('makePeerUserTopicResolver', () => {
  const profiles: Record<string, { pairingState?: string; homebaseTopicId?: number; fingerprint?: string }> = {
    fpverified: { pairingState: 'mutual-verified', homebaseTopicId: 50, fingerprint: 'fpverified' },
    fppending: { pairingState: 'invite-accepted', homebaseTopicId: 51, fingerprint: 'fppending' },
    // A lookup that returned a profile for a key that is NOT its fingerprint (a name lookup).
    scout: { pairingState: 'mutual-verified', homebaseTopicId: 52, fingerprint: 'fpscout' },
  };
  const mk = (enabled = true, conv: Record<string, { boundTopicId?: number; boundTopicSource?: 'operator' }> = {}) =>
    makePeerUserTopicResolver({
      enabled: () => enabled,
      profileFor: (p) => profiles[p.toLowerCase()] ?? profiles[p] ?? null,
      conversationFor: (t) => conv[t] ?? null,
    });

  it('a mutual-verified peer resolves to its homebase', () => {
    expect(mk()({ threadId: 't', peers: [undefined, 'fpverified'] })).toEqual({ topicId: 50, via: 'homebase' });
  });
  it('a display name never resolves to a homebase (a stranger calling itself "scout")', () => {
    expect(mk()({ threadId: 't', peers: ['scout'], existingTopicId: 3 })).toEqual({ topicId: 3, via: 'existing' });
  });
  it('fingerprint matching is case-insensitive', () => {
    expect(mk()({ threadId: 't', peers: ['FPVERIFIED'] })).toEqual({ topicId: 50, via: 'homebase' });
  });
  it('a peer that is not mutual-verified does not get its homebase used', () => {
    expect(mk()({ threadId: 't', peers: ['fppending'], existingTopicId: 3 })).toEqual({ topicId: 3, via: 'existing' });
  });
  it('the off switch restores existing routing', () => {
    expect(mk(false)({ threadId: 't', peers: ['fpverified'], existingTopicId: 3 })).toEqual({ topicId: 3, via: 'existing' });
  });
  it('the operator binding on the conversation still wins', () => {
    expect(mk(true, { t: { boundTopicId: 9, boundTopicSource: 'operator' } })({ threadId: 't', peers: ['fpverified'] })).toEqual({ topicId: 9, via: 'operator-binding' });
  });
  it('a throwing store resolves to existing routing, never throws', () => {
    const r = makePeerUserTopicResolver({ enabled: () => true, profileFor: () => { throw new Error('boom'); }, conversationFor: () => null });
    expect(r({ threadId: 't', peers: ['x'], existingTopicId: 4 })).toEqual({ topicId: 4, via: 'existing' });
  });
});

describe('PeerHomebaseRelay', () => {
  const resolverFor = (via: 'homebase' | 'operator-binding' | 'existing') => () =>
    ({ topicId: via === 'existing' ? null : via === 'homebase' ? 50 : 9, via });

  it('posts a first (user-visible) message into the homebase', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const relay = new PeerHomebaseRelay({ resolve: resolverFor('homebase'), salienceGate: new SalienceGate(), sendToTopic: send });
    const r = await relay.relayInbound({ threadId: 'th1', peers: ['fp'], senderName: 'scout', text: 'Please tell Justin the invoice is ready.' });
    expect(r).toEqual({ posted: true, topicId: 50 });
    expect(send).toHaveBeenCalledWith(50, expect.stringContaining('Message from scout'));
  });

  it('does not post an agent-internal follow-up (housekeeping keeps existing routing)', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    let now = 1_000_000;
    const relay = new PeerHomebaseRelay({ resolve: resolverFor('homebase'), salienceGate: new SalienceGate(), sendToTopic: send, now: () => now });
    await relay.relayInbound({ threadId: 'th1', peers: ['fp'], senderName: 'scout', text: 'first' });
    now += 120_000;
    const r = await relay.relayInbound({ threadId: 'th1', peers: ['fp'], senderName: 'scout', text: 'ack, working on it' });
    expect(r).toMatchObject({ posted: false, reason: 'agent-internal' });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('a user-visible follow-up IS posted when the classifier says so', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    let now = 1_000_000;
    const gate = new SalienceGate({ classify: async () => ({ verdict: 'user-visible', reason: 'asks the user' }) });
    const relay = new PeerHomebaseRelay({ resolve: resolverFor('homebase'), salienceGate: gate, sendToTopic: send, now: () => now });
    await relay.relayInbound({ threadId: 'th1', peers: ['fp'], senderName: 'scout', text: 'first' });
    now += 120_000;
    const r = await relay.relayInbound({ threadId: 'th1', peers: ['fp'], senderName: 'scout', text: 'Justin must approve this' });
    expect(r.posted).toBe(true);
  });

  it('stays out of an operator-bound conversation and a peer with no homebase', async () => {
    const send = vi.fn();
    const a = new PeerHomebaseRelay({ resolve: resolverFor('operator-binding'), salienceGate: new SalienceGate(), sendToTopic: send });
    const b = new PeerHomebaseRelay({ resolve: resolverFor('existing'), salienceGate: new SalienceGate(), sendToTopic: send });
    expect(await a.relayInbound({ threadId: 't', peers: ['fp'], senderName: 's', text: 'x' })).toMatchObject({ posted: false, reason: 'operator-bound' });
    expect(await b.relayInbound({ threadId: 't', peers: ['fp'], senderName: 's', text: 'x' })).toMatchObject({ posted: false, reason: 'no-homebase' });
    expect(send).not.toHaveBeenCalled();
  });

  it('caps posts per topic so many threads cannot flood it', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const relay = new PeerHomebaseRelay({ resolve: resolverFor('homebase'), salienceGate: new SalienceGate(), sendToTopic: send, now: () => 5 });
    const results = [];
    for (let i = 0; i < 5; i++) results.push(await relay.relayInbound({ threadId: `t${i}`, peers: ['fp'], senderName: 's', text: 'hello' }));
    expect(results.filter((r) => r.posted)).toHaveLength(3);
    expect(results[4]).toMatchObject({ posted: false, reason: 'rate-limited' });
  });

  it('a send failure is reported, never thrown', async () => {
    const relay = new PeerHomebaseRelay({ resolve: resolverFor('homebase'), salienceGate: new SalienceGate(), sendToTopic: async () => { throw new Error('tg down'); } });
    expect(await relay.relayInbound({ threadId: 't', peers: ['fp'], senderName: 's', text: 'x' })).toMatchObject({ posted: false, reason: 'send-failed' });
  });

  it('formats readable text: caps the body and unwraps JSON', () => {
    expect(formatRelayPost('scout', '{"text":"hi there"}')).toBe('💬 Message from scout:\n\nhi there');
    const long = formatRelayPost('scout', 'a'.repeat(RELAY_BODY_CAP + 50));
    expect(long).toContain('[truncated]');
    expect(long.length).toBeLessThan(RELAY_BODY_CAP + 60);
  });
});

// ── Topic-linked replies (TopicLinkageHandler) ─────────────────────────────

function envelope(threadId: string, body = 'here is the data you asked for'): MessageEnvelope {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    message: {
      id: 'm-' + Math.random().toString(36).slice(2),
      from: { agent: 'scout', session: 'threadline', machine: 'remote' },
      to: { agent: 'echo', session: 'best', machine: 'local' },
      type: 'request', priority: 'medium', subject: 'Reply', body, threadId, createdAt: now,
    },
    transport: { relayChain: ['relay'], originServer: 'http://example.test', nonce: 'n:' + now, timestamp: now },
    delivery: { phase: 'received', transitions: [{ from: 'created', to: 'received', at: now, reason: 'test' }], attempts: 1 },
  } as MessageEnvelope;
}

describe('TopicLinkageHandler — §2.6 user-facing post goes to the peer topic', () => {
  let stateDir: string;
  beforeEach(() => { stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-route-')); });
  afterEach(() => SafeFsExecutor.safeRmSync(stateDir, { recursive: true, force: true, operation: 'tests/unit/peer-homebase-user-routing.test.ts' }));

  function deps(over: Partial<TopicLinkageDeps>): TopicLinkageDeps {
    fs.mkdirSync(path.join(stateDir, 'state'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ updates: { autoApply: true } }));
    return {
      commitmentTracker: new CommitmentTracker({ stateDir, liveConfig: new LiveConfig(stateDir) }),
      topicResumeMap: new TopicResumeMap(stateDir, stateDir),
      threadResumeMap: new ThreadResumeMap(stateDir, stateDir),
      salienceGate: new SalienceGate(),
      localAgent: 'echo',
      injectIntoSession: vi.fn().mockReturnValue(true),
      isSessionAlive: vi.fn().mockReturnValue(true),
      sendTelegramToTopic: vi.fn().mockResolvedValue(undefined),
      getSessionForTopic: vi.fn().mockReturnValue('echo-topic-9210'),
      ...over,
    };
  }

  it('a live-injected user-visible reply is ALSO posted to the homebase, not the origin topic', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const inject = vi.fn().mockReturnValue(true);
    const d = deps({ sendTelegramToTopic: send, injectIntoSession: inject, resolveUserTopic: () => 50 });
    const h = new TopicLinkageHandler(d);
    h.captureOriginOnSend({ threadId: 'tl1', remoteAgent: 'scout', originTopicId: 9210 });
    const out = await h.tryRouteReplyToTopic({ envelope: envelope('tl1'), threadEntry: { remoteAgent: 'scout', originTopicId: 9210 } });
    expect(out).toMatchObject({ kind: 'routed', deliveryMode: 'live-inject', telegramSent: true });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toBe(50);
    // The session still got the reply, and is told where the user reads this peer.
    expect(inject).toHaveBeenCalledTimes(1);
    expect(inject.mock.calls[0][1]).toContain('post in topic 50');
  });

  it('without a redirect, a live-injected reply posts nothing (today\'s behaviour)', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const d = deps({ sendTelegramToTopic: send, resolveUserTopic: () => null });
    const h = new TopicLinkageHandler(d);
    h.captureOriginOnSend({ threadId: 'tl2', remoteAgent: 'scout', originTopicId: 9210 });
    const out = await h.tryRouteReplyToTopic({ envelope: envelope('tl2'), threadEntry: { remoteAgent: 'scout', originTopicId: 9210 } });
    expect(out).toMatchObject({ deliveryMode: 'live-inject', telegramSent: false });
    expect(send).not.toHaveBeenCalled();
  });

  it('an operator-bound conversation (resolver returns the origin topic) keeps posting there', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const d = deps({ sendTelegramToTopic: send, injectIntoSession: vi.fn().mockReturnValue(false), resolveUserTopic: () => 9210 });
    const h = new TopicLinkageHandler(d);
    h.captureOriginOnSend({ threadId: 'tl3', remoteAgent: 'scout', originTopicId: 9210 });
    await h.tryRouteReplyToTopic({ envelope: envelope('tl3'), threadEntry: { remoteAgent: 'scout', originTopicId: 9210 } });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toBe(9210);
    expect(send.mock.calls[0][1]).toContain('You asked for this here');
  });

  it('a failed hand-off is surfaced in the homebase', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const d = deps({ sendTelegramToTopic: send, injectIntoSession: vi.fn().mockReturnValue(false), resolveUserTopic: () => 50 });
    const h = new TopicLinkageHandler(d);
    h.captureOriginOnSend({ threadId: 'tl4', remoteAgent: 'scout', originTopicId: 9210 });
    const out = await h.tryRouteReplyToTopic({ envelope: envelope('tl4'), threadEntry: { remoteAgent: 'scout', originTopicId: 9210 } });
    expect(out).toMatchObject({ deliveryMode: 'failure-visible', telegramSent: true });
    expect(send.mock.calls[0][0]).toBe(50);
    expect(send.mock.calls[0][1]).toContain('started in another topic');
  });

  it('an agent-internal reply on a redirected thread is not posted', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const d = deps({
      sendTelegramToTopic: send,
      resolveUserTopic: () => 50,
      salienceGate: new SalienceGate({ classify: async () => ({ verdict: 'agent-internal', reason: 'ack' }) }),
    });
    const h = new TopicLinkageHandler(d);
    h.captureOriginOnSend({ threadId: 'tl5', remoteAgent: 'scout', originTopicId: 9210 });
    await h.tryRouteReplyToTopic({ envelope: envelope('tl5', 'ack'), threadEntry: { remoteAgent: 'scout', originTopicId: 9210 } });
    expect(send).not.toHaveBeenCalled();
  });

  // §2.7: a redirected reply is judged per message.
  it('per-message judge says agent-internal on a redirected reply → not posted, even the first', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const judge = vi.fn(async () => ({ verdict: 'agent-internal' as const, reason: 'per-message: referee/referee' }));
    const d = deps({ sendTelegramToTopic: send, resolveUserTopic: () => 50, judgeUserMeant: judge });
    const h = new TopicLinkageHandler(d);
    h.captureOriginOnSend({ threadId: 'tl7', remoteAgent: 'scout', originTopicId: 9210 });
    await h.tryRouteReplyToTopic({ envelope: envelope('tl7', 'schema synced'), threadEntry: { remoteAgent: 'scout', originTopicId: 9210 } });
    expect(judge).toHaveBeenCalledTimes(1);
    expect(send).not.toHaveBeenCalled();
  });

  it('per-message judge: two user-meant replies on one redirected thread inside a minute are BOTH posted', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const judge = vi.fn(async () => ({ verdict: 'user-visible' as const, reason: 'per-message: jev/jev-confident' }));
    const d = deps({ sendTelegramToTopic: send, resolveUserTopic: () => 50, judgeUserMeant: judge });
    const h = new TopicLinkageHandler(d);
    h.captureOriginOnSend({ threadId: 'tl8', remoteAgent: 'scout', originTopicId: 9210 });
    await h.tryRouteReplyToTopic({ envelope: envelope('tl8', 'Justin: the invoice is ready'), threadEntry: { remoteAgent: 'scout', originTopicId: 9210 } });
    await h.tryRouteReplyToTopic({ envelope: envelope('tl8', 'Justin: and it needs your approval'), threadEntry: { remoteAgent: 'scout', originTopicId: 9210 } });
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls.every((c) => c[0] === 50)).toBe(true);
  });

  it('the judge is not consulted when nothing is redirected, and a null (switched off) judge leaves the SalienceGate deciding', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const judge = vi.fn(async () => ({ verdict: 'agent-internal' as const, reason: 'x' }));
    const h1 = new TopicLinkageHandler(deps({ sendTelegramToTopic: send, resolveUserTopic: () => null, judgeUserMeant: judge }));
    h1.captureOriginOnSend({ threadId: 'tl9', remoteAgent: 'scout', originTopicId: 9210 });
    await h1.tryRouteReplyToTopic({ envelope: envelope('tl9'), threadEntry: { remoteAgent: 'scout', originTopicId: 9210 } });
    expect(judge).not.toHaveBeenCalled();
    const off = vi.fn(async () => null);
    const h2 = new TopicLinkageHandler(deps({ sendTelegramToTopic: send, resolveUserTopic: () => 50, judgeUserMeant: off }));
    h2.captureOriginOnSend({ threadId: 'tl10', remoteAgent: 'scout', originTopicId: 9210 });
    await h2.tryRouteReplyToTopic({ envelope: envelope('tl10'), threadEntry: { remoteAgent: 'scout', originTopicId: 9210 } });
    expect(off).toHaveBeenCalledTimes(1);
    // SalienceGate fallback: first reply → user-visible → posted to the homebase.
    expect(send).toHaveBeenCalledWith(50, expect.any(String));
  });

  it('a throwing judge fails toward the user (posted)', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const d = deps({ sendTelegramToTopic: send, resolveUserTopic: () => 50, judgeUserMeant: async () => { throw new Error('boom'); } });
    const h = new TopicLinkageHandler(d);
    h.captureOriginOnSend({ threadId: 'tl11', remoteAgent: 'scout', originTopicId: 9210 });
    await h.tryRouteReplyToTopic({ envelope: envelope('tl11'), threadEntry: { remoteAgent: 'scout', originTopicId: 9210 } });
    expect(send).toHaveBeenCalledWith(50, expect.any(String));
  });

  it('a throwing resolver keeps today\'s destination', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const d = deps({ sendTelegramToTopic: send, injectIntoSession: vi.fn().mockReturnValue(false), resolveUserTopic: () => { throw new Error('x'); } });
    const h = new TopicLinkageHandler(d);
    h.captureOriginOnSend({ threadId: 'tl6', remoteAgent: 'scout', originTopicId: 9210 });
    await h.tryRouteReplyToTopic({ envelope: envelope('tl6'), threadEntry: { remoteAgent: 'scout', originTopicId: 9210 } });
    expect(send.mock.calls[0][0]).toBe(9210);
  });
});
