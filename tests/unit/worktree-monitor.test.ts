/**
 * Unit tests for WorktreeMonitor — post-session worktree scanning
 * and orphan branch detection.
 *
 * Tests:
 * - Worktree listing: parses git worktree list --porcelain output
 * - Unmerged work detection: identifies commits ahead of default branch
 * - Orphan branch detection: finds worktree-* branches with no active worktree
 * - Post-session scan: alerts on worktree activity after session completion
 * - Periodic scan: detects stale worktrees
 * - Alert formatting: readable messages for Telegram
 * - State persistence: saves/loads reports
 * - Lifecycle: start/stop idempotent
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import {
  WorktreeMonitor,
  FILES_CHANGED_KEPT,
  MAX_SAVED_REPORT_BYTES,
  type Worktree,
  type WorktreeMonitorConfig,
} from '../../src/monitoring/WorktreeMonitor.js';
import type { Session } from '../../src/core/types.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { sanitizedGitEnv } from '../helpers/git-test-env.js';

// ── Helpers ──────────────────────────────────────────────────────

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'instar-worktree-test-'));
}

function makeSession(overrides?: Partial<Session>): Session {
  return {
    id: `session-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    name: 'test-session',
    status: 'completed',
    tmuxSession: 'test-tmux-session',
    startedAt: new Date(Date.now() - 3600_000).toISOString(),
    endedAt: new Date().toISOString(),
    ...overrides,
  };
}

/**
 * Run a shell command in a directory. All git helpers use this to avoid
 * space-splitting issues with commit messages and glob patterns.
 *
 * env is sanitized to drop GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE so a
 * pre-push-hook-triggered test run can't accidentally redirect git ops
 * into the parent repo. vitest-setup.ts strips these from process.env
 * already; this is defense-in-depth in case the fixture is reused.
 */
function shell(cmd: string, cwd: string): { stdout: string; stderr: string; status: number | null } {
  return spawnSync('/bin/sh', ['-c', cmd], { cwd, encoding: 'utf-8', env: sanitizedGitEnv() });
}

/**
 * Initialize a real git repo in a temp directory for integration-style unit tests.
 * Returns the repo path.
 */
function initGitRepo(dir: string): string {
  const repoDir = path.join(dir, 'repo');
  fs.mkdirSync(repoDir, { recursive: true });

  shell('git init --initial-branch main', repoDir);
  shell('git config user.email test@test.com', repoDir);
  shell('git config user.name Test', repoDir);

  // Create initial commit
  fs.writeFileSync(path.join(repoDir, 'README.md'), '# Test Project\n');
  shell('git add README.md', repoDir);
  shell('git commit -m "Initial commit"', repoDir);

  return repoDir;
}

/**
 * Create a worktree in the repo with optional commits.
 */
function createWorktree(
  repoDir: string,
  name: string,
  opts?: { addCommits?: number; files?: string[] }
): string {
  const wtPath = path.join(repoDir, 'worktrees', name);
  const branchName = `worktree-${name}`;

  // Create the worktree
  fs.mkdirSync(path.dirname(wtPath), { recursive: true });
  const result = shell(`git worktree add "${wtPath}" -b "${branchName}"`, repoDir);
  if (result.status !== 0) {
    throw new Error(`git worktree add failed: ${result.stderr}`);
  }

  // Add commits if requested
  const commitCount = opts?.addCommits ?? 0;
  for (let i = 0; i < commitCount; i++) {
    const filename = opts?.files?.[i] ?? `file-${i}.txt`;
    fs.writeFileSync(path.join(wtPath, filename), `Content ${i}\n`);
    shell(`git add "${filename}"`, wtPath);
    shell(`git commit -m "Worktree commit ${i + 1}"`, wtPath);
  }

  return wtPath;
}

/**
 * Create an orphan branch (branch matching worktree-* but with no active worktree).
 */
function createOrphanBranch(repoDir: string, name: string): void {
  shell(`git branch worktree-${name}`, repoDir);
}

// ── Tests ────────────────────────────────────────────────────────

