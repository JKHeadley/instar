/**
 * leftoverReaper (docs/specs/machine-memory-care.md §2): the pure parsers and the selection
 * rules, and the signal order (SIGCONT then SIGKILL). Fakes for the process table.
 */

import { describe, expect, it } from 'vitest';
import {
  localVerifyRunPrefixes, parseEtime, parseLsofPaths, parsePsRows, protectedPids, reapLeftovers, selectLeftovers,
  type ProcRow, type ReapDeps,
} from '../../../src/localVerify/leftoverReaper.js';
import { runLeftoverPrefixes } from '../../../src/localVerify/orchestrator.js';

const RUNS = '/agents/echo/.worktrees/.verify/runs/';
const row = (over: Partial<ProcRow>): ProcRow => ({ pid: 100, ppid: 1, uid: 501, stat: 'S', ageS: 3600, command: 'node x', ...over });

describe('parsers', () => {
  it('parseEtime reads every ps etime form', () => {
    expect(parseEtime('05')).toBeNull();
    expect(parseEtime('01:05')).toBe(65);
    expect(parseEtime('02:01:05')).toBe(7265);
    expect(parseEtime('18-02:01:05')).toBe(18 * 86400 + 7265);
    expect(parseEtime('nope')).toBeNull();
  });
  it('parsePsRows keeps the full command and skips junk', () => {
    const rows = parsePsRows(' 2909     1   501 SNs  01-17:57:19 /opt/homebrew/bin/tmux new-session -d -c /private/tmp/lv-tmp-PZoYqV/x\nbad line\n');
    expect(rows).toEqual([{ pid: 2909, ppid: 1, uid: 501, stat: 'SNs', ageS: 151039, command: '/opt/homebrew/bin/tmux new-session -d -c /private/tmp/lv-tmp-PZoYqV/x' }]);
  });
  it('parseLsofPaths groups socket paths by pid', () => {
    const m = parseLsofPaths('p669\nf6\nn/private/tmp/tmux-501/default\np2909\nf6\nn/private/tmp/lv-tmux-0B4tQs/tmux-501/default\nf7\nn->0xabc\n');
    expect(m.get(669)).toEqual(['/private/tmp/tmux-501/default']);
    expect(m.get(2909)).toEqual(['/private/tmp/lv-tmux-0B4tQs/tmux-501/default', '->0xabc']);
  });
});

