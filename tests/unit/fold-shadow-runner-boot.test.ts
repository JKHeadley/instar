/**
 * Unit — the shadow runner's trigger wiring (context-budget-layered-summaries
 * §16 Phase 2; slice P2-4b). A topic session's `Stop` event triggers one run;
 * the handoff turn's own `Stop` is routed to the waiting runner (never a second
 * fold); one fold per machine at a time; switch off ⇒ nothing; a non-topic or
 * non-Claude session ⇒ nothing.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const runs: Array<{ topicKey: string }> = [];
let release: (() => void) | null = null;
let awaitedReply: string | null | undefined;

vi.mock('../../src/monitoring/foldShadowRunner.js', () => ({
  runShadowFoldOnStop: async (deps: { session: { awaitTurnEnd: (s: unknown, ms: number, tick: () => void) => Promise<string | null> } }, s: { topicKey: string }) => {
    runs.push({ topicKey: s.topicKey });
    awaitedReply = await deps.session.awaitTurnEnd(s, 60_000, () => undefined);
    await new Promise<void>((r) => { release = r; });
    return null;
  },
}));

import { startShadowFoldRunner, type ShadowRunnerBootDeps } from '../../src/monitoring/foldShadowRunnerBoot.js';

function harness(o: { enabled?: boolean } = {}) {
  let cb: ((p: Record<string, unknown>) => void) | null = null;
  const sessions = [
    { id: 'live-a', tmuxSession: 'echo-1', telegramTopicId: 1, claudeSessionId: 'c-a', framework: 'claude-code' },
    { id: 'live-b', tmuxSession: 'echo-2', telegramTopicId: 2, claudeSessionId: 'c-b', framework: 'claude-code' },
    { id: 'codex-c', tmuxSession: 'echo-3', telegramTopicId: 3, claudeSessionId: 'c-c', framework: 'codex-cli' },
    { id: 'job-d', tmuxSession: 'job-4', claudeSessionId: 'c-d', framework: 'claude-code' },
  ];
  const d = {
    stateDir: '/tmp/none', enabled: () => o.enabled ?? true, sessions: () => sessions, transcriptPath: () => null,
    onStop: (f: (p: Record<string, unknown>) => void) => { cb = f; return () => { cb = null; }; },
    base: {} as ShadowRunnerBootDeps['base'],
  } as unknown as ShadowRunnerBootDeps;
  const h = startShadowFoldRunner(d);
  return { h, stop: (iid: string, msg?: string) => cb?.({ instar_session_id: iid, ...(msg ? { last_assistant_message: msg } : {}) }), unsubscribed: () => cb === null };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => { runs.length = 0; release = null; awaitedReply = undefined; });

describe('startShadowFoldRunner', () => {
  it('a topic session\'s Stop runs one fold; its own next Stop is the handoff reply, never a second fold', async () => {
    const { h, stop } = harness();
    stop('live-a');
    await tick();
    expect(runs).toEqual([{ topicKey: '1' }]);
    expect(h.status().inFlight).toBe('1');
    stop('live-a', '{"schema":"fold-handoff/1"}'); // the handoff turn ends
    await tick();
    expect(awaitedReply).toBe('{"schema":"fold-handoff/1"}');
    expect(runs).toHaveLength(1);
  });

  it('one fold per machine at a time: another topic\'s Stop while one runs is ignored, never queued', async () => {
    const { h, stop } = harness();
    stop('live-a');
    await tick();
    stop('live-b');
    await tick();
    expect(runs).toEqual([{ topicKey: '1' }]);
    stop('live-a', 'reply'); await tick();
    release!(); await tick(); await tick();
    expect(h.status().inFlight).toBeNull();
    stop('live-b'); await tick();
    expect(runs.map((r) => r.topicKey)).toEqual(['1', '2']);
  });

  it('switch off, a Codex session, a job without a topic, or an unknown session ⇒ nothing', async () => {
    const off = harness({ enabled: false });
    off.stop('live-a'); await tick();
    const on = harness();
    on.stop('codex-c'); on.stop('job-d'); on.stop('nobody'); on.stop(''); await tick();
    expect(runs).toEqual([]);
  });

  it('stop() unsubscribes and releases a waiting runner', async () => {
    const { h, stop, unsubscribed } = harness();
    stop('live-a'); await tick();
    h.stop();
    await tick();
    expect(awaitedReply).toBeNull();
    expect(unsubscribed()).toBe(true);
  });
});
