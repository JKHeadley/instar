/**
 * peer-conversation-homebase-topic §2.6 — a spawned thread session is told which Telegram topic
 * to use for the user, so it never picks an unrelated one (the 2026-10-31 "B2Lead Invoices" case).
 */
import { describe, it, expect, vi } from 'vitest';
import { ThreadlineRouter } from '../../src/threadline/ThreadlineRouter.js';
import type { MessageEnvelope, AgentMessage } from '../../src/messaging/types.js';

function setup() {
  const messageRouter = { getThread: vi.fn().mockResolvedValue({ messages: [] }) };
  const spawnManager = {
    evaluate: vi.fn().mockResolvedValue({ approved: true, sessionId: 's', tmuxSession: 't', reason: 'ok' }),
    handleDenial: vi.fn(),
  };
  const threadResumeMap = {
    get: vi.fn().mockReturnValue(null), save: vi.fn(), remove: vi.fn(), resolve: vi.fn(),
    getByRemoteAgent: vi.fn().mockReturnValue([]),
  };
  const router = new ThreadlineRouter(messageRouter as any, spawnManager as any, threadResumeMap as any, {} as any,
    { localAgent: 'echo', localMachine: 'm', maxHistoryMessages: 20 });
  return { router, spawnManager };
}

const env = (): MessageEnvelope => ({
  message: {
    id: 'm1', from: { agent: 'scout', machine: 'r' }, to: { agent: 'echo', machine: 'm' },
    threadId: 'th-1', subject: 'hi', body: 'hello', createdAt: new Date().toISOString(), priority: 'normal',
  } as AgentMessage,
} as MessageEnvelope);

describe('ThreadlineRouter peer user-topic hint', () => {
  it('names the homebase topic in the spawn prompt', async () => {
    const { router, spawnManager } = setup();
    router.setPeerUserTopicResolver(() => ({ topicId: 50, via: 'homebase' }));
    await router.handleInboundMessage(env());
    const ctx = spawnManager.evaluate.mock.calls[0][0].context as string;
    expect(ctx).toContain('post in topic 50');
    expect(ctx).toContain('never in another topic');
  });

  it('adds nothing when there is no homebase', async () => {
    const { router, spawnManager } = setup();
    router.setPeerUserTopicResolver(() => ({ topicId: 7, via: 'existing' }));
    await router.handleInboundMessage(env());
    expect(spawnManager.evaluate.mock.calls[0][0].context as string).not.toContain('Telegram topic for this conversation');
  });

  it('a throwing resolver leaves the prompt unchanged', async () => {
    const { router, spawnManager } = setup();
    router.setPeerUserTopicResolver(() => { throw new Error('x'); });
    await router.handleInboundMessage(env());
    expect(spawnManager.evaluate.mock.calls[0][0].context as string).not.toContain('Telegram topic for this conversation');
  });
});
