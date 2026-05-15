/**
 * Unit tests for InteractivePool replacement-failure handling.
 *
 * Verifies that spawn failures during retire-and-replace emit observable
 * degradation events, retry with backoff, and emit a heal event on
 * recovery. The bug this defends against: previous behavior was
 * `.catch(console.error)` — failures were logged and the pool decayed
 * silently. This test asserts the new contract without spawning real
 * `claude` REPLs by stubbing the pool's spawnOne and capturePane.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { InteractivePool, type PoolSession } from '../../../../../src/providers/adapters/anthropic-interactive-pool/pool.js';
import { configFromEnv } from '../../../../../src/providers/adapters/anthropic-interactive-pool/config.js';

function makeFakePool(): {
  pool: InteractivePool;
  spawn: ReturnType<typeof vi.fn>;
} {
  const cfg = { ...configFromEnv(), poolSize: 1 };
  const pool = new InteractivePool(cfg);
  // Stub spawnOne: avoid touching real tmux/claude binaries.
  const spawn = vi.fn(async () => {
    const sess: PoolSession = {
      id: `fake-${Math.random().toString(36).slice(2, 8)}`,
      tmuxName: 'fake-tmux',
      state: 'ready',
      messageCount: 0,
      spawnedAt: Date.now(),
      lastUsedAt: Date.now(),
    };
    (pool as unknown as { sessions: Map<string, PoolSession> }).sessions.set(sess.id, sess);
    pool.emit('session:ready', sess);
  });
  (pool as unknown as { spawnOne: typeof spawn }).spawnOne = spawn;
  return { pool, spawn };
}

describe('InteractivePool — replacement failure handling', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('emits pool:degraded then pool:healed when a single retry succeeds', async () => {
    const { pool, spawn } = makeFakePool();
    // Seed an initial "live" session that we'll retire.
    const initial: PoolSession = {
      id: 'initial',
      tmuxName: 'initial-tmux',
      state: 'ready',
      messageCount: 0,
      spawnedAt: Date.now(),
      lastUsedAt: Date.now(),
    };
    (pool as unknown as { sessions: Map<string, PoolSession> }).sessions.set('initial', initial);
    // First spawn (replacement attempt) fails, second succeeds.
    let attempt = 0;
    spawn.mockImplementation(async () => {
      attempt += 1;
      if (attempt === 1) throw new Error('first attempt fails');
      const sess: PoolSession = {
        id: `recovered-${attempt}`,
        tmuxName: 'recovered',
        state: 'ready',
        messageCount: 0,
        spawnedAt: Date.now(),
        lastUsedAt: Date.now(),
      };
      (pool as unknown as { sessions: Map<string, PoolSession> }).sessions.set(sess.id, sess);
      pool.emit('session:ready', sess);
    });

    const degraded: Array<{ error: Error; attempt: number }> = [];
    const healed: Array<{ afterAttempts: number }> = [];
    pool.on('pool:degraded', (e) => degraded.push(e));
    pool.on('pool:healed', (e) => healed.push(e));

    // Retire the initial session — this triggers replaceRetired → spawnOne
    // (which fails) → scheduleRetryReplacement(1).
    await pool.retire(initial);
    // Initial spawn attempt has already failed by now.
    expect(degraded).toHaveLength(1);
    expect(degraded[0]!.attempt).toBe(0);
    expect(healed).toHaveLength(0);

    // Advance past the 1-second backoff for attempt 1.
    await vi.advanceTimersByTimeAsync(1_100);
    // The async spawn inside the timer should have resolved by now.
    expect(healed).toHaveLength(1);
    expect(healed[0]!.afterAttempts).toBe(1);
  });

  it('emits pool:degraded_persistent after MAX_REPLACEMENT_ATTEMPTS retries fail', async () => {
    const { pool, spawn } = makeFakePool();
    const initial: PoolSession = {
      id: 'initial',
      tmuxName: 'initial-tmux',
      state: 'ready',
      messageCount: 0,
      spawnedAt: Date.now(),
      lastUsedAt: Date.now(),
    };
    (pool as unknown as { sessions: Map<string, PoolSession> }).sessions.set('initial', initial);
    spawn.mockImplementation(async () => {
      throw new Error('always fails');
    });

    const degraded: Array<{ error: Error; attempt: number }> = [];
    const persistent: Array<{ totalAttempts: number }> = [];
    pool.on('pool:degraded', (e) => degraded.push(e));
    pool.on('pool:degraded_persistent', (e) => persistent.push(e));

    await pool.retire(initial);
    // Drain all backoff timers — exponential up to 30s cap × 5 retries.
    // 2^0 + 2^1 + 2^2 + 2^3 + 2^4 = 31s; cap at 30s never reached. Total
    // wait window roughly 32s; advance well beyond.
    await vi.advanceTimersByTimeAsync(120_000);

    // 1 initial + 5 retries = 6 degraded events; 1 persistent.
    expect(degraded.length).toBe(6);
    expect(persistent).toHaveLength(1);
    expect(persistent[0]!.totalAttempts).toBe(5);
  });

  it('does not schedule new retries once shutdown has started', async () => {
    const { pool, spawn } = makeFakePool();
    const initial: PoolSession = {
      id: 'initial',
      tmuxName: 'initial-tmux',
      state: 'ready',
      messageCount: 0,
      spawnedAt: Date.now(),
      lastUsedAt: Date.now(),
    };
    (pool as unknown as { sessions: Map<string, PoolSession> }).sessions.set('initial', initial);
    spawn.mockImplementation(async () => {
      throw new Error('always fails');
    });

    const degraded: Array<{ error: Error; attempt: number }> = [];
    pool.on('pool:degraded', (e) => degraded.push(e));

    await pool.retire(initial);
    // Initial replacement attempt fires immediately and fails (1 event).
    expect(degraded.length).toBe(1);

    // Shutdown before any backoff fires.
    await pool.shutdown();

    // Advancing the clock far past the would-be retry windows should NOT
    // produce additional spawn attempts.
    await vi.advanceTimersByTimeAsync(120_000);
    expect(degraded.length).toBe(1);
  });
});
