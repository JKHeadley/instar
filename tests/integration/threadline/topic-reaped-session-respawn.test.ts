/**
 * ACT-091 integration — a topic-bound relay reply through the REAL
 * ThreadlineRouter + REAL TopicLinkageHandler (real CommitmentTracker,
 * TopicResumeMap, ThreadResumeMap) when the topic's session was idle-reaped.
 *
 * Before the fix the router returned `resumed: true` (the relay logged
 * "Resumed session") for a reply that reached no session. Now:
 *  - reaped + respawn wired  → respawned with the reply, delivered, path topic;
 *  - reaped + respawn refused→ accepted, NOT delivered, NOT resumed;
 *  - live session            → typed in, never respawned.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { ThreadlineRouter } from '../../../src/threadline/ThreadlineRouter.js';
import { ThreadResumeMap } from '../../../src/threadline/ThreadResumeMap.js';
import { TopicResumeMap } from '../../../src/core/TopicResumeMap.js';
import { TopicLinkageHandler } from '../../../src/threadline/TopicLinkageHandler.js';
import { SalienceGate } from '../../../src/threadline/SalienceGate.js';
import { CommitmentTracker } from '../../../src/monitoring/CommitmentTracker.js';
import { LiveConfig } from '../../../src/config/LiveConfig.js';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';
import { outcomeFromRouterResult } from '../../../src/threadline/InboundIdLedger.js';
import { SpawningTopicsRegistry } from '../../../src/core/SpawningTopicsRegistry.js';
import { createThreadlineTopicRespawn } from '../../../src/threadline/topicRespawnHook.js';
import type { MessageEnvelope } from '../../../src/messaging/types.js';

const PEER = 'dawn-fingerprint';
const TOPIC = 9210;

function envelope(threadId: string): MessageEnvelope {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    message: {
      id: crypto.randomUUID(),
      from: { agent: PEER, session: 'relay', machine: 'relay' },
      to: { agent: 'echo', session: 'best', machine: 'local' },
      type: 'query', priority: 'medium', subject: 'Relay message', body: 'the answer you asked for', createdAt: now, threadId,
    },
    transport: { relayChain: [], originServer: 'http://localhost:1', nonce: `${crypto.randomUUID()}:${now}`, timestamp: now },
    delivery: { phase: 'received', transitions: [], attempts: 1 },
  } as MessageEnvelope;
}

const relayCtx = { trust: { kind: 'plaintext-tofu' as const, senderFingerprint: PEER }, senderFingerprint: PEER, senderName: 'dawn', trustLevel: 'verified' as const };

describe('ThreadlineRouter + TopicLinkageHandler — reaped topic session (ACT-091)', () => {
  let dir: string;
  let stateDir: string;
  let threadResumeMap: ThreadResumeMap;
  let spawn: { evaluate: ReturnType<typeof vi.fn>; handleDenial: ReturnType<typeof vi.fn>; getStatus: ReturnType<typeof vi.fn>; reset: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-reaped-'));
    stateDir = path.join(dir, '.instar');
    fs.mkdirSync(path.join(stateDir, 'state'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ sessions: { maxSessions: 3 } }));
    threadResumeMap = new ThreadResumeMap(stateDir, dir);
    spawn = {
      evaluate: vi.fn().mockResolvedValue({ approved: true, sessionId: 'sid', tmuxSession: 'thread-worker', reason: 'ok' }),
      handleDenial: vi.fn(), getStatus: vi.fn().mockReturnValue({ cooldowns: [], pendingRetries: 0 }), reset: vi.fn(),
    };
  });
  afterEach(() => SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/integration/threadline/topic-reaped-session-respawn.test.ts' }));

  function build(opts: { alive: boolean | (() => boolean); respawn?: (args: { topicId: number; text: string }) => Promise<import('../../../src/threadline/topicRespawnHook.js').TopicRespawnResult>; spawning?: () => boolean }) {
    const inject = vi.fn().mockResolvedValue(true);
    const sendTg = vi.fn().mockResolvedValue(undefined);
    const handler = new TopicLinkageHandler({
      commitmentTracker: new CommitmentTracker({ stateDir, liveConfig: new LiveConfig(stateDir) }),
      topicResumeMap: new TopicResumeMap(stateDir, dir),
      threadResumeMap,
      salienceGate: new SalienceGate({ classify: async () => ({ verdict: 'agent-internal' as const, reason: 'chatter' }) }),
      localAgent: 'echo',
      injectIntoSession: inject,
      isSessionAlive: () => (typeof opts.alive === 'function' ? opts.alive() : opts.alive),
      ...(opts.spawning ? { isTopicSpawning: opts.spawning } : {}),
      sendTelegramToTopic: sendTg,
      getSessionForTopic: () => 'echo-topic-9210',
      ...(opts.respawn ? { respawnTopicSession: opts.respawn } : {}),
    });
    const store = { getThread: vi.fn().mockResolvedValue(null), exists: vi.fn(), save: vi.fn() };
    const router = new ThreadlineRouter({ getThread: vi.fn().mockResolvedValue(null) } as never, spawn as never, threadResumeMap, store as never,
      { localAgent: 'echo', localMachine: 'local' }, null as never, null as never);
    router.setTopicLinkageHandler(handler);
    const threadId = crypto.randomUUID();
    handler.captureOriginOnSend({ threadId, remoteAgent: PEER, originTopicId: TOPIC });
    return { router, threadId, inject, sendTg };
  }

  it('reaped + respawn wired → the session is respawned with the reply; delivered, resumed, path topic', async () => {
    const respawn = vi.fn().mockResolvedValue({ delivered: true, mode: 'respawn-inject', sessionName: 'echo-topic-9210' });
    const { router, threadId, inject } = build({ alive: false, respawn });
    const r = await router.handleInboundMessage(envelope(threadId), relayCtx);
    expect(respawn).toHaveBeenCalledTimes(1);
    expect(respawn.mock.calls[0][0]).toMatchObject({ topicId: TOPIC });
    expect(respawn.mock.calls[0][0].text).toContain('the answer you asked for');
    expect(inject).not.toHaveBeenCalled();
    expect(r).toMatchObject({ handled: true, delivered: true, resumed: true, path: 'topic' });
    expect(outcomeFromRouterResult(r)).toEqual({ kind: 'handed-off', path: 'topic' });
    expect(spawn.evaluate).not.toHaveBeenCalled(); // no context-less thread worker
  });

  it('reaped + respawn refused → accepted but NOT delivered and NOT reported as resumed', async () => {
    const respawn = vi.fn().mockResolvedValue({ delivered: false, reason: 'topic-owned-by-another-machine' });
    const { router, threadId, sendTg } = build({ alive: false, respawn });
    const r = await router.handleInboundMessage(envelope(threadId), relayCtx);
    expect(r.handled).toBe(true);
    expect(r.delivered).toBe(false);
    expect(r.resumed).toBe(false);
    expect(r.path).toBeUndefined();
    expect(sendTg).toHaveBeenCalledTimes(1); // failure-visible → surfaced to the topic
  });

  it('reaped + no respawn path (legacy resume-pending) → never reported as resumed', async () => {
    const { router, threadId } = build({ alive: false });
    const r = await router.handleInboundMessage(envelope(threadId), relayCtx);
    expect(r.delivered).toBe(false);
    expect(r.resumed).toBe(false);
  });

  it('live session → typed into the live session; respawn is never called', async () => {
    const respawn = vi.fn().mockResolvedValue({ delivered: true, mode: 'respawn-inject' });
    const { router, threadId, inject } = build({ alive: true, respawn });
    const r = await router.handleInboundMessage(envelope(threadId), relayCtx);
    expect(inject).toHaveBeenCalledTimes(1);
    expect(respawn).not.toHaveBeenCalled();
    expect(r).toMatchObject({ delivered: true, injected: true, path: 'topic' });
  });

  it('two replies inside ONE respawn (real registry + real hook): the first respawns, the second waits and is typed in once — nothing lost, nothing duplicated', async () => {
    let alive = false;
    const spawning = new SpawningTopicsRegistry();
    let finishRespawn!: () => void;
    const respawnPrimitive = vi.fn(() => new Promise<void>((res) => { finishRespawn = () => { alive = true; res(); }; }));
    const injectConfirmed = vi.fn().mockResolvedValue(true);
    const hook = createThreadlineTopicRespawn({
      spawning,
      ownedElsewhere: () => false,
      registeredSession: () => 'echo-topic-9210',
      isSessionAlive: () => alive,
      injectConfirmed,
      leaseGate: () => ({ spawnLocally: true, reason: 'single-machine' }),
      classifyDeath: () => 'other',
      respawn: respawnPrimitive,
      coldSpawn: vi.fn(),
      spawnWaitPollMs: 5,
      log: () => {},
    });
    // The handler's direct-inject path must not see the booting session as a live target.
    const { router, threadId, inject, sendTg } = build({ alive: () => alive, respawn: hook, spawning: (t) => spawning.has(t) });

    const first = router.handleInboundMessage(envelope(threadId), relayCtx);
    await new Promise((r) => setTimeout(r, 20));
    expect(spawning.has(TOPIC)).toBe(true);
    const second = router.handleInboundMessage({ ...envelope(threadId), message: { ...envelope(threadId).message, body: 'one more thing' } } as MessageEnvelope, relayCtx);
    await new Promise((r) => setTimeout(r, 20));
    expect(injectConfirmed).not.toHaveBeenCalled();
    finishRespawn();

    const r1 = await first;
    const r2 = await second;
    expect(r1).toMatchObject({ delivered: true, resumed: true, path: 'topic' });
    expect(r2).toMatchObject({ delivered: true, injected: true, resumed: false, path: 'topic' });
    expect(respawnPrimitive).toHaveBeenCalledTimes(1);
    expect(injectConfirmed).toHaveBeenCalledTimes(1);
    expect(injectConfirmed.mock.calls[0][1]).toContain('one more thing');
    expect(inject).not.toHaveBeenCalled(); // the handler never pasted directly into the booting session
    expect(sendTg).not.toHaveBeenCalled(); // neither reply was posted as a failure
    expect(spawning.has(TOPIC)).toBe(false);
  });
});
