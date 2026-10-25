/**
 * OrphanProcessReaper signals a process only while it is provably the one whose
 * ownership the scan established.
 *
 * - A dead pane retained by remain-on-exit keeps reporting its old pane_pid; a
 *   foreign process that later gets that pid must not be mapped to the old
 *   (genuinely owned) session, classified as an orphan, or signalled.
 * - The start time read when ownership is established is carried to the kill:
 *   an unchanged start time is signalled (SIGTERM, then SIGKILL after the
 *   grace); a changed or unreadable one is not signalled at all.
 *
 * Every subprocess read (ps, tmux, pgrep) is scripted, and process.kill is a
 * recording stub — no real process is signalled.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

type Scripted = { stdout: string };
const script = {
  panes: '',
  /** Successive answers to `ps -p <pid> -o lstart=` (the last one repeats). */
  lstart: [] as string[],
};

vi.mock('node:child_process', async (orig) => {
  const real = await orig<typeof import('node:child_process')>();
  return {
    ...real,
    spawnSync: vi.fn((cmd: string, args: string[]): Scripted => {
      if (cmd === 'ps' && args.includes('lstart=')) {
        const next = script.lstart.length > 1 ? script.lstart.shift()! : (script.lstart[0] ?? '');
        return { stdout: next };
      }
      const line = cmd === '/bin/sh' ? args[1] : `${cmd} ${args.join(' ')}`;
      if (line.startsWith('ps -u ')) return { stdout: '222 500 100000 02:00:00 claude -p build the thing\n' };
      if (line.includes('list-panes -a')) return { stdout: script.panes };
      if (line.startsWith('ps -o ppid=')) return { stdout: '1\n' };
      if (line.startsWith('ps -o command=')) return { stdout: '/usr/sbin/somed\n' };
      if (line.startsWith('pgrep')) return { stdout: '' };
      return { stdout: '' };
    }),
  };
});

const { OrphanProcessReaper } = await import('../../src/monitoring/OrphanProcessReaper.js');
import type { InstarConfig } from '../../src/core/types.js';
import type { SessionManager } from '../../src/core/SessionManager.js';

const OWNED = 'proj-job-old';
const START = 'Wed Sep 30 05:00:00 2026';

function reaper(owns = true) {
  const sm = {
    listKnownTmuxSessions: () => new Set([OWNED]),
    listRunningSessions: () => [],
    // The session under the name genuinely carries this agent's INSTAR_SESSION_ID.
    ownsLiveTmuxSession: vi.fn(() => owns),
  };
  const r = new OrphanProcessReaper(
    { projectName: 'proj', sessions: { tmuxPath: 'tmux' } } as unknown as InstarConfig,
    sm as unknown as SessionManager,
    { orphanMaxAgeMs: 60_000, autoKillOrphans: true, reportExternalProcesses: false },
  );
  return { r, sm };
}

let kill: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout'] });
  kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
  script.panes = '';
  script.lstart = [START];
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  kill.mockRestore();
});

describe('OrphanProcessReaper — retained dead pane', () => {
  it('a foreign process reusing a dead pane pid is not classified as an orphan or signalled', async () => {
    script.panes = `${OWNED}||222||1\n`;
    const { r } = reaper();
    const report = await r.scan();
    expect(report.orphans).toEqual([]);
    expect(report.external.map((p) => p.pid)).toEqual([222]);
    expect(report.external[0].tmuxSession).toBeNull();
    vi.advanceTimersByTime(6000);
    expect(kill).not.toHaveBeenCalled();
  });

  it('an indeterminate pane state (no pane_dead field) maps nothing', async () => {
    script.panes = `${OWNED}||222\n`;
    const { r } = reaper();
    const report = await r.scan();
    expect(report.orphans).toEqual([]);
    expect(kill).not.toHaveBeenCalled();
  });

  it('the same pid in a LIVE owned pane is an orphan and is reaped (SIGTERM, then SIGKILL)', async () => {
    script.panes = `${OWNED}||222||0\n`;
    const { r, sm } = reaper();
    const report = await r.scan();
    expect(report.orphans.map((p) => p.pid)).toEqual([222]);
    expect(report.orphans[0].procStart).toBe(Date.parse(START));
    expect(kill).toHaveBeenCalledWith(222, 'SIGTERM');
    // Ownership re-checked right before the terminal tmux cleanup.
    expect(sm.ownsLiveTmuxSession).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(5000);
    expect(kill).toHaveBeenCalledWith(222, 'SIGKILL');
  });
});

describe('OrphanProcessReaper — identity carried from ownership to the kill', () => {
  it('a start time that changed after ownership was established: no signal at all', async () => {
    script.panes = `${OWNED}||222||0\n`;
    // Classification reads START; by kill time the pid runs a later process.
    script.lstart = [START, 'Wed Sep 30 06:00:00 2026'];
    const { r } = reaper();
    const report = await r.scan();
    expect(report.actionsPerformed.join('\n')).toMatch(/Skipped orphan PID 222/);
    vi.advanceTimersByTime(6000);
    expect(kill).not.toHaveBeenCalled();
  });

  it('an unreadable start time never authorizes SIGTERM', async () => {
    script.panes = `${OWNED}||222||0\n`;
    script.lstart = [''];
    const { r } = reaper();
    const report = await r.scan();
    expect(report.orphans[0].procStart).toBeNull();
    vi.advanceTimersByTime(6000);
    expect(kill).not.toHaveBeenCalled();
  });

  it('the explicit operator-requested kill of a listed external pid stays available', async () => {
    script.panes = `${OWNED}||222||1\n`;
    const { r } = reaper();
    await r.scan();
    expect(r.killExternalProcess(222).success).toBe(true);
    expect(kill).toHaveBeenCalledWith(222, 'SIGTERM');
  });
});
