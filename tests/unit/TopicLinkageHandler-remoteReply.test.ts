/**
 * Unit tier — A2A cross-machine route §5 (docs/specs/a2a-cross-machine-route.md):
 * a reply on a topic-bound thread reaches that topic's live session on
 * whichever of my machines has it.
 *
 *  - the ungated sender-check fix (a name-addressed send's reply is accepted
 *    when its sender is the thread entry's resolved fingerprint);
 *  - the ask order (machineOrigin, then the ownership record ONLY after a
 *    definitive not-injected) inside one budget;
 *  - every failure is `routed` + failure-visible — never a fall-through;
 *  - "no machineOrigin and no record" is today's exact outcome;
 *  - through a REAL ThreadlineRouter: nothing is spawned on any failure path.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { CommitmentTracker } from '../../src/monitoring/CommitmentTracker.js';
import { LiveConfig } from '../../src/config/LiveConfig.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { TopicResumeMap } from '../../src/core/TopicResumeMap.js';
import { ThreadResumeMap } from '../../src/threadline/ThreadResumeMap.js';
import { ThreadlineRouter } from '../../src/threadline/ThreadlineRouter.js';
import { SalienceGate } from '../../src/threadline/SalienceGate.js';
import { TopicLinkageHandler, type TopicLinkageDeps } from '../../src/threadline/TopicLinkageHandler.js';
import type { TopicOwnerAskResult } from '../../src/threadline/relayForward.js';
import type { MessageEnvelope } from '../../src/messaging/types.js';

const PEER_FP = 'cd'.repeat(16);
const TOPIC = 4242;
const SELF = 'm_holder';

function envelope(over: { threadId: string; from?: string; body?: string; id?: string }): MessageEnvelope {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    message: {
      id: over.id ?? 'in-' + crypto.randomUUID().slice(0, 8),
      from: { agent: over.from ?? PEER_FP, session: 'relay', machine: 'relay' },
      to: { agent: 'echo', session: 'best', machine: 'local' },
      type: 'query', priority: 'medium', subject: 'Relay message',
      body: over.body ?? 'here is the answer', threadId: over.threadId, createdAt: now,
    },
    transport: { relayChain: ['relay'], originServer: 'http://x.test', nonce: 'n:' + now, timestamp: now },
    delivery: { phase: 'received', transitions: [], attempts: 1 },
  } as MessageEnvelope;
}

interface Rig {
  deps: TopicLinkageDeps;
  handler: TopicLinkageHandler;
  asks: Array<{ machineId: string; payload: { topicId: number; text: string; messageId: string; threadId: string }; timeoutMs: number }>;
  answer: (machineId: string) => Promise<TopicOwnerAskResult> | TopicOwnerAskResult;
  sendTg: ReturnType<typeof vi.fn>;
  inject: ReturnType<typeof vi.fn>;
  events: string[];
  owner: { value: string | null; throws: boolean };
  gate: { on: boolean };
}

function rig(stateDir: string, over: Partial<TopicLinkageDeps> = {}): Rig {
  fs.mkdirSync(path.join(stateDir, 'state'), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ updates: { autoApply: true }, sessions: { maxSessions: 3 } }));
  const r = {
    asks: [], events: [],
    owner: { value: null as string | null, throws: false },
    gate: { on: true },
    answer: () => ({ injected: true }),
  } as unknown as Rig;
  r.sendTg = vi.fn().mockResolvedValue(undefined);
  r.inject = vi.fn().mockReturnValue(true);
  r.deps = {
    commitmentTracker: new CommitmentTracker({ stateDir, liveConfig: new LiveConfig(stateDir) }),
    topicResumeMap: new TopicResumeMap(stateDir, stateDir),
    threadResumeMap: new ThreadResumeMap(stateDir, stateDir),
    salienceGate: new SalienceGate(),
    localAgent: 'echo',
    injectIntoSession: r.inject,
    isSessionAlive: vi.fn().mockReturnValue(false),
    sendTelegramToTopic: r.sendTg,
    // The holder has NO session for the standby's topic.
    getSessionForTopic: vi.fn().mockReturnValue(null),
    deliverToTopicOwner: async (machineId, payload, timeoutMs) => {
      r.asks.push({ machineId, payload, timeoutMs });
      return r.answer(machineId);
    },
    remoteReplyEnabled: () => r.gate.on,
    selfMachineId: () => SELF,
    selfMachineName: () => 'the mini',
    topicOwnerOf: () => { if (r.owner.throws) throw new Error('registry unreadable'); return r.owner.value; },
    onRemoteReplyEvent: (e) => { r.events.push(e); },
    remoteReplyBudgetMs: 400,
    ...over,
  };
  r.handler = new TopicLinkageHandler(r.deps);
  return r;
}

/** A forwarded send's capture: display name typed by the caller, fingerprint resolved. */
const capture = (r: Rig, threadId: string, machineOrigin?: string) => r.handler.captureOriginOnSend({
  threadId, remoteAgent: PEER_FP, remoteAgentDisplayName: 'Dawn', originTopicId: TOPIC, ...(machineOrigin ? { machineOrigin } : {}),
});
const entry = (machineOrigin?: string) => ({ remoteAgent: PEER_FP, originTopicId: TOPIC, ...(machineOrigin ? { machineOrigin } : {}) });

