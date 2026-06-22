/**
 * Unit tests for SpawnCapIntelligenceProvider (fork-bomb prevention P1 chokepoint
 * + P3 bounded ingress).
 *
 * Spec: docs/specs/forkbomb-prevention-simple.md §P1/§P3.
 *
 * Covers:
 *   - acquire-around-evaluate: the inner provider only runs while a slot is held,
 *     and the slot is RELEASED in finally (so a throw still frees it).
 *   - bounded wait: a saturated cap is polled up to acquireMs, then sheds.
 *   - the shed is a typed LlmCapacityUnavailableError (the gate-seam signal).
 *   - waiters ceiling: past waitersMax concurrent pollers, a new call sheds
 *     immediately (waiters-full).
 *   - per-evaluate acquire (one shared instance, N concurrent calls each acquire).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HostSpawnSemaphore } from '../../src/core/hostSpawnSemaphore.js';
import {
  SpawnCapIntelligenceProvider,
  LlmCapacityUnavailableError,
  isCapacityUnavailable,
  activeSpawnPollers,
  _resetSpawnPollersForTest,
} from '../../src/core/SpawnCapIntelligenceProvider.js';
import type { IntelligenceProvider, IntelligenceOptions } from '../../src/core/types.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

function tmpHoldersPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spawn-cap-'));
  return path.join(dir, 'host-spawn-holders.json');
}

function makeSem(holdersPath: string, cap: number): HostSpawnSemaphore {
  return new HostSpawnSemaphore({
    holdersPath,
    cap,
    hostname: () => 'cap-host',
    pidAlive: () => true,
    isPathHostLocal: () => true,
    genId: () => `cap-host:${Math.random().toString(36).slice(2)}`,
  });
}

/** An inner provider whose evaluate() resolves after a controllable gate. */
class GatedProvider implements IntelligenceProvider {
  public running = 0;
  public maxRunning = 0;
  public calls = 0;
  private release!: () => void;
  private gate = new Promise<void>((r) => { this.release = r; });
  constructor(private autoResolve = true) {}
  async evaluate(_prompt: string, _options?: IntelligenceOptions): Promise<string> {
    this.calls++;
    this.running++;
    this.maxRunning = Math.max(this.maxRunning, this.running);
    if (!this.autoResolve) await this.gate;
    this.running--;
    return 'ok';
  }
  open(): void { this.release(); }
}

