/**
 * Unit test for the OneShotCompletion retire-on-error path.
 *
 * Verifies that when runPrompt throws (timeout / abort / exec failure),
 * the pool session is retired (killed + scheduled for replacement)
 * rather than released back to ready. Releasing a possibly-wedged
 * session would cause the next allocate to hand out a poisoned session
 * that returns residual pane content as if it were the new response.
 *
 * The test stubs runPrompt and the pool's release/retire so it doesn't
 * touch real tmux / claude.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createOneShotCompletion } from '../../../../../src/providers/adapters/anthropic-interactive-pool/transport/oneShotCompletion.js';
import { InteractivePool, type PoolSession } from '../../../../../src/providers/adapters/anthropic-interactive-pool/pool.js';
import { configFromEnv } from '../../../../../src/providers/adapters/anthropic-interactive-pool/config.js';

// Mock the runPrompt module — the transport imports it; we replace it.
vi.mock('../../../../../src/providers/adapters/anthropic-interactive-pool/promptRunner.js', () => ({
  runPrompt: vi.fn(),
}));
import { runPrompt } from '../../../../../src/providers/adapters/anthropic-interactive-pool/promptRunner.js';

function makeFakeSession(id = 'fake'): PoolSession {
  return {
    id,
    tmuxName: `tmux-${id}`,
    state: 'busy',
    messageCount: 0,
    spawnedAt: Date.now(),
    lastUsedAt: Date.now(),
  };
}

describe('OneShotCompletion — retire-on-error', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('releases the session on success', async () => {
    const cfg = { ...configFromEnv(), poolSize: 1 };
    const pool = new InteractivePool(cfg);
    const session = makeFakeSession();

    vi.spyOn(pool, 'allocate').mockResolvedValue(session);
    const releaseSpy = vi.spyOn(pool, 'release').mockResolvedValue(undefined);
    const retireSpy = vi.spyOn(pool, 'retire').mockResolvedValue(undefined);

    vi.mocked(runPrompt).mockResolvedValue({
      text: '4',
      raw: '⏺ 4',
      durationMs: 123,
    });

    const oneShot = createOneShotCompletion(pool, cfg);
    const result = await oneShot.evaluate('what is 2+2?');

    expect(result.text).toBe('4');
    expect(releaseSpy).toHaveBeenCalledTimes(1);
    expect(retireSpy).not.toHaveBeenCalled();
  });

  it('retires the session when runPrompt throws (timeout / abort / exec failure)', async () => {
    const cfg = { ...configFromEnv(), poolSize: 1 };
    const pool = new InteractivePool(cfg);
    const session = makeFakeSession();

    vi.spyOn(pool, 'allocate').mockResolvedValue(session);
    const releaseSpy = vi.spyOn(pool, 'release').mockResolvedValue(undefined);
    const retireSpy = vi.spyOn(pool, 'retire').mockResolvedValue(undefined);

    vi.mocked(runPrompt).mockRejectedValue(new Error('prompt timed out'));

    const oneShot = createOneShotCompletion(pool, cfg);
    await expect(oneShot.evaluate('what is 2+2?')).rejects.toThrow('prompt timed out');

    expect(retireSpy).toHaveBeenCalledTimes(1);
    expect(retireSpy).toHaveBeenCalledWith(session);
    expect(releaseSpy).not.toHaveBeenCalled();
  });

  it('retires on abort signal during runPrompt', async () => {
    const cfg = { ...configFromEnv(), poolSize: 1 };
    const pool = new InteractivePool(cfg);
    const session = makeFakeSession();

    vi.spyOn(pool, 'allocate').mockResolvedValue(session);
    const releaseSpy = vi.spyOn(pool, 'release').mockResolvedValue(undefined);
    const retireSpy = vi.spyOn(pool, 'retire').mockResolvedValue(undefined);

    vi.mocked(runPrompt).mockRejectedValue(Object.assign(new Error('aborted'), { name: 'AbortError' }));

    const oneShot = createOneShotCompletion(pool, cfg);
    await expect(oneShot.evaluate('long')).rejects.toThrow('aborted');

    expect(retireSpy).toHaveBeenCalledTimes(1);
    expect(releaseSpy).not.toHaveBeenCalled();
  });
});
