/**
 * Live removal, end to end (docs/specs/reaper-removal-out-of-process.md, Testing →
 * Integration): a throwaway agent home with real git worktrees, the COMPILED
 * child (dist/monitoring/agentWorktreeReclaimMain.js, built by the integration
 * lane's globalSetup) started through the real runner with its real seams
 * (`nice`, detached group, asynchronous `ps`), and removal live in the
 * throwaway's own config only.
 *
 * Checks the full order (archive → rename into .trash → delete), that a dirty and
 * a locked worktree are kept, that a sibling's registration stays intact, that
 * the child refuses to run outside the agent home, that the parent's event loop
 * never blocks over 1 s during the run, and a real SIGKILL of the child's leader
 * after its `renamed` row: the surviving group member keeps exclusion, the next
 * run deletes the leftover trash, and the breaker counts nothing twice.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { SafeGitExecutor } from '../../src/core/SafeGitExecutor.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { AgentWorktreeReclaimRunner, realReclaimRunnerSeams } from '../../src/monitoring/agentWorktreeReclaimRunner.js';
import { parseRows, type ReclaimChildInput, type ReclaimRow } from '../../src/monitoring/agentWorktreeReclaimMain.js';

const OP = 'tests/integration/agent-worktree-reclaim-live.test.ts';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CHILD = path.join(ROOT, 'dist', 'monitoring', 'agentWorktreeReclaimMain.js');
const REAL_GIT = fs.existsSync('/usr/bin/git') ? '/usr/bin/git' : 'git';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor<T>(fn: () => T | null | undefined | false, timeoutMs: number, stepMs = 5): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v) return v as T;
    if (Date.now() > end) throw new Error('timed out waiting');
    await sleep(stepMs);
  }
}

describe('agent worktree reclaim, live, through the compiled child', () => {
  let root: string;
  let home: string;
  let worktreesDir: string;
  let stateDir: string;
  let configPath: string;
  let shared: string;
  const savedEnv: Record<string, string | undefined> = {};

  const g = (cwd: string, args: string[]) => SafeGitExecutor.run(args, { cwd, operation: OP });
  const addWorktree = (slug: string): string => {
    const wt = path.join(worktreesDir, slug);
    g(home, ['worktree', 'add', '-q', wt, '-b', `b-${slug}`, 'HEAD']);
    fs.symlinkSync(shared, path.join(wt, 'node_modules'));
    return wt;
  };
  const runner = () => new AgentWorktreeReclaimRunner({
    stateDir, processName: 'agentWorktreeReclaimMain', mainScript: CHILD, nodePath: process.execPath,
    agentHome: home, projectDir: home, worktreesDir, configPath,
    githubMergeCheck: () => false, maxReaps: () => 20, pollMs: 100, killGraceMs: 1_000,
  });
  const rowsOf = (runId: string): ReclaimRow[] => {
    try { return parseRows(fs.readFileSync(path.join(stateDir, 'runs', `${runId}.jsonl`), 'utf8')); } catch { return []; }
  };
  const listed = () => g(home, ['worktree', 'list', '--porcelain']);

  beforeEach(() => {
    for (const k of ['INSTAR_AUDIT_LOG_DIR', 'INSTAR_AUDIT_LOG_DISABLED', 'PATH']) savedEnv[k] = process.env[k];
    // The child writes its audit trail to <its cwd>/.instar/audit: leave the default so it shows where it ran.
    delete process.env.INSTAR_AUDIT_LOG_DIR;
    delete process.env.INSTAR_AUDIT_LOG_DISABLED;
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'reclaim-live-')));
    home = path.join(root, '.instar', 'agents', 'throwaway');
    fs.mkdirSync(home, { recursive: true });
    g(home, ['init', '-q', '-b', 'main']);
    g(home, ['config', 'user.email', 't@t.l']);
    g(home, ['config', 'user.name', 'T']);
    g(home, ['config', 'commit.gpgsign', 'false']);
    fs.writeFileSync(path.join(home, '.gitignore'), 'node_modules\n.worktrees/\n.instar/audit/\n.instar/state/\n.instar/config.json\n.instar/instar-dev-decisions-archive/\n');
    fs.mkdirSync(path.join(home, '.instar'));
    fs.writeFileSync(path.join(home, '.instar', 'README.md'), 'state\n');
    fs.writeFileSync(path.join(home, 'README.md'), 'home\n');
    g(home, ['add', '-A']);
    g(home, ['commit', '-qm', 'init']);
    worktreesDir = path.join(home, '.worktrees');
    fs.mkdirSync(worktreesDir);
    stateDir = path.join(home, '.instar', 'state', 'agent-worktree-reclaim');
    configPath = path.join(home, '.instar', 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({ monitoring: { agentWorktreeReaper: { enabled: true, dryRun: false } } }));
    shared = path.join(root, 'shared-node_modules');
    fs.mkdirSync(path.join(shared, 'pkg'), { recursive: true });
    fs.writeFileSync(path.join(shared, 'pkg', 'index.js'), 'live');
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: OP });
  });

  it('the compiled child exists (built by the lane globalSetup)', () => {
    expect(fs.existsSync(CHILD)).toBe(true);
  });

  it('refuses to run when its working folder is not the agent home (exit 5, nothing touched)', async () => {
    const wt = addWorktree('untouched');
    const runId = 'd'.repeat(32);
    const input: ReclaimChildInput = {
      runId, agentHome: home, projectDir: home, worktreesDir, stateDir, configPath,
      rowsPath: path.join(stateDir, 'runs', `${runId}.jsonl`), reportPath: path.join(stateDir, 'report.json'),
      deadlineAt: Date.now() + 900_000, maxReaps: 20, githubMergeCheck: false, excludedPaths: [],
    };
    const child = spawn(process.execPath, [CHILD, '--run-id', runId, '--input-json', JSON.stringify(input)], { cwd: root, stdio: 'ignore' });
    const code = await new Promise<number | null>((r) => child.once('exit', (c) => r(c)));
    expect(code).toBe(5);
    expect(fs.existsSync(wt)).toBe(true);
    expect(fs.existsSync(input.rowsPath)).toBe(false);
  });

  it('removes eligible checkouts in order, keeps dirty and locked ones and a sibling registration, with no event-loop block over 1 s', async () => {
    const e1 = addWorktree('eligible-one');
    const e2 = addWorktree('eligible-two');
    // Archived residue (PR 3480): a per-checkout audit trail.
    fs.mkdirSync(path.join(e1, '.instar', 'audit'), { recursive: true });
    fs.writeFileSync(path.join(e1, '.instar', 'audit', 'destructive-ops.jsonl'), '{"op":"x"}\n');
    const dirty = addWorktree('dirty');
    fs.writeFileSync(path.join(dirty, 'notes.txt'), 'mine');
    const locked = addWorktree('locked');
    g(home, ['worktree', 'lock', '--reason', 'held', locked]);
    const sibling = path.join(worktreesDir, 'sibling');
    g(home, ['worktree', 'add', '-q', sibling, '-b', 'sibling', 'HEAD']);
    fs.writeFileSync(path.join(sibling, 's.txt'), 's');
    g(sibling, ['add', '-A']);
    g(sibling, ['commit', '-qm', 'unmerged sibling work']);

    const h = monitorEventLoopDelay({ resolution: 10 });
    h.enable();
    const r = runner();
    const started = await r.startRun({ excludedPaths: [] });
    expect(started.started).toBe(true);
    const { runId, done } = started as { started: true; runId: string; done: Promise<void> };
    await Promise.race([done, sleep(110_000).then(() => { throw new Error('run did not finish'); })]);
    h.disable();
    expect(h.max / 1e6).toBeLessThan(1_000);

    const rows = rowsOf(runId);
    const byAttempt = (p: string) => {
      const id = rows.find((x) => x.t === 'attempt' && x.path === p)?.attemptId;
      return rows.filter((x) => x.attemptId === id || (x.t.startsWith('trash-') && x.name === id)).map((x) => x.t);
    };
    for (const e of [e1, e2]) {
      expect(byAttempt(e)).toEqual(['attempt', 'archived', 'renaming', 'renamed', 'trash-done', 'removed']);
      expect(fs.existsSync(e)).toBe(false);
    }
    expect(fs.readdirSync(path.join(worktreesDir, '.trash'))).toEqual([]);
    // archived before removal
    expect(fs.readFileSync(path.join(home, '.instar', 'instar-dev-decisions-archive', 'eligible-one', '.instar', 'audit', 'destructive-ops.jsonl'), 'utf8')).toBe('{"op":"x"}\n');
    // the shared install behind the symlinked node_modules survives
    expect(fs.readFileSync(path.join(shared, 'pkg', 'index.js'), 'utf8')).toBe('live');
    // dirty kept by the evaluation, locked kept at removal time, sibling untouched
    expect(fs.readFileSync(path.join(dirty, 'notes.txt'), 'utf8')).toBe('mine');
    expect(fs.existsSync(locked)).toBe(true);
    expect(rows.find((x) => x.t === 'kept' && rows.find((a) => a.t === 'attempt' && a.path === locked && a.attemptId === x.attemptId))?.reason).toBe('locked');
    const l = listed();
    for (const p of [dirty, locked, sibling]) expect(l).toContain(`worktree ${p}`);
    for (const p of [e1, e2]) expect(l).not.toContain(`worktree ${p}`);
    // The child ran in the agent home: its executors' audit trail is <agent home>/.instar/audit.
    const audit = fs.readFileSync(path.join(home, '.instar', 'audit', 'destructive-ops.jsonl'), 'utf8');
    expect(audit).toContain('safeRenameDirSync');
    expect(fs.existsSync(path.join(sibling, '.instar', 'audit'))).toBe(false);
    // The route's report: the full evaluation
    const report = JSON.parse(fs.readFileSync(path.join(stateDir, 'report.json'), 'utf8'));
    expect(report.phase).toBe('final');
    expect(report.worktrees).toHaveLength(5);
    expect(report.removed.sort()).toEqual([e1, e2].sort());
    // outcomes once
    const outcomes = await r.collectOutcomes();
    expect(outcomes.filter((o) => o.kind === 'removed').map((o) => o.path).sort()).toEqual([e1, e2].sort());
    expect(outcomes.filter((o) => o.kind === 'failed')).toEqual([]);
    expect(await runner().collectOutcomes()).toEqual([]);
  }, 120_000);

  it('a real SIGKILL of the leader after `renamed`: a surviving member keeps exclusion, the next run deletes the trash, nothing is counted twice', async () => {
    const e = addWorktree('killed');
    // A `git` that sleeps on `worktree prune`: the child is held right after its `renamed` row.
    const bin = path.join(root, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh\ncase "$*" in *"worktree prune"*) sleep 4 ;; esac\nexec ${REAL_GIT} "$@"\n`, { mode: 0o755 });
    process.env.PATH = `${bin}:${savedEnv.PATH ?? ''}`;
    const r = runner();
    const started = await r.startRun({ excludedPaths: [] }) as { started: true; runId: string; done: Promise<void> };
    expect(started.started).toBe(true);
    const leader = (JSON.parse(fs.readFileSync(path.join(stateDir, 'run.json'), 'utf8')) as { pgid: number }).pgid;
    await waitFor(() => rowsOf(started.runId).some((x) => x.t === 'renamed'), 90_000);
    // Wait until the held `git worktree prune` is running in the child's group, so the kill
    // lands mid-run with a live sub-process (and before any trash delete starts).
    const seams = realReclaimRunnerSeams();
    const end = Date.now() + 10_000;
    for (;;) {
      const m = await seams.groupMembers(leader);
      if (m && m.some((x) => x.pid !== leader && /worktree prune|sleep/.test(x.command))) break;
      if (Date.now() > end) throw new Error('held prune never appeared in the group');
      await sleep(20);
    }
    // `nice` exec'd node, so the group leader IS the child.
    process.kill(leader, 'SIGKILL');
    await sleep(500);
    // The leader is gone; the sleeping git (no run id on its command line) still holds the group.
    expect(r.busy()).toBe(true);
    expect(await r.startRun({ excludedPaths: [] })).toEqual({ started: false, reason: 'busy' });
    await Promise.race([started.done, sleep(60_000).then(() => { throw new Error('group never emptied'); })]);
    process.env.PATH = savedEnv.PATH;

    const rows1 = rowsOf(started.runId);
    const attemptId = rows1.find((x) => x.t === 'attempt' && x.path === e)!.attemptId!;
    expect(rows1.some((x) => x.attemptId === attemptId && ['removed', 'error', 'kept'].includes(x.t))).toBe(false);
    const trash = path.join(worktreesDir, '.trash', attemptId);
    expect(fs.existsSync(trash)).toBe(true);
    expect(fs.existsSync(e)).toBe(false);
    // The open attempt is leftover trash, not a failure — and it is read once only.
    expect(await r.collectOutcomes()).toEqual([]);

    const again = await r.startRun({ excludedPaths: [] }) as { started: true; runId: string; done: Promise<void> };
    expect(again.started).toBe(true);
    await Promise.race([again.done, sleep(110_000).then(() => { throw new Error('second run did not finish'); })]);
    const rows2 = rowsOf(again.runId);
    expect(rows2.find((x) => x.t === 'trash-start' && x.name === attemptId)?.knownAttempt).toBe(true);
    expect(rows2.some((x) => x.t === 'trash-done' && x.name === attemptId)).toBe(true);
    expect(fs.existsSync(trash)).toBe(false);
    expect(await r.collectOutcomes()).toEqual([]);
    expect(await runner().collectOutcomes()).toEqual([]); // a restart does not count the first run again
    expect(listed()).not.toContain(`worktree ${e}`);
  }, 240_000);
});
