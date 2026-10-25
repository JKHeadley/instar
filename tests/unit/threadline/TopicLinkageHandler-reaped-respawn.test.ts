/**
 * ACT-091 — a topic-bound Threadline reply whose topic session was idle-reaped.
 *
 * Before the fix the handler took the "registered but not alive" branch, set
 * `resume-pending` and never woke the session: the reply reached nothing. Now,
 * with a respawn path wired, the reaped session is respawned with the reply as
 * its first message (`respawn-inject`); a refused/failed respawn is
 * `failure-visible` (always surfaced). A LIVE session is still typed into and
 * never respawned — both sides of the boundary are covered here.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { CommitmentTracker } from '../../../src/monitoring/CommitmentTracker.js';
import { LiveConfig } from '../../../src/config/LiveConfig.js';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';
import { TopicResumeMap } from '../../../src/core/TopicResumeMap.js';
import { ThreadResumeMap } from '../../../src/threadline/ThreadResumeMap.js';
import { SalienceGate } from '../../../src/threadline/SalienceGate.js';
import { TopicLinkageHandler, type TopicLinkageDeps } from '../../../src/threadline/TopicLinkageHandler.js';
import type { MessageEnvelope } from '../../../src/messaging/types.js';

function envelope(threadId: string, body = 'here is the answer'): MessageEnvelope {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    message: {
      id: 'msg-' + Math.random().toString(36).slice(2),
      from: { agent: 'dawn', session: 'threadline', machine: 'remote' },
      to: { agent: 'echo', session: 'best', machine: 'local' },
      type: 'request', priority: 'medium', subject: 'Reply', body, threadId, createdAt: now,
    },
    transport: { relayChain: ['relay'], originServer: 'http://example.test', nonce: 'n:' + now, timestamp: now },
    delivery: { phase: 'received', transitions: [], attempts: 1 },
  } as MessageEnvelope;
}

const lowSalience = () => new SalienceGate({
  classify: async () => ({ verdict: 'agent-internal' as const, reason: 'chatter' }),
});

describe('TopicLinkageHandler — reaped topic session (ACT-091)', () => {
  let stateDir: string;
  beforeEach(() => { stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'linkage-reaped-')); });
  afterEach(() => SafeFsExecutor.safeRmSync(stateDir, { recursive: true, force: true, operation: 'tests/unit/threadline/TopicLinkageHandler-reaped-respawn.test.ts' }));

  function deps(overrides: Partial<TopicLinkageDeps>): TopicLinkageDeps {
    fs.mkdirSync(path.join(stateDir, 'state'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ sessions: { maxSessions: 3 } }));
    return {
      commitmentTracker: new CommitmentTracker({ stateDir, liveConfig: new LiveConfig(stateDir) }),
      topicResumeMap: new TopicResumeMap(stateDir, stateDir),
      threadResumeMap: new ThreadResumeMap(stateDir, stateDir),
      salienceGate: lowSalience(),
      localAgent: 'echo',
      injectIntoSession: vi.fn().mockResolvedValue(true),
      isSessionAlive: vi.fn().mockReturnValue(true),
      sendTelegramToTopic: vi.fn().mockResolvedValue(undefined),
      getSessionForTopic: vi.fn().mockReturnValue('echo-topic-9210'),
      ...overrides,
    };
  }

  async function route(d: TopicLinkageDeps, threadId: string) {
    const h = new TopicLinkageHandler(d);
    h.captureOriginOnSend({ threadId, remoteAgent: 'dawn', originTopicId: 9210 });
    return h.tryRouteReplyToTopic({
      envelope: envelope(threadId),
      threadEntry: { remoteAgent: 'dawn', originTopicId: 9210, originSessionName: 'echo-topic-9210' },
    });
  }

  it('session ALIVE → live-inject; the respawn path is never called', async () => {
    const respawn = vi.fn().mockResolvedValue({ delivered: true, mode: 'respawn-inject' });
    const d = deps({ isSessionAlive: vi.fn().mockReturnValue(true), respawnTopicSession: respawn });
    const out = await route(d, 't-alive');
    expect(out.kind).toBe('routed');
    if (out.kind === 'routed') expect(out.deliveryMode).toBe('live-inject');
    expect(d.injectIntoSession).toHaveBeenCalledTimes(1);
    expect(respawn).not.toHaveBeenCalled();
  });

  it('session REAPED → respawns the topic session with the reply as its first message (respawn-inject)', async () => {
    const respawn = vi.fn().mockResolvedValue({ delivered: true, mode: 'respawn-inject', sessionName: 'echo-topic-9210' });
    const sendTg = vi.fn().mockResolvedValue(undefined);
    const d = deps({ isSessionAlive: vi.fn().mockReturnValue(false), respawnTopicSession: respawn, sendTelegramToTopic: sendTg });
    const out = await route(d, 't-reaped');
    expect(out.kind).toBe('routed');
    if (out.kind === 'routed') {
      expect(out.deliveryMode).toBe('respawn-inject');
      expect(out.commitmentDelivered).toBe(true);
    }
    expect(respawn).toHaveBeenCalledTimes(1);
    const arg = respawn.mock.calls[0][0];
    expect(arg.topicId).toBe(9210);
    expect(arg.text).toContain('here is the answer');
    expect(d.injectIntoSession).not.toHaveBeenCalled();
    expect(sendTg).not.toHaveBeenCalled(); // the woken session relays it — no double post
  });

  it('session REAPED + respawn refused → failure-visible and surfaced, never a silent pending', async () => {
    const respawn = vi.fn().mockResolvedValue({ delivered: false, reason: 'spawn-in-progress' });
    const sendTg = vi.fn().mockResolvedValue(undefined);
    const d = deps({ isSessionAlive: vi.fn().mockReturnValue(false), respawnTopicSession: respawn, sendTelegramToTopic: sendTg });
    const out = await route(d, 't-refused');
    if (out.kind === 'routed') expect(out.deliveryMode).toBe('failure-visible');
    expect(sendTg).toHaveBeenCalledTimes(1);
  });

  it('session REAPED + respawn throws → failure-visible and surfaced', async () => {
    const respawn = vi.fn().mockRejectedValue(new Error('tmux gone'));
    const sendTg = vi.fn().mockResolvedValue(undefined);
    const d = deps({ isSessionAlive: vi.fn().mockReturnValue(false), respawnTopicSession: respawn, sendTelegramToTopic: sendTg });
    const out = await route(d, 't-throws');
    if (out.kind === 'routed') expect(out.deliveryMode).toBe('failure-visible');
    expect(sendTg).toHaveBeenCalledTimes(1);
  });

  it('session alive but a spawn is IN FLIGHT for the topic → the hook (which waits for the spawn), not a direct paste into a booting session', async () => {
    const respawn = vi.fn().mockResolvedValue({ delivered: true, mode: 'live-inject', sessionName: 'echo-topic-9210' });
    const d = deps({ isSessionAlive: vi.fn().mockReturnValue(true), isTopicSpawning: () => true, respawnTopicSession: respawn });
    const out = await route(d, 't-booting');
    expect(d.injectIntoSession).not.toHaveBeenCalled();
    expect(respawn).toHaveBeenCalledTimes(1);
    if (out.kind === 'routed') {
      // Dawn's point 3: a live inject made by the hook is reported as live-inject, not as a respawn.
      expect(out.deliveryMode).toBe('live-inject');
      expect(out.commitmentDelivered).toBe(true);
    }
  });

  it('a spawn flag without a respawn path changes nothing (legacy direct inject)', async () => {
    const d = deps({ isSessionAlive: vi.fn().mockReturnValue(true), isTopicSpawning: () => true });
    const out = await route(d, 't-legacy');
    expect(d.injectIntoSession).toHaveBeenCalledTimes(1);
    if (out.kind === 'routed') expect(out.deliveryMode).toBe('live-inject');
  });
});
