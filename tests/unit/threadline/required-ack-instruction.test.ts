/**
 * a2a-required-acknowledgment D4: the instruction reaches a session on every path that
 * watches a message (cold spawn, resume, live inject, topic), outside the untrusted
 * framing, and only for a watched message. A remote topic session gets none, because it
 * has no watch row to close. D2: `spawnQueued` is true only for the spawn queue.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ThreadlineRouter, type RelayMessageContext } from '../../../src/threadline/ThreadlineRouter.js';
import { CommitmentTracker } from '../../../src/monitoring/CommitmentTracker.js';
import { LiveConfig } from '../../../src/config/LiveConfig.js';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';
import { TopicResumeMap } from '../../../src/core/TopicResumeMap.js';
import { ThreadResumeMap } from '../../../src/threadline/ThreadResumeMap.js';
import { SalienceGate } from '../../../src/threadline/SalienceGate.js';
import { TopicLinkageHandler, type TopicLinkageDeps } from '../../../src/threadline/TopicLinkageHandler.js';
import { requiredAckInstruction } from '../../../src/threadline/requiredAck.js';
import type { MessageEnvelope } from '../../../src/messaging/types.js';

const REF = 'ack-0123456789ab';
const INSTRUCTION = requiredAckInstruction(REF);
const receipt = { watchId: 1, peerFp: 'peer', messageId: 'peer-chosen-id', threadId: 't' };
const ctx = (watched = true): RelayMessageContext => ({
  trust: { kind: 'plaintext-tofu', senderFingerprint: 'peer' }, senderFingerprint: 'peer', senderName: 'peer', trustLevel: 'verified',
  ...(watched ? { requiredAck: { instruction: INSTRUCTION, receipt } } : {}),
});
const envelope = (threadId = 't'): MessageEnvelope => {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    message: { id: 'peer-chosen-id', from: { agent: 'peer', session: 'relay', machine: 'relay' }, to: { agent: 'me', session: 'best', machine: 'local' }, type: 'query', priority: 'medium', subject: 'S', body: 'PEER-BODY', threadId, createdAt: now },
    transport: { relayChain: [], originServer: '', nonce: 'n', timestamp: now },
    delivery: { phase: 'received', transitions: [], attempts: 1 },
  } as MessageEnvelope;
};

function router(spawn: { approved: boolean; queued?: boolean; reason?: string }, entry?: Record<string, unknown>, delivery?: unknown) {
  const evaluate = vi.fn().mockResolvedValue({ tmuxSession: 'tmux', sessionId: 'id', ...spawn });
  const resume = { get: vi.fn(() => entry ?? null), save: vi.fn() };
  const r = new ThreadlineRouter(
    { getThread: vi.fn().mockResolvedValue({ messages: [] }) } as never,
    { evaluate, handleDenial: vi.fn() } as never,
    resume as never,
    {} as never,
    { localAgent: 'me', localMachine: 'm' },
    null,
    (delivery ?? null) as never,
  );
  return { r, evaluate };
}

describe('the router carries the instruction and the receipt', () => {
  it('cold spawn: outside the framing, before the grounding header, with the receipt on the request', async () => {
    const { r, evaluate } = router({ approved: true });
    await r.handleInboundMessage(envelope(), ctx());
    const req = evaluate.mock.calls[0][0];
    expect(req.receipt).toEqual(receipt);
    expect(req.context.indexOf(INSTRUCTION)).toBe(0);
    expect(req.context.indexOf(INSTRUCTION)).toBeLessThan(req.context.indexOf('[EXTERNAL MESSAGE'));
  });

  it('resume path', async () => {
    const entry = { uuid: 'u', sessionName: 'gone', remoteAgent: 'peer', subject: 'S', state: 'idle', messageCount: 1 };
    const { r, evaluate } = router({ approved: true }, entry);
    await r.handleInboundMessage(envelope(), ctx());
    expect(evaluate.mock.calls[0][0].receipt).toEqual(receipt);
    expect(evaluate.mock.calls[0][0].context).toContain(INSTRUCTION);
  });

  it('live inject into a thread session', async () => {
    const entry = { uuid: 'u', sessionName: 'live', remoteAgent: 'peer', subject: 'S', state: 'active', messageCount: 1 };
    const deliverToSession = vi.fn().mockResolvedValue({ success: true });
    const { r } = router({ approved: true }, entry, { deliverToSession });
    const out = await r.handleInboundMessage(envelope(), ctx());
    expect(out).toMatchObject({ delivered: true, sessionName: 'live' });
    const body: string = deliverToSession.mock.calls[0][1].message.body;
    expect(body.indexOf(INSTRUCTION)).toBeLessThan(body.indexOf('PEER-BODY'));
    expect(body.indexOf(INSTRUCTION)).toBeGreaterThanOrEqual(0);
  });

  it('a message that is not watched is unchanged', async () => {
    const { r, evaluate } = router({ approved: true });
    await r.handleInboundMessage(envelope(), ctx(false));
    expect(evaluate.mock.calls[0][0].receipt).toBeUndefined();
    expect(evaluate.mock.calls[0][0].context).not.toContain('threadline_ack');
  });

  it('spawnQueued only when the spawn manager admitted the payload', async () => {
    const queued = await router({ approved: false, queued: true, reason: 'Session limit reached' }).r.handleInboundMessage(envelope(), ctx());
    expect(queued).toMatchObject({ delivered: false, queued: true, spawnQueued: true });
    const refused = await router({ approved: false, queued: false, reason: 'no' }).r.handleInboundMessage(envelope(), ctx());
    expect(refused).toMatchObject({ delivered: false, queued: false, spawnQueued: false });
  });
});

describe('the topic path', () => {
  let stateDir: string;
  beforeEach(() => { stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'req-ack-topic-')); });
  afterEach(() => SafeFsExecutor.safeRmSync(stateDir, { recursive: true, force: true, operation: 'tests/unit/threadline/required-ack-instruction.test.ts' }));

  function deps(over: Partial<TopicLinkageDeps>): TopicLinkageDeps {
    fs.mkdirSync(path.join(stateDir, 'state'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ sessions: { maxSessions: 3 } }));
    return {
      commitmentTracker: new CommitmentTracker({ stateDir, liveConfig: new LiveConfig(stateDir) }),
      topicResumeMap: new TopicResumeMap(stateDir, stateDir),
      threadResumeMap: new ThreadResumeMap(stateDir, stateDir),
      salienceGate: new SalienceGate({ classify: async () => ({ verdict: 'agent-internal' as const, reason: 'x' }) }),
      localAgent: 'me',
      injectIntoSession: vi.fn().mockResolvedValue(true),
      isSessionAlive: vi.fn().mockReturnValue(true),
      sendTelegramToTopic: vi.fn().mockResolvedValue(undefined),
      getSessionForTopic: vi.fn().mockReturnValue('topic-session'),
      ...over,
    };
  }
  const input = { envelope: envelope('topic-thread'), requiredAckInstruction: INSTRUCTION, threadEntry: { remoteAgent: 'peer', originTopicId: 77, originSessionName: 'topic-session' } };

  it('a local topic session gets it ahead of the untrusted block, and reports its name', async () => {
    const d = deps({});
    const out = await new TopicLinkageHandler(d).tryRouteReplyToTopic(input);
    const text = (d.injectIntoSession as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
    expect(text.indexOf(INSTRUCTION)).toBe(0);
    expect(text.indexOf('REMOTE_REPLY_BEGIN')).toBeGreaterThan(0);
    expect(out).toMatchObject({ kind: 'routed', sessionName: 'topic-session' });
  });

  it('a respawned session reports the new name, not the dead one', async () => {
    const respawn = vi.fn().mockResolvedValue({ delivered: true, mode: 'respawn-inject', sessionName: 'fresh' });
    const d = deps({ isSessionAlive: vi.fn().mockReturnValue(false), respawnTopicSession: respawn });
    const out = await new TopicLinkageHandler(d).tryRouteReplyToTopic(input);
    expect(respawn.mock.calls[0][0].text).toContain(INSTRUCTION);
    expect(out).toMatchObject({ deliveryMode: 'respawn-inject', sessionName: 'fresh' });
  });

  it('a topic session on another machine gets no instruction and reports remote', async () => {
    const deliverToTopicOwner = vi.fn().mockResolvedValue({ injected: true, definitive: true });
    const d = deps({
      isSessionAlive: vi.fn().mockReturnValue(false),
      getSessionForTopic: vi.fn().mockReturnValue(null),
      deliverToTopicOwner,
      remoteReplyEnabled: () => true,
      selfMachineId: () => 'me-machine',
      topicOwnerOf: () => 'other-machine',
    });
    const out = await new TopicLinkageHandler(d).tryRouteReplyToTopic({ ...input, threadEntry: { ...input.threadEntry, machineOrigin: 'other-machine' } });
    expect(deliverToTopicOwner).toHaveBeenCalled();
    expect(deliverToTopicOwner.mock.calls[0][1].text).not.toContain('threadline_ack');
    expect(out).toMatchObject({ kind: 'routed', deliveryMode: 'live-inject', remote: true });
  });
});