describe('WorktreeMonitor', () => {
  let tmpDir: string;
  let repoDir: string;
  let stateDir: string;
  let monitor: WorktreeMonitor;
  let alerts: string[];

  beforeEach(() => {
    tmpDir = createTempDir();
    repoDir = initGitRepo(tmpDir);
    stateDir = path.join(tmpDir, 'state');
    alerts = [];

    monitor = new WorktreeMonitor({
      projectDir: repoDir,
      stateDir,
      pollIntervalMs: 0, // disable periodic scanning in tests
      alertCallback: async (msg) => { alerts.push(msg); },
    });
  });

  afterEach(() => {
    monitor.stop();
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/unit/worktree-monitor.test.ts:137' });
  });

  describe('saved report at boot', () => {
    const reportPath = () => path.join(stateDir, 'worktree-monitor', 'last-report.json');
    it('does not parse a saved report over the size bound (OOM at boot, 2026-11-19)', () => {
      fs.mkdirSync(path.dirname(reportPath()), { recursive: true });
      const fd = fs.openSync(reportPath(), 'w');
      fs.ftruncateSync(fd, MAX_SAVED_REPORT_BYTES + 1); // sparse: cheap on disk, over the bound
      fs.closeSync(fd);
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const restarted = new WorktreeMonitor({ projectDir: repoDir, stateDir, pollIntervalMs: 0, alertCallback: async () => {} });
      expect(restarted.getLastReport()).toBeNull();
      expect(warn.mock.calls.some((c) => String(c[0]).includes('not loaded'))).toBe(true);
      warn.mockRestore();
      restarted.stop();
    });
    it('still loads a saved report under the bound', () => {
      fs.mkdirSync(path.dirname(reportPath()), { recursive: true });
      fs.writeFileSync(reportPath(), JSON.stringify({ timestamp: 'x', worktrees: [], orphanBranches: [], alerts: [] }));
      const restarted = new WorktreeMonitor({ projectDir: repoDir, stateDir, pollIntervalMs: 0, alertCallback: async () => {} });
      expect(restarted.getLastReport()).toMatchObject({ timestamp: 'x' });
      restarted.stop();
    });
  });

  // ── Worktree Listing ─────────────────────────────────────────

  describe('listWorktrees()', () => {
    it('returns only main worktree when no extras exist', async () => {
      const wts = await monitor.listWorktrees();
      expect(wts).toHaveLength(1);
      expect(wts[0].isMain).toBe(true);
      expect(wts[0].branch).toBe('main');
    });

    it('detects a created worktree', async () => {
      createWorktree(repoDir, 'feature-auth');

      const wts = await monitor.listWorktrees();
      expect(wts).toHaveLength(2);

      const extra = wts.find(w => !w.isMain);
      expect(extra).toBeDefined();
      expect(extra!.branch).toBe('worktree-feature-auth');
      expect(extra!.path).toContain('feature-auth');
    });

    it('detects multiple worktrees', async () => {
      createWorktree(repoDir, 'feature-a');
      createWorktree(repoDir, 'feature-b');
      createWorktree(repoDir, 'feature-c');

      const wts = await monitor.listWorktrees();
      expect(wts).toHaveLength(4); // main + 3

      const nonMain = wts.filter(w => !w.isMain);
      expect(nonMain).toHaveLength(3);
      expect(nonMain.map(w => w.branch).sort()).toEqual([
        'worktree-feature-a',
        'worktree-feature-b',
        'worktree-feature-c',
      ]);
    });
  });

  // ── Unmerged Work Detection ──────────────────────────────────

  describe('checkUnmergedWork()', () => {
    it('returns null when worktree has no commits ahead', async () => {
      createWorktree(repoDir, 'empty');

      const wts = await monitor.listWorktrees();
      const wt = wts.find(w => w.branch === 'worktree-empty')!;
      const result = await monitor.checkUnmergedWork(wt, 'main');
      expect(result).toBeNull();
    });

    it('detects commits ahead of main', async () => {
      createWorktree(repoDir, 'with-work', {
        addCommits: 3,
        files: ['auth.ts', 'config.ts', 'test.ts'],
      });

      const wts = await monitor.listWorktrees();
      const wt = wts.find(w => w.branch === 'worktree-with-work')!;
      const result = await monitor.checkUnmergedWork(wt, 'main');

      expect(result).not.toBeNull();
      expect(result!.commitsAhead).toBe(3);
      expect(result!.filesChanged).toContain('auth.ts');
      expect(result!.filesChanged).toContain('config.ts');
      expect(result!.filesChanged).toContain('test.ts');
    });

    it('keeps only the first FILES_CHANGED_KEPT names but counts every changed file', async () => {
      const wtPath = createWorktree(repoDir, 'many-files');
      const total = FILES_CHANGED_KEPT + 15;
      for (let i = 0; i < total; i++) fs.writeFileSync(path.join(wtPath, `f-${String(i).padStart(3, '0')}.txt`), `x${i}\n`);
      shell('git add -A', wtPath);
      shell('git commit -m "many files"', wtPath);

      const wts = await monitor.listWorktrees();
      const wt = wts.find(w => w.branch === 'worktree-many-files')!;
      const result = await monitor.checkUnmergedWork(wt, 'main');

      expect(result).not.toBeNull();
      expect(result!.filesChangedCount).toBe(total);
      expect(result!.filesChanged).toHaveLength(FILES_CHANGED_KEPT);
    });

    it('keeps every name when under the cap', async () => {
      createWorktree(repoDir, 'few-files', { addCommits: 2, files: ['a.ts', 'b.ts'] });
      const wts = await monitor.listWorktrees();
      const wt = wts.find(w => w.branch === 'worktree-few-files')!;
      const result = await monitor.checkUnmergedWork(wt, 'main');
      expect(result!.filesChangedCount).toBe(2);
      expect(result!.filesChanged.sort()).toEqual(['a.ts', 'b.ts']);
    });

    it('returns null for worktree with no branch', async () => {
      const fakeBranchless: Worktree = {
        path: '/tmp/fake',
        head: 'abc123',
        branch: null,
        isMain: false,
        isBare: false,
      };
      const result = await monitor.checkUnmergedWork(fakeBranchless, 'main');
      expect(result).toBeNull();
    });
  });

  // ── Orphan Branch Detection ──────────────────────────────────

  describe('findOrphanBranches()', () => {
    it('returns empty when no orphan branches exist', async () => {
      const wts = await monitor.listWorktrees();
      const orphans = await monitor.findOrphanBranches(wts);
      expect(orphans).toEqual([]);
    });

    it('detects orphan worktree-* branches', async () => {
      createOrphanBranch(repoDir, 'abandoned-feature');
      createOrphanBranch(repoDir, 'old-work');

      const wts = await monitor.listWorktrees();
      const orphans = await monitor.findOrphanBranches(wts);

      expect(orphans).toHaveLength(2);
      expect(orphans.sort()).toEqual([
        'worktree-abandoned-feature',
        'worktree-old-work',
      ]);
    });

    it('excludes branches that have active worktrees', async () => {
      createWorktree(repoDir, 'active');
      createOrphanBranch(repoDir, 'orphaned');

      const wts = await monitor.listWorktrees();
      const orphans = await monitor.findOrphanBranches(wts);

      expect(orphans).toHaveLength(1);
      expect(orphans[0]).toBe('worktree-orphaned');
    });
  });

  // ── Full Scan ────────────────────────────────────────────────

  describe('scanWorktrees()', () => {
    it('a second scan of an unchanged repo makes no per-worktree git calls (fb-9f890bce-bd2)', async () => {
      createWorktree(repoDir, 'one', { addCommits: 1 });
      createWorktree(repoDir, 'two', { addCommits: 2 });
      const spy = vi.spyOn(monitor as unknown as { gitCommand(a: string): Promise<string> }, 'gitCommand');
      const first = await monitor.scanWorktrees();
      const perWorktree = (calls: string[]) => calls.filter((c) => /^(rev-list --count|diff --name-only|show -s)/.test(c)).length;
      const firstCalls = spy.mock.calls.map((c) => String(c[0]));
      expect(perWorktree(firstCalls)).toBeGreaterThanOrEqual(4);
      spy.mockClear();
      const second = await monitor.scanWorktrees();
      expect(perWorktree(spy.mock.calls.map((c) => String(c[0])))).toBe(0);
      expect(second.withUnmergedWork.map((w) => [w.worktree.branch, w.commitsAhead]).sort())
        .toEqual(first.withUnmergedWork.map((w) => [w.worktree.branch, w.commitsAhead]).sort());
      spy.mockRestore();
    });

    it('a new commit on the default branch recomputes rather than reusing the cache', async () => {
      createWorktree(repoDir, 'feat', { addCommits: 1, files: ['f.ts'] });
      await monitor.scanWorktrees();
      // Merge the branch into main: the worktree has nothing ahead any more.
      shell('git merge --no-ff -m merge worktree-feat', repoDir);
      const spy = vi.spyOn(monitor as unknown as { gitCommand(a: string): Promise<string> }, 'gitCommand');
      const after = await monitor.scanWorktrees();
      expect(spy.mock.calls.some((c) => String(c[0]).startsWith('rev-list --count'))).toBe(true);
      expect(after.withUnmergedWork).toEqual([]);
      spy.mockRestore();
    });

    it('returns clean report when no worktrees exist', async () => {
      const report = await monitor.scanWorktrees();

      expect(report.worktrees).toEqual([]);
      expect(report.withUnmergedWork).toEqual([]);
      expect(report.orphanBranches).toEqual([]);
      expect(report.timestamp).toBeTruthy();
    });

    it('detects worktrees with unmerged work', async () => {
      createWorktree(repoDir, 'feature', { addCommits: 2, files: ['a.ts', 'b.ts'] });

      const report = await monitor.scanWorktrees();

      expect(report.worktrees).toHaveLength(1);
      expect(report.withUnmergedWork).toHaveLength(1);
      expect(report.withUnmergedWork[0].commitsAhead).toBe(2);
    });

    it('detects orphan branches alongside active worktrees', async () => {
      createWorktree(repoDir, 'active');
      createOrphanBranch(repoDir, 'orphaned');

      const report = await monitor.scanWorktrees();

      expect(report.worktrees).toHaveLength(1); // active only (non-main)
      expect(report.orphanBranches).toHaveLength(1);
      expect(report.orphanBranches[0]).toBe('worktree-orphaned');
    });

    it('shares one in-flight scan between overlapping callers (no pile-up)', async () => {
      createWorktree(repoDir, 'busy', { addCommits: 1 });

      // A periodic tick and a session end arriving together must not start two scans.
      const [first, second] = await Promise.all([monitor.scanWorktrees(), monitor.scanWorktrees()]);
      expect(second).toBe(first);
      expect(first.withUnmergedWork).toHaveLength(1);

      // Once the scan settles, the next caller gets a fresh scan.
      const later = await monitor.scanWorktrees();
      expect(later).not.toBe(first);
      expect(later.withUnmergedWork).toHaveLength(1);
    });

    it('lets a new scan start after a failed one', async () => {
      const failing = vi.spyOn(monitor as unknown as { runScan: () => Promise<unknown> }, 'runScan')
        .mockRejectedValueOnce(new Error('git exploded'));
      await expect(monitor.scanWorktrees()).rejects.toThrow('git exploded');
      failing.mockRestore();
      const report = await monitor.scanWorktrees();
      expect(report.worktrees).toEqual([]);
    });
  });

  // ── Post-Session Scan ────────────────────────────────────────

  describe('onSessionComplete()', () => {
    it('does not alert when no worktrees exist', async () => {
      const session = makeSession();
      const report = await monitor.onSessionComplete(session);

      expect(alerts).toHaveLength(0);
      expect(report.worktrees).toEqual([]);
      expect(report.actions).toEqual([]);
    });

    it('alerts when unmerged work is found', async () => {
      createWorktree(repoDir, 'stale-work', { addCommits: 1, files: ['important.ts'] });

      const session = makeSession({ name: 'job-build-feature' });
      const report = await monitor.onSessionComplete(session);

      expect(alerts).toHaveLength(1);
      expect(alerts[0]).toContain('job-build-feature');
      expect(alerts[0]).toContain('UNMERGED WORK');
      expect(alerts[0]).toContain('worktree-stale-work');
      expect(alerts[0]).toContain('important.ts');
      expect(report.actions).toHaveLength(1);
    });

    it('alerts when orphan branches are found', async () => {
      createOrphanBranch(repoDir, 'forgotten');

      const session = makeSession();
      const report = await monitor.onSessionComplete(session);

      expect(alerts).toHaveLength(1);
      expect(alerts[0]).toContain('ORPHAN BRANCHES');
      expect(alerts[0]).toContain('worktree-forgotten');
    });

    it('includes both unmerged and orphan info in one alert', async () => {
      createWorktree(repoDir, 'has-work', { addCommits: 2 });
      createOrphanBranch(repoDir, 'no-worktree');

      const session = makeSession();
      const report = await monitor.onSessionComplete(session);

      expect(alerts).toHaveLength(1);
      expect(alerts[0]).toContain('UNMERGED WORK');
      expect(alerts[0]).toContain('ORPHAN BRANCHES');
      expect(report.withUnmergedWork).toHaveLength(1);
      expect(report.orphanBranches).toHaveLength(1);
    });
  });

  // ── Announce on change only ──────────────────────────────────

  describe('announce on change only', () => {
    it('does not re-announce an unchanged finding on the next session', async () => {
      createWorktree(repoDir, 'same', { addCommits: 1 });

      await monitor.onSessionComplete(makeSession({ name: 'job-a' }));
      const second = await monitor.onSessionComplete(makeSession({ name: 'job-b' }));

      expect(alerts).toHaveLength(1);
      expect(second.actions).toEqual(['Alert suppressed: findings unchanged since last announcement']);
    });

    it('a burst of overlapping session ends (sharing one scan) announces an unchanged finding once', async () => {
      createWorktree(repoDir, 'burst', { addCommits: 1 });
      const reports = await Promise.all(Array.from({ length: 10 }, (_, i) => monitor.onSessionComplete(makeSession({ name: `job-${i}` }))));
      expect(alerts).toHaveLength(1);
      // Each caller gets its own report: one generated the alert, the rest were suppressed.
      expect(reports.filter((r) => r.actions.some((a) => a.startsWith('Alert generated'))).length).toBe(1);
      expect(reports.filter((r) => r.actions.includes('Alert suppressed: findings unchanged since last announcement')).length).toBe(9);
    });

    it('announces again when a new branch appears', async () => {
      createWorktree(repoDir, 'first', { addCommits: 1 });
      await monitor.onSessionComplete(makeSession());

      createOrphanBranch(repoDir, 'second');
      await monitor.onSessionComplete(makeSession());

      expect(alerts).toHaveLength(2);
      expect(alerts[1]).toContain('worktree-second');
    });

    it('announces again when one item resolves and others remain', async () => {
      createOrphanBranch(repoDir, 'keep');
      createOrphanBranch(repoDir, 'drop');
      await monitor.onSessionComplete(makeSession());

      shell('git branch -D worktree-drop', repoDir);
      await monitor.onSessionComplete(makeSession());

      expect(alerts).toHaveLength(2);
      expect(alerts[1]).toContain('worktree-keep');
      expect(alerts[1]).not.toContain('worktree-drop');
    });

    it('announces a reappearing finding after the set was clear', async () => {
      createOrphanBranch(repoDir, 'flap');
      await monitor.onSessionComplete(makeSession());
      shell('git branch -D worktree-flap', repoDir);
      await monitor.onSessionComplete(makeSession());
      createOrphanBranch(repoDir, 'flap');
      await monitor.onSessionComplete(makeSession());

      expect(alerts).toHaveLength(2);
    });

    it('does not re-announce after a restart', async () => {
      createOrphanBranch(repoDir, 'persisted');
      await monitor.onSessionComplete(makeSession());

      const restartedAlerts: string[] = [];
      const restarted = new WorktreeMonitor({
        projectDir: repoDir,
        stateDir,
        pollIntervalMs: 0,
        alertCallback: async (msg) => { restartedAlerts.push(msg); },
      });
      await restarted.onSessionComplete(makeSession());

      expect(alerts).toHaveLength(1);
      expect(restartedAlerts).toHaveLength(0);
      expect(fs.existsSync(path.join(stateDir, 'worktree-monitor', 'announced.json'))).toBe(true);
    });

    it('re-announces an unchanged finding once the reminder interval has passed', async () => {
      const reminding = new WorktreeMonitor({
        projectDir: repoDir,
        stateDir,
        pollIntervalMs: 0,
        reminderIntervalMs: 0,
        alertCallback: async (msg) => { alerts.push(msg); },
      });
      createOrphanBranch(repoDir, 'long-open');

      await reminding.onSessionComplete(makeSession());
      await reminding.onSessionComplete(makeSession());

      expect(alerts).toHaveLength(2);
    });

    it('does not record a failed send as announced', async () => {
      let fail = true;
      const flaky = new WorktreeMonitor({
        projectDir: repoDir,
        stateDir,
        pollIntervalMs: 0,
        alertCallback: async (msg) => {
          if (fail) throw new Error('Telegram down');
          alerts.push(msg);
        },
      });
      flaky.on('error', () => {});
      createOrphanBranch(repoDir, 'retry-me');

      await flaky.onSessionComplete(makeSession());
      fail = false;
      await flaky.onSessionComplete(makeSession());

      expect(alerts).toHaveLength(1);
    });

    it('periodic stale notice is announced once for an unchanged stale set', async () => {
      const periodic = new WorktreeMonitor({
        projectDir: repoDir,
        stateDir,
        pollIntervalMs: 0,
        staleThresholdMs: -1,
        alertCallback: async (msg) => { alerts.push(msg); },
      });
      createWorktree(repoDir, 'old');

      await periodic.periodicScan();
      const second = await periodic.periodicScan();
      createWorktree(repoDir, 'older');
      await periodic.periodicScan();

      expect(alerts).toHaveLength(2);
      expect(alerts[0]).toContain('Stale worktrees detected');
      expect(second.actions).toEqual(['Stale worktree alert suppressed: findings unchanged since last announcement']);
      expect(alerts[1]).toContain('worktree-older');
    });
  });

  // ── State Persistence ────────────────────────────────────────

  describe('state persistence', () => {
    it('saves report after scan', async () => {
      createWorktree(repoDir, 'tracked');

      await monitor.onSessionComplete(makeSession());

      const stateFile = path.join(stateDir, 'worktree-monitor', 'last-report.json');
      expect(fs.existsSync(stateFile)).toBe(true);

      const saved = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
      expect(saved.worktrees).toHaveLength(1);
      expect(saved.timestamp).toBeTruthy();
    });

    it('loads previous report on construction', async () => {
      createWorktree(repoDir, 'tracked');
      await monitor.onSessionComplete(makeSession());

      // Create new monitor instance — should load saved state
      const monitor2 = new WorktreeMonitor({
        projectDir: repoDir,
        stateDir,
        pollIntervalMs: 0,
      });

      const loaded = monitor2.getLastReport();
      expect(loaded).not.toBeNull();
      expect(loaded!.worktrees).toHaveLength(1);

      monitor2.stop();
    });
  });

  // ── Default Branch Detection ─────────────────────────────────

  describe('getDefaultBranch()', () => {
    it('detects main as default branch', async () => {
      const branch = await monitor.getDefaultBranch();
      expect(branch).toBe('main');
    });
  });

  // ── Lifecycle ────────────────────────────────────────────────

  describe('lifecycle', () => {
    it('start/stop is idempotent', () => {
      const m = new WorktreeMonitor({
        projectDir: repoDir,
        stateDir,
        pollIntervalMs: 60_000,
      });

      m.start();
      m.start(); // second start should be no-op
      m.stop();
      m.stop(); // second stop should be no-op
    });

    it('emits scan events', async () => {
      const events: unknown[] = [];
      monitor.on('scan', (report) => events.push(report));

      await monitor.onSessionComplete(makeSession());

      expect(events).toHaveLength(1);
    });
  });

  // ── Alert Callback Error Handling ────────────────────────────

  describe('alert error handling', () => {
    it('emits error event when alert callback fails', async () => {
      const errorMonitor = new WorktreeMonitor({
        projectDir: repoDir,
        stateDir,
        pollIntervalMs: 0,
        alertCallback: async () => { throw new Error('Telegram down'); },
      });

      const errors: Error[] = [];
      errorMonitor.on('error', (err) => errors.push(err));

      createWorktree(repoDir, 'work', { addCommits: 1 });
      await errorMonitor.onSessionComplete(makeSession());

      expect(errors).toHaveLength(1);
      expect(errors[0].message).toBe('Telegram down');

      errorMonitor.stop();
    });
  });
});
