/**
 * Creating a topic's workspace must not hold the server's event loop.
 *
 * 2026-11-13 14:09Z: a new topic session ran `git worktree add` for the whole instar checkout
 * synchronously, inside an HTTP handler, on a loaded disk. The event loop was held for the
 * child's whole life, health checks went unanswered for 60 s, and the supervisor killed the
 * server (and the test runs it was coordinating). The heavy steps (worktree add, clone, the
 * dependency copy) now run as children the server does not wait on synchronously.
 *
 * A slow `git` is put first on PATH: it sleeps before `worktree add` / `clone` and then runs
 * the real git, so the test measures what the server does while git is busy.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createTwoSessionHarness, type HarnessHandle } from '../fixtures/two-session-harness.js';
import { HEAVY_GIT_TIMEOUT_MS } from '../../src/core/WorktreeManager.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const REAL_GIT = execFileSync('/usr/bin/which', ['git'], { encoding: 'utf8' }).trim();
const SLOW_MS = 700;

let h: HarnessHandle;
let shimDir: string;
let callLog: string;
let savedPath: string | undefined;

beforeEach(async () => {
  h = await createTwoSessionHarness(); // built with the real git
  shimDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slow-git-'));
  callLog = path.join(shimDir, 'calls.log');
  fs.writeFileSync(path.join(shimDir, 'git'), [
    '#!/bin/bash',
    'for a in "$@"; do',
    `  if [ "$a" = worktree ] || [ "$a" = clone ]; then echo "$a" >> "${callLog}"; sleep ${SLOW_MS / 1000}; break; fi`,
    'done',
    `exec "${REAL_GIT}" "$@"`,
    '',
  ].join('\n'), { mode: 0o755 });
  savedPath = process.env.PATH;
  process.env.PATH = `${shimDir}${path.delimiter}${savedPath ?? ''}`;
});
afterEach(() => {
  process.env.PATH = savedPath;
  h.cleanup();
  SafeFsExecutor.safeRmSync(shimDir, { recursive: true, force: true, operation: 'tests/unit/WorktreeManager-create-off-event-loop.test.ts:cleanup' });
});

const heavyCalls = (): string[] => (fs.existsSync(callLog) ? fs.readFileSync(callLog, 'utf8').trim().split('\n').filter(Boolean) : []);

describe('workspace creation runs off the event loop', () => {
  // The harness project lives in the temp dir, so creation takes the clone path by default;
  // INSTAR_WORKTREE_FORCE_WORKTREE=1 selects the `git worktree add` path (the one in the incident).
  it.each([['clone', undefined], ['worktree', '1']] as const)('timers keep firing while git is busy creating the workspace (%s path)', async (verb, force) => {
    const saved = process.env.INSTAR_WORKTREE_FORCE_WORKTREE;
    if (force) process.env.INSTAR_WORKTREE_FORCE_WORKTREE = force; else delete process.env.INSTAR_WORKTREE_FORCE_WORKTREE;
    let ticks = 0;
    const timer = setInterval(() => { ticks++; }, 25);
    const started = Date.now();
    try {
      const s = await h.spawn({ topicId: 4101, slug: 'slow-create' });
      const elapsed = Date.now() - started;
      expect(fs.existsSync(path.join(s.cwd!, 'README.md'))).toBe(true); // the workspace is real
      expect(heavyCalls()).toEqual([verb]); // the slow git really ran, on the intended path
      expect(elapsed).toBeGreaterThanOrEqual(SLOW_MS);
      // A synchronous git allows 0 ticks during its 700 ms (28 nominal). Three is far from
      // zero and safe on a starved machine.
      expect(ticks).toBeGreaterThanOrEqual(3);
    } finally {
      clearInterval(timer);
      if (saved === undefined) delete process.env.INSTAR_WORKTREE_FORCE_WORKTREE; else process.env.INSTAR_WORKTREE_FORCE_WORKTREE = saved;
    }
  });

  it('two sessions asking for the same new topic at once share one creation', async () => {
    const results = await Promise.allSettled([
      h.spawn({ topicId: 4102, slug: 'same-topic', sessionId: 'session-a' }),
      h.spawn({ topicId: 4102, slug: 'same-topic', sessionId: 'session-b' }),
    ]);
    // One git creation, not two racing on the same path.
    expect(heavyCalls()).toHaveLength(1);
    const ok = results.filter((r) => r.status === 'fulfilled');
    const refused = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    expect(ok).toHaveLength(1);
    // The other session is told the workspace is held, the same answer it gets for any
    // workspace another live session holds; it is not a git failure.
    expect(refused).toHaveLength(1);
    expect((refused[0].reason as { code?: string }).code).toBe('LOCK_HELD');
  });

  it('a failed creation is not remembered: the next request tries again', async () => {
    const internals = h.manager as unknown as { creatingBindings: Map<string, unknown> };
    fs.writeFileSync(path.join(shimDir, 'git'), '#!/bin/bash\nfor a in "$@"; do if [ "$a" = clone ]; then echo "fatal: disk says no" >&2; exit 128; fi; done\n' + `exec "${REAL_GIT}" "$@"\n`, { mode: 0o755 });
    await expect(h.spawn({ topicId: 4103, slug: 'retry' })).rejects.toThrow(/^git clone failed \(exit 128\): fatal: disk says no$/);
    expect(internals.creatingBindings.size).toBe(0);
    fs.writeFileSync(path.join(shimDir, 'git'), `#!/bin/bash\nexec "${REAL_GIT}" "$@"\n`, { mode: 0o755 });
    const s = await h.spawn({ topicId: 4103, slug: 'retry' });
    expect(fs.existsSync(path.join(s.cwd!, 'README.md'))).toBe(true);
  });
});

describe('gitWriteOffLoop', () => {
  type Internals = { gitWriteOffLoop(args: string[], opts: { timeout: number; operation: string; cwd?: string }): Promise<void> };
  const run = (args: string[], timeout: number) => (h.manager as unknown as Internals).gitWriteOffLoop(args, { timeout, operation: 'test:gitWriteOffLoop' });

  it('at the time limit it rejects at once and stops git AND the helper git left running', async () => {
    // Real `git worktree add` checks out in a helper process that survives a kill of its parent
    // and keeps the output pipe open. This git does the same: a background helper that would run
    // for 30 s, holding stderr.
    const helperPid = path.join(shimDir, 'helper.pid');
    fs.writeFileSync(path.join(shimDir, 'git'), `#!/bin/bash\nsleep 30 &\necho $! > "${helperPid}"\nwait\n`, { mode: 0o755 });
    const target = path.join(h.stateDir, 'worktrees', 'timeout-probe');
    const started = Date.now();
    await expect(run(['-C', h.projectDir, 'worktree', 'add', '--detach', target], 1500)).rejects.toThrow(/^git worktree add timed out after 1500ms$/);
    // Settled at the limit: it did not wait for the helper's pipe to close (30 s).
    expect(Date.now() - started).toBeLessThan(10_000);
    // On a starved machine the fake git may have been killed before it started its helper;
    // then there is no helper to check, and the rejection above is the whole result.
    if (!fs.existsSync(helperPid)) return;
    const pid = Number(fs.readFileSync(helperPid, 'utf8').trim());
    expect(pid).toBeGreaterThan(1);
    const alive = (): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
    for (let i = 0; i < 100 && alive(); i++) await new Promise((r) => setTimeout(r, 20));
    expect(alive()).toBe(false); // the helper went with the group
  });

  it('a failed git reports its own words and exit code, with no paths from the command', async () => {
    fs.writeFileSync(path.join(shimDir, 'git'), '#!/bin/bash\necho "fatal: not today" >&2\nexit 3\n', { mode: 0o755 });
    const target = path.join(h.stateDir, 'worktrees', 'fail-probe');
    await expect(run(['-C', h.projectDir, 'worktree', 'add', '--detach', target], 5000)).rejects.toThrow(/^git worktree add failed \(exit 3\): fatal: not today$/);
  });

  it('refuses a read-only git verb, as the guarded synchronous form does', async () => {
    await expect(run(['-C', h.projectDir, 'status'], 5000)).rejects.toThrow(/read-only/);
  });

  it('the heavy steps are given minutes, since a slow one no longer blocks the server', () => {
    expect(HEAVY_GIT_TIMEOUT_MS.worktreeAdd).toBeGreaterThanOrEqual(60_000);
    expect(HEAVY_GIT_TIMEOUT_MS.clone).toBeGreaterThanOrEqual(60_000);
  });
});
