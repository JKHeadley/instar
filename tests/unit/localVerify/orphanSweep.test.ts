/**
 * Local Verify orphan sweep (spec docs/specs/disk-steward.md §5): run checkouts
 * left by runs cut short are removed at the start of the next run, with a
 * non-forced `git worktree remove` only; kept failed runs and anything git
 * refuses are kept.
 */
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { keepFailed, sweepOrphanVerifyRuns, verifyPaths, type OrchestratorSeams } from '../../../src/localVerify/orchestrator.js';
import { runCheckoutInUse } from '../../../src/localVerify/orchestratorSeams.js';

const HOME = '/agent';
const p = verifyPaths(HOME, 'aaaaaaaaaaaa0000000000000000000000000000');

function fake(o: { entries: string[]; kept?: string | null; refuse?: string[]; realpath?: (x: string) => string | null; noList?: boolean; unregistered?: string[]; busy?: string[]; inUseUnknown?: boolean; listFails?: boolean; sizes?: Record<string, number | null> }) {
  const present = new Set(o.entries.map((n) => path.join(p.runsDir, n)));
  const calls: string[][] = [];
  const logs: Array<Record<string, unknown>> = [];
  const degrades: Array<Record<string, unknown>> = [];
  const writes: Array<[string, string]> = [];
  const files = new Map<string, string>();
  if (o.kept !== undefined && o.kept !== null) files.set(p.keptListFile, o.kept);
  const seams = {
    git: async (args: string[]) => {
      calls.push(args);
      if (args[0] === 'worktree' && args[1] === 'list') {
        if (o.listFails) return { status: 128, stdout: '', stderr: 'fatal: not a git repository' };
        const rows = [...present].filter((d) => !o.unregistered?.includes(path.basename(d))).map((d) => `worktree ${d}\nHEAD abc\ndetached\n`);
        return { status: 0, stdout: rows.join('\n'), stderr: '' };
      }
      if (args[0] === 'worktree' && args[1] === 'remove') {
        const dir = args[2];
        if (o.refuse?.includes(path.basename(dir))) return { status: 128, stdout: '', stderr: 'contains modified or untracked files' };
        present.delete(dir);
      }
      return { status: 0, stdout: '', stderr: '' };
    },
    fs: {
      exists: (x: string) => present.has(x) || files.has(x),
      mkdirp: () => {}, writeFile: (x: string, data: string) => { writes.push([x, data]); },
      readFile: (x: string) => files.get(x) ?? null,
      mkdtemp: () => '/tmp/x', removeTree: async () => { throw new Error('the sweep must never use the recursive delete'); },
      ...(o.noList ? {} : { list: (x: string) => (x === p.runsDir ? [...present].map((d) => path.basename(d)) : null) }),
      realpath: o.realpath ?? ((x: string) => x),
      inUse: (d: string) => (o.inUseUnknown ? null : !!o.busy?.includes(path.basename(d))),
      ...(o.sizes ? { treeSize: (d: string) => o.sizes?.[path.basename(d)] ?? null } : {}),
    },
    log: (e: Record<string, unknown>) => { logs.push(e); },
    degrade: (e: Record<string, unknown>) => { degrades.push(e); },
  } as unknown as OrchestratorSeams;
  return { seams, calls, logs, degrades, writes, present };
}