describe('SpawnCapIntelligenceProvider', () => {
  let holdersPath: string;
  beforeEach(() => { holdersPath = tmpHoldersPath(); _resetSpawnPollersForTest(); });
  afterEach(() => {
    _resetSpawnPollersForTest();
    try { SafeFsExecutor.safeRmSync(path.dirname(holdersPath), { recursive: true, force: true, operation: 'tests/unit/spawn-cap-provider.test.ts:afterEach' }); } catch { /* ignore */ }
  });

  it('runs the inner provider while a slot is held and releases it after (success)', async () => {
    const sem = makeSem(holdersPath, 2);
    const inner = new GatedProvider(true);
    const wrapped = new SpawnCapIntelligenceProvider(inner, { semaphore: sem, sleep: async () => {} });
    expect(await wrapped.evaluate('p')).toBe('ok');
    // Released in finally → no holders linger.
    expect(sem.status().liveHolders).toBe(0);
    expect(inner.calls).toBe(1);
  });

  it('releases the slot in finally even when the inner provider throws', async () => {
    const sem = makeSem(holdersPath, 1);
    const thrower: IntelligenceProvider = {
      async evaluate() { throw new Error('boom'); },
    };
    const wrapped = new SpawnCapIntelligenceProvider(thrower, { semaphore: sem, sleep: async () => {} });
    await expect(wrapped.evaluate('p')).rejects.toThrow('boom');
    expect(sem.status().liveHolders).toBe(0); // slot freed despite the throw
  });

  it('sheds with a typed LlmCapacityUnavailableError when the cap is saturated past acquireMs', async () => {
    const sem = makeSem(holdersPath, 1);
    // Pre-fill the only slot with a foreign holder that never frees.
    sem.acquire('occupier');
    let slept = 0;
    const wrapped = new SpawnCapIntelligenceProvider(
      { async evaluate() { return 'unreached'; } },
      { semaphore: sem, acquireMs: 300, pollIntervalMs: 50, sleep: async (ms) => { slept += ms; } },
    );
    await expect(wrapped.evaluate('p')).rejects.toBeInstanceOf(LlmCapacityUnavailableError);
    try {
      await wrapped.evaluate('p');
    } catch (err) {
      expect(isCapacityUnavailable(err)).toBe(true);
      expect((err as LlmCapacityUnavailableError).reason).toBe('acquire-timeout');
    }
    expect(slept).toBeGreaterThan(0); // it actually polled (bounded wait), didn't fail instantly
  });

  it('acquires once a slot frees mid-poll (bounded wait succeeds)', async () => {
    const sem = makeSem(holdersPath, 1);
    sem.acquire('occupier');
    let polls = 0;
    const wrapped = new SpawnCapIntelligenceProvider(
      { async evaluate() { return 'got-in'; } },
      {
        semaphore: sem,
        acquireMs: 5000,
        pollIntervalMs: 10,
        sleep: async () => {
          polls++;
          if (polls === 3) sem.release('occupier'); // free the slot on the 3rd poll
        },
      },
    );
    expect(await wrapped.evaluate('p')).toBe('got-in');
  });

  it('sheds immediately (waiters-full) past the concurrent-poller ceiling', async () => {
    const sem = makeSem(holdersPath, 1);
    sem.acquire('occupier'); // cap full so every call must poll
    // Hold the sleep so pollers accumulate; waitersMax=2.
    let releaseSleep!: () => void;
    const sleepGate = new Promise<void>((r) => { releaseSleep = r; });
    const wrapped = new SpawnCapIntelligenceProvider(
      { async evaluate() { return 'x'; } },
      { semaphore: sem, acquireMs: 10_000, waitersMax: 2, pollIntervalMs: 10, sleep: () => sleepGate },
    );
    // Two pollers fill the waiter ceiling (they park in the first sleep).
    const p1 = wrapped.evaluate('a').catch((e) => e);
    const p2 = wrapped.evaluate('b').catch((e) => e);
    // Let the microtask queue advance so both increment _activePollers.
    await new Promise((r) => setTimeout(r, 5));
    expect(activeSpawnPollers()).toBe(2);
    // A third call sheds immediately with waiters-full (no sleep).
    const r3 = await wrapped.evaluate('c').catch((e) => e);
    expect(isCapacityUnavailable(r3)).toBe(true);
    expect((r3 as LlmCapacityUnavailableError).reason).toBe('waiters-full');
    // Cleanup: free the occupier + the sleep gate so p1/p2 resolve.
    sem.release('occupier');
    releaseSleep();
    await Promise.all([p1, p2]);
  });

  it('per-evaluate acquire: one shared wrapper, N concurrent calls each bounded by the cap', async () => {
    const CAP = 2;
    const sem = makeSem(holdersPath, CAP);
    const inner = new GatedProvider(false); // blocks until open()
    const wrapped = new SpawnCapIntelligenceProvider(inner, { semaphore: sem, acquireMs: 50, pollIntervalMs: 10, sleep: async () => {} });

    // Fire 5 concurrent evaluate() calls through the ONE shared wrapper.
    const results = [0, 1, 2, 3, 4].map(() => wrapped.evaluate('p').catch((e) => e));
    await new Promise((r) => setTimeout(r, 20)); // let them race for slots
    // At most CAP inner.evaluate() are concurrently running (the fan-out is bounded).
    expect(inner.maxRunning).toBeLessThanOrEqual(CAP);
    // Let the blocked inner calls finish.
    inner.open();
    const settled = await Promise.all(results);
    // The ones that couldn't get a slot in 50ms shed with the typed error.
    const shed = settled.filter((r) => isCapacityUnavailable(r));
    const ok = settled.filter((r) => r === 'ok');
    expect(ok.length + shed.length).toBe(5);
    expect(inner.maxRunning).toBeLessThanOrEqual(CAP);
  });
});