describe('TopicLinkageHandler — the sender check (ungated fix)', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'linkage-remote-')); });
  afterEach(() => SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/TopicLinkageHandler-remoteReply.test.ts' }));

  it('a NAME-addressed send: the reply\'s fingerprint equals the thread entry\'s resolved fingerprint ⇒ routed (was no-linkage)', async () => {
    const r = rig(dir, { getSessionForTopic: vi.fn().mockReturnValue('echo-topic-4242'), isSessionAlive: vi.fn().mockReturnValue(true) });
    r.gate.on = false; // the fix is NOT gated
    capture(r, 't-name');
    expect(r.deps.commitmentTracker.findByThreadId('t-name')!.relatedAgent).toBe('Dawn'); // the stored commitment is unchanged
    const out = await r.handler.tryRouteReplyToTopic({ envelope: envelope({ threadId: 't-name' }), threadEntry: entry() });
    expect(out).toMatchObject({ kind: 'routed', deliveryMode: 'live-inject' });
    expect(r.inject).toHaveBeenCalledTimes(1);
  });

  it('the comparison is case-folded', async () => {
    const r = rig(dir, { getSessionForTopic: vi.fn().mockReturnValue('s'), isSessionAlive: vi.fn().mockReturnValue(true) });
    capture(r, 't-case');
    const out = await r.handler.tryRouteReplyToTopic({ envelope: envelope({ threadId: 't-case', from: PEER_FP.toUpperCase() }), threadEntry: entry() });
    expect(out.kind).toBe('routed');
  });

  it('a DIFFERENT fingerprint on that thread is still refused (the hijack guard stands)', async () => {
    const r = rig(dir, { getSessionForTopic: vi.fn().mockReturnValue('s'), isSessionAlive: vi.fn().mockReturnValue(true) });
    capture(r, 't-hijack');
    const out = await r.handler.tryRouteReplyToTopic({ envelope: envelope({ threadId: 't-hijack', from: 'ee'.repeat(16) }), threadEntry: entry() });
    expect(out).toEqual({ kind: 'no-linkage' });
    expect(r.inject).not.toHaveBeenCalled();
    expect(r.asks).toHaveLength(0);
    expect(r.deps.commitmentTracker.findByThreadId('t-hijack')!.status).toBe('pending');
  });

  it('a sender equal to the stored display name still passes (unchanged)', async () => {
    const r = rig(dir, { getSessionForTopic: vi.fn().mockReturnValue('s'), isSessionAlive: vi.fn().mockReturnValue(true) });
    r.handler.captureOriginOnSend({ threadId: 't-same', remoteAgent: 'ai-guy', originTopicId: TOPIC });
    const out = await r.handler.tryRouteReplyToTopic({ envelope: envelope({ threadId: 't-same', from: 'ai-guy' }), threadEntry: { remoteAgent: 'ai-guy', originTopicId: TOPIC } });
    expect(out.kind).toBe('routed');
  });
});

