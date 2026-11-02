/**
 * Integration — the topic name rides beside every topic id a session is handed (operator rule
 * 2026-11-02). Through the REAL ThreadlineRouter + TopicLinkageHandler, with the name read from
 * a REAL TelegramAdapter's on-disk topic registry, exactly as boot wires `setTopicNameResolver`.
 *
 * Live case: a peer's session was told "topic 11882, the topic for echo" with no name and told
 * its user it could not see the name, though the registry held "🤝 echo".
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
import { TelegramAdapter } from '../../../src/messaging/TelegramAdapter.js';
import { setTopicNameResolver } from '../../../src/messaging/shared/topicRef.js';
import type { MessageEnvelope } from '../../../src/messaging/types.js';

const PEER = 'e69ee27193f3cf899fceef5a0487c28b';
const ORIGIN = 9210;
const HOMEBASE = 11882;

function envelope(threadId: string): MessageEnvelope {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    message: {
      id: crypto.randomUUID(),
      from: { agent: PEER, session: 'relay', machine: 'relay' },
      to: { agent: 'scout', session: 'best', machine: 'local' },
      type: 'query', priority: 'medium', subject: 'Relay message', body: 'For your person: hello.', createdAt: now, threadId,
    },
    transport: { relayChain: [], originServer: 'http://localhost:1', nonce: `${crypto.randomUUID()}:${now}`, timestamp: now },
    delivery: { phase: 'received', transitions: [], attempts: 1 },
  } as MessageEnvelope;
}
const relayCtx = { trust: { kind: 'plaintext-tofu' as const, senderFingerprint: PEER }, senderFingerprint: PEER, senderName: 'echo', trustLevel: 'verified' as const };

describe('topic name beside id — threadline session text', () => {
  let dir: string;
  let stateDir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'topic-name-int-'));
    stateDir = path.join(dir, '.instar');
    fs.mkdirSync(path.join(stateDir, 'state'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ sessions: { maxSessions: 3 } }));
    // The real topic registry the adapter persists; the homebase is named, the origin is not.
    fs.writeFileSync(path.join(stateDir, 'topic-session-registry.json'), JSON.stringify({
      topicToSession: {}, topicToName: { [String(HOMEBASE)]: '🤝 echo' },
    }));
    const adapter = new TelegramAdapter({ token: 'test-token', chatId: '-100123', pollIntervalMs: 100 }, stateDir);
    setTopicNameResolver((id) => adapter.getTopicName(id));
  });
  afterEach(() => {
    setTopicNameResolver(null);
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/integration/threadline/topic-name-beside-id.test.ts' });
  });

  it('a topic-linked reply redirected to the homebase names both topics (or says unresolved)', async () => {
    const threadResumeMap = new ThreadResumeMap(stateDir, dir);
    const inject = vi.fn().mockResolvedValue(true);
    const handler = new TopicLinkageHandler({
      commitmentTracker: new CommitmentTracker({ stateDir, liveConfig: new LiveConfig(stateDir) }),
      topicResumeMap: new TopicResumeMap(stateDir, dir),
      threadResumeMap,
      salienceGate: new SalienceGate(),
      localAgent: 'scout',
      injectIntoSession: inject,
      isSessionAlive: () => true,
      sendTelegramToTopic: vi.fn().mockResolvedValue(undefined),
      getSessionForTopic: () => 'scout-topic-9210',
      resolveUserTopic: () => HOMEBASE,
    });
    const spawn = { evaluate: vi.fn(), handleDenial: vi.fn(), getStatus: vi.fn().mockReturnValue({ cooldowns: [], pendingRetries: 0 }), reset: vi.fn() };
    const router = new ThreadlineRouter({ getThread: vi.fn().mockResolvedValue(null) } as never, spawn as never, threadResumeMap, { getThread: vi.fn(), exists: vi.fn(), save: vi.fn() } as never,
      { localAgent: 'scout', localMachine: 'local' }, null as never, null as never);
    router.setTopicLinkageHandler(handler);
    const threadId = crypto.randomUUID();
    handler.captureOriginOnSend({ threadId, remoteAgent: PEER, originTopicId: ORIGIN });
    await router.handleInboundMessage(envelope(threadId), relayCtx);
    const text = inject.mock.calls[0][1] as string;
    expect(text).toContain(`topic ${HOMEBASE} "🤝 echo"`);
    expect(text).toContain(`topic ${ORIGIN} (name unresolved)`);
    // No bare id anywhere in the notice line.
    expect(text).not.toMatch(/topic \d+(?! "| \(name unresolved\))/);
  });

  it('the spawn-prompt topic hint names the topic', () => {
    const spawn = { evaluate: vi.fn(), handleDenial: vi.fn(), getStatus: vi.fn().mockReturnValue({ cooldowns: [], pendingRetries: 0 }), reset: vi.fn() };
    const router = new ThreadlineRouter({ getThread: vi.fn() } as never, spawn as never, new ThreadResumeMap(stateDir, dir), { getThread: vi.fn(), exists: vi.fn(), save: vi.fn() } as never,
      { localAgent: 'scout', localMachine: 'local' }, null as never, null as never);
    router.setPeerUserTopicResolver(() => ({ topicId: HOMEBASE, via: 'homebase' }));
    const hint = (router as unknown as { userTopicHint: (t: string, r: string, c?: unknown) => string }).userTopicHint('t', PEER, relayCtx);
    expect(hint).toContain(`topic ${HOMEBASE} "🤝 echo"`);
    expect(hint).not.toMatch(/topic \d+(?! "| \(name unresolved\))/);
  });
});
