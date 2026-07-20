import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { FeedbackDrainSelfHeal, feedbackDrainRecoveryBackoff } from '../../src/feedback-factory/drain/FeedbackDrainSelfHeal.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'feedback-drain-self-heal.test.ts' });
});
const temp = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feedback-self-heal-')); dirs.push(dir); return dir; };

describe('FeedbackDrainSelfHeal', () => {
  it('repairs, restarts only after a byte change, rechecks, ticks exactly once, and durably dedupes the episode', async () => {
    const stateDir = temp(); let now = 10_000;
    const calls = { repair: 0, restart: 0, recheck: 0, tick: 0 };
    const controller = new FeedbackDrainSelfHeal({ stateDir, clock: () => now, wait: async (ms) => { now += ms; } });
    const request = {
      episodeKey: 'dark-development:config-v1', classification: 'recoverable-dark-development' as const,
      repair: () => { calls.repair++; return { changed: true }; },
      restart: () => { calls.restart++; },
      recheck: () => { calls.recheck++; return true; },
      tick: () => { calls.tick++; },
    };
    expect(await controller.run(request)).toMatchObject({ status: 'healed', attempts: 1, restarted: true, ticked: true });
    expect(calls).toEqual({ repair: 1, restart: 1, recheck: 1, tick: 1 });
    const restartedController = new FeedbackDrainSelfHeal({ stateDir, clock: () => now });
    expect(await restartedController.run(request)).toMatchObject({ status: 'deduped', ticked: false });
    expect(calls).toEqual({ repair: 1, restart: 1, recheck: 1, tick: 1 });
  });

  it('uses bounded exponential backoff, stops at two attempts, opens a durable P19 breaker, and raises one attention', async () => {
    expect(feedbackDrainRecoveryBackoff(1, 100, 1_000)).toBe(100);
    expect(feedbackDrainRecoveryBackoff(2, 100, 1_000)).toBe(200);
    expect(feedbackDrainRecoveryBackoff(9, 100, 1_000)).toBe(1_000);
    const stateDir = temp(); let now = 20_000; const waits: number[] = []; const attention = vi.fn(); let attempts = 0;
    const controller = new FeedbackDrainSelfHeal({ stateDir, baseBackoffMs: 100, maxBackoffMs: 1_000, clock: () => now,
      wait: async (ms) => { waits.push(ms); now += ms; }, raiseAttention: attention });
    const request = { episodeKey: 'stalled:episode-1', classification: 'recoverable-stalled-drain' as const,
      repair: () => { attempts++; throw new Error('still stalled'); }, recheck: () => false, tick: () => undefined };
    expect(await controller.run(request)).toMatchObject({ status: 'breaker-open', attempts: 2, ticked: false });
    expect(attempts).toBe(2); expect(waits).toEqual([100]); expect(attention).toHaveBeenCalledTimes(1);
    const afterRestart = new FeedbackDrainSelfHeal({ stateDir, clock: () => now, raiseAttention: attention });
    expect(await afterRestart.run(request)).toMatchObject({ status: 'breaker-open', attempts: 2 });
    expect(attempts).toBe(2); expect(attention).toHaveBeenCalledTimes(1);
  });

  it('coalesces concurrent copies of one episode into one repair and one tick', async () => {
    const stateDir = temp(); let repairs = 0; let ticks = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const controller = new FeedbackDrainSelfHeal({ stateDir });
    const request = { episodeKey: 'same-episode', classification: 'recoverable-stalled-drain' as const,
      repair: async () => { repairs++; await gate; return { changed: false }; }, recheck: () => true, tick: () => { ticks++; } };
    const first = controller.run(request); const second = controller.run(request); release();
    expect((await Promise.all([first, second])).map((result) => result.status)).toEqual(['healed', 'healed']);
    expect(repairs).toBe(1); expect(ticks).toBe(1);
  });

  it('opens the breaker when the bounded wall clock is exhausted before a second attempt', async () => {
    const stateDir = temp(); let now = 30_000; let attempts = 0;
    const controller = new FeedbackDrainSelfHeal({ stateDir, maxWallClockMs: 1_000, baseBackoffMs: 1_000, clock: () => now,
      wait: async (ms) => { now += ms; } });
    const result = await controller.run({ episodeKey: 'wall-clock', classification: 'recoverable-stalled-drain',
      repair: () => { attempts++; throw new Error('slow failure'); }, recheck: () => false, tick: () => undefined });
    expect(result).toMatchObject({ status: 'breaker-open', attempts: 1 });
    expect(attempts).toBe(1);
  });

  it('raises one aggregate attention after three successful heals within 30 minutes', async () => {
    const stateDir = temp(); const now = 40_000; const attention = vi.fn();
    const controller = new FeedbackDrainSelfHeal({ stateDir, clock: () => now, raiseAttention: attention });
    for (const key of ['heal-1', 'heal-2', 'heal-3', 'heal-4']) {
      expect((await controller.run({ episodeKey: key, classification: 'recoverable-stalled-drain', repair: () => ({ changed: false }),
        recheck: () => true, tick: () => undefined })).status).toBe('healed');
    }
    expect(attention).toHaveBeenCalledTimes(1);
    expect(attention.mock.calls[0]?.[0]).toMatchObject({ id: expect.stringContaining('feedback-drain-heal-window:'), priority: 'HIGH' });
  });

  it('prohibits every mutating recovery action for critical corruption and alerts once', async () => {
    const stateDir = temp(); const attention = vi.fn(); const repair = vi.fn(); const restart = vi.fn(); const recheck = vi.fn(); const tick = vi.fn();
    const request = { episodeKey: 'critical:db-checksum', classification: 'critical-corruption' as const,
      repair, restart, recheck, tick };
    const first = new FeedbackDrainSelfHeal({ stateDir, raiseAttention: attention });
    expect(await first.run(request)).toMatchObject({ status: 'critical-held', attempts: 0, ticked: false, restarted: false });
    const afterRestart = new FeedbackDrainSelfHeal({ stateDir, raiseAttention: attention });
    expect((await afterRestart.run(request)).status).toBe('critical-held');
    expect(repair).not.toHaveBeenCalled(); expect(restart).not.toHaveBeenCalled(); expect(recheck).not.toHaveBeenCalled(); expect(tick).not.toHaveBeenCalled();
    expect(attention).toHaveBeenCalledTimes(1);
  });
});
