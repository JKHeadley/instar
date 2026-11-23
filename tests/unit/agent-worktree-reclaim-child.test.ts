/**
 * The reclaim child (docs/specs/reaper-removal-out-of-process.md §1-4), against
 * real git worktrees in a temporary agent home whose path contains `/.instar/`.
 * Process scans are faked (empty) so the tests do not depend on this machine's
 * running processes; everything else (git, the archive, the rename, prune, the
 * trash delete sub-process) is real.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeGitExecutor } from '../../src/core/SafeGitExecutor.js';
import { SafeFsExecutor, type SubprocessRmResult } from '../../src/core/SafeFsExecutor.js';
import { makeAgentWorktreeReaperDeps, type ReadGit } from '../../src/monitoring/agentWorktreeGit.js';
import {
  runReclaimChild,
  parseRows,
  parseReclaimArgs,
  takeReclaimLock,
  readTrashRetries,
  removalStillLive,
  appendDurableRow,
  type ReclaimChildInput,
  type ReclaimChildSeams,
  type ReclaimRow,
} from '../../src/monitoring/agentWorktreeReclaimMain.js';

const OP = 'tests/unit/agent-worktree-reclaim-child.test.ts';
const readGit: ReadGit = (args, cwd) => SafeGitExecutor.readSync(args, {
  cwd, encoding: 'utf-8', timeout: 30_000, operation: OP, sourceTreeReadOk: true, sourceTreeWorktreeManagerOk: true,
});

describe('agent worktree reclaim child', () => {
  let root: string;
  let home: string;
  let worktreesDir: string;
  let stateDir: string;
  let configPath: string;
  let live: string;
  let runN = 0;

  const g = (cwd: string, args: string[]) => SafeGitExecutor.run(args, { cwd, operation: OP });
  const setLive = (on: boolean) => fs.writeFileSync(configPath, JSON.stringify({ monitoring: { agentWorktreeReaper: { enabled: true, dryRun: !on } } }));
  const addWorktree = (slug: string, opts: { merged?: boolean; symlinkNodeModules?: boolean } = {}): string => {
    const wt = path.join(worktreesDir, slug);
    g(home, ['worktree', 'add', '-q', wt, '-b', `b-${slug}`, 'HEAD']);
    if (opts.merged === false) {
      fs.writeFileSync(path.join(wt, `${slug}.txt`), slug);
      g(wt, ['add', '-A']);
      g(wt, ['commit', '-qm', `unmerged ${slug}`]);
    }
    if (opts.symlinkNodeModules) fs.symlinkSync(live, path.join(wt, 'node_modules'));
    return wt;
  };
  const deps = (over: Partial<Parameters<typeof makeAgentWorktreeReaperDeps>[0]> = {}) => makeAgentWorktreeReaperDeps({
    instarRepo: home, worktreesDir, githubMergeCheck: false, readGit,
    cwdRoots: () => new Set<string>(), commandLines: () => [], inboundLinks: async () => new Set<string>(),
    ...over,
  });
  const input = (over: Partial<ReclaimChildInput> = {}): ReclaimChildInput => {
    const runId = (++runN).toString(16).padStart(32, 'a');
    return {
      runId, agentHome: home, projectDir: home, worktreesDir, stateDir, configPath,
      rowsPath: path.join(stateDir, 'runs', `${runId}.jsonl`), reportPath: path.join(stateDir, 'report.json'),
      deadlineAt: Date.now() + 900_000, maxReaps: 20, githubMergeCheck: false, excludedPaths: [],
      ...over,
    };
  };
  const rows = (inp: ReclaimChildInput): ReclaimRow[] => parseRows(fs.readFileSync(inp.rowsPath, 'utf8'));
  const listed = (): string => g(home, ['worktree', 'list', '--porcelain']);
  const run = (inp: ReclaimChildInput, seams: ReclaimChildSeams = {}) => runReclaimChild(inp, { deps: deps(), commandOf: async () => '', ...seams });

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'reclaim-child-')));
    home = path.join(root, '.instar', 'agents', 'echo');
    fs.mkdirSync(home, { recursive: true });
    process.env.INSTAR_AUDIT_LOG_DIR = path.join(root, 'audit');
    g(home, ['init', '-q', '-b', 'main']);
    g(home, ['config', 'user.email', 't@t.l']);
    g(home, ['config', 'user.name', 'T']);
    g(home, ['config', 'commit.gpgsign', 'false']);
    fs.writeFileSync(path.join(home, '.gitignore'), 'node_modules\n.worktrees/\n');
    fs.writeFileSync(path.join(home, 'README.md'), 'home\n');
    g(home, ['add', '-A']);
    g(home, ['commit', '-qm', 'init']);
    worktreesDir = path.join(home, '.worktrees');
    fs.mkdirSync(worktreesDir);
    stateDir = path.join(home, '.instar', 'state', 'agent-worktree-reclaim');
    configPath = path.join(home, '.instar', 'config.json');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    setLive(true);
    live = path.join(home, 'shared-node_modules');
    fs.mkdirSync(path.join(live, 'pkg'), { recursive: true });
    fs.writeFileSync(path.join(live, 'pkg', 'index.js'), 'live');
  });
  afterEach(() => {
    delete process.env.INSTAR_AUDIT_LOG_DIR;
    SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: OP });
  });

  it('removes an eligible checkout in the spec order; a dirty and an unmerged sibling are kept with their registrations', async () => {
    const wt = addWorktree('merged', { symlinkNodeModules: true });
    const dirty = addWorktree('dirty');
    fs.writeFileSync(path.join(dirty, 'notes.txt'), 'mine');
    const unmerged = addWorktree('unmerged', { merged: false });
    const inp = input();
    const res = await run(inp);
    expect(res.removed).toEqual([wt]);
    const ts = rows(inp).map((r) => r.t);
    expect(ts).toEqual(['lock', 'attempt', 'archived', 'renaming', 'renamed', 'trash-done', 'removed', 'done']);
    expect(fs.existsSync(wt)).toBe(false);
    expect(fs.readdirSync(path.join(worktreesDir, '.trash'))).toEqual([]);
    // symlinked node_modules was removed as a link: the shared install survives
    expect(fs.readFileSync(path.join(live, 'pkg', 'index.js'), 'utf8')).toBe('live');
    const l = listed();
    expect(l).not.toContain(wt);
    expect(l).toContain(dirty);
    expect(l).toContain(unmerged);
    expect(fs.readFileSync(path.join(dirty, 'notes.txt'), 'utf8')).toBe('mine');
    // the report the route serves carries the full evaluation
    const report = JSON.parse(fs.readFileSync(inp.reportPath, 'utf8'));
    expect(report.phase).toBe('final');
    const byPath = Object.fromEntries(report.worktrees.map((w: { path: string }) => [w.path, w]));
    expect(byPath[dirty].reason).toBe('uncommitted-changes');
    expect(byPath[unmerged].reason).toBe('unmerged');
    expect(byPath[wt].outcome).toBe('removed');
    expect(report.removed).toEqual([wt]);
  });

  it('every row is a whole JSON line (fsynced append), and a torn last line is ignored', () => {
    const f = path.join(root, 'rows.jsonl');
    appendDurableRow(f, { t: 'attempt', at: 1, attemptId: 'a', path: '/x' });
    fs.appendFileSync(f, '{"t":"removed","attemptId":"a"');
    expect(parseRows(fs.readFileSync(f, 'utf8')).map((r) => r.t)).toEqual(['attempt']);
  });

  it('re-evaluation immediately before acting keeps a path that became dirty', async () => {
    const wt = addWorktree('raced');
    const inp = input();
    const res = await run(inp, {
      afterRow: (r) => { if (r.t === 'attempt') fs.writeFileSync(path.join(wt, 'late.txt'), 'new work'); },
    });
    expect(res.removed).toEqual([]);
    expect(res.kept).toEqual([{ path: wt, reason: 'raced-now-dirty' }]);
    expect(fs.readFileSync(path.join(wt, 'late.txt'), 'utf8')).toBe('new work');
  });

  it('re-evaluation keeps a path that became in use or unmerged', async () => {
    const a = addWorktree('inuse');
    let inUse = false;
    const res = await run(input(), {
      deps: deps({ cwdRoots: () => (inUse ? new Set([a]) : new Set<string>()) }),
      afterRow: (r) => { if (r.t === 'attempt') inUse = true; },
    });
    // The race guard reads the 10 s memo; the final re-check reads the process list fresh and refuses.
    expect(res.removed).toEqual([]);
    expect(res.errors).toEqual([{ path: a, reason: 'final re-check: a process now works inside the checkout' }]);
    expect(fs.existsSync(a)).toBe(true);
    const b = addWorktree('newcommit');
    const res2 = await run(input(), {
      afterRow: (r) => {
        if (r.t !== 'attempt' || r.path !== b) return;
        fs.writeFileSync(path.join(b, 'c.txt'), 'c');
        g(b, ['add', '-A']);
        g(b, ['commit', '-qm', 'more work']);
      },
    });
    // same branch, new commit: the live head no longer matches what was evaluated ⇒ kept
    expect(res2.kept).toEqual([{ path: b, reason: 'raced-changed-since-eval' }]);
    expect(fs.existsSync(path.join(b, 'c.txt'))).toBe(true);
  });

  it('a checkout of another repository is kept as other-repo (git common dir is not <projectDir>/.git)', async () => {
    const other = path.join(worktreesDir, 'foreign');
    fs.mkdirSync(other);
    g(other, ['init', '-q', '-b', 'main']);
    g(other, ['config', 'user.email', 't@t.l']);
    g(other, ['config', 'user.name', 'T']);
    fs.writeFileSync(path.join(other, 'f'), 'x');
    g(other, ['add', '-A']);
    g(other, ['commit', '-qm', 'x']);
    const base = deps();
    const wrapped = {
      ...base,
      listWorktrees: () => ({ ok: true as const, worktrees: [{ path: other, branch: 'main', headSha: g(other, ['rev-parse', 'HEAD']).trim() }] }),
      isMerged: () => true,
    };
    expect(base.isOtherRepo(other)).toBe(true);
    const res = await run(input(), { deps: wrapped });
    expect(res.kept).toEqual([{ path: other, reason: 'other-repo' }]);
    expect(fs.existsSync(path.join(other, 'f'))).toBe(true);
    const own = addWorktree('own');
    expect(base.isOtherRepo(own)).toBe(false);
  });

  it('a locked worktree is kept and reported', async () => {
    const wt = addWorktree('locked');
    g(home, ['worktree', 'lock', '--reason', 'busy', wt]);
    const res = await run(input());
    expect(res.kept).toEqual([{ path: wt, reason: 'locked' }]);
    expect(fs.existsSync(wt)).toBe(true);
  });

  it('prune runs against <projectDir>: a sibling locked "initializing" with its folder missing keeps its entry', async () => {
    const sib = addWorktree('initializing');
    g(home, ['worktree', 'lock', '--reason', 'initializing', sib]);
    // Mid-`git worktree add`: the admin entry exists, locked, the checkout not yet written.
    const trashRoot = path.join(worktreesDir, '.trash');
    fs.mkdirSync(trashRoot);
    SafeFsExecutor.safeRenameDirSync(sib, path.join(trashRoot, 'parked'), {
      operation: OP, worktreeTrashScope: { worktreesDir, trashRoot, allowedSources: [sib] },
    });
    const wt = addWorktree('goes');
    const res = await run(input());
    expect(res.removed).toEqual([wt]);
    const l = listed();
    expect(l).toContain(`worktree ${sib}`);
    expect(l).toMatch(/locked initializing/);
    expect(l).not.toContain(`worktree ${wt}`);
  });

  it('the cap stops the run; the time-left rule stops before the cap', async () => {
    addWorktree('c1'); addWorktree('c2'); addWorktree('c3');
    const capped = await run(input({ maxReaps: 1 }));
    expect(capped.removed).toHaveLength(1);
    expect(capped.stopReason).toBe('cap');
    let clock = Date.now();
    const inp = input({ deadlineAt: clock + 40_000, maxReaps: 20 });
    const timed = await run(inp, { now: () => clock, afterRow: (r) => { if (r.t === 'removed') clock += 30_000; } });
    expect(timed.removed).toHaveLength(1);
    expect(timed.stopReason).toBe('time-left');
  });

  it('re-reads the on-disk config before each removal and stops when dryRun turns true', async () => {
    addWorktree('d1'); addWorktree('d2');
    const inp = input();
    const res = await run(inp, { afterRow: (r) => { if (r.t === 'removed') setLive(false); } });
    expect(res.removed).toHaveLength(1);
    expect(res.stopReason).toBe('config-no-longer-live');
    expect(rows(inp).filter((r) => r.t === 'attempt')).toHaveLength(1);
    expect(removalStillLive(configPath)).toBe(false);
    fs.writeFileSync(configPath, '{not json');
    expect(removalStillLive(configPath)).toBe(false);
  });

  it('a run killed after the rename leaves only trash, which the next run clears and prunes', async () => {
    const wt = addWorktree('killed');
    const trashRoot = path.join(worktreesDir, '.trash');
    fs.mkdirSync(trashRoot);
    const attemptId = `${'b'.repeat(16)}-0011aabb`;
    // State left by a kill between `renamed` and the delete.
    SafeFsExecutor.safeRenameDirSync(wt, path.join(trashRoot, attemptId), { operation: OP, worktreeTrashScope: { worktreesDir, trashRoot, allowedSources: [wt] } });
    const earlier = path.join(stateDir, 'runs', `${'b'.repeat(32)}.jsonl`);
    appendDurableRow(earlier, { t: 'attempt', at: 1, attemptId, path: wt });
    appendDurableRow(earlier, { t: 'renaming', at: 2, attemptId, trash: path.join(trashRoot, attemptId) });
    expect(listed()).toContain(wt);
    const inp = input();
    const res = await run(inp);
    expect(res.trash.deleted).toEqual([attemptId]);
    expect(rows(inp).find((r) => r.t === 'trash-start')?.knownAttempt).toBe(true);
    expect(fs.readdirSync(trashRoot)).toEqual([]);
    // a later removal's prune dropped the stale admin entry too (run one more removal to prune)
    addWorktree('next');
    await run(input());
    expect(listed()).not.toContain(`worktree ${wt}`);
  });

  it('a run killed before the rename leaves the checkout intact; the next run evaluates it fresh', async () => {
    const wt = addWorktree('intact');
    const earlier = path.join(stateDir, 'runs', `${'c'.repeat(32)}.jsonl`);
    appendDurableRow(earlier, { t: 'attempt', at: 1, attemptId: `${'c'.repeat(16)}-00112233`, path: wt });
    expect(fs.existsSync(wt)).toBe(true);
    const res = await run(input());
    expect(res.removed).toEqual([wt]);
  });

  it('a trash folder with no rows is cleaned and reported as unknown to any attempt', async () => {
    const stray = path.join(worktreesDir, '.trash', 'stray');
    fs.mkdirSync(stray, { recursive: true });
    fs.writeFileSync(path.join(stray, 'f'), 'x');
    const inp = input();
    const res = await run(inp);
    expect(res.trash.deleted).toEqual(['stray']);
    expect(rows(inp).find((r) => r.t === 'trash-start')).toMatchObject({ name: 'stray', knownAttempt: false });
  });

  it('a failing trash delete is counted BEFORE it runs, backs off, survives a restart, and is skipped after 3 tries as trash-stuck', async () => {
    const t = path.join(worktreesDir, '.trash', 'sticky');
    fs.mkdirSync(t, { recursive: true });
    const retriesFile = path.join(stateDir, 'trash-retries.json');
    const seenAtCall: number[] = [];
    const failing = async (): Promise<SubprocessRmResult> => {
      seenAtCall.push(readTrashRetries(retriesFile).sticky?.failures ?? 0);
      return { ok: false, exitCode: 1, signal: null, timedOut: false, error: 'Operation not permitted' };
    };
    let clock = Date.now();
    for (let i = 1; i <= 3; i++) {
      // each run is a fresh child (a restart): counts come only from the file
      await run(input({ deadlineAt: clock + 900_000 }), { rmTree: failing, now: () => clock });
      expect(readTrashRetries(retriesFile).sticky.failures).toBe(i);
      // a run inside the back-off window does not retry
      const inWindow = await run(input({ deadlineAt: clock + 900_000 }), { rmTree: failing, now: () => clock + 1_000 });
      if (i < 3) expect(inWindow.trash.deferred).toEqual(['sticky']);
      else expect(inWindow.trash.stuck.map((x) => x.name)).toEqual(['sticky']);
      clock += 3_600_000 * 2 ** i + 1;
    }
    expect(seenAtCall).toEqual([1, 2, 3]); // the count was already written when the delete started
    const fourthInput = input({ deadlineAt: clock + 900_000 });
    const fourth = await run(fourthInput, { rmTree: failing, now: () => clock });
    // the route's report carries it too
    expect(JSON.parse(fs.readFileSync(fourthInput.reportPath, 'utf8')).trash.stuck).toEqual([expect.objectContaining({ name: 'sticky' })]);
    expect(fourth.trash.stuck).toEqual([expect.objectContaining({ name: 'sticky', lastError: 'Operation not permitted' })]);
    expect(seenAtCall).toHaveLength(3);
  });

  it('hanging trash deletes stop at the trash budget; healthy candidates still run', async () => {
    for (const n of ['h1', 'h2', 'h3']) fs.mkdirSync(path.join(worktreesDir, '.trash', n), { recursive: true });
    const wt = addWorktree('healthy');
    const hanging = (target: string, o: { timeoutMs: number }): Promise<SubprocessRmResult> =>
      /^h\d$/.test(path.basename(target))
        ? new Promise((resolve) => setTimeout(() => resolve({ ok: false, exitCode: null, signal: 'SIGKILL', timedOut: true, error: 'killed at budget' }), o.timeoutMs))
        : SafeFsExecutor.safeRmTreeInSubprocess(target, { operation: OP, worktreeTrashScope: { worktreesDir, trashRoot: path.join(worktreesDir, '.trash') }, timeoutMs: o.timeoutMs });
    const started = Date.now();
    const res = await run(input({ trashBudgetMs: 300 }), { rmTree: hanging as ReclaimChildSeams['rmTree'] });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(res.trash.errors.map((e) => e.name)).toEqual(['h1']);
    expect(res.trash.deferred).toEqual(['h2', 'h3']);
    expect(res.removed).toEqual([wt]);
  });

  describe('lock', () => {
    const lockPath = () => path.join(stateDir, 'reclaim.lock');
    const lockOpts = (commandOf: (pid: number) => Promise<string | null>) => ({ staleUnreadableMs: 900_000, now: () => Date.now(), commandOf });

    it('is never empty: it holds pid and run id while the run works', async () => {
      addWorktree('l1');
      let seen: unknown = null;
      await run(input(), { afterRow: (r) => { if (r.t === 'lock') seen = JSON.parse(fs.readFileSync(lockPath(), 'utf8')); } });
      expect(seen).toMatchObject({ pid: process.pid, runId: expect.any(String) });
      expect(fs.existsSync(lockPath())).toBe(false); // released at the end
    });

    it('a second child is refused while a corroborated holder lives', async () => {
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(lockPath(), JSON.stringify({ pid: 4242, runId: 'held-run', startedAt: 1 }));
      const inp = input();
      const res = await run(inp, { commandOf: async () => 'node agentWorktreeReclaimMain.js --run-id held-run' });
      expect(res.outcome).toBe('lock-busy');
      expect(rows(inp).map((r) => r.t)).toEqual(['lock-busy']);
      expect(await takeReclaimLock(lockPath(), { pid: 1, runId: 'x', startedAt: 1 }, lockOpts(async () => null))).toBe(false); // unknown ⇒ kept
    });

    it('a lock whose pid is gone, or whose pid now belongs to another command, is cleared', async () => {
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(lockPath(), JSON.stringify({ pid: 4242, runId: 'old-run', startedAt: 1 }));
      expect(await takeReclaimLock(lockPath(), { pid: 7, runId: 'new1', startedAt: 2 }, lockOpts(async () => ''))).toBe(true);
      expect(JSON.parse(fs.readFileSync(lockPath(), 'utf8')).runId).toBe('new1');
      expect(await takeReclaimLock(lockPath(), { pid: 8, runId: 'new2', startedAt: 3 }, lockOpts(async () => '/usr/sbin/unrelated --daemon'))).toBe(true);
      expect(JSON.parse(fs.readFileSync(lockPath(), 'utf8')).runId).toBe('new2');
    });

    it('an unreadable lock is stale only once older than the run deadline', async () => {
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(lockPath(), '');
      expect(await takeReclaimLock(lockPath(), { pid: 9, runId: 'n', startedAt: 1 }, lockOpts(async () => ''))).toBe(false);
      const old = (Date.now() - 1_000_000) / 1000;
      fs.utimesSync(lockPath(), old, old);
      expect(await takeReclaimLock(lockPath(), { pid: 9, runId: 'n', startedAt: 1 }, lockOpts(async () => ''))).toBe(true);
    });
  });

  it('parseReclaimArgs requires a hex run id that matches, and absolute paths', () => {
    const inp = input();
    const argv = ['node', 'x.js', '--run-id', inp.runId, '--input-json', JSON.stringify(inp)];
    expect(parseReclaimArgs(argv)?.runId).toBe(inp.runId);
    expect(parseReclaimArgs(['node', 'x.js', '--run-id', inp.runId, '--input-json', JSON.stringify({ ...inp, agentHome: 'rel' })])).toBeNull();
    expect(parseReclaimArgs(['node', 'x.js', '--run-id', 'f'.repeat(32), '--input-json', JSON.stringify(inp)])).toBeNull();
  });
});