describe('sweepOrphanVerifyRuns', () => {
  it('removes orphans, keeps the current run and kept failed runs', async () => {
    const keptDir = path.join(p.runsDir, 'bbbbbbbbbbbb');
    const f = fake({ entries: ['aaaaaaaaaaaa', 'bbbbbbbbbbbb', 'cccccccccccc', 'dddddddddddd'], kept: JSON.stringify([keptDir]) });
    const r = await sweepOrphanVerifyRuns(f.seams, p);
    expect(r.removed.map((d) => path.basename(d)).sort()).toEqual(['cccccccccccc', 'dddddddddddd']);
    expect(f.present.has(p.runDir)).toBe(true);
    expect(f.present.has(keptDir)).toBe(true);
    // non-forced remove only, then one prune
    for (const c of f.calls.filter((c) => c[1] === 'remove')) expect(c).not.toContain('--force');
    expect(f.calls.filter((c) => c[1] === 'remove')).toHaveLength(2);
    expect(f.calls.filter((c) => c[1] === 'prune')).toHaveLength(1);
  });

  it('keeps an entry git refuses and lists it, never forcing', async () => {
    const f = fake({ entries: ['cccccccccccc'], kept: '[]', refuse: ['cccccccccccc'] });
    const r = await sweepOrphanVerifyRuns(f.seams, p);
    expect(r.removed).toEqual([]);
    expect(r.kept.map((d) => path.basename(d))).toEqual(['cccccccccccc']);
    expect(f.present.size).toBe(1);
  });

  it('matches a kept run by realpath when the stored path is spelled differently', async () => {
    const stored = '/private' + path.join(p.runsDir, 'bbbbbbbbbbbb');
    const f = fake({
      entries: ['bbbbbbbbbbbb'], kept: JSON.stringify([stored]),
      realpath: (x) => (x.startsWith('/private') ? x : '/private' + x),
    });
    const r = await sweepOrphanVerifyRuns(f.seams, p);
    expect(r.removed).toEqual([]);
    expect(f.present.size).toBe(1);
  });

  it('sweeps nothing while kept-failed.json exists but cannot be parsed', async () => {
    const f = fake({ entries: ['cccccccccccc', 'dddddddddddd'], kept: '[ "/agent/.worktrees/.verify/runs/cc' });
    const r = await sweepOrphanVerifyRuns(f.seams, p);
    expect(r.skipped).toBe('kept-list-unreadable');
    expect(f.calls).toEqual([]);
    expect(f.present.size).toBe(2);
    expect(f.logs.some((l) => l.event === 'orphan-sweep-skipped')).toBe(true);
    // Recorded as a degradation (disk-steward §5), not only as a run-log line.
    expect(f.degrades.map((d) => d.feature)).toEqual(['LocalVerify.keptList']);
  });

  it('leaves anything the verifier did not make: wrong name or not registered in its clone', async () => {
    const f = fake({ entries: ['lease-jobs-4009a9d2', 'eeeeeeeeeeee', 'cccccccccccc'], kept: '[]', unregistered: ['eeeeeeeeeeee'] });
    const r = await sweepOrphanVerifyRuns(f.seams, p);
    expect(r.removed.map((d) => path.basename(d))).toEqual(['cccccccccccc']);
    expect(r.kept.map((d) => path.basename(d)).sort()).toEqual(['eeeeeeeeeeee', 'lease-jobs-4009a9d2']);
  });

  it('keeps a checkout a running process uses, and all of them when that cannot be read', async () => {
    const busy = fake({ entries: ['cccccccccccc', 'dddddddddddd'], kept: '[]', busy: ['cccccccccccc'] });
    const r = await sweepOrphanVerifyRuns(busy.seams, p);
    expect(r.removed.map((d) => path.basename(d))).toEqual(['dddddddddddd']);
    const unknown = fake({ entries: ['cccccccccccc'], kept: '[]', inUseUnknown: true });
    expect((await sweepOrphanVerifyRuns(unknown.seams, p)).removed).toEqual([]);
  });

  it('a missing kept list means no kept runs', async () => {
    const f = fake({ entries: ['cccccccccccc'], kept: null });
    const r = await sweepOrphanVerifyRuns(f.seams, p);
    expect(r.removed).toHaveLength(1);
  });

  it('does nothing without a list seam', async () => {
    const f = fake({ entries: ['cccccccccccc'], kept: '[]', noList: true });
    const r = await sweepOrphanVerifyRuns(f.seams, p);
    expect(r.skipped).toBe('no-list-seam');
    expect(f.calls).toEqual([]);
  });

  it('never throws: a git failure is logged and the verify goes on', async () => {
    const f = fake({ entries: ['cccccccccccc'], kept: '[]' });
    (f.seams as unknown as { git: () => Promise<never> }).git = async () => { throw new Error('git exploded'); };
    await expect(sweepOrphanVerifyRuns(f.seams, p)).resolves.toBeTruthy();
    expect(f.logs.some((l) => l.event === 'orphan-sweep-failed')).toBe(true);
  });

  it('logs the skip when its own clone cannot list worktrees, and removes nothing', async () => {
    const f = fake({ entries: ['cccccccccccc'], kept: '[]', listFails: true });
    const r = await sweepOrphanVerifyRuns(f.seams, p);
    expect(r.skipped).toBe('worktree-list-failed');
    expect(r.removed).toEqual([]);
    expect(f.present.size).toBe(1);
    const skip = f.logs.find((l) => l.event === 'orphan-sweep-skipped');
    expect(skip).toBeTruthy();
    expect(String(skip?.detail)).toContain('git worktree list failed');
    expect(f.calls.filter((c) => c[1] === 'remove')).toHaveLength(0);
  });

  it('lists every kept entry with its size', async () => {
    const f = fake({ entries: ['cccccccccccc', 'hand-made-copy'], kept: '[]', refuse: ['cccccccccccc'], sizes: { cccccccccccc: 4096, 'hand-made-copy': null } });
    await sweepOrphanVerifyRuns(f.seams, p);
    const done = f.logs.find((l) => l.event === 'orphan-sweep') as { kept: number; keptEntries: Array<{ dir: string; bytes: number | null }> };
    expect(done.kept).toBe(2);
    const byName = Object.fromEntries(done.keptEntries.map((e) => [path.basename(e.dir), e.bytes]));
    expect(byName).toEqual({ cccccccccccc: 4096, 'hand-made-copy': null });
  });
});

