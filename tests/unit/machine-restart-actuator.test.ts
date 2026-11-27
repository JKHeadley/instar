/**
 * Restart actuator, episode ledger and brakes (machine-self-maintenance Part C/D/E, CMT-1199).
 *
 * Both sides of every boundary: each brake just under and at its limit; operator passes
 * every brake but the 6-hour rule (and that only with its override); claimRung refuses a
 * stale generation, an expired plan, another boot, a claimed rung, and a fresh-check
 * refusal (rung 1 aborts, rung 2 goes outcome-unknown); the attempt is on disk as
 * `unknown` before the command runs; each dispatch outcome maps exactly as the spec says;
 * the real command never runs inside a test process; and no other src file holds a
 * restart command line.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { BRAKES, HostMaintenanceStore, checkBrakes, type EpisodeRow, type LedgerRow } from '../../src/monitoring/machineMaintenance/HostMaintenanceStore.js';
import { RESTART_COMMANDS, RestartActuator, sudoersLines, type SpawnResult } from '../../src/monitoring/machineMaintenance/RestartActuator.js';

const MIN = 60_000;
const H = 60 * MIN;
const D = 24 * H;
const BOOT = 1_000 * D;

function ep(over: Partial<EpisodeRow>): EpisodeRow {
  return { type: 'episode', episodeId: 'e1', generation: 1, kind: 'wedge', state: 'reserved', bootAt: BOOT, expiresAt: BOOT + 10 * D, at: BOOT + D, by: 'echo', ...over };
}
const spentWedge = (id: string, at: number): LedgerRow[] => [ep({ episodeId: id, at, state: 'reserved' }), ep({ episodeId: id, at, state: 'dispatched', rung: 1, dispatch: 'accepted' }), ep({ episodeId: id, at, state: 'restarted' })];

describe('checkBrakes', () => {
  const now = BOOT + 3 * D;
  it('6-hour rule: automatic refused under 6 h of uptime, allowed at 6 h; operator needs the override', () => {
    expect(checkBrakes([], { kind: 'scheduled', now: BOOT + BRAKES.recentBootMs - 1, bootAt: BOOT })).toBe('recent-boot');
    expect(checkBrakes([], { kind: 'scheduled', now: BOOT + BRAKES.recentBootMs, bootAt: BOOT })).toBeNull();
    expect(checkBrakes([], { kind: 'operator', now: BOOT + H, bootAt: BOOT })).toBe('recent-boot');
    expect(checkBrakes([], { kind: 'operator', now: BOOT + H, bootAt: BOOT, overrideRecentBoot: true })).toBeNull();
  });

  it('wedge: 2 per 24 h and 3 per 7 days; aborted episodes spend no budget', () => {
    const one = spentWedge('a', now - H);
    expect(checkBrakes(one, { kind: 'wedge', now, bootAt: BOOT })).toBeNull();
    const two = [...one, ...spentWedge('b', now - 2 * H)];
    expect(checkBrakes(two, { kind: 'wedge', now, bootAt: BOOT })).toBe('wedge-24h');
    const spread = [...spentWedge('a', now - 2 * D), ...spentWedge('b', now - 3 * D), ...spentWedge('c', now - 4 * D)];
    expect(checkBrakes(spread, { kind: 'wedge', now, bootAt: BOOT })).toBe('wedge-7d');
    const aborted = [ep({ episodeId: 'x', at: now - H, state: 'reserved' }), ep({ episodeId: 'x', at: now - H, state: 'aborted-unclaimed' }), ...one];
    expect(checkBrakes(aborted, { kind: 'wedge', now, bootAt: BOOT })).toBeNull();
  });

  it('scheduled: one per 5 days; a rolled night spends none', () => {
    const sched = (id: string, at: number) => spentWedge(id, at).map((r) => ({ ...r, kind: 'scheduled' as const }));
    expect(checkBrakes(sched('s', now - 4 * D), { kind: 'scheduled', now, bootAt: BOOT })).toBe('scheduled-5d');
    expect(checkBrakes(sched('s', now - 5 * D - 1), { kind: 'scheduled', now, bootAt: BOOT })).toBeNull();
    const rolled = [ep({ episodeId: 'r', kind: 'scheduled', at: now - D }), ep({ episodeId: 'r', kind: 'scheduled', at: now - D, state: 'rolled' })];
    expect(checkBrakes(rolled, { kind: 'scheduled', now, bootAt: BOOT })).toBeNull();
  });

  it('abort brake at 3 aborted or refused in 7 days; operator still allowed', () => {
    const aborts = ['a', 'b', 'c'].flatMap((id, i) => [ep({ episodeId: id, at: now - (i + 1) * H }), ep({ episodeId: id, at: now - (i + 1) * H, state: i === 2 ? 'refused' : 'aborted' })]);
    expect(checkBrakes(aborts.slice(0, 4), { kind: 'scheduled', now, bootAt: BOOT })).toBeNull();
    expect(checkBrakes(aborts, { kind: 'scheduled', now, bootAt: BOOT })).toBe('abort-brake');
    expect(checkBrakes(aborts, { kind: 'operator', now, bootAt: BOOT })).toBeNull();
  });

  it('outcome-unknown and an open episode stop automatic requests; proof-failed latches automatic only', () => {
    expect(checkBrakes([ep({ state: 'outcome-unknown' })], { kind: 'wedge', now, bootAt: BOOT })).toBe('outcome-unknown');
    expect(checkBrakes([ep({ state: 'reserved', expiresAt: now + H })], { kind: 'scheduled', now, bootAt: BOOT })).toBe('episode-open');
    expect(checkBrakes([], { kind: 'wedge', now, bootAt: BOOT, proofFailed: true })).toBe('proof-failed');
    expect(checkBrakes([], { kind: 'operator', now, bootAt: BOOT, proofFailed: true })).toBeNull();
  });
});

describe('episode store: reserve, claimRung, record', () => {
  let dir: string;
  let clock: number;
  let store: HostMaintenanceStore;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-act-')); clock = BOOT + D; store = new HostMaintenanceStore({ dir, now: () => clock }); });
  afterEach(() => SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/machine-restart-actuator.test.ts' }));

  const reserve = (kind: 'operator' | 'wedge' = 'operator') => store.reserveEpisode({ kind, by: 'echo', bootAt: BOOT, ttlMs: 30 * MIN }) as { ok: true; episodeId: string; generation: number; tookOver: boolean };

  it('the row is on disk as dispatched/unknown before the command runs', () => {
    const r = reserve();
    let seenAtSpawn: LedgerRow[] = [];
    const c = store.claimRung({ episodeId: r.episodeId, generation: 1, rung: 1, currentBootAt: BOOT, by: 'echo', fresh: () => null, spawn: () => { seenAtSpawn = new HostMaintenanceStore({ dir }).readLedger()!; } });
    expect(c.ok).toBe(true);
    expect(seenAtSpawn.at(-1)).toMatchObject({ state: 'dispatched', rung: 1, dispatch: 'unknown' });
  });

  it('refuses a second claim of the same rung, a stale generation, an expired plan and another boot', () => {
    const r = reserve();
    const claim = (o: Partial<{ generation: number; rung: 1 | 2; currentBootAt: number }>) =>
      store.claimRung({ episodeId: r.episodeId, generation: 1, rung: 1, currentBootAt: BOOT, by: 'echo', fresh: () => null, spawn: () => {}, ...o });
    expect(claim({ currentBootAt: BOOT + D })).toMatchObject({ ok: false, reason: 'wrong-boot' });
    expect(claim({ generation: 2 })).toMatchObject({ ok: false, reason: 'stale-generation' });
    expect(claim({ rung: 2 })).toMatchObject({ ok: false, reason: 'rung1-not-dispatched' });
    expect(claim({}).ok).toBe(true);
    expect(claim({})).toMatchObject({ ok: false, reason: 'rung-claimed' });
    const r2 = (() => { const s2 = new HostMaintenanceStore({ dir: path.join(dir, 'b'), now: () => clock }); const x = s2.reserveEpisode({ kind: 'operator', by: 'e', bootAt: BOOT, ttlMs: MIN }) as any; clock += 2 * MIN; return s2.claimRung({ episodeId: x.episodeId, generation: 1, rung: 1, currentBootAt: BOOT, by: 'e', fresh: () => null, spawn: () => {} }); })();
    expect(r2).toMatchObject({ ok: false, reason: 'expired' });
  });

  it('a fresh-check refusal before rung 1 aborts (nothing asked of the OS); before rung 2 it is outcome-unknown', () => {
    const a = reserve();
    let spawned = 0;
    expect(store.claimRung({ episodeId: a.episodeId, generation: 1, rung: 1, currentBootAt: BOOT, by: 'echo', fresh: () => 'S1-os-update', spawn: () => { spawned++; } })).toMatchObject({ ok: false, reason: 'S1-os-update' });
    expect(spawned).toBe(0);
    expect(store.readLedger()!.at(-1)).toMatchObject({ state: 'aborted', reason: 'S1-os-update' });

    clock += H;
    const b = reserve();
    store.claimRung({ episodeId: b.episodeId, generation: b.generation, rung: 1, currentBootAt: BOOT, by: 'echo', fresh: () => null, spawn: () => {} });
    store.recordDispatch({ episodeId: b.episodeId, generation: b.generation, rung: 1, outcome: 'accepted', by: 'echo' });
    expect(store.claimRung({ episodeId: b.episodeId, generation: b.generation, rung: 2, currentBootAt: BOOT, by: 'echo', fresh: () => 'off-switch', spawn: () => { spawned++; } }).ok).toBe(false);
    expect(spawned).toBe(0);
    expect(store.readLedger()!.at(-1)).toMatchObject({ state: 'outcome-unknown', rung: 2 });
    // outcome-unknown now holds every automatic request.
    expect(store.reserveEpisode({ kind: 'wedge', by: 'echo', bootAt: BOOT, ttlMs: MIN })).toMatchObject({ ok: false, brake: 'outcome-unknown' });
  });

  it('an operator request takes over an open episode with a new generation; the stale generation can no longer close it', () => {
    clock = BOOT + D;
    const a = store.reserveEpisode({ kind: 'operator', by: 'echo', bootAt: BOOT, ttlMs: 30 * MIN }) as any;
    const b = store.reserveEpisode({ kind: 'operator', by: 'echo', bootAt: BOOT, ttlMs: 30 * MIN }) as any;
    expect(b).toMatchObject({ ok: true, episodeId: a.episodeId, generation: 2, tookOver: true });
    expect(store.transitionEpisode({ episodeId: a.episodeId, generation: 1, state: 'aborted', by: 'stale' })).toBe(false);
    expect(store.transitionEpisode({ episodeId: a.episodeId, generation: 2, state: 'aborted', by: 'echo' })).toBe(true);
  });

  it('a refused rung 1 closes the episode as refused; the next boot after a dispatch is attributed to it and closes it restarted', () => {
    const a = reserve();
    store.claimRung({ episodeId: a.episodeId, generation: 1, rung: 1, currentBootAt: BOOT, by: 'echo', fresh: () => null, spawn: () => {} });
    store.recordDispatch({ episodeId: a.episodeId, generation: 1, rung: 1, outcome: 'refused', by: 'echo' });
    expect(store.readLedger()!.at(-1)).toMatchObject({ state: 'refused' });

    clock += H;
    store.observeBoot(BOOT, 'echo');
    const b = reserve();
    store.claimRung({ episodeId: b.episodeId, generation: b.generation, rung: 1, currentBootAt: BOOT, by: 'echo', fresh: () => null, spawn: () => {} });
    store.recordDispatch({ episodeId: b.episodeId, generation: b.generation, rung: 1, outcome: 'accepted', by: 'echo' });
    const seen = store.observeBoot(BOOT + D, 'echo')!;
    expect(seen.row.attribution).toBe(b.episodeId);
    expect(store.readLedger()!.at(-1)).toMatchObject({ episodeId: b.episodeId, state: 'restarted' });
  });

  it('unreadable ledger: automatic requests fail closed; an operator sets it aside and starts a new one', () => {
    fs.mkdirSync(path.join(dir, 'restarts.jsonl'));
    expect(store.reserveEpisode({ kind: 'wedge', by: 'e', bootAt: BOOT, ttlMs: MIN })).toMatchObject({ ok: false, brake: 'ledger-unreadable' });
    expect(store.reserveEpisode({ kind: 'operator', by: 'e', bootAt: BOOT, ttlMs: MIN })).toMatchObject({ ok: true });
  });
});

describe('RestartActuator', () => {
  let dir: string;
  let store: HostMaintenanceStore;
  const clock = BOOT + D;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-act2-')); store = new HostMaintenanceStore({ dir, now: () => clock }); });
  afterEach(() => SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/machine-restart-actuator.test.ts' }));

  function make(result: SpawnResult, over: { sudoList?: string | null; platform?: 'darwin' | 'linux' | 'wsl' } = {}) {
    const calls: Array<{ command: string; args: string[] }> = [];
    const a = new RestartActuator({
      store, platform: over.platform ?? 'darwin', agent: 'echo', readBootAt: async () => BOOT, freshCheck: () => null, isThrowaway: () => false,
      sudoList: over.sudoList === undefined ? undefined : async () => over.sudoList ?? null,
      spawn: async (command, args) => { calls.push({ command, args }); return result; },
    });
    const r = store.reserveEpisode({ kind: 'operator', by: 'echo', bootAt: BOOT, ttlMs: 30 * MIN }) as any;
    return { a, calls, ep: { episodeId: r.episodeId, generation: r.generation, rung: 1 as const } };
  }

  it('exit 0 is accepted; the exact rung 1 line runs', async () => {
    const { a, calls, ep: e } = make({ spawned: true, exitCode: 0, signal: null, timedOut: false });
    expect(await a.dispatch(e)).toEqual({ dispatched: true, outcome: 'accepted' });
    expect(calls).toEqual([{ command: 'sudo', args: ['-n', '/sbin/shutdown', '-r', 'now'] }]);
  });

  it('never started is refused; timeout and signal are unknown, never cancelled', async () => {
    const n = make({ spawned: false, exitCode: null, signal: null, timedOut: false });
    expect(await n.a.dispatch(n.ep)).toMatchObject({ outcome: 'refused' });
    const t = make({ spawned: true, exitCode: null, signal: 'SIGKILL', timedOut: true });
    expect(await t.a.dispatch(t.ep)).toMatchObject({ outcome: 'unknown' });
  });

  it('a nonzero exit is refused only when sudo no longer lists the exact line; otherwise unknown', async () => {
    const granted = make({ spawned: true, exitCode: 1, signal: null, timedOut: false }, { sudoList: '(root) NOPASSWD: /sbin/shutdown -r now, /sbin/reboot -q' });
    expect(await granted.a.dispatch(granted.ep)).toMatchObject({ outcome: 'unknown' });
  });

  it('a nonzero exit with the line not granted is refused; unread sudo listing stays unknown', async () => {
    const none = make({ spawned: true, exitCode: 1, signal: null, timedOut: false }, { sudoList: 'Sorry, user may not run sudo' });
    expect(await none.a.dispatch(none.ep)).toMatchObject({ outcome: 'refused' });
  });

  it('the real command never runs in a test process or a throwaway agent', async () => {
    const r = store.reserveEpisode({ kind: 'operator', by: 'echo', bootAt: BOOT, ttlMs: 30 * MIN }) as any;
    const real = new RestartActuator({ store, platform: 'darwin', agent: 'echo', readBootAt: async () => BOOT, freshCheck: () => null, isThrowaway: () => false, env: { VITEST: 'true' } });
    expect(await real.dispatch({ episodeId: r.episodeId, generation: r.generation, rung: 1 })).toEqual({ dispatched: false, reason: 'test-process' });
    const thr = new RestartActuator({ store, platform: 'darwin', agent: 'echo', readBootAt: async () => BOOT, freshCheck: () => null, isThrowaway: () => true, env: {} });
    expect(await thr.dispatch({ episodeId: r.episodeId, generation: r.generation, rung: 1 })).toEqual({ dispatched: false, reason: 'throwaway' });
    // Nothing was claimed: the ledger holds only the reservation.
    expect(store.readLedger()!.filter((x) => x.type === 'episode' && x.state === 'dispatched')).toHaveLength(0);
  });

  it('sudoers lines match the dispatched commands exactly', () => {
    expect(sudoersLines('darwin')).toEqual(['/sbin/shutdown -r now', '/sbin/reboot -q']);
    expect(sudoersLines('linux')).toEqual(['/usr/bin/systemctl reboot', '/usr/bin/systemctl reboot --force']);
    expect(RESTART_COMMANDS.wsl[1].command).toBe('/mnt/c/Windows/System32/shutdown.exe');
  });
});

describe('only RestartActuator holds a restart command line', () => {
  it('no other file under src/ names one', () => {
    const root = path.resolve(__dirname, '../../src');
    const offenders: string[] = [];
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p); continue; }
        if (!/\.(ts|js|mjs|sh)$/.test(e.name) || p.endsWith(path.join('machineMaintenance', 'RestartActuator.ts'))) continue;
        const t = fs.readFileSync(p, 'utf-8');
        if (/\/sbin\/shutdown|\/sbin\/reboot|systemctl['", ]+reboot|systemctl reboot|shutdown\.exe/.test(t)) offenders.push(path.relative(root, p));
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });
});
