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
  it('ticks only machines already unattended; this machine can be turned on from any state', () => {
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
    expect(by.peerA).toMatchObject({ canTurnOn: false, defaultTick: false });
    // CMT-1541: a plain reason, not an instruction that reads as offered here.
    expect(by.peerA.blockedWhy).toMatch(/Repairing without asking is off there, and it can only be switched on from that machine itself/);
    expect(by.peerA.blockedWhy).toMatch(/another machine is not allowed to raise/);
    expect(by.peerOff.blockedWhy).toBe(by.peerA.blockedWhy);
    expect(by.peerOff).toMatchObject({ canTurnOn: false, canSwitchBack: false });
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

  it('the owner-must-enable-here result reads as the same plain reason', () => {
    expect(resultWords({ ok: false, error: 'owner-must-enable-here' })).toMatch(/can only be switched on from that machine itself/);
  });

  it('rows this page cannot change carry no tick-box permission (canTurnOn and canSwitchBack both false)', () => {
    const m = buildAutoRepair(read([cfg('peerA', 'approval', ['a@x.io'], ['a@x.io'], { remote: true, machineNickname: 'Mac Mini' })]));
    expect(m.rows[0]).toMatchObject({ canTurnOn: false, canSwitchBack: false, defaultTick: false });
  });

  it('builds the exact request: own machine 0/0, other machines keep their waits; approval keeps list and waits', () => {
    const m = buildAutoRepair(read([
      cfg('self', 'approval', ['a@x.io'], ['a@x.io', 'b@x.io'], { remote: false, minimumSuccessfulRepairs: 10, minimumEvidenceDays: 30 }),
      cfg('peer', 'unattended', ['a@x.io'], ['a@x.io', 'b@x.io'], { remote: true, minimumSuccessfulRepairs: 5, minimumEvidenceDays: 7 }),
    ]));
    const on = configurePayload(m.rows, new Set(['self', 'peer']), 'unattended');
    expect(on.targets).toEqual([
      expect.objectContaining({ machineId: 'self', identities: ['a@x.io', 'b@x.io'], minimumSuccessfulRepairs: 0, minimumEvidenceDays: 0 }),
      expect.objectContaining({ machineId: 'peer', identities: ['a@x.io', 'b@x.io'], minimumSuccessfulRepairs: 5, minimumEvidenceDays: 7 }),
    ]);
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
