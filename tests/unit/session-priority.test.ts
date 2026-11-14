/**
 * C3 (trustworthy-machine-load, carried into P3): sessions run at nice 5 while
 * admission is enforced; the server is never touched. Each pane process group is
 * reniced once with the absolute form; inactive does nothing; failures are counted
 * and not retried every pass; a respawned session (new pane pid) is lowered again.
 */
import { describe, it, expect } from 'vitest';
import { SessionPriorityLowerer, SESSION_NICE } from '../../src/core/sessionPriority.js';

function rig(opts: { active?: boolean; sessions?: string[]; pids?: Record<string, number>; reniceFails?: boolean } = {}) {
  const calls: Array<[string, string[]]> = [];
  const pids = { ...(opts.pids ?? { 'echo-a': 1234 }) };
  const state = { active: opts.active ?? true, sessions: opts.sessions ?? ['echo-a'] };
  const lowerer = new SessionPriorityLowerer({
    active: () => state.active,
    tmuxPath: 'tmux',
    runningSessions: () => state.sessions,
    run: async (file, args) => {
      calls.push([file, args]);
      if (file === 'tmux') { const name = args[3].slice(1, -1); if (!(name in pids)) throw new Error('no session'); return `${pids[name]}\n`; }
      if (opts.reniceFails) throw new Error('permission denied');
      return '';
    },
  });
  return { lowerer, calls, pids, state };
}

describe('SessionPriorityLowerer (C3)', () => {
  it('renices each session pane process group once with the absolute nice value', async () => {
    const r = rig();
    await r.lowerer.tick();
    await r.lowerer.tick();
    const renices = r.calls.filter(([f]) => f === 'renice');
    expect(renices).toEqual([['renice', [String(SESSION_NICE), '-g', '1234']]]);
    expect(r.lowerer.status()).toMatchObject({ active: true, nice: 5, lowered: 1, failed: 0, tracked: 1 });
  });

  it('does nothing while admission is not enforced (dry-run / dark)', async () => {
    const r = rig({ active: false });
    await r.lowerer.tick();
    expect(r.calls).toEqual([]);
  });

  it('a respawned session (new pane pid) is lowered again; an ended one is forgotten', async () => {
    const r = rig();
    await r.lowerer.tick();
    r.pids['echo-a'] = 5678;
    await r.lowerer.tick();
    expect(r.calls.filter(([f]) => f === 'renice').map(([, a]) => a[2])).toEqual(['1234', '5678']);
    r.state.sessions = [];
    await r.lowerer.tick();
    expect(r.lowerer.status().tracked).toBe(0);
  });

  it('a failed renice is counted, logged and not retried every pass; a vanished session is skipped', async () => {
    const r = rig({ reniceFails: true, sessions: ['echo-a', 'gone'] });
    await r.lowerer.tick();
    await r.lowerer.tick();
    expect(r.calls.filter(([f]) => f === 'renice')).toHaveLength(1);
    expect(r.lowerer.status()).toMatchObject({ lowered: 0, failed: 1 });
  });
});
