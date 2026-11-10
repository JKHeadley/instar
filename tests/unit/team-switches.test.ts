/**
 * TeamSwitches (docs/specs/team-switches-agent-wide.md): one line per setting for the whole agent,
 * and one tap that reaches every machine, reports each one, and retries a machine that did not answer.
 */
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  PENDING_MAX_AGE_MS, PeerLacksSwitchRoute, PeerRefusedSwitch, PeerSwitchFailed, TeamSwitchApplier, teamSwitchSummary,
  isTeamSwitchSetting, type SwitchPeer, type TeamSwitchSetting,
} from '../../src/core/TeamSwitches.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/unit/team-switches.test.ts' }); });
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'team-switches-')); dirs.push(d); return d; };

const good = { enforcement: 1, native: true, privacy: true };

describe('teamSwitchSummary', () => {
  it('gives one line per setting with every machine it is off on, not one line per machine', () => {
    const lines = teamSwitchSummary([
      { machineId: 'studio', standing: good },
      { machineId: 'mini', standing: { ...good, privacy: false } },
      { machineId: 'laptop', standing: { ...good, privacy: false } },
      { machineId: 'mama', standing: { ...good, native: false } },
      { machineId: 'm5', standing: { ...good, native: false } },
    ]);
    expect(lines).toEqual([
      { setting: 'app-conversations', on: false, offOn: ['mama', 'm5'], action: 'turn-on-everywhere', requested: [] },
      { setting: 'memory-privacy', on: false, offOn: ['mini', 'laptop'], action: 'turn-on-everywhere', requested: [] },
    ]);
  });

  it('lists an older build only under build, with update as its action', () => {
    expect(teamSwitchSummary([{ machineId: 'old', standing: { enforcement: 0, native: false, privacy: false } }]))
      .toEqual([{ setting: 'build', on: false, offOn: ['old'], action: 'update', requested: [] }]);
  });

  it('is empty when every machine has everything on', () => {
    expect(teamSwitchSummary([{ machineId: 'a', standing: good }, { machineId: 'b', standing: good }])).toEqual([]);
  });

  it('marks the machines already asked', () => {
    const [line] = teamSwitchSummary([{ machineId: 'a', standing: { ...good, privacy: false } }, { machineId: 'b', standing: { ...good, privacy: false } }], [{ setting: 'memory-privacy', machineId: 'b' }]);
    expect(line.requested).toEqual(['b']);
  });

  it('keeps a machine owed the request on the line even when no standing has been heard from it', () => {
    const [line] = teamSwitchSummary([{ machineId: 'studio', standing: good }], [{ setting: 'memory-privacy', machineId: 'mama' }]);
    expect(line).toEqual({ setting: 'memory-privacy', on: false, offOn: ['mama'], action: 'turn-on-everywhere', requested: ['mama'] });
  });

  it('knows its two settings and nothing else', () => {
    expect(isTeamSwitchSetting('memory-privacy')).toBe(true);
    expect(isTeamSwitchSetting('app-conversations')).toBe(true);
    expect(isTeamSwitchSetting('build')).toBe(false);
    expect(isTeamSwitchSetting('memoryPrivacy.enabled')).toBe(false);
  });
});

function peer(machineId: string, behave: () => Promise<{ changed: boolean; restarting: boolean }>): SwitchPeer & { calls: TeamSwitchSetting[] } {
  const calls: TeamSwitchSetting[] = [];
  return { machineId, calls, turnOn: async (s) => { calls.push(s); return behave(); } };
}