describe('TopicLinkageHandler — machineOrigin at capture', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'linkage-remote-')); });
  afterEach(() => SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/TopicLinkageHandler-remoteReply.test.ts' }));

  it('a forwarded capture stamps machineOrigin, and a later forwarded capture OVERWRITES it', () => {
    const r = rig(dir);
    capture(r, 't-mo', 'm_standby_a');
    expect(r.deps.threadResumeMap.get('t-mo')!.machineOrigin).toBe('m_standby_a');
    capture(r, 't-mo', 'm_standby_b'); // the topic moved to a second standby
    expect(r.deps.threadResumeMap.get('t-mo')!.machineOrigin).toBe('m_standby_b');
  });
  it('a holder-local capture (no machineOrigin) keeps the stored value', () => {
    const r = rig(dir);
    capture(r, 't-keep', 'm_standby_a');
    capture(r, 't-keep');
    expect(r.deps.threadResumeMap.get('t-keep')!.machineOrigin).toBe('m_standby_a');
  });
  it('an ordinary capture stores none', () => {
    const r = rig(dir);
    capture(r, 't-none');
    expect(r.deps.threadResumeMap.get('t-none')!.machineOrigin).toBeUndefined();
  });
});

describe('TopicLinkageHandler — whom to ask (spec §5)', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'linkage-remote-')); vi.spyOn(console, 'warn').mockImplementation(() => {}); });
  afterEach(() => { vi.restoreAllMocks(); SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/TopicLinkageHandler-remoteReply.test.ts' }); });

  const route = (r: Rig, threadId: string, machineOrigin?: string, body?: string) =>
    r.handler.tryRouteReplyToTopic({ envelope: envelope({ threadId, id: 'in-77', body }), threadEntry: entry(machineOrigin) });

  it('1. machineOrigin names another machine ⇒ ask it; injected ⇒ live-inject, no Telegram post, commitment delivered', async () => {
    const r = rig(dir);
    capture(r, 't-1', 'm_standby');
    const out = await route(r, 't-1', 'm_standby');
    expect(out).toMatchObject({ kind: 'routed', deliveryMode: 'live-inject', telegramSent: false, commitmentDelivered: true });
    expect(r.asks).toHaveLength(1);
    expect(r.asks[0].machineId).toBe('m_standby');
    expect(r.asks[0].payload).toMatchObject({ topicId: TOPIC, messageId: 'in-77', threadId: 't-1' });
    expect(r.asks[0].payload.text).toContain('[threadline-reply]');
    expect(r.asks[0].payload.text).toContain('here is the answer');
    expect(r.asks[0].timeoutMs).toBe(400); // the whole budget
    expect(r.sendTg).not.toHaveBeenCalled();
    expect(r.inject).not.toHaveBeenCalled(); // nothing is typed on the holder
    expect(r.events).toEqual(['ask', 'injected']);
  });

  it('step 1 works with NO ownership record (the session pool dark)', async () => {
    const r = rig(dir, { topicOwnerOf: undefined });
    capture(r, 't-dark', 'm_standby');
    expect(await route(r, 't-dark', 'm_standby')).toMatchObject({ kind: 'routed', deliveryMode: 'live-inject' });
  });

  it('2. a DEFINITIVE not-injected, and the record names a third machine ⇒ ask that one, inside the same budget', async () => {
    const r = rig(dir, { remoteReplyBudgetMs: 5000 });
    r.owner.value = 'm_third';
    r.answer = (m) => m === 'm_standby' ? { injected: false, definitive: true, reason: 'no-session-for-topic' } : { injected: true };
    capture(r, 't-2', 'm_standby');
    const out = await route(r, 't-2', 'm_standby');
    expect(out).toMatchObject({ kind: 'routed', deliveryMode: 'live-inject' });
    expect(r.asks.map((a) => a.machineId)).toEqual(['m_standby', 'm_third']);
    expect(r.asks[0].timeoutMs).toBe(5000);
    expect(r.asks[1].timeoutMs).toBeLessThanOrEqual(5000);
    expect(r.asks[1].payload).toEqual(r.asks[0].payload);
  });

  it.each([
    ['a timeout', () => new Promise<TopicOwnerAskResult>(() => {})],
    ['a transport error', async () => ({ injected: false as const, definitive: false, reason: 'transport-error' })],
    ['an older peer answering claim-unauthorized', async () => ({ injected: false as const, definitive: false, reason: 'claim-unauthorized' })],
    ['an attempted but unconfirmed inject', async () => ({ injected: false as const, definitive: false, reason: 'inject-unconfirmed' })],
    ['a throwing ask', async () => { throw new Error('mesh client blew up'); }],
  ])('%s on the first ask ⇒ failure-visible with NO second ask (the first may have landed)', async (_label, first) => {
    const r = rig(dir);
    r.owner.value = 'm_third';
    r.answer = first as never;
    capture(r, 't-noask2', 'm_standby');
    const t = Date.now();
    const out = await route(r, 't-noask2', 'm_standby');
    expect(Date.now() - t).toBeLessThan(3000);
    expect(out).toMatchObject({ kind: 'routed', deliveryMode: 'failure-visible', telegramSent: true, commitmentDelivered: true });
    expect(r.asks).toHaveLength(1);
    expect(r.sendTg).toHaveBeenCalledTimes(1);
    expect(r.sendTg.mock.calls[0][0]).toBe(TOPIC);
    expect(String(r.sendTg.mock.calls[0][1])).toContain('here is the answer');
    expect(r.events).toEqual(['ask', 'failure-visible']);
  });

  it('a definitive not-injected with no third machine (absent, self, or the same machine) ⇒ failure-visible, one ask', async () => {
    for (const owner of [null, SELF, 'm_standby']) {
      const r = rig(fs.mkdtempSync(path.join(dir, 'sub-')));
      r.owner.value = owner;
      r.answer = () => ({ injected: false, definitive: true, reason: 'session-not-alive' });
      capture(r, 't-one', 'm_standby');
      const out = await route(r, 't-one', 'm_standby');
      expect(out).toMatchObject({ kind: 'routed', deliveryMode: 'failure-visible' });
      expect(r.asks).toHaveLength(1);
    }
  });

  it('a throwing ownership read at step 2 ⇒ failure-visible, never a throw', async () => {
    const r = rig(dir);
    r.owner.throws = true;
    r.answer = () => ({ injected: false, definitive: true, reason: 'no-session-for-topic' });
    capture(r, 't-throw2', 'm_standby');
    const out = await route(r, 't-throw2', 'm_standby');
    expect(out).toMatchObject({ kind: 'routed', deliveryMode: 'failure-visible', telegramSent: true });
    expect(r.asks).toHaveLength(1);
  });

  it('at most TWO asks, and both failing is failure-visible', async () => {
    const r = rig(dir, { remoteReplyBudgetMs: 5000 });
    r.owner.value = 'm_third';
    r.answer = () => ({ injected: false, definitive: true, reason: 'no-session-for-topic' });
    capture(r, 't-two', 'm_standby');
    const out = await route(r, 't-two', 'm_standby');
    expect(out).toMatchObject({ kind: 'routed', deliveryMode: 'failure-visible' });
    expect(r.asks).toHaveLength(2);
  });

  it('ONE budget: a slow first ask leaves the second only what remains, and none when under a second is left', async () => {
    const r = rig(dir, { remoteReplyBudgetMs: 1500 });
    r.owner.value = 'm_third';
    r.answer = (m) => m === 'm_standby'
      ? new Promise((res) => setTimeout(() => res({ injected: false, definitive: true, reason: 'no-session-for-topic' }), 250))
      : { injected: true };
    capture(r, 't-budget', 'm_standby');
    await route(r, 't-budget', 'm_standby');
    expect(r.asks).toHaveLength(2);
    expect(r.asks[1].timeoutMs).toBeLessThanOrEqual(1500 - 240);
    expect(r.asks[1].timeoutMs).toBeGreaterThan(900);

    const tight = rig(fs.mkdtempSync(path.join(dir, 'sub-')), { remoteReplyBudgetMs: 1100 });
    tight.owner.value = 'm_third';
    tight.answer = (m) => m === 'm_standby'
      ? new Promise((res) => setTimeout(() => res({ injected: false, definitive: true, reason: 'no-session-for-topic' }), 250))
      : { injected: true };
    capture(tight, 't-budget2', 'm_standby');
    const out = await route(tight, 't-budget2', 'm_standby');
    expect(tight.asks).toHaveLength(1); // < 1 s left: no second ask
    expect(out).toMatchObject({ kind: 'routed', deliveryMode: 'failure-visible' });
  });

  it('3. no machineOrigin: the machine the ownership record names is asked (a topic that moved after a holder-local send)', async () => {
    const r = rig(dir);
    r.owner.value = 'm_moved_to';
    capture(r, 't-3');
    const out = await route(r, 't-3');
    expect(out).toMatchObject({ kind: 'routed', deliveryMode: 'live-inject' });
    expect(r.asks.map((a) => a.machineId)).toEqual(['m_moved_to']);
  });

  it('3. a machineOrigin naming THIS machine is treated like none', async () => {
    const r = rig(dir);
    r.owner.value = 'm_moved_to';
    capture(r, 't-3self', SELF);
    await route(r, 't-3self', SELF);
    expect(r.asks.map((a) => a.machineId)).toEqual(['m_moved_to']);
  });

  it('3. a definitive not-injected from the record\'s machine gets no second ask', async () => {
    const r = rig(dir);
    r.owner.value = 'm_moved_to';
    r.answer = () => ({ injected: false, definitive: true, reason: 'session-not-alive' });
    capture(r, 't-3no');
    const out = await route(r, 't-3no');
    expect(out).toMatchObject({ kind: 'routed', deliveryMode: 'failure-visible' });
    expect(r.asks).toHaveLength(1);
  });

  it('a throwing ownership read at step 3 still returns routed (failure-visible), with no ask', async () => {
    const r = rig(dir);
    r.owner.throws = true;
    capture(r, 't-throw3');
    const out = await route(r, 't-throw3');
    expect(out).toMatchObject({ kind: 'routed', deliveryMode: 'failure-visible', telegramSent: true });
    expect(r.asks).toHaveLength(0);
  });

  it('a throwing salience gate still returns routed (failure-visible)', async () => {
    const r = rig(dir, { salienceGate: { evaluate: async () => { throw new Error('classifier down'); } } as never });
    capture(r, 't-sal', 'm_standby');
    const out = await route(r, 't-sal', 'm_standby');
    expect(out).toMatchObject({ kind: 'routed', deliveryMode: 'failure-visible', telegramSent: true });
  });

  it('a live LOCAL session wins before any ask (a stale machineOrigin is harmless)', async () => {
    const r = rig(dir, { getSessionForTopic: vi.fn().mockReturnValue('echo-topic-4242'), isSessionAlive: vi.fn().mockReturnValue(true) });
    r.owner.value = 'm_third';
    capture(r, 't-local', 'm_standby');
    const out = await route(r, 't-local', 'm_standby');
    expect(out).toMatchObject({ kind: 'routed', deliveryMode: 'live-inject' });
    expect(r.asks).toHaveLength(0);
    expect(r.inject).toHaveBeenCalledTimes(1);
  });

  it('a rate-limited post: the reply is neither injected nor posted, the commitment stays OPEN — and it is still routed', async () => {
    const r = rig(dir);
    r.answer = () => ({ injected: false, definitive: false, reason: 'timeout' });
    capture(r, 't-rl', 'm_standby');
    const a = await route(r, 't-rl', 'm_standby');
    expect(a).toMatchObject({ kind: 'routed', deliveryMode: 'failure-visible', telegramSent: true });
    capture(r, 't-rl', 'm_standby'); // the commitment was delivered; a second send re-opens one
    const b = await route(r, 't-rl', 'm_standby'); // inside the per-thread minute
    expect(b).toMatchObject({ kind: 'routed', deliveryMode: 'failure-visible', telegramSent: false, commitmentDelivered: false });
    expect(r.sendTg).toHaveBeenCalledTimes(1);
    expect(r.deps.commitmentTracker.findByThreadId('t-rl')!.status).toBe('pending');
  });

  it('a long reply is truncated with a pointer that names the HOLDER as the place to read the full body', async () => {
    const r = rig(dir);
    capture(r, 't-long', 'm_standby');
    await route(r, 't-long', 'm_standby', 'y'.repeat(9000));
    const text = r.asks[0].payload.text;
    expect(text).toContain('reply body truncated to 8000 chars; the full body is on my machine "the mini"');
    expect(text).not.toContain('full body available via threadline_history]');
    expect(Buffer.byteLength(text, 'utf-8')).toBeLessThan(64 * 1024);
  });

  // ── today's code, unchanged ───────────────────────────────────

  it('NO machineOrigin and NO ownership record ⇒ today\'s exact outcome (topic-expired, commitment delivered, no ask, no post)', async () => {
    const r = rig(dir);
    capture(r, 't-today');
    const out = await route(r, 't-today');
    expect(out).toEqual({ kind: 'topic-expired', reason: 'topic has no live session and no dormant resume entry' });
    expect(r.asks).toHaveLength(0);
    expect(r.sendTg).not.toHaveBeenCalled();
    expect(r.deps.commitmentTracker.findByThreadId('t-today')).toBeNull(); // delivered ⇒ no longer active
    expect(r.events).toEqual([]);
  });

  it('the record names THIS machine ⇒ today\'s code', async () => {
    const r = rig(dir);
    r.owner.value = SELF;
    capture(r, 't-self');
    expect((await route(r, 't-self')).kind).toBe('topic-expired');
    expect(r.asks).toHaveLength(0);
  });

  it('the gate OFF: no machine is asked — today\'s topic linkage (the rollback case)', async () => {
    const r = rig(dir);
    r.gate.on = false;
    r.owner.value = 'm_third';
    capture(r, 't-off', 'm_standby');
    const out = await route(r, 't-off', 'm_standby');
    expect(out.kind).toBe('topic-expired');
    expect(r.asks).toHaveLength(0);
  });

  it('the gate OFF adds no call at all: not even the ownership read or an extra liveness probe', async () => {
    const ownerOf = vi.fn(() => 'm_third');
    const alive = vi.fn().mockReturnValue(true);
    const r = rig(dir, { topicOwnerOf: ownerOf, isSessionAlive: alive, getSessionForTopic: vi.fn().mockReturnValue('echo-topic-4242') });
    r.gate.on = false;
    capture(r, 't-off-calls', 'm_standby');
    const out = await route(r, 't-off-calls', 'm_standby');
    expect(out).toMatchObject({ kind: 'routed', deliveryMode: 'live-inject' });
    expect(ownerOf).not.toHaveBeenCalled();
    expect(alive).toHaveBeenCalledTimes(1); // today's single probe before the inject
  });

  it('no dependency wired / no mesh identity / a throwing gate reader ⇒ today\'s code', async () => {
    for (const over of [
      { deliverToTopicOwner: undefined },
      { selfMachineId: () => null },
      { remoteReplyEnabled: () => { throw new Error('x'); } },
      { remoteReplyEnabled: undefined },
    ] as Array<Partial<TopicLinkageDeps>>) {
      const r = rig(fs.mkdtempSync(path.join(dir, 'sub-')), over);
      capture(r, 't-nodep', 'm_standby');
      expect((await route(r, 't-nodep', 'm_standby')).kind).toBe('topic-expired');
    }
  });
});

