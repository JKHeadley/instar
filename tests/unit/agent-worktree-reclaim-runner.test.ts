/**
 * Server side of the reclaim child (docs/specs/reaper-removal-out-of-process.md §1-3):
 * durable intent before spawn, ownership by process group, corroboration by run
 * id, escalating kill, adoption after restart, and attempt outcomes read once.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import {
  AgentWorktreeReclaimRunner,
  parseGroupMembers,
  realReclaimRunnerSeams,
  type ReclaimGroupMember,
  type ReclaimRunnerSeams,
  type ReclaimRunRecord,
} from '../../src/monitoring/agentWorktreeReclaimRunner.js';
import { appendDurableRow, parseReclaimArgs } from '../../src/monitoring/agentWorktreeReclaimMain.js';

const OP = 'tests/unit/agent-worktree-reclaim-runner.test.ts';

describe('AgentWorktreeReclaimRunner', () => {
  let root: string;
  let stateDir: string;
  let worktreesDir: string;
  let clock: number;
  let timers: Array<{ fn: () => void; cancelled: boolean }>;
  let members: Map<number, ReclaimGroupMember[] | null>;
  let spawned: Array<{ args: string[]; cwd: string }>;
  let kills: Array<{ pgid: number; signal: string }>;
  let failWrites: boolean;
  let failRows: boolean;
  let nextPid: number | undefined;
  let bootTime: number;

  const real = realReclaimRunnerSeams();
  const seams = (): ReclaimRunnerSeams => ({
    spawnChild: (args, cwd) => { spawned.push({ args, cwd }); return { pid: nextPid }; },
    groupMembers: async (pgid) => (members.has(pgid) ? members.get(pgid)! : []),
    findGroupByArgs: async () => null,
    killGroup: (pgid, signal) => { kills.push({ pgid, signal }); },
    writeDurable: (f, d) => (failWrites ? false : real.writeDurable(f, d)),
    appendRow: (f, r) => (failRows ? false : real.appendRow(f, r)),
    readFile: real.readFile,
    exists: real.exists,
    bootTime: () => bootTime,
    now: () => clock,
    setTimer: (fn) => { const t = { fn, cancelled: false }; timers.push(t); return { cancel: () => { t.cancelled = true; } }; },
  });
  /** Fire every pending timer once, then let the async polls settle. */
  const tick = async (): Promise<void> => {
    const due = timers.splice(0);
    for (const t of due) if (!t.cancelled) t.fn();
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
  };
  const mk = (over: Partial<ConstructorParameters<typeof AgentWorktreeReclaimRunner>[0]> = {}) => new AgentWorktreeReclaimRunner({
    stateDir, processName: 'agentWorktreeReclaimMain', mainScript: '/x/agentWorktreeReclaimMain.js', nodePath: process.execPath,
    agentHome: root, projectDir: root, worktreesDir, configPath: path.join(root, 'config.json'),
    githubMergeCheck: () => false, maxReaps: () => 20, ...over,
  }, seams());
  const writeRecord = (r: ReclaimRunRecord) => { fs.mkdirSync(stateDir, { recursive: true }); fs.writeFileSync(path.join(stateDir, 'run.json'), JSON.stringify(r)); };
  const readRecord = (): ReclaimRunRecord => JSON.parse(fs.readFileSync(path.join(stateDir, 'run.json'), 'utf8'));

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'reclaim-runner-')));
    stateDir = path.join(root, 'state');
    worktreesDir = path.join(root, '.worktrees');
    fs.mkdirSync(worktreesDir);
    clock = 1_000_000_000_000;
    bootTime = clock - 86_400_000;
    timers = []; members = new Map(); spawned = []; kills = [];
    failWrites = false; failRows = false; nextPid = 5555;
  });
  afterEach(() => { SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: OP }); });

  it('writes the intent durably BEFORE spawning, and spawns from the agent home with the run id on argv', async () => {
    const r = mk();
    const started = await r.startRun({ excludedPaths: ['/a'] });
    expect(started.started).toBe(true);
    const runId = (started as { runId: string }).runId;
    const rows = fs.readFileSync(path.join(stateDir, 'runs', `${runId}.jsonl`), 'utf8');
    expect(JSON.parse(rows.split('\n')[0])).toMatchObject({ t: 'intent', runId });
    expect(spawned).toHaveLength(1);
    expect(spawned[0].cwd).toBe(root);
    expect(spawned[0].args).toContain(runId);
    const input = parseReclaimArgs(['node', ...spawned[0].args]);
    expect(input).toMatchObject({ runId, agentHome: root, excludedPaths: ['/a'], maxReaps: 20 });
    expect(readRecord()).toMatchObject({ runId, state: 'spawned', pgid: 5555 });
  });

  it('a failed intent write (run record or intent row) starts no run', async () => {
    failWrites = true;
    expect(await mk().startRun({ excludedPaths: [] })).toEqual({ started: false, reason: 'intent-failed' });
    failWrites = false; failRows = true;
    expect(await mk().startRun({ excludedPaths: [] })).toEqual({ started: false, reason: 'intent-failed' });
    expect(spawned).toHaveLength(0);
  });

  it('a spawn with no pid is recorded finished and reported', async () => {
    nextPid = undefined;
    expect(await mk().startRun({ excludedPaths: [] })).toEqual({ started: false, reason: 'spawn-failed' });
    expect(readRecord().state).toBe('finished');
  });

  it('one child at a time; finished only when no process in the group remains', async () => {
    const r = mk();
    const s = await r.startRun({ excludedPaths: [] }) as { started: true; runId: string; done: Promise<void> };
    members.set(5555, [{ pid: 5555, command: `node agentWorktreeReclaimMain.js --run-id ${s.runId}` }]);
    expect(await r.startRun({ excludedPaths: [] })).toEqual({ started: false, reason: 'busy' });
    await tick();
    expect(r.busy()).toBe(true);
    members.set(5555, []);
    await tick();
    await s.done;
    expect(r.busy()).toBe(false);
    expect(readRecord().state).toBe('finished');
    expect(spawned).toHaveLength(1);
  });

  it('leader death with a surviving sub-process keeps exclusion until the group is gone, and it is never killed uncorroborated', async () => {
    const r = mk();
    const s = await r.startRun({ excludedPaths: [] }) as { started: true; runId: string; done: Promise<void> };
    // The child died; its `rm -rf` (no run id on its command line) still runs in the group.
    members.set(5555, [{ pid: 6001, command: 'rm -rf -- /x/.worktrees/.trash/abc' }]);
    await tick();
    expect(r.busy()).toBe(true);
    expect(await r.startRun({ excludedPaths: [] })).toEqual({ started: false, reason: 'busy' });
    clock += 1_000_000; // past the 900 s deadline
    await tick();
    expect(kills).toEqual([]); // cannot prove identity ⇒ not killed
    expect(r.busy()).toBe(true);
    members.set(5555, []);
    await tick();
    await s.done;
    expect(r.busy()).toBe(false);
  });

  it('past the deadline a corroborated group is killed with escalation (SIGTERM, then SIGKILL)', async () => {
    const r = mk({ killGraceMs: 10 });
    const s = await r.startRun({ excludedPaths: [] }) as { started: true; runId: string };
    members.set(5555, [{ pid: 5555, command: `nice node agentWorktreeReclaimMain.js --run-id ${s.runId}` }]);
    clock += 901_000;
    await tick();
    expect(kills).toEqual([{ pgid: 5555, signal: 'SIGTERM' }]);
    await tick(); // the grace timer: still alive and corroborated
    expect(kills).toEqual([{ pgid: 5555, signal: 'SIGTERM' }, { pgid: 5555, signal: 'SIGKILL' }]);
  });

  describe('adoption after restart', () => {
    const rec = (over: Partial<ReclaimRunRecord> = {}): ReclaimRunRecord => ({
      runId: 'r'.repeat(32), startedAt: clock - 60_000, deadline: clock + 840_000, rowsPath: path.join(stateDir, 'runs', 'x.jsonl'), state: 'spawned', pid: 7777, pgid: 7777, ...over,
    });

    it('a live corroborated group is adopted and holds exclusion', async () => {
      writeRecord(rec());
      members.set(7777, [{ pid: 7777, command: `node agentWorktreeReclaimMain.js --run-id ${'r'.repeat(32)}` }]);
      const r = mk();
      expect(await r.recover()).toBe('adopted');
      expect(await r.startRun({ excludedPaths: [] })).toEqual({ started: false, reason: 'busy' });
      expect(spawned).toHaveLength(0);
    });

    it('an adopted run already past its deadline is killed', async () => {
      writeRecord(rec({ deadline: clock - 1 }));
      members.set(7777, [{ pid: 7777, command: `node agentWorktreeReclaimMain.js --run-id ${'r'.repeat(32)}` }]);
      expect(await mk().recover()).toBe('adopted');
      expect(kills[0]).toEqual({ pgid: 7777, signal: 'SIGTERM' });
    });

    it('an unreadable process list leaves ownership unresolved: no new run until it resolves', async () => {
      writeRecord(rec());
      members.set(7777, null);
      const r = mk();
      expect(await r.recover()).toBe('unresolved');
      expect(await r.startRun({ excludedPaths: [] })).toEqual({ started: false, reason: 'unresolved' });
      expect(spawned).toHaveLength(0);
      members.set(7777, []);
      expect((await r.startRun({ excludedPaths: [] })).started).toBe(true);
    });

    it('a run from before the last boot is treated as gone (pids reused), nothing killed', async () => {
      writeRecord(rec({ startedAt: bootTime - 1 }));
      members.set(7777, [{ pid: 7777, command: 'unrelated daemon' }]);
      expect(await mk().recover()).toBe('stale');
      expect(kills).toEqual([]);
      expect(readRecord().state).toBe('stale');
    });

    it('an uncorroborated surviving group stops holding exclusion past the release bound', async () => {
      writeRecord(rec({ deadline: clock - 3_700_000 }));
      members.set(7777, [{ pid: 7777, command: 'something else now' }]);
      expect(await mk().recover()).toBe('finished');
    });

    it('an intent with no pid is found by run id + process name, else treated as gone', async () => {
      writeRecord(rec({ state: 'intent', pid: undefined, pgid: undefined }));
      expect(await mk().recover()).toBe('finished');
    });
  });

  describe('collectOutcomes (the breaker reads each attempt once)', () => {
    const runsDir = () => path.join(stateDir, 'runs');
    const writeRun = (runId: string, rows: Array<Record<string, unknown>>) => {
      for (const r of rows) appendDurableRow(path.join(runsDir(), `${runId}.jsonl`), { at: 1, runId, ...r } as never);
    };

    it('reads removed and error rows, reconciles open attempts with the disk, and dedupes across restarts', async () => {
      const removedPath = path.join(worktreesDir, 'gone');
      const failedPath = path.join(worktreesDir, 'failed');
      const beforeRename = path.join(worktreesDir, 'intact');
      fs.mkdirSync(beforeRename);
      const afterRename = path.join(worktreesDir, 'renamed');
      fs.mkdirSync(path.join(worktreesDir, '.trash', 'a4-0000'), { recursive: true });
      writeRun('a'.repeat(32), [
        { t: 'intent' },
        { t: 'attempt', attemptId: 'a1-0000', path: removedPath }, { t: 'removed', attemptId: 'a1-0000' },
        { t: 'attempt', attemptId: 'a2-0000', path: failedPath }, { t: 'error', attemptId: 'a2-0000', reason: 'archive verification failed' },
        { t: 'attempt', attemptId: 'a3-0000', path: beforeRename }, { t: 'archived', attemptId: 'a3-0000' },
        { t: 'attempt', attemptId: 'a4-0000', path: afterRename }, { t: 'renaming', attemptId: 'a4-0000', trash: path.join(worktreesDir, '.trash', 'a4-0000') },
        { t: 'attempt', attemptId: 'a5-0000', path: path.join(worktreesDir, 'kept') }, { t: 'kept', attemptId: 'a5-0000', reason: 'locked' },
      ]);
      fs.appendFileSync(path.join(runsDir(), `${'a'.repeat(32)}.jsonl`), '{"t":"error","attemptId":"a5'); // torn last line
      const out = await mk().collectOutcomes();
      expect(out).toEqual([
        { attemptId: 'a1-0000', path: removedPath, kind: 'removed' },
        { attemptId: 'a2-0000', path: failedPath, kind: 'failed', reason: 'archive verification failed' },
        { attemptId: 'a3-0000', path: beforeRename, kind: 'failed', reason: 'run ended mid-attempt before the rename' },
      ]);
      // a new runner (a server restart) does not count them again
      expect(await mk().collectOutcomes()).toEqual([]);
    });

    it('a live run is not read until it ends', async () => {
      const r = mk();
      const s = await r.startRun({ excludedPaths: [] }) as { started: true; runId: string; done: Promise<void> };
      members.set(5555, [{ pid: 5555, command: `x --run-id ${s.runId}` }]);
      appendDurableRow(path.join(runsDir(), `${s.runId}.jsonl`), { t: 'attempt', at: 1, attemptId: 'b1-0000', path: '/nowhere' });
      appendDurableRow(path.join(runsDir(), `${s.runId}.jsonl`), { t: 'error', at: 1, attemptId: 'b1-0000', reason: 'x' });
      expect(await r.collectOutcomes()).toEqual([]);
      members.set(5555, []);
      await tick();
      await s.done;
      expect((await r.collectOutcomes()).map((o) => o.attemptId)).toEqual(['b1-0000']);
    });
  });

  describe('real supervision seams (asynchronous ps)', () => {
    it('parseGroupMembers reads pid, pgid, command', () => {
      expect(parseGroupMembers('  101   100 rm -rf -- /x\n102 100 git worktree prune\n')).toEqual([
        { pid: 101, command: 'rm -rf -- /x' }, { pid: 102, command: 'git worktree prune' },
      ]);
    });

    it('groupMembers sees a surviving member after its leader exits, and [] once the group is gone', async () => {
      if (process.platform === 'win32') return;
      // A detached leader that starts a sleeper in its group, then exits.
      const leader = spawn(process.execPath, ['-e', "require('child_process').spawn('sleep', ['3'], { stdio: 'ignore' }).unref(); setTimeout(() => process.exit(0), 100);"], { detached: true, stdio: 'ignore' });
      const pgid = leader.pid!;
      await new Promise((r) => leader.once('exit', r));
      const during = await real.groupMembers(pgid);
      expect(during).not.toBeNull();
      expect(during!.some((m) => m.command.includes('sleep'))).toBe(true);
      expect(during!.some((m) => m.pid === pgid)).toBe(false); // the leader is gone
      try { process.kill(-pgid, 'SIGKILL'); } catch { /* already gone */ }
      for (let i = 0; i < 50; i++) {
        const after = await real.groupMembers(pgid);
        if (after && after.length === 0) return;
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error('group never emptied');
    });
  });
});
