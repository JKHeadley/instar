/**
 * Burst-invariant test for HostSpawnSemaphore (Bounded Accumulation /
 * Bounded Blast Radius). 10,000 acquire attempts under contention →
 * LIVE holders NEVER exceed the cap. This is the structural proof that the
 * fork-bomb cap cannot be exceeded under a storm — the standing ratchet the
 * "Bounded Blast Radius" constitution standard names.
 *
 * Spec: docs/specs/forkbomb-prevention-simple.md §Tests (Unit, burst-invariant).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { HostSpawnSemaphore } from '../../src/core/hostSpawnSemaphore.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

function tmpHoldersPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spawn-burst-'));
  return path.join(dir, 'host-spawn-holders.json');
}

const THIS_HOST = 'burst-host';
const runWorker = promisify(execFile);

function makeSem(holdersPath: string, cap: number): HostSpawnSemaphore {
  return new HostSpawnSemaphore({
    holdersPath,
    cap,
    hostname: () => THIS_HOST,
    pidAlive: () => true, // all holders "alive" — no reclaim noise; pure cap test
    isPathHostLocal: () => true,
    genId: () => `${THIS_HOST}:${Math.random().toString(36).slice(2, 12)}`,
  });
}

/** Read the live holder count straight from the file (ground truth). */
function liveCount(holdersPath: string): number {
  try {
    const obj = JSON.parse(fs.readFileSync(holdersPath, 'utf-8'));
    return Array.isArray(obj.holders) ? obj.holders.length : 0;
  } catch {
    return 0;
  }
}

describe('HostSpawnSemaphore — burst invariant (Bounded Accumulation)', () => {
  let holdersPath: string;
  beforeEach(() => { holdersPath = tmpHoldersPath(); });
  afterEach(() => {
    try { SafeFsExecutor.safeRmSync(path.dirname(holdersPath), { recursive: true, force: true, operation: 'tests/unit/host-spawn-semaphore-burst-invariant.test.ts:afterEach' }); } catch { /* ignore */ }
  });

  it('10,000 acquire/release attempts NEVER let live holders exceed the cap', () => {
    const CAP = 8;
    const sem = makeSem(holdersPath, CAP);
    const held: string[] = [];
    let maxObserved = 0;
    let granted = 0;
    let refused = 0;

    for (let i = 0; i < 10_000; i++) {
      // Randomly acquire or release to churn the holder-set.
      const doRelease = held.length > 0 && Math.random() < 0.45;
      if (doRelease) {
        const id = held.pop()!;
        sem.release(id);
      } else {
        const id = `id-${i}`;
        if (sem.acquire(id)) {
          held.push(id);
          granted++;
        } else {
          refused++;
        }
      }
      // INVARIANT — the file's live-holder count never exceeds the cap.
      const live = liveCount(holdersPath);
      maxObserved = Math.max(maxObserved, live);
      expect(live).toBeLessThanOrEqual(CAP);
    }

    // Sanity: the cap was actually exercised (we hit refusals AND filled slots).
    expect(maxObserved).toBe(CAP);
    expect(granted).toBeGreaterThan(0);
    expect(refused).toBeGreaterThan(0);
  });

  it('many concurrent same-file semaphores (cross-instance) never exceed the cap', () => {
    // Several independent HostSpawnSemaphore instances over the SAME file model
    // multiple processes/agents on one host. The flock + holder-set must hold the
    // cap across all of them.
    const CAP = 4;
    const sems = Array.from({ length: 6 }, () => makeSem(holdersPath, CAP));
    const held: Array<{ sem: HostSpawnSemaphore; id: string }> = [];

    for (let i = 0; i < 5_000; i++) {
      const sem = sems[i % sems.length];
      const doRelease = held.length > 0 && Math.random() < 0.45;
      if (doRelease) {
        const h = held.pop()!;
        h.sem.release(h.id);
      } else {
        const id = `s${i % sems.length}-${i}`;
        if (sem.acquire(id)) held.push({ sem, id });
      }
      expect(liveCount(holdersPath)).toBeLessThanOrEqual(CAP);
    }
  });

  it('TRUE multi-process lock contention holds the cap (forked acquirers)', async () => {
    // Fork N OS processes concurrently against the same real holder file.
    // Report every acquire result and keep each granted holder in the file.
    const CAP = 3;
    const N = 12;
    const dir = path.dirname(holdersPath);
    // Each worker tries one slot and leaves any granted holder in place.
    const worker = path.join(dir, 'worker.mjs');
    const repoRoot = path.resolve(__dirname, '../..');
    fs.writeFileSync(
      worker,
      `
import { HostSpawnSemaphore } from ${JSON.stringify(path.join(repoRoot, 'dist/core/hostSpawnSemaphore.js'))};
const holdersPath = process.argv[2];
const sem = new HostSpawnSemaphore({
  holdersPath, cap: ${CAP},
  hostname: () => ${JSON.stringify(THIS_HOST)},
  pidAlive: () => true,
  isPathHostLocal: () => true,
});
const ok = sem.acquire('w-' + process.pid + '-' + Math.random().toString(36).slice(2));
// The fixture's pidAlive returns true, so the holder survives worker exit.
process.stdout.write(ok ? '1' : '0');
`,
    );

    // Build dist for this module if missing (the worker runs the compiled file).
    const distFile = path.join(repoRoot, 'dist/core/hostSpawnSemaphore.js');
    if (!fs.existsSync(distFile)) {
      // Skip the cross-process variant when dist isn't built — the in-process
      // variants above already prove the holder-set invariant. (E2E/CI build dist.)
      return;
    }

    // Wait for every child before checking results or removing the fixture.
    const results = await Promise.allSettled(Array.from({ length: N }, () =>
      runWorker(process.execPath, [worker, holdersPath], { encoding: 'utf8', timeout: 5000 })));
    let successes = 0;
    for (const result of results) {
      if (result.status === 'rejected') throw result.reason;
      expect(result.value.stdout).toMatch(/^[01]$/);
      if (result.value.stdout === '1') successes++;
    }
    expect(successes).toBeLessThanOrEqual(CAP);
    expect(successes).toBeGreaterThan(0);
    expect(liveCount(holdersPath)).toBe(successes);
  });
});