describe('keepFailed', () => {
  it('leaves an unparseable kept-failed.json untouched, logs it, and records the degradation', async () => {
    const f = fake({ entries: ['aaaaaaaaaaaa'], kept: '{ not a list' });
    await keepFailed(f.seams, p);
    expect(f.writes).toEqual([]);
    expect(f.logs.some((l) => l.event === 'kept-list-unreadable')).toBe(true);
    expect(f.degrades.map((d) => d.feature)).toEqual(['LocalVerify.keptList']);
    expect(f.calls.filter((c) => c[1] === 'remove')).toHaveLength(0);
  });

  it('records this run in a readable list', async () => {
    const f = fake({ entries: ['aaaaaaaaaaaa'], kept: '[]' });
    await keepFailed(f.seams, p);
    expect(f.writes).toHaveLength(1);
    expect(JSON.parse(f.writes[0][1])).toEqual([p.runDir]);
    expect(f.degrades).toEqual([]);
  });
});

describe('runCheckoutInUse', () => {
  const dir = '/agent/.worktrees/.verify/runs/cccccccccccc';
  it('is true when a process has its working folder inside the checkout', () => {
    expect(runCheckoutInUse(dir, { cwds: `p123\nn/agent/.worktrees/.verify/runs/cccccccccccc/node_modules\n`, cmds: '' })).toBe(true);
    expect(runCheckoutInUse(dir, { cwds: `p123\nn${dir}\n`, cmds: '' })).toBe(true);
  });
  it('is true when a command line names the checkout', () => {
    expect(runCheckoutInUse(dir, { cwds: 'p1\nn/elsewhere\n', cmds: `node ${dir}/node_modules/.bin/vitest run\n` })).toBe(true);
  });
  it('is false for other folders and a sibling run with a longer name', () => {
    expect(runCheckoutInUse(dir, { cwds: 'p1\nn/elsewhere\nn/agent/.worktrees/.verify/runs/cccccccccccc0\n', cmds: 'vitest run /agent/.worktrees/.verify/runs/dddddddddddd/x\n' })).toBe(false);
  });
  it('is null, never false, when the process view could not be read', () => {
    expect(runCheckoutInUse(dir, null)).toBeNull();
  });
});
