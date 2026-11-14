/**
 * a2a-required-acknowledgment, the spawn manager's part: receipts on queue entries
 * (D3), the delivered callback (D5) and the early drain re-arm (D7).
 */
import { describe, it, expect, vi } from 'vitest';
import { SpawnRequestManager, type SpawnQueueReceipt, type SpawnRequest } from '../../src/messaging/SpawnRequestManager.js';

const AGENT = 'peer-a';
const MINUTE = 60_000;
const receipt = (id: string): SpawnQueueReceipt => ({ watchId: 1, peerFp: 'f'.repeat(32), messageId: id, threadId: 't' });
const req = (id: string, agent = AGENT, over: Partial<SpawnRequest> = {}): SpawnRequest => ({
  requester: { agent, session: 's', machine: 'm' },
  target: { agent: 'me', machine: 'm' },
  reason: 'r',
  context: `prompt ${id}`,
  priority: 'medium',
  pendingMessages: [id],
  receipt: receipt(id),
  ...over,
});

function harness(over: { maxGlobalQueued?: number; cooldownMs?: number; threshold?: number } = {}) {
  const clock = { now: 1_000_000 };
  const dropped: Array<{ id: string; cause: string }> = [];
  const delivered: Array<{ id: string; sessionName: string | null; interactive: boolean }> = [];
  const state = { sessions: 5, liveCleared: false, drainApproved: false };
  const attention = vi.fn();
  const rearm = vi.fn();
  const mgr: SpawnRequestManager = new SpawnRequestManager({
    maxSessions: 5,
    getActiveSessions: () => Array(state.sessions).fill({}) as never,
    spawnSession: async () => ({ sessionId: 'sid', tmuxSession: 'tmux-1' }),
    cooldownMs: over.cooldownMs ?? 0,
    maxGlobalQueued: over.maxGlobalQueued,
    nowFn: () => clock.now,
    drainRefusalGiveUpThreshold: over.threshold ?? 1,
    drainGiveUpRearmCooldownMs: 8 * MINUTE,
    isDrainRefusalLiveCleared: (m) => /session limit/i.test(m.refusalSignature) && state.liveCleared,
    onDrainGiveUp: attention,
    onDrainRearm: rearm,
    onQueuedMessageDropped: (r, cause) => dropped.push({ id: r.messageId, cause }),
    onQueuedMessageDelivered: (r, s) => delivered.push({ id: r.messageId, ...s }),
    onDrainReady: async (agent) => {
      if (state.drainApproved) return mgr.evaluate({ requester: { agent, session: 'd', machine: 'd' }, target: { agent: 'me', machine: 'm' }, reason: 'd', priority: 'medium', triggeredBy: 'spawn-request-drain' });
      return { approved: false, reason: 'Session limit reached (5/5). Priority medium insufficient to override.' };
    },
  });
  return { mgr, clock, dropped, delivered, state, attention, rearm };
}