describe('through a REAL ThreadlineRouter — a topic-bound reply never spawns on the holder', () => {
  let dir: string;
  let spawn: { evaluate: ReturnType<typeof vi.fn>; handleDenial: ReturnType<typeof vi.fn>; getStatus: ReturnType<typeof vi.fn>; reset: ReturnType<typeof vi.fn> };
  const relayCtx = { trust: { kind: 'plaintext-tofu' as const, senderFingerprint: PEER_FP }, senderFingerprint: PEER_FP, senderName: 'Dawn', trustLevel: 'verified' as const };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'linkage-remote-router-'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    spawn = {
      evaluate: vi.fn().mockResolvedValue({ approved: true, sessionId: 'sid', tmuxSession: 'tmux-1', reason: 'ok' }),
      handleDenial: vi.fn(), getStatus: vi.fn().mockReturnValue({ cooldowns: [], pendingRetries: 0 }), reset: vi.fn(),
    };
  });
  afterEach(() => { vi.restoreAllMocks(); SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/TopicLinkageHandler-remoteReply.test.ts' }); });

  function build(over: Partial<TopicLinkageDeps> = {}) {
    const r = rig(dir, over);
    const store = { getThread: vi.fn().mockResolvedValue(null), exists: vi.fn(), save: vi.fn() };
    const msgRouter = { getThread: vi.fn().mockResolvedValue(null) };
    const router = new ThreadlineRouter(msgRouter as never, spawn as never, r.deps.threadResumeMap, store as never,
      { localAgent: 'echo', localMachine: SELF }, null as never, null as never);
    router.setTopicLinkageHandler(r.handler);
    return { r, router };
  }

  const failures: Array<[string, (r: Rig) => void]> = [
    ['an unreachable machine (transport error)', (r) => { r.answer = () => ({ injected: false, definitive: false, reason: 'transport-error' }); }],
    ['an older peer answering claim-unauthorized', (r) => { r.answer = () => ({ injected: false, definitive: false, reason: 'claim-unauthorized' }); }],
    ['a timeout', (r) => { r.answer = () => new Promise(() => {}); }],
    ['no live session on the asked machine and no record', (r) => { r.answer = () => ({ injected: false, definitive: true, reason: 'no-session-for-topic' }); }],
    ['a throwing ask', (r) => { r.answer = () => { throw new Error('boom'); }; }],
    ['a throwing ownership read', (r) => { r.owner.throws = true; r.answer = () => ({ injected: false, definitive: true, reason: 'no-session-for-topic' }); }],
    ['a Telegram post that itself fails', (r) => { r.answer = () => ({ injected: false, definitive: false, reason: 'timeout' }); r.sendTg.mockRejectedValue(new Error('telegram down')); }],
  ];
  for (const [label, arrange] of failures) {
    it(`${label} ⇒ handled, nothing spawned`, async () => {
      const { r, router } = build();
      arrange(r);
      capture(r, 't-router', 'm_standby');
      const res = await router.handleInboundMessage(envelope({ threadId: 't-router' }), relayCtx);
      expect(res).toMatchObject({ handled: true, accepted: true, delivered: false, threadId: 't-router' });
      expect(spawn.evaluate).not.toHaveBeenCalled();
    });
  }

  it('a rate-limited post ⇒ handled, nothing spawned (the reply stays in the hub)', async () => {
    const { r, router } = build();
    r.answer = () => ({ injected: false, definitive: false, reason: 'timeout' });
    capture(r, 't-router-rl', 'm_standby');
    await router.handleInboundMessage(envelope({ threadId: 't-router-rl' }), relayCtx);
    capture(r, 't-router-rl', 'm_standby');
    const second = await router.handleInboundMessage(envelope({ threadId: 't-router-rl' }), relayCtx);
    expect(second).toMatchObject({ handled: true, delivered: false });
    expect(r.sendTg).toHaveBeenCalledTimes(1);
    expect(spawn.evaluate).not.toHaveBeenCalled();
  });

  it('an inject on the other machine ⇒ handled + delivered on the topic path, nothing spawned', async () => {
    const { r, router } = build();
    capture(r, 't-router-ok', 'm_standby');
    const res = await router.handleInboundMessage(envelope({ threadId: 't-router-ok' }), relayCtx);
    expect(res).toMatchObject({ handled: true, delivered: true, injected: true, path: 'topic' });
    expect(spawn.evaluate).not.toHaveBeenCalled();
  });

  it('the router hands the thread\'s machineOrigin to the handler', async () => {
    const { r, router } = build();
    capture(r, 't-router-mo', 'm_standby');
    await router.handleInboundMessage(envelope({ threadId: 't-router-mo' }), relayCtx);
    expect(r.asks.map((a) => a.machineId)).toEqual(['m_standby']);
  });

  it('CONTRAST — today\'s code: no machineOrigin and no record reaches the thread worker (the only case that still can)', async () => {
    const { r, router } = build();
    capture(r, 't-router-today');
    const res = await router.handleInboundMessage(envelope({ threadId: 't-router-today' }), relayCtx);
    expect(r.asks).toHaveLength(0);
    expect(res.handled).toBe(true);
    expect(spawn.evaluate).toHaveBeenCalledTimes(1);
  });
});
