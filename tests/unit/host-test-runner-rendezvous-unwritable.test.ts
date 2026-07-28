/**
 * A PERMANENT rendezvous failure must fail open at once, not be waited out.
 *
 * MEASURED before this existed, with the rendezvous dir mode 500 and everything else
 * identical (same test file, same directory, one tree with the fix and one without):
 *
 *     BEFORE  Duration 66.23s   Tests 5 passed
 *     AFTER   Duration  794ms   Tests 5 passed
 *
 * The admit was always correct — the tests pass either way. What was wrong is that
 * `takeLockBounded` reported EACCES as an undifferentiated error, so the acquisition loop
 * treated a permanently unwritable directory as transient lock contention and polled it at
 * 5s intervals for the whole 60s targeted budget before reaching the SAME conclusion.
 *
 * Why that is a correctness problem and not a performance one: 60s exceeds any observer's
 * patience. A sandboxed agent investigating its own runs interrupted at 30s and reported
 * the suite as un-runnable; four delegate sessions were written off as mysterious stalls.
 * **A degradation that is loud but arrives after everyone has stopped looking is
 * indistinguishable from a silent one** — the precise failure class this guard exists to
 * prevent, happening inside the guard.
 *
 * These tests assert on the recorded SLEEP LIST rather than wall-clock duration:
 * "did it poll at all?" is the actual claim, and it is deterministic.
 */

import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  HostTestRunnerSemaphore,
  resolveTestRunnerPaths,
  type TestRunnerPaths,
  type HostTestRunnerSemaphoreDeps,
} from '../../src/core/hostTestRunnerSemaphore.js';
import { tryTakeLockOnce } from '../../src/core/hostSemaphoreCore.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const HOST = 'test-host';
const madeDirs: string[] = [];

afterEach(() => {
  for (const dir of madeDirs.splice(0)) {
    try {
      fs.chmodSync(dir, 0o700);
    } catch { /* may already be writable */ }
    try {
      SafeFsExecutor.safeRmSync(dir, {
        recursive: true, force: true,
        operation: 'tests/unit/host-test-runner-rendezvous-unwritable.test.ts:cleanup',
      });
    } catch { /* best-effort */ }
  }
});

/** A rendezvous whose base dir exists but cannot be written into. */
function unwritablePaths(): TestRunnerPaths {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rendezvous-ro-'));
  madeDirs.push(dir);
  fs.chmodSync(dir, 0o500); // r-x — present, not writable
  return resolveTestRunnerPaths({ INSTAR_HOST_TEST_BASE_DIR: dir });
}

/** A normal, writable rendezvous. */
function writablePaths(): TestRunnerPaths {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rendezvous-rw-'));
  madeDirs.push(dir);
  return resolveTestRunnerPaths({ INSTAR_HOST_TEST_BASE_DIR: dir });
}

/**
 * REAL clock for `now`, injected `sleep` that only RECORDS.
 *
 * A fully fake clock cannot be used here: `takeLockBounded` bounds its attempt with a
 * sub-millisecond busy-wait against `now()`, so a clock that only advances inside `sleep`
 * never reaches the 250ms deadline and the loop spins forever. (My first version of this
 * harness did exactly that and hung — the test caught its own defect before it could be
 * mistaken for one in the code.)
 *
 * The claim under test is "did it POLL?", and the recorded sleep list answers that
 * precisely without needing a fake clock at all.
 */
function clockSem(paths: TestRunnerPaths, over: Partial<HostTestRunnerSemaphoreDeps> = {}) {
  const sleeps: number[] = [];
  const sem = new HostTestRunnerSemaphore({
    paths,
    env: {},
    hostname: () => HOST,
    dfProbe: () => ({ status: 'local' }),
    pidAlive: () => true,
    gatherEvidence: () => ({ startMs: new Map(), pgid: new Map() }),
    signal: () => {},
    bootTimeMs: () => null,
    pollIntervalMs: 5000,
    now: () => Date.now(),
    sleep: async (ms: number) => { sleeps.push(ms); },
    ...over,
  } as HostTestRunnerSemaphoreDeps);
  return { sem, sleeps };
}

// chmod does not restrain root. Running as root would silently turn the central test into
// a no-op that still passes — exactly the "green but establishing nothing" shape this
// project is about — so it is skipped loudly instead.
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

describe('rendezvous unwritable → fail open immediately', () => {
  it.skipIf(isRoot)('THE FIX: admits at once with cause rendezvous-unwritable, without polling', async () => {
    const { sem, sleeps } = clockSem(unwritablePaths());

    const res = await sem.acquire({ lane: 'targeted', runClass: 'background', budgetMs: 60_000 });

    expect(res.kind).toBe('fail-open-admit');
    if (res.kind === 'fail-open-admit') {
      // A distinct cause: never conflated with genuine contention in the ledger.
      expect(res.cause).toBe('rendezvous-unwritable');
    }
    // The whole point. Previously this polled the full budget first.
    expect(sleeps, 'must not poll a directory that cannot become writable').toEqual([]);
  });

  it.skipIf(isRoot)('the admit still happens — the decision is unchanged, only its latency', async () => {
    // Dead-check for the test above: if the change had turned a fail-open into a refusal,
    // the assertion on `cause` alone would not have caught it.
    const { sem } = clockSem(unwritablePaths());
    const res = await sem.acquire({ lane: 'suite', runClass: 'background', budgetMs: 120_000 });
    expect(res.kind).toBe('fail-open-admit');
  });

  it('a WRITABLE rendezvous is unaffected — it acquires normally', async () => {
    // The other side of the boundary: the fast-fail must not fire on a healthy path.
    const { sem, sleeps } = clockSem(writablePaths());
    const res = await sem.acquire({ lane: 'targeted', runClass: 'background', budgetMs: 60_000 });
    expect(res.kind).toBe('acquired');
    expect(sleeps).toEqual([]);
  });
});

describe('tryTakeLockOnce errno surfacing', () => {
  it('surfaces the errno on a permission failure', () => {
    if (isRoot) return;
    const paths = unwritablePaths();
    const res = tryTakeLockOnce(paths.lock, 'record');
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe('error');
      expect(res.code).toBe('EACCES');
    }
  });

  it('a HELD lock reports contention and carries no errno — the distinction the fix rests on', () => {
    const paths = writablePaths();
    const first = tryTakeLockOnce(paths.lock, 'first');
    expect(first.ok).toBe(true);

    const second = tryTakeLockOnce(paths.lock, 'second');
    expect(second.ok).toBe(false);
    if (!second.ok) {
      // `held` is genuine contention: it WILL clear when the holder releases, so waiting
      // is correct and this path must never be fast-failed.
      expect(second.reason).toBe('held');
      expect(second.code).toBeUndefined();
    }
  });
});