describe('selectLeftovers', () => {
  const o = { prefixes: [{ prefix: RUNS, minAgeS: 0 }, { prefix: '/private/tmp/lv-', minAgeS: 0 }], selfPid: 50, uid: 501 };

  it('takes an orphaned stopped vitest worker in a run worktree, with everything under it', () => {
    const rows = [
      row({ pid: 11, stat: 'T', command: `node ${RUNS}abc123/node_modules/vitest/dist/workers/forks.js` }),
      row({ pid: 4, ppid: 1, stat: 'T', command: `node ${RUNS}abc123/node_modules/vitest/dist/child.js` }),
      row({ pid: 5, ppid: 4, command: 'sleep 60' }), // under an orphan: goes with it
      row({ pid: 3, command: '/opt/homebrew/bin/tmux new-session -d -s mine' }), // the agent's own tmux: never
    ];
    expect(selectLeftovers(rows, new Map(), o).map((r) => r.pid)).toEqual([11, 4, 5]);
    // init itself is never a candidate, even when a row claims it names a run path
    expect(selectLeftovers([row({ pid: 1, ppid: 0, command: `launchd ${RUNS}x` }), row({ pid: 9, command: 'unrelated' })], new Map(), o)).toEqual([]);
  });

  it('a process that still has its real parent is never a root, whatever its command line names (an agent session prompt)', () => {
    const rows = [
      row({ pid: 60, ppid: 1, command: 'tmux' }),
      row({ pid: 61, ppid: 60, command: 'claude -p "diagnose the failed verify, logs in /private/tmp/lv-tmp-AAA/run.log"' }),
      row({ pid: 62, ppid: 900, command: `node ${RUNS}kept1/node_modules/.bin/vitest run tests/x.test.ts` }), // a developer's run in a kept checkout
    ];
    expect(selectLeftovers(rows, new Map(), o)).toEqual([]);
  });

  it('a tmux server is matched only by its socket, never by its command line', () => {
    const rows = [row({ pid: 2, command: '/opt/homebrew/bin/tmux new-session -d -s x -c /private/tmp/lv-tmp-PZoYqV/y' })];
    expect(selectLeftovers(rows, new Map(), o)).toEqual([]);
    expect(selectLeftovers(rows, new Map([[2, ['/private/tmp/lv-tmux-Q/tmux-501/default']]]), o).map((r) => r.pid)).toEqual([2]);
  });

  it('a Linux orphan re-parented to the per-user systemd counts as an orphan', () => {
    const rows = [row({ pid: 700, ppid: 1, command: '/lib/systemd/systemd --user' }), row({ pid: 701, ppid: 700, command: `node ${RUNS}a/w.js` })];
    expect(selectLeftovers(rows, new Map(), o).map((r) => r.pid)).toEqual([701]);
  });

  it('takes a tmux server whose command line names nothing but whose socket is in a run temp folder', () => {
    const rows = [row({ pid: 7, command: 'tmux -L instar-rfa-e2e-4242 new-session -d -s crashed' }), row({ pid: 8, command: 'tmux' })];
    const socks = new Map([[7, ['/private/tmp/lv-tmux-0B4tQs/tmux-501/instar-rfa-e2e-4242']], [8, ['/private/tmp/tmux-501/default']]]);
    expect(selectLeftovers(rows, socks, o).map((r) => r.pid)).toEqual([7]);
  });

  it('never another user, a zombie, this process or any of its ancestors', () => {
    const cmd = `node ${RUNS}abc/x.js`;
    const rows = [
      row({ pid: 10, uid: 0, command: cmd }),
      row({ pid: 11, stat: 'Z', command: cmd }),
      row({ pid: 50, ppid: 40, command: cmd }), // self
      row({ pid: 40, ppid: 30, command: cmd }), // parent
      row({ pid: 30, ppid: 1, command: cmd }), // grandparent (an orphan that names a run path: still protected)
      row({ pid: 12, command: cmd }),
    ];
    expect(selectLeftovers(rows, new Map(), o).map((r) => r.pid)).toEqual([12]);
    expect([...protectedPids(rows, 50)].sort()).toEqual([30, 40, 50]);
  });

  it('applies each rule\'s age, the start-time floor, and refuses an unknown age when an age is required', () => {
    const rows = [row({ pid: 31, ageS: 100, command: '/private/tmp/lv-tmp-a/x' }), row({ pid: 32, ageS: 30_000, command: '/private/tmp/lv-tmp-a/x' }), row({ pid: 33, ageS: null, command: '/private/tmp/lv-tmp-a/x' })];
    expect(selectLeftovers(rows, new Map(), { ...o, prefixes: [{ prefix: '/private/tmp/lv-', minAgeS: 21_600 }] }).map((r) => r.pid)).toEqual([32]);
    expect(selectLeftovers(rows, new Map(), { ...o, prefixes: [{ prefix: '/private/tmp/lv-', minAgeS: 0 }], minAgeFloorS: 200 }).map((r) => r.pid)).toEqual([32]);
    expect(selectLeftovers(rows, new Map(), { ...o, prefixes: [{ prefix: '/private/tmp/lv-', minAgeS: 0 }] }).map((r) => r.pid)).toEqual([31, 32, 33]);
  });

  it('a prefix too short to name a run folder is never a rule', () => {
    expect(selectLeftovers([row({ command: '/tmp/anything' })], new Map(), { ...o, prefixes: [{ prefix: '/tmp', minAgeS: 0 }, { prefix: '/', minAgeS: 0 }] })).toEqual([]);
  });
});

