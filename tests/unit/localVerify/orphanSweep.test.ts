/**
 * Local Verify orphan sweep (spec docs/specs/disk-steward.md §5): run checkouts
 * left by runs cut short are removed at the start of the next run, with a
 * non-forced `git worktree remove` only; kept failed runs and anything git
 * refuses are kept.
 */
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { sweepOrphanVerifyRuns, verifyPaths, type OrchestratorSeams } from '../../../src/localVerify/orchestrator.js';

const HOME = '/agent';
const p = verifyPaths(HOME, 'aaaaaaaaaaaa0000000000000000000000000000');

function fake(o: { entries: string[]; kept?: string | null; refuse?: string[]; realpath?: (x: string) => string | null; noList?: boolean; unregistered?: string[]; busy?: string[]; inUseUnknown?: boolean }) {
  const present = new Set(o.entries.map((n) => path.join(p.runsDir, n)));
  const calls: string[][] = [];
  const logs: Array<Record<string, unknown>> = [];
  const files = new Map<string, string>();
  if (o.kept !== undefined && o.kept !== null) files.set(p.keptListFile, o.kept);
  const seams = {
    git: async (args: string[]) => {
      calls.push(args);
      if (args[0] === 'worktree' && args[1] === 'list') {
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
      mkdirp: () => {}, writeFile: () => {},
      readFile: (x: string) => files.get(x) ?? null,
      mkdtemp: () => '/tmp/x', removeTree: async () => { throw new Error('the sweep must never use the recursive delete'); },
      ...(o.noList ? {} : { list: (x: string) => (x === p.runsDir ? [...present].map((d) => path.basename(d)) : null) }),
      realpath: o.realpath ?? ((x: string) => x),
      inUse: (d: string) => (o.inUseUnknown ? null : !!o.busy?.includes(path.basename(d))),
    },
    log: (e: Record<string, unknown>) => { logs.push(e); },
  } as unknown as OrchestratorSeams;
  return { seams, calls, logs, present };
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
});
