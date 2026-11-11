import { describe, expect, it } from 'vitest';
// @ts-expect-error — plain ES module from the dashboard
import { buildAutoRepair, configurePayload, resultWords, confirmation } from '../../dashboard/console/auto-repair-model.js';

// spec one-tap-unattended-repair §6 — the Accounts page section model.
const cfg = (machineId: string, mode: string, ids: string[], pool: string[] | null, extra: Record<string, unknown> = {}) => ({
  machineId, mode, identities: ids, verifiedPoolEmails: pool, minimumSuccessfulRepairs: 0, minimumEvidenceDays: 0,
  revision: `sha256:${machineId.padEnd(64, '0').slice(0, 64)}`, activationPending: false, ...extra,
});
const read = (configs: unknown[], extra: Record<string, unknown> = {}) => ({ ok: true, data: { pool: { configs, configsMissing: [], failed: [], ...extra } } });

describe('auto-repair section model', () => {
  it('starts ticked only where already unattended; ANY readable machine can be ticked from any dashboard (operator 2026-11-10)', () => {
    const m = buildAutoRepair(read([
      cfg('self', 'off', [], ['a@x.io'], { remote: false, machineNickname: 'Studio' }),
      cfg('peerU', 'unattended', ['a@x.io'], ['a@x.io', 'b@x.io'], { remote: true, machineNickname: 'Mama PC' }),
      cfg('peerA', 'approval', ['a@x.io'], ['a@x.io'], { remote: true, machineNickname: 'Mac Mini' }),
      cfg('peerOff', 'off', [], ['a@x.io'], { remote: true, machineNickname: 'M5 Pro' }),
    ]));
    const by = Object.fromEntries(m.rows.map((r: any) => [r.machineId, r]));
    expect(m.rows[0].machineId).toBe('self');
    expect(by.self).toMatchObject({ canTurnOn: true, defaultTick: false, stateWords: 'Off' });
    expect(by.peerU).toMatchObject({ canTurnOn: true, defaultTick: true, uncovered: ['b@x.io'] });
    // Another machine that asks first or is off: tickable here, unticked by default, no "only from
    // that machine" reason.
    expect(by.peerA).toMatchObject({ canTurnOn: true, defaultTick: false, blockedWhy: null });
    expect(by.peerOff).toMatchObject({ canTurnOn: true, canSwitchBack: false, defaultTick: false, blockedWhy: null });
  });

  it('marks removals, shows remote waits, and never shows a raw machine id', () => {
    const m = buildAutoRepair(read([cfg('m_abc123', 'unattended', ['a@x.io', 'gone@x.io'], ['a@x.io'], { remote: true, minimumSuccessfulRepairs: 10, minimumEvidenceDays: 30 })]));
    const r = m.rows[0];
    expect(r.removals).toEqual(['gone@x.io']);
    expect(r.waitsLine).toMatch(/10 repairs \/ 30 days/);
    expect(r.name).not.toContain('m_abc123');
  });

  it('older and unreachable machines are listed but cannot be ticked', () => {
    const m = buildAutoRepair(read([], { configsMissing: ['old'], failed: [{ machineId: 'gone', error: 'timeout' }] }), { names: { old: 'Laptop' } });
    expect(m.rows.find((r: any) => r.machineId === 'old').unreadable).toBe('Needs an Instar update first');
    // CMT-1541: no /pool evidence → says plainly that how long and whether anything is fixing it are not known.
    expect(m.rows.find((r: any) => r.machineId === 'gone').unreadable).toBe("Couldn't reach a machine with no name yet (for how long is not known); not known whether anything is fixing it.");
  });

  it('an unreachable machine says how long and whether anything is fixing it (CMT-1541)', () => {
    const now = Date.parse('2026-11-09T12:00:00Z');
    const pool = { ok: true, data: { machines: [
      { machineId: 'lap', nickname: 'Laptop', liveness: { state: 'unreachable', source: 'direct', evidenceAt: '2026-11-09T11:48:00Z' }, reconnect: { state: 'retrying' } },
    ] } };
    const m = buildAutoRepair(read([], { failed: [{ machineId: 'lap', error: 'timeout' }] }), { names: { lap: 'Laptop' }, poolMachines: pool, now });
    expect(m.rows[0].unreadable).toBe("Couldn't reach Laptop for 12 min; reconnecting by itself.");
  });

  it('no result reads as "only from that machine itself"; an older machine or older issuer reads as needing an update', () => {
    for (const error of ['owner-must-enable-here', 'operator-unlock-missing']) {
      const words = resultWords({ ok: false, error });
      expect(words).not.toMatch(/only be switched on from that machine itself/);
      expect(words).toMatch(/Instar update/);
    }
  });

  it('rows this page cannot change carry no tick-box permission: unreadable accounts or no accounts', () => {
    const m = buildAutoRepair(read([
      cfg('peerNull', 'approval', ['a@x.io'], null, { remote: true, machineNickname: 'Mac Mini' }),
      cfg('peerEmpty', 'off', [], [], { remote: true, machineNickname: 'Laptop' }),
    ]));
    const by = Object.fromEntries(m.rows.map((r: any) => [r.machineId, r]));
    expect(by.peerNull).toMatchObject({ canTurnOn: false, canSwitchBack: false, defaultTick: false });
    expect(by.peerEmpty).toMatchObject({ canTurnOn: false, canSwitchBack: false, blockedWhy: 'No accounts on this machine yet.' });
  });

  it('builds the exact request: turning any machine on sets 0/0, a machine already on keeps its waits; approval keeps list and waits', () => {
    const m = buildAutoRepair(read([
      cfg('self', 'approval', ['a@x.io'], ['a@x.io', 'b@x.io'], { remote: false, minimumSuccessfulRepairs: 10, minimumEvidenceDays: 30 }),
      cfg('peer', 'unattended', ['a@x.io'], ['a@x.io', 'b@x.io'], { remote: true, minimumSuccessfulRepairs: 5, minimumEvidenceDays: 7 }),
      cfg('peerOff', 'off', [], ['c@x.io'], { remote: true, minimumSuccessfulRepairs: 10, minimumEvidenceDays: 30 }),
    ]));
    const on = configurePayload(m.rows, new Set(['self', 'peer', 'peerOff']), 'unattended');
    expect(on.targets).toEqual(expect.arrayContaining([
      expect.objectContaining({ machineId: 'self', identities: ['a@x.io', 'b@x.io'], minimumSuccessfulRepairs: 0, minimumEvidenceDays: 0 }),
      expect.objectContaining({ machineId: 'peer', identities: ['a@x.io', 'b@x.io'], minimumSuccessfulRepairs: 5, minimumEvidenceDays: 7 }),
      expect.objectContaining({ machineId: 'peerOff', identities: ['c@x.io'], minimumSuccessfulRepairs: 0, minimumEvidenceDays: 0 }),
    ]));
    expect(on.targets).toHaveLength(3);
    const back = configurePayload(m.rows, new Set(['self', 'peer']), 'approval');
    expect(back.targets).toEqual([expect.objectContaining({ machineId: 'peer', identities: ['a@x.io'], minimumSuccessfulRepairs: 5 })]);
  });

  it('this machine already without asking keeps its waits in the request', () => {
    const m = buildAutoRepair(read([cfg('self', 'unattended', ['a@x.io'], ['a@x.io', 'b@x.io'], { remote: false, minimumSuccessfulRepairs: 10, minimumEvidenceDays: 30 })]));
    expect(configurePayload(m.rows, new Set(['self']), 'unattended').targets[0]).toMatchObject({ minimumSuccessfulRepairs: 10, minimumEvidenceDays: 30 });
  });

  it('result words and confirmation', () => {
    expect(resultWords({ ok: true, mode: 'unattended', restartRequested: true })).toMatch(/restarting/);
    expect(resultWords({ ok: false, error: 'delivery-refused' })).toMatch(/update/);
    expect(resultWords({ ok: false, error: 'outcome-unknown' })).toMatch(/checking again/);
    expect(confirmation({ revision: 'r2', activationPending: false }, { revision: 'r2' })).toBe('confirmed');
    expect(confirmation({ revision: 'r2', activationPending: true }, { revision: 'r2' })).toBe('pending');
    expect(confirmation({ revision: 'r3', activationPending: false }, { revision: 'r2' })).toBe('superseded');
  });
});
