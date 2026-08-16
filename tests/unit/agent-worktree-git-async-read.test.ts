// safe-git-allow: test file — execFileSync('git') builds the fixture repo; fs.rmSync is per-test tmpdir cleanup.
/**
 * Tier 1 (unit) — the non-blocking git read primitive + bounded fan-out that the
 * worktree-reaper read-path fix is built on.
 *
 * These run against REAL git (not a fake spawner), because the contract that
 * matters is "partial stdout is discarded on every failure shape" and only a real
 * child process exercises the exit-code / signal paths.
 *
 * Discrimination note (requester constraint 1): `defaultReadGitAsync` and
 * `mapBounded` are NEW in this change, so every test here fails on unfixed source
 * by not compiling at all — the symbols do not exist. They are evidence for the
 * primitive's contract, NOT for the event-loop fix itself; that proof lives in
 * tests/integration/agent-worktree-reaper-eventloop.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { defaultReadGitAsync, mapBounded } from '../../src/monitoring/agentWorktreeGit.js';

let repo: string;

beforeAll(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'awg-async-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'a.txt'), 'hello\n');
  execFileSync('git', ['add', '-A'], { cwd: repo });
  execFileSync('git', ['commit', '-q', '-m', 'init'], {
    cwd: repo,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
    },
  });
});

afterAll(() => {
  try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe('defaultReadGitAsync', () => {
  it('resolves stdout for a clean read', async () => {
    const out = await defaultReadGitAsync(['-C', repo, 'rev-parse', '--abbrev-ref', 'HEAD'], repo);
    expect(out.trim()).toBe('main');
  });

  it('returns the same bytes as the blocking read it replaces', async () => {
    // The fix must not change WHAT is read, only when the thread is released.
    const sync = execFileSync('git', ['-C', repo, 'status', '--porcelain'], { cwd: repo, encoding: 'utf-8' });
    const async_ = await defaultReadGitAsync(['-C', repo, 'status', '--porcelain'], repo);
    expect(async_).toBe(sync);
  });

  it('reads a multi-line porcelain worktree listing intact (no truncation)', async () => {
    const out = await defaultReadGitAsync(['-C', repo, 'worktree', 'list', '--porcelain'], repo);
    expect(out).toContain('worktree ');
    expect(out).toContain('branch refs/heads/main');
  });

  it('REJECTS on a non-zero exit and discards partial stdout', async () => {
    // `cherry` against a ref that does not exist: git prints to stderr and exits non-zero.
    await expect(
      defaultReadGitAsync(['-C', repo, 'cherry', 'refs/heads/does-not-exist', 'HEAD'], repo),
    ).rejects.toThrow();
  });

  it('REJECTS rather than resolving empty when the repo path is invalid', async () => {
    // The deletion-safe direction: callers treat a rejection as "cannot determine"
    // and KEEP. Resolving '' here would read as "clean"/"merged" and could authorise
    // a delete — this test pins that it never happens.
    const missing = path.join(repo, 'no-such-dir');
    await expect(
      defaultReadGitAsync(['-C', missing, 'status', '--porcelain'], repo),
    ).rejects.toThrow();
  });
});

describe('mapBounded', () => {
  it('preserves input order in the results', async () => {
    const items = [5, 1, 4, 2, 3];
    const out = await mapBounded(items, 2, async (n) => {
      await new Promise<void>((r) => setTimeout(r, n));
      return n * 10;
    });
    expect(out).toEqual([50, 10, 40, 20, 30]);
  });

  it('never exceeds the concurrency limit', async () => {
    let inFlight = 0;
    let peak = 0;
    await mapBounded(Array.from({ length: 25 }, (_, i) => i), 4, async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise<void>((r) => setTimeout(r, 5));
      inFlight--;
      return null;
    });
    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThan(1); // proves it actually parallelises
  });

  it('handles an empty input without spawning a worker', async () => {
    let calls = 0;
    const out = await mapBounded([], 4, async () => { calls++; return 1; });
    expect(out).toEqual([]);
    expect(calls).toBe(0);
  });

  it('clamps a limit larger than the input to the input size', async () => {
    let peak = 0;
    let inFlight = 0;
    await mapBounded([1, 2], 99, async () => {
      inFlight++; peak = Math.max(peak, inFlight);
      await new Promise<void>((r) => setTimeout(r, 5));
      inFlight--; return null;
    });
    expect(peak).toBeLessThanOrEqual(2);
  });
});