describe('D3: drop sites', () => {
  it('site 1: an expired head is dropped when a new arrival is admitted', async () => {
    const h = harness();
    expect((await h.mgr.evaluate(req('old'))).queued).toBe(true);
    h.clock.now += 11 * MINUTE;
    await h.mgr.evaluate(req('new'));
    expect(h.dropped).toEqual([{ id: 'old', cause: 'expired' }]);
  });

  it('site 2: the per-agent cap evicts the oldest', async () => {
    const h = harness();
    for (let i = 0; i < SpawnRequestManager.MAX_QUEUED_PER_AGENT + 1; i++) await h.mgr.evaluate(req(`m${i}`));
    expect(h.dropped).toEqual([{ id: 'm0', cause: 'evicted' }]);
  });

  it('site 3: an earlier reserved payload displaces the globally newest arrival', async () => {
    const h = harness({ maxGlobalQueued: 1 });
    let release!: () => void;
    let rejectSpawn = false;
    const blockers = new SpawnRequestManager({
      maxSessions: 5,
      getActiveSessions: () => [],
      cooldownMs: 0,
      maxGlobalQueued: 1,
      nowFn: () => h.clock.now,
      spawnSession: () => new Promise((resolve, reject) => { release = () => (rejectSpawn ? reject(new Error('launch failed')) : resolve('id')); }),
      onQueuedMessageDropped: (r, cause) => h.dropped.push({ id: r.messageId, cause }),
    });
    const launch = blockers.evaluate(req('reserved', 'a'));
    await Promise.resolve();
    await blockers.evaluate(req('later', 'a')); // refused while in flight: queued, newest
    expect(blockers.getQueuedCount('a')).toBe(1);
    rejectSpawn = true;
    release();
    await launch;
    expect(h.dropped).toEqual([{ id: 'later', cause: 'evicted' }]);
    expect(blockers.getQueuedCount('a')).toBe(1);
  });

  it('site 4: a snapshot drops what has expired, and delivers the rest', async () => {
    const h = harness();
    await h.mgr.evaluate(req('stale'));
    h.clock.now += 6 * MINUTE;
    await h.mgr.evaluate(req('fresh'));
    h.clock.now += 5 * MINUTE; // stale is past 10 minutes, fresh is not
    h.state.sessions = 0;
    const out = await h.mgr.evaluate(req('now'));
    expect(out.approved).toBe(true);
    expect(h.dropped).toEqual([{ id: 'stale', cause: 'expired' }]);
    expect(h.delivered.map((d) => d.id).sort()).toEqual(['fresh', 'now']);
  });

  it('a tick prunes expiry on a quiet queue', async () => {
    const h = harness();
    await h.mgr.evaluate(req('quiet'));
    h.clock.now += 11 * MINUTE;
    await h.mgr.runTick();
    expect(h.dropped).toEqual([{ id: 'quiet', cause: 'expired' }]);
    expect(h.mgr.getQueuedCount(AGENT)).toBe(0);
  });

  it('the prune skips a latched queue, keeping its hold', async () => {
    const h = harness();
    await h.mgr.evaluate(req('held'));
    await h.mgr.runTick(); // a refused drain latches at threshold 1
    expect(h.mgr.getStatus().drainGiveUps).toHaveLength(1);
    h.clock.now += 7 * MINUTE;
    await h.mgr.runTick();
    h.clock.now += 4 * MINUTE; // now past max age, still latched inside the re-arm cooldown from the last refusal
    await h.mgr.runTick();
    expect(h.dropped).toEqual([]);
    expect(h.mgr.getQueuedCount(AGENT)).toBe(1);
  });

  it('no receipt, no callback: non-Threadline spawns are unchanged', async () => {
    const h = harness();
    await h.mgr.evaluate(req('plain', AGENT, { receipt: undefined }));
    h.clock.now += 11 * MINUTE;
    await h.mgr.runTick();
    expect(h.dropped).toEqual([]);
  });

  it('a throwing sink never breaks the queue', async () => {
    const mgr = new SpawnRequestManager({
      maxSessions: 0, getActiveSessions: () => [], spawnSession: async () => 'x', cooldownMs: 0,
      onQueuedMessageDropped: () => { throw new Error('sink'); },
      onDrainReady: async () => ({ approved: false, reason: 'x' }),
      nowFn: () => 5,
    });
    await mgr.evaluate(req('a'));
    await expect(mgr.runTick()).resolves.toBeTypeOf('number');
  });
});

describe('D5: the delivered callback', () => {
  it('an inline spawn reports its own payload with the session name and lane', async () => {
    const h = harness();
    h.state.sessions = 0;
    await h.mgr.evaluate(req('inline', AGENT, { interactive: true }));
    expect(h.delivered).toEqual([{ id: 'inline', sessionName: 'tmux-1', interactive: true }]);
  });

  it('an inline spawn that takes the backlog reports every queued entry too', async () => {
    const h = harness();
    await h.mgr.evaluate(req('q1'));
    await h.mgr.evaluate(req('q2'));
    h.state.sessions = 0;
    await h.mgr.evaluate(req('head'));
    expect(h.delivered.map((d) => d.id).sort()).toEqual(['head', 'q1', 'q2']);
    expect(h.delivered.every((d) => d.interactive === false)).toBe(true);
    expect(h.mgr.getQueuedCount(AGENT)).toBe(0);
  });

  it('the drain path reports the queued entries', async () => {
    const h = harness();
    await h.mgr.evaluate(req('drained'));
    h.state.sessions = 0;
    h.state.drainApproved = true;
    await h.mgr.runTick();
    expect(h.delivered).toEqual([{ id: 'drained', sessionName: 'tmux-1', interactive: false }]);
  });

  it('a failed launch reports nothing delivered, and keeps the reservation queued', async () => {
    const dropped: string[] = [];
    const delivered: string[] = [];
    const mgr = new SpawnRequestManager({
      maxSessions: 5, getActiveSessions: () => [], cooldownMs: 0,
      spawnSession: async () => { throw new Error('no'); },
      onQueuedMessageDropped: (r) => dropped.push(r.messageId),
      onQueuedMessageDelivered: (r) => delivered.push(r.messageId),
    });
    expect((await mgr.evaluate(req('f'))).queued).toBe(true);
    expect(delivered).toEqual([]);
    expect(mgr.getQueuedCount(AGENT)).toBe(1);
  });
});

