import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ResumeQueue } from '../../src/monitoring/ResumeQueue.js';
import { ResumeQueueDrainer } from '../../src/monitoring/ResumeQueueDrainer.js';
import { ListenerSessionManager } from '../../src/threadline/ListenerSessionManager.js';
import { createThreadlineReapRecovery } from '../../src/threadline/ThreadlineReapRecovery.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

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
});
