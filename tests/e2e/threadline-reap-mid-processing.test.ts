import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ResumeQueue } from '../../src/monitoring/ResumeQueue.js';
import { ResumeQueueDrainer } from '../../src/monitoring/ResumeQueueDrainer.js';
import { ListenerSessionManager } from '../../src/threadline/ListenerSessionManager.js';
import { createThreadlineReapRecovery } from '../../src/threadline/ThreadlineReapRecovery.js';
import { ThreadLog } from '../../src/threadline/ThreadLog.js';
import { contentDigest } from '../../src/threadline/threadDigest.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

// canonical-migration-validator: threadline-inbound-canonical-store@1

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'threadline reap e2e cleanup' });
});

describe('quota reap during Threadline warm-turn processing', () => {
  it('durably queues the exact inbound and redrives it once pressure clears', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'threadline-reap-e2e-'));
    dirs.push(dir);
    const listener = new ListenerSessionManager(dir, 'token');
    listener.appendCanonicalInboxEntry({
      from: 'peer-fp', senderName: 'Peer', trustLevel: 'trusted', threadId: 'thread-1', text: 'the interrupted reply', messageId: 'msg-1',
    });
    const queue = new ResumeQueue({
      stateDir: dir,
      hostname: () => os.hostname(),
      pidAlive: () => false,
      isStateDirHostLocal: () => true,
    }, { enabled: true, dryRun: false });
    expect(queue.start()).toBe(true);
    const enqueued = queue.considerEnqueue({
      sessionName: 'msg-warm-1', tmuxSession: 'msg-warm-1', cwd: dir,
      threadId: 'thread-1', threadlineMessageId: 'msg-1', reason: 'quota-shed',
      disposition: 'terminal', origin: 'autonomous', workEvidence: ['pending-injection'],
    });
    expect(enqueued.enqueued).toBe(true);
    expect(enqueued.entry?.stableKey).toBe('thread:thread-1');

    const redriven: string[] = [];
    const recovery = createThreadlineReapRecovery({
      localAgent: 'self', manager: () => listener,
      router: () => ({
        handleInboundMessage: async (envelope: { message: { id: string; threadId?: string; body: string } }) => {
          redriven.push(envelope.message.id);
          expect(envelope.message).toMatchObject({ id: 'msg-1', threadId: 'thread-1', body: 'the interrupted reply' });
          return { handled: true, threadId: 'thread-1', sessionName: 'msg-warm-recovered' };
        },
      }) as never,
    });
    expect(listener.tryClaimReply('msg-1', 'original-worker')).toBe(true);
    expect(recovery.pending(enqueued.entry!)).toBe(false);
    listener.releaseReplyClaim('msg-1', 'original-worker');
    expect(recovery.pending(enqueued.entry!)).toBe(true);
    const drainer = new ResumeQueueDrainer({
      queue,
      pressureTier: () => 'normal', canSpawnSession: () => true, sessionCountOk: () => true, migrationInFlight: () => false,
      liveSessionForTopic: () => false, currentResumeUuid: () => null, topicOwnerElsewhere: () => false,
      topicBindingMatches: () => true, operatorStopSince: () => false, jobCheck: () => ({ ok: true }), pathExists: fs.existsSync,
      respawnTopic: async () => 'unused', triggerJob: async () => 'skipped',
      threadlineMessagePending: recovery.pending,
      respawnThread: recovery.respawn,
      spawnAliveAfterGrace: async () => true, raiseAggregated: () => {}, audit: () => {},
    }, { requiredCalmTicks: 0, tier1Check: false });

    expect(await drainer.tick({ skipCalmTicks: true })).toEqual({ resumed: true });
    expect(redriven).toEqual(['msg-1']);
    expect(listener.tryClaimReply('msg-1', 'competing-original')).toBe(false);
    expect(queue.list().find((entry) => entry.id === enqueued.entry!.id)?.status).toBe('respawned');
    queue.stop();
  });

  it('redrives a modern-only canonical ThreadLog inbound when the legacy inbox is empty', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'threadline-reap-modern-e2e-'));
    dirs.push(dir);
    const listener = new ListenerSessionManager(dir, 'token');
    const threadLog = new ThreadLog(dir);
    const createdAt = '2026-07-19T22:00:00.000Z';
    threadLog.append({
      threadId: 'thread-modern', messageId: 'msg-modern', direction: 'inbound',
      contentDigest: contentDigest({
        threadId: 'thread-modern', messageId: 'msg-modern', body: 'modern canonical body', createdAt,
      }),
      createdAt, peerFingerprint: 'peer-modern', author: { agentFingerprint: 'peer-modern' },
      textRef: { kind: 'inline', text: 'modern canonical body' },
    });
    const handled: string[] = [];
    const recovery = createThreadlineReapRecovery({
      localAgent: 'self', manager: () => listener, threadLog: () => threadLog,
      router: () => ({
        handleInboundMessage: async (envelope: { message: { body: string } }) => {
          handled.push(envelope.message.body);
          return { handled: true, threadId: 'thread-modern', sessionName: 'msg-modern-recovered' };
        },
      }) as never,
    });
    const entry = {
      id: 'rq-modern', threadlineMessageId: 'msg-modern', threadId: 'thread-modern',
    } as unknown as import('../../src/monitoring/ResumeQueue.js').ResumeQueueEntry;

    expect(recovery.pending(entry)).toBe(true);
    expect(await recovery.respawn(entry)).toBe('msg-modern-recovered');
    expect(handled).toEqual(['modern canonical body']);
  });

  it('resolves and redrives a modern-only store-backed canonical inbound', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'threadline-reap-store-e2e-'));
    dirs.push(dir);
    const listener = new ListenerSessionManager(dir, 'token');
    const threadLog = new ThreadLog(dir);
    const createdAt = '2026-07-19T22:10:00.000Z';
    const body = 'store-backed canonical body';
    threadLog.append({
      threadId: 'thread-stored', messageId: 'msg-stored', direction: 'inbound',
      contentDigest: contentDigest({ threadId: 'thread-stored', messageId: 'msg-stored', body, createdAt }),
      createdAt, peerFingerprint: 'peer-stored',
      textRef: { kind: 'store', messageStoreId: 'msg-stored' },
    });
    const handled: string[] = [];
    const recovery = createThreadlineReapRecovery({
      localAgent: 'self', manager: () => listener, threadLog: () => threadLog,
      messageStore: () => ({
        get: async () => ({ message: { id: 'msg-stored', threadId: 'thread-stored', body, createdAt } }) as never,
      }),
      router: () => ({
        handleInboundMessage: async (envelope: { message: { body: string } }) => {
          handled.push(envelope.message.body);
          return { handled: true, threadId: 'thread-stored', sessionName: 'msg-stored-recovered' };
        },
      }) as never,
    });
    const entry = { id: 'rq-stored', threadlineMessageId: 'msg-stored', threadId: 'thread-stored' } as never;

    expect(recovery.pending(entry)).toBe(true);
    expect(await recovery.respawn(entry)).toBe('msg-stored-recovered');
    expect(handled).toEqual([body]);
  });

  it.each([
    ['missing', null],
    ['corrupt identity', { message: { id: 'wrong-id', threadId: 'thread-stored', body: 'body', createdAt: '2026-07-19T22:20:00.000Z' } }],
    ['digest mismatch', { message: { id: 'msg-stored', threadId: 'thread-stored', body: 'tampered', createdAt: '2026-07-19T22:20:00.000Z' } }],
  ])('fails closed for %s store-backed canonical evidence', async (_case, storedEnvelope) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'threadline-reap-store-invalid-e2e-'));
    dirs.push(dir);
    const listener = new ListenerSessionManager(dir, 'token');
    const threadLog = new ThreadLog(dir);
    const createdAt = '2026-07-19T22:20:00.000Z';
    threadLog.append({
      threadId: 'thread-stored', messageId: 'msg-stored', direction: 'inbound',
      contentDigest: contentDigest({ threadId: 'thread-stored', messageId: 'msg-stored', body: 'authentic', createdAt }),
      createdAt, peerFingerprint: 'peer-stored',
      textRef: { kind: 'store', messageStoreId: 'msg-stored' },
    });
    const router = { handleInboundMessage: vi.fn() };
    const recovery = createThreadlineReapRecovery({
      localAgent: 'self', manager: () => listener, threadLog: () => threadLog,
      messageStore: () => ({ get: async () => storedEnvelope as never }),
      router: () => router as never,
    });
    const entry = { id: 'rq-stored', threadlineMessageId: 'msg-stored', threadId: 'thread-stored' } as never;

    expect(recovery.pending(entry)).toBe(true);
    await expect(recovery.respawn(entry)).rejects.toThrow('already settled or unavailable');
    expect(router.handleInboundMessage).not.toHaveBeenCalled();
    expect(listener.tryClaimReply('msg-stored', 'later-valid-retry')).toBe(true);
  });
});
