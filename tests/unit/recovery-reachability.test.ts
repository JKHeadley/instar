import { describe, it, expect, vi } from 'vitest';
import { deliverReachable, type ReachabilityDeps } from '../../src/monitoring/recoveryReachability';

function makeDeps(over: Partial<ReachabilityDeps> = {}): ReachabilityDeps & {
  sent: Array<{ topicId: number; text: string }>;
  unreachable: Array<{ sessionName: string; sentinel: string; text: string; tried: string[] }>;
  reachedCalls: Array<{ sessionName: string; sentinel: string; reached: string; topicId?: number }>;
} {
  const sent: Array<{ topicId: number; text: string }> = [];
  const unreachable: Array<{ sessionName: string; sentinel: string; text: string; tried: string[] }> = [];
  const reachedCalls: Array<{ sessionName: string; sentinel: string; reached: string; topicId?: number }> = [];
  return {
    topicForSession: () => undefined,
    lifelineTopicId: () => undefined,
    sendToTopic: async (topicId, text) => { sent.push({ topicId, text }); },
    auditUnreachable: (sessionName, sentinel, text, tried) =>
      unreachable.push({ sessionName, sentinel, text, tried }),
    auditReached: (sessionName, sentinel, reached, topicId) =>
      reachedCalls.push({ sessionName, sentinel, reached, topicId }),
    ...over,
    sent, unreachable, reachedCalls,
  };
}

describe('deliverReachable', () => {
  it('routes to the bound topic when one exists', async () => {
    const deps = makeDeps({ topicForSession: () => 42 });
    const r = await deliverReachable('echo', 'rate-limit', 'hi', deps);
    expect(r.reached).toBe('topic');
    expect(r.topicId).toBe(42);
    expect(deps.sent).toEqual([{ topicId: 42, text: 'hi' }]);
    expect(deps.unreachable).toEqual([]);
  });

  it('falls back to lifeline with sentinel-tagged prefix when no binding', async () => {
    const deps = makeDeps({ lifelineTopicId: () => 7 });
    const r = await deliverReachable('echo-session', 'socket-disconnect', 'lost the link', deps);
    expect(r.reached).toBe('lifeline');
    expect(r.topicId).toBe(7);
    expect(deps.sent).toHaveLength(1);
    expect(deps.sent[0]).toEqual({
      topicId: 7,
      text: '[socket-disconnect/echo-session] lost the link',
    });
    expect(deps.unreachable).toEqual([]);
  });

  it('audit-only when neither topic nor lifeline is available', async () => {
    const deps = makeDeps();
    const r = await deliverReachable('orphan', 'active-silence', 'gone quiet', deps);
    expect(r.reached).toBe('audit-only');
    expect(deps.sent).toEqual([]);
    expect(deps.unreachable).toEqual([
      { sessionName: 'orphan', sentinel: 'active-silence', text: 'gone quiet', tried: ['topic', 'lifeline', 'audit'] },
    ]);
  });

  it('falls through to lifeline when topic send throws', async () => {
    const deps = makeDeps({
      topicForSession: () => 1,
      lifelineTopicId: () => 7,
      sendToTopic: async (topicId, text) => {
        if (topicId === 1) throw new Error('topic deleted');
        deps.sent.push({ topicId, text });
      },
    });
    const r = await deliverReachable('s', 'rl', 'm', deps);
    expect(r.reached).toBe('lifeline');
    expect(r.fallbackTried).toContain('topic-error:topic deleted');
  });

  it('audit-only when topic AND lifeline both throw', async () => {
    const deps = makeDeps({
      topicForSession: () => 1,
      lifelineTopicId: () => 7,
      sendToTopic: async () => { throw new Error('telegram dead'); },
    });
    const r = await deliverReachable('s', 'rl', 'm', deps);
    expect(r.reached).toBe('audit-only');
    expect(deps.unreachable).toHaveLength(1);
    expect(deps.unreachable[0].tried).toEqual(
      expect.arrayContaining(['topic', 'topic-error:telegram dead', 'lifeline', 'lifeline-error:telegram dead', 'audit']),
    );
  });

  it('audit-unreachable contract is never silent — calls auditUnreachable on every audit-only outcome', async () => {
    const deps = makeDeps();
    const spy = vi.fn();
    deps.auditUnreachable = spy;
    await deliverReachable('s', 'rl', 'msg', deps);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith('s', 'rl', 'msg', expect.arrayContaining(['audit']));
  });

  it('auditReached fires on successful delivery (metrics hook)', async () => {
    const deps = makeDeps({ topicForSession: () => 42 });
    await deliverReachable('s', 'rl', 'm', deps);
    expect(deps.reachedCalls).toEqual([{ sessionName: 's', sentinel: 'rl', reached: 'topic', topicId: 42 }]);
  });
});