describe('reapLeftovers', () => {
  function deps(ps: string | null, lsof: string | null = '') {
    const sent: Array<[number, string]> = [];
    const d: ReapDeps = { listProcesses: async () => ps, listTmuxSockets: async () => lsof, kill: (pid, sig) => { sent.push([pid, sig]); }, selfPid: 50, uid: 501 };
    return { d, sent };
  }
  it('continues then kills each leftover, and reports a bounded sample', async () => {
    const { d, sent } = deps(`  21  1 501 T 18-00:00:00 node ${RUNS}abc/w.js\n  22  1 501 S 01:00 node /elsewhere/w.js\n`);
    const r = await reapLeftovers(d, [{ prefix: RUNS, minAgeS: 0 }]);
    expect(sent).toEqual([[21, 'SIGCONT'], [21, 'SIGKILL']]);
    expect(r).toMatchObject({ matched: 1, killed: 1 });
    expect(r.sample[0]).toMatchObject({ pid: 21, stat: 'T', ageS: 18 * 86400 });
  });
  it('an unreadable process table reaps nothing; a failed kill is matched, not killed', async () => {
    expect(await reapLeftovers(deps(null).d, [{ prefix: RUNS, minAgeS: 0 }])).toEqual({ matched: 0, killed: 0, sample: [] });
    const { d } = deps(`  21  1 501 S 01:00 node ${RUNS}abc/w.js\n`);
    d.kill = () => { throw new Error('ESRCH'); };
    expect(await reapLeftovers(d, [{ prefix: RUNS, minAgeS: 0 }])).toMatchObject({ matched: 1, killed: 0 });
  });
  it('startedBeforeMs: a process that started after the sweep decision is kept', async () => {
    const { d, sent } = deps(`  21  1 501 S 00:03 node ${RUNS}abc/w.js\n  22  1 501 S 05:00 node ${RUNS}abc/w.js\n`);
    await reapLeftovers(d, [{ prefix: RUNS, minAgeS: 0 }], { startedBeforeMs: 1_000_000, now: () => 1_010_000 });
    expect(sent.map((s) => s[0])).toEqual([22, 22]);
  });
});

describe('prefix builders', () => {
  it('localVerifyRunPrefixes names the agent run worktrees and both spellings of the temp root', () => {
    expect(localVerifyRunPrefixes('/agents/echo/', '/private/tmp')).toEqual({ runs: RUNS, diagnosis: '/agents/echo/.worktrees/.verify/diagnosis/', temp: ['/private/tmp/lv-', '/tmp/lv-'] });
    expect(localVerifyRunPrefixes('/home/a', '/tmp')).toEqual({ runs: '/home/a/.worktrees/.verify/runs/', diagnosis: '/home/a/.worktrees/.verify/diagnosis/', temp: ['/tmp/lv-'] });
  });
  it('runLeftoverPrefixes covers the run worktree and every temp folder of that run only', () => {
    expect(runLeftoverPrefixes(`${RUNS}abc123`, ['/private/tmp/lv-tmp-AAA', '/private/tmp/lv-tmux-BBB/'])).toEqual([
      { prefix: `${RUNS}abc123`, minAgeS: 0 },
      { prefix: '/private/tmp/lv-tmp-AAA', minAgeS: 0 },
      { prefix: '/tmp/lv-tmp-AAA', minAgeS: 0 },
      { prefix: '/private/tmp/lv-tmux-BBB', minAgeS: 0 },
      { prefix: '/tmp/lv-tmux-BBB', minAgeS: 0 },
    ]);
  });
});

describe('unreadable tmux sockets are reported, never silent', () => {
  it('no lsof: the result says so, and command-line roots are still reaped', async () => {
    const sent: number[] = [];
    const r = await reapLeftovers({
      listProcesses: async () => `  21  1 501 S 01:00 node ${RUNS}abc/w.js\n`,
      listTmuxSockets: async () => null,
      kill: (pid) => { sent.push(pid); }, selfPid: 50, uid: 501,
    }, [{ prefix: RUNS, minAgeS: 0 }]);
    expect(r.socketsUnreadable).toBe(true);
    expect(r.matched).toBe(1);
  });
});