describe('TeamSwitchApplier', () => {
  it('sends the setting to every peer, then this machine, and reports each one', async () => {
    const order: string[] = [];
    const a = peer('mini', async () => { order.push('mini'); return { changed: true, restarting: true }; });
    const b = peer('laptop', async () => { order.push('laptop'); return { changed: false, restarting: false }; });
    const applier = new TeamSwitchApplier({
      selfMachineId: () => 'studio', peers: () => [a, b],
      applyLocal: () => { order.push('studio'); return { changed: true, restarting: true }; },
    });
    const r = await applier.turnOn('memory-privacy');
    expect(order.at(-1)).toBe('studio'); // this machine's restart cannot cut the requests short
    expect(a.calls).toEqual(['memory-privacy']);
    expect(r.machines).toEqual([
      { machineId: 'mini', self: false, outcome: 'applied', result: 'applied', restarting: true, willRetry: false },
      { machineId: 'laptop', self: false, outcome: 'already-on', result: 'already-on', restarting: false, willRetry: false },
      { machineId: 'studio', self: true, outcome: 'applied', result: 'applied', restarting: true, willRetry: false },
    ]);
    expect(applier.pending()).toEqual([]);
  });

  it('lists an unreachable peer, keeps it on file, and retries it until it answers', async () => {
    let t = 1_000_000;
    let up = false;
    const file = path.join(tmp(), 'sub', 'switch-requests.json');
    const errors: unknown[] = [];
    const laptop = peer('laptop', async () => { if (!up) throw new Error('ECONNREFUSED'); return { changed: true, restarting: true }; });
    const deps = { selfMachineId: () => 'studio', peers: () => [laptop], applyLocal: () => ({ changed: false, restarting: false }), file, now: () => t, reportError: (e: unknown) => errors.push(e) };
    const applier = new TeamSwitchApplier(deps);
    const r = await applier.turnOn('app-conversations');
    expect(r.machines[0]).toEqual({ machineId: 'laptop', self: false, outcome: 'unreachable', result: 'unreachable', restarting: false, willRetry: true });
    expect(r.machines[1]).toMatchObject({ self: true, outcome: 'already-on' });
    expect(errors).toHaveLength(1);
    // A restart of this machine does not forget it.
    const again = new TeamSwitchApplier(deps);
    expect(again.pending()).toEqual([expect.objectContaining({ setting: 'app-conversations', machineId: 'laptop', attempts: 1 })]);
    // Too soon: waits.
    t += 10_000;
    expect(await again.retryPending()).toEqual([]);
    t += 60_000;
    expect((await again.retryPending())[0].outcome).toBe('unreachable');
    expect(again.pending()[0].attempts).toBe(2);
    up = true;
    t += 120_000;
    expect((await again.retryPending())[0]).toMatchObject({ outcome: 'applied', willRetry: false });
    expect(again.pending()).toEqual([]);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual([]);
  });

  it('a machine known to the agent but with no address right now is listed and owed the request', async () => {
    const applier = new TeamSwitchApplier({
      selfMachineId: () => 'studio', peers: () => [], knownMachines: () => ['studio', 'mama'],
      applyLocal: () => ({ changed: true, restarting: true }),
    });
    const r = await applier.turnOn('memory-privacy');
    expect(r.machines.map((m) => [m.machineId, m.outcome])).toEqual([['mama', 'unreachable'], ['studio', 'applied']]);
    expect(applier.pending().map((p) => p.machineId)).toEqual(['mama']);
  });

  it('an older build needs updating and is still retried; a refusal is not', async () => {
    const old = peer('old', async () => { throw new PeerLacksSwitchRoute('old'); });
    const no = peer('no', async () => { throw new PeerRefusedSwitch('no'); });
    const applier = new TeamSwitchApplier({ selfMachineId: () => 's', peers: () => [old, no], applyLocal: () => ({ changed: false, restarting: false }) });
    const r = await applier.turnOn('memory-privacy');
    expect(r.machines.slice(0, 2).map((m) => [m.outcome, m.willRetry])).toEqual([['needs-update', true], ['refused', false]]);
    expect(applier.pending().map((p) => p.machineId)).toEqual(['old']);
  });

  it('this machine failing is reported as failed, never hidden', async () => {
    const applier = new TeamSwitchApplier({ selfMachineId: () => 's', peers: () => [], applyLocal: () => { throw new Error('no restart'); } });
    expect((await applier.turnOn('memory-privacy')).machines).toEqual([{ machineId: 's', self: true, outcome: 'failed', result: 'failed', restarting: false, willRetry: false }]);
  });

  it('drops a request once the machine reports the setting on, or after the retry window', async () => {
    let t = 0;
    let on = false;
    const laptop = peer('laptop', async () => { throw new Error('down'); });
    const applier = new TeamSwitchApplier({ selfMachineId: () => 's', peers: () => [laptop], applyLocal: () => ({ changed: false, restarting: false }), reportsOn: () => on, now: () => t });
    await applier.turnOn('memory-privacy');
    on = true;
    t += 120_000;
    await applier.retryPending();
    expect(applier.pending()).toEqual([]);
    expect(laptop.calls).toHaveLength(1);
    on = false;
    await applier.turnOn('memory-privacy');
    t += PENDING_MAX_AGE_MS + 1;
    await applier.retryPending();
    expect(applier.pending()).toEqual([]);
  });

  it('a peer that answered but failed is failed, not unreachable, and is retried', async () => {
    const bad = peer('bad', async () => { throw new PeerSwitchFailed('bad'); });
    const applier = new TeamSwitchApplier({ selfMachineId: () => 's', peers: () => [bad], applyLocal: () => ({ changed: false, restarting: false }) });
    const r = await applier.turnOn('memory-privacy');
    expect(r.machines[0]).toMatchObject({ outcome: 'failed', willRetry: true });
    expect(applier.pending().map((p) => p.machineId)).toEqual(['bad']);
  });

  it('a machine that applied it and is restarting stays asked until it reports on, and the owner device is passed along', async () => {
    let on = false;
    const seen: Array<string | null | undefined> = [];
    const mini: SwitchPeer = { machineId: 'mini', turnOn: async (_s, by) => { seen.push(by); return { changed: true, restarting: true }; } };
    const applier = new TeamSwitchApplier({ selfMachineId: () => 'studio', peers: () => [mini], applyLocal: () => ({ changed: false, restarting: false }), reportsOn: (_s, id) => on && id === 'mini' });
    await applier.turnOn('memory-privacy', 'owner-device-1');
    expect(seen).toEqual(['owner-device-1']);
    expect(applier.pending()).toEqual([]);
    expect(applier.requested()).toEqual([{ setting: 'memory-privacy', machineId: 'mini' }]);
    on = true;
    expect(applier.requested()).toEqual([]);
  });
});
