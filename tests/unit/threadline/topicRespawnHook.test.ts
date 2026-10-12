/**
 * createThreadlineTopicRespawn (ACT-091) — the dead-topic-session delivery
 * decision, both sides of every boundary. Dawn's review point 1: a second reply
 * inside one respawn waits for the in-flight spawn and is typed in once.
 */
import { describe, it, expect, vi } from 'vitest';
import { SpawningTopicsRegistry } from '../../../src/core/SpawningTopicsRegistry.js';
import { createThreadlineTopicRespawn, type TopicRespawnDeps } from '../../../src/threadline/topicRespawnHook.js';

function makeDeps(over: Partial<TopicRespawnDeps> = {}) {
  let alive = false;
  const deps: TopicRespawnDeps = {
    spawning: new SpawningTopicsRegistry(),
    ownedElsewhere: () => false,
    registeredSession: () => 'echo-topic-9210',
    isSessionAlive: () => alive,
    injectConfirmed: vi.fn().mockResolvedValue(true),
    leaseGate: () => ({ spawnLocally: true, reason: 'single-machine' }),
    classifyDeath: () => 'other',
    respawn: vi.fn(async () => { alive = true; }),
    coldSpawn: vi.fn(async () => { alive = true; return 'echo-topic-new'; }),
    // A real (macrotask) sleep: a no-op sleep would spin the wait loop on
    // microtasks and starve the timers the tests use to finish the first spawn.
    sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
    spawnWaitPollMs: 1,
    log: () => {},
    ...over,
  };
  return { deps, setAlive: (v: boolean) => { alive = v; } };
}

describe('createThreadlineTopicRespawn', () => {
  it('live session → types the reply in and reports live-inject (never a respawn)', async () => {
    const { deps, setAlive } = makeDeps(); setAlive(true);
    const r = await createThreadlineTopicRespawn(deps)({ topicId: 9210, text: 'hi' });
    expect(r).toEqual({ delivered: true, mode: 'live-inject', sessionName: 'echo-topic-9210' });
    expect(deps.respawn).not.toHaveBeenCalled();
  });

  it('dead registered session → respawn (resume) with the reply, awaited; respawn-inject', async () => {
    const { deps } = makeDeps();
    const r = await createThreadlineTopicRespawn(deps)({ topicId: 9210, text: 'hi' });
    expect(r).toMatchObject({ delivered: true, mode: 'respawn-inject' });
    expect(deps.respawn).toHaveBeenCalledWith('echo-topic-9210', 9210, 'hi', false);
    expect(deps.spawning.has(9210)).toBe(false); // guard released
  });

  it('no registered session → cold spawn', async () => {
    const { deps } = makeDeps({ registeredSession: () => null });
    const r = await createThreadlineTopicRespawn(deps)({ topicId: 9210, text: 'hi' });
    expect(r).toEqual({ delivered: true, mode: 'respawn-inject', sessionName: 'echo-topic-new' });
    expect(deps.respawn).not.toHaveBeenCalled();
  });

  it('a second reply during an in-flight spawn WAITS, then is typed into the live session exactly once', async () => {
    const { deps, setAlive } = makeDeps();
    const hook = createThreadlineTopicRespawn(deps);
    let finishFirst!: () => void;
    (deps.respawn as ReturnType<typeof vi.fn>).mockImplementation(() => new Promise<void>((res) => { finishFirst = () => { setAlive(true); res(); }; }));
    const first = hook({ topicId: 9210, text: 'reply 1' });
    await new Promise((r) => setTimeout(r, 5));
    expect(deps.spawning.has(9210)).toBe(true);
    const second = hook({ topicId: 9210, text: 'one more thing' });
    await new Promise((r) => setTimeout(r, 5));
    expect(deps.injectConfirmed).not.toHaveBeenCalled(); // still waiting, not pasted into a booting session
    finishFirst();
    expect(await first).toMatchObject({ delivered: true, mode: 'respawn-inject' });
    expect(await second).toMatchObject({ delivered: true, mode: 'live-inject' });
    expect(deps.respawn).toHaveBeenCalledTimes(1);
    expect(deps.injectConfirmed).toHaveBeenCalledTimes(1);
    expect(deps.injectConfirmed).toHaveBeenCalledWith('echo-topic-9210', 'one more thing');
  });

  it('an in-flight spawn that outlives the wait bound → spawn-in-progress (surfaced, never silent)', async () => {
    let t = 0;
    const spawning = new SpawningTopicsRegistry({ now: () => t });
    spawning.add(9210); // a wedged spawn nobody clears
    const { deps } = makeDeps({ spawning, spawnWaitBoundMs: 1000, spawnWaitPollMs: 100, sleep: async (ms) => { t += ms; } });
    const r = await createThreadlineTopicRespawn(deps)({ topicId: 9210, text: 'hi' });
    expect(r).toEqual({ delivered: false, reason: 'spawn-in-progress' });
    expect(deps.respawn).not.toHaveBeenCalled();
    expect(deps.injectConfirmed).not.toHaveBeenCalled();
  });

  it('refusals: another machine owns the topic; the lease gate says forward; admission refuses', async () => {
    for (const [over, reason] of [
      [{ ownedElsewhere: () => true }, 'topic-owned-by-another-machine'],
      [{ leaseGate: () => ({ spawnLocally: false, reason: 'not-holder' }) }, 'lease-gate: not-holder'],
      [{ admit: () => ({ allow: false, reason: 'owner-alive' }) }, 'spawn-admission: owner-alive'],
    ] as const) {
      const { deps } = makeDeps(over as Partial<TopicRespawnDeps>);
      expect(await createThreadlineTopicRespawn(deps)({ topicId: 9210, text: 'hi' })).toEqual({ delivered: false, reason });
      expect(deps.respawn).not.toHaveBeenCalled();
    }
  });

  it('death cause: quota → no respawn; context-exhausted → fresh start (resume dropped)', async () => {
    const q = makeDeps({ classifyDeath: () => 'quota' });
    expect(await createThreadlineTopicRespawn(q.deps)({ topicId: 9210, text: 'hi' })).toEqual({ delivered: false, reason: 'quota-exhausted' });
    expect(q.deps.respawn).not.toHaveBeenCalled();
    const c = makeDeps({ classifyDeath: () => 'context-exhausted' });
    expect(await createThreadlineTopicRespawn(c.deps)({ topicId: 9210, text: 'hi' })).toMatchObject({ delivered: true });
    expect(c.deps.respawn).toHaveBeenCalledWith('echo-topic-9210', 9210, 'hi', true);
  });

  it('a respawn that throws → delivered:false with the reason, guard released', async () => {
    const { deps } = makeDeps({ respawn: vi.fn().mockRejectedValue(new Error('tmux gone')) });
    expect(await createThreadlineTopicRespawn(deps)({ topicId: 9210, text: 'hi' })).toEqual({ delivered: false, reason: 'tmux gone' });
    expect(deps.spawning.has(9210)).toBe(false);
  });

  it('an unconfirmed live paste is not a delivery', async () => {
    const { deps, setAlive } = makeDeps({ injectConfirmed: vi.fn().mockResolvedValue(false) }); setAlive(true);
    expect(await createThreadlineTopicRespawn(deps)({ topicId: 9210, text: 'hi' })).toEqual({ delivered: false, reason: 'inject-unconfirmed' });
  });
});