describe('D7: shorter wait behind the session limit', () => {
  const latched = async (h: ReturnType<typeof harness>) => {
    await h.mgr.evaluate(req('m'));
    await h.mgr.runTick();
    expect(h.mgr.getStatus().drainGiveUps).toHaveLength(1);
  };

  it('stays latched inside the cooldown with no free slot; re-arms at once with one', async () => {
    const h = harness();
    await latched(h);
    h.clock.now += 1000;
    await h.mgr.runTick();
    expect(h.mgr.getStatus().drainGiveUps).toHaveLength(1);
    h.state.liveCleared = true;
    h.clock.now += 1000;
    h.state.drainApproved = true;
    h.state.sessions = 0;
    await h.mgr.runTick();
    expect(h.mgr.getStatus().drainGiveUps).toHaveLength(0);
    expect(h.rearm).toHaveBeenCalledTimes(1);
  });

  it('other signatures wait for the normal cooldown', async () => {
    const clock = { now: 0 };
    const mgr = new SpawnRequestManager({
      maxSessions: 5, getActiveSessions: () => [], spawnSession: async () => 'x', cooldownMs: 0, nowFn: () => clock.now,
      drainRefusalGiveUpThreshold: 1, drainGiveUpRearmCooldownMs: 8 * MINUTE,
      shouldSpawnSession: () => ({ allowed: false, reason: 'quota' }),
      isDrainRefusalLiveCleared: (m) => /session limit/i.test(m.refusalSignature),
      onDrainReady: async () => ({ approved: false, reason: 'Subscription quota gate: quota' }),
    });
    await mgr.evaluate(req('q'));
    await mgr.runTick();
    clock.now += 1000;
    await mgr.runTick();
    expect(mgr.getStatus().drainGiveUps).toHaveLength(1);
  });

  it('brakes: at most one a minute, three per episode, then the normal cooldown', async () => {
    const h = harness();
    h.state.liveCleared = true; // the slot keeps looking free, but the drain keeps being refused
    await latched(h);
    const rearmsAt: number[] = [];
    h.rearm.mockImplementation(() => { rearmsAt.push(h.clock.now); });
    for (let i = 0; i < 40; i++) {
      await h.mgr.runTick();
      h.clock.now += 5000;
    }
    expect(rearmsAt).toHaveLength(3);
    for (let i = 1; i < rearmsAt.length; i++) expect(rearmsAt[i] - rearmsAt[i - 1]).toBeGreaterThanOrEqual(MINUTE);
  });

  it('does not refresh queue ages, except entries already past the maximum age', async () => {
    const h = harness();
    await h.mgr.evaluate(req('aged'));
    await h.mgr.runTick();
    h.clock.now += 11 * MINUTE; // past max age while latched
    h.state.liveCleared = true;
    h.state.drainApproved = true;
    h.state.sessions = 0;
    await h.mgr.runTick();
    await h.mgr.runTick();
    expect(h.dropped).toEqual([]); // it would otherwise expire at the next free slot
    expect(h.delivered.map((d) => d.id)).toEqual(['aged']);

    // A young entry keeps its real age: an early re-arm is not a fresh ten minutes.
    const y = harness({ threshold: 2 });
    await y.mgr.evaluate(req('young'));
    await y.mgr.runTick();
    await y.mgr.runTick();
    expect(y.mgr.getStatus().drainGiveUps).toHaveLength(1);
    y.clock.now += 3 * MINUTE;
    y.state.liveCleared = true;
    await y.mgr.runTick(); // early re-arm; one refusal, below the threshold, so not latched
    expect(y.mgr.getStatus().drainGiveUps).toHaveLength(0);
    y.clock.now += 8 * MINUTE; // 11 minutes since it arrived
    await y.mgr.runTick();
    expect(y.dropped).toEqual([{ id: 'young', cause: 'expired' }]);
  });

  it('a re-latch in the same episode does not reopen Attention; a successful drain ends the episode', async () => {
    const h = harness();
    await latched(h);
    expect(h.attention).toHaveBeenCalledTimes(1);
    h.state.liveCleared = true;
    await h.mgr.runTick(); // early re-arm, drain refused, latched again
    h.clock.now += MINUTE;
    await h.mgr.runTick();
    expect(h.attention).toHaveBeenCalledTimes(1);

    h.state.drainApproved = true;
    h.state.sessions = 0;
    h.clock.now += MINUTE;
    await h.mgr.runTick();
    await h.mgr.runTick();
    expect(h.mgr.getQueuedCount(AGENT)).toBe(0);

    // A new episode: a fresh latch does announce itself.
    h.state.drainApproved = false;
    h.state.liveCleared = false;
    h.state.sessions = 5;
    await h.mgr.evaluate(req('next'));
    h.clock.now += MINUTE;
    await h.mgr.runTick();
    expect(h.attention).toHaveBeenCalledTimes(2);
  });

  it('an existing clear predicate still gates the normal path', async () => {
    const clock = { now: 0 };
    const mgr = new SpawnRequestManager({
      maxSessions: 5, getActiveSessions: () => [], spawnSession: async () => 'x', cooldownMs: 0, nowFn: () => clock.now,
      drainRefusalGiveUpThreshold: 1, drainGiveUpRearmCooldownMs: MINUTE,
      shouldSpawnSession: () => ({ allowed: false, reason: 'quota' }),
      isDrainRefusalCleared: () => false,
      onDrainReady: async () => ({ approved: false, reason: 'x' }),
    });
    await mgr.evaluate(req('q'));
    await mgr.runTick();
    clock.now += 2 * MINUTE;
    await mgr.runTick();
    expect(mgr.getStatus().drainGiveUps).toHaveLength(1);
  });
});
