/**
 * OrphanProcessReaper reads parent pids and parent commands from ONE `ps -A` listing per
 * classify pass, instead of two synchronous `ps -p` spawns per candidate (each held the
 * server's event loop on a loaded host). A pid missing from the listing falls back to the
 * per-pid query, so classification answers are unchanged. Every subprocess read is scripted.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

type Scripted = { stdout: string };
const script = { snapshot: '', calls: [] as string[] };

vi.mock('node:child_process', async (orig) => {
  const real = await orig<typeof import('node:child_process')>();
  const run = vi.fn((cmd: string, args: string[]): Scripted => {
    const line = cmd === '/bin/sh' ? args[1] : `${cmd} ${args.join(' ')}`;
    script.calls.push(line);
    if (line.startsWith('ps -A ')) return { stdout: script.snapshot };
    if (line.startsWith('ps -u ')) return { stdout: '222 500 100000 02:00:00 claude -p build the thing\n333 600 100000 02:00:00 claude -p other\n' };
    if (line.startsWith('ps -o ppid=')) return { stdout: '1\n' };
    if (line.startsWith('ps -o command=')) return { stdout: '/usr/sbin/somed\n' };
    return { stdout: '' };
  });
  const execFile = vi.fn((cmd: string, args: string[], _options: unknown,
    callback: (error: Error | null, stdout: string, stderr: string) => void) => {
    callback(null, run(cmd, args).stdout, '');
  });
  Object.defineProperty(execFile, Symbol.for('nodejs.util.promisify.custom'), {
    value: (cmd: string, args: string[], options: unknown) => new Promise((resolve, reject) => {
      execFile(cmd, args, options, (error, stdout, stderr) => {
        if (error) reject(error);
        else resolve({ stdout, stderr });
      });
    }),
  });
  return { ...real, spawnSync: run, execFile };
});

const { OrphanProcessReaper } = await import('../../src/monitoring/OrphanProcessReaper.js');
import type { InstarConfig } from '../../src/core/types.js';
import type { SessionManager } from '../../src/core/SessionManager.js';

function reaper() {
  const sm = { listKnownTmuxSessions: () => new Set<string>(), listRecordedRunningSessions: () => [], ownsLiveTmuxSessionAsync: vi.fn(async () => false) };
  return new OrphanProcessReaper({ projectName: 'proj', sessions: { tmuxPath: 'tmux' } } as unknown as InstarConfig,
    sm as unknown as SessionManager, { orphanMaxAgeMs: 60_000, autoKillOrphans: false, reportExternalProcesses: false });
}
const perPid = () => script.calls.filter((c) => c.startsWith('ps -o ppid=') || c.startsWith('ps -o command=')).length;

beforeEach(() => { script.calls = []; script.snapshot = ''; });

describe('OrphanProcessReaper — one ps listing per classify pass', () => {
  it('answers parent pid and parent command from the listing, with no per-pid spawn', async () => {
    script.snapshot = '500 1 /usr/sbin/somed\n600 1 /usr/sbin/somed\n1 0 /sbin/launchd\n';
    const report = await reaper().scan();
    expect(script.calls.filter((c) => c.startsWith('ps -A ')).length).toBe(1);
    expect(perPid()).toBe(0);
    expect(report.external.map((p) => p.pid).sort()).toEqual([222, 333]);
  });

  it('falls back to the per-pid query for a pid the listing does not have, with the same answer', async () => {
    script.snapshot = '600 1 /usr/sbin/somed\n';
    const withListing = await reaper().scan();
    expect(perPid()).toBeGreaterThan(0);
    script.calls = []; script.snapshot = '';
    const withoutListing = await reaper().scan();
    expect(withListing.external.map((p) => [p.pid, p.classification])).toEqual(withoutListing.external.map((p) => [p.pid, p.classification]));
  });
});
