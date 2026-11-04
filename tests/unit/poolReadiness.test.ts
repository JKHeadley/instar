import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { computePoolReadiness as compute, PoolReadinessLog, type PoolReadinessDeps, type PoolReadinessReport } from '../../src/core/poolReadiness.js';
import { gitLeaseHasNoRemote } from '../../src/core/leaseMediumSelection.js';
import type { MachineCapacity } from '../../src/core/types.js';

const computePoolReadiness = (d: PoolReadinessDeps): PoolReadinessReport => compute(d) as PoolReadinessReport;
const NOW = 1_800_000_000_000;
const CHAT = { telegram: { chatIds: ['-100'] } };

function peer(over: Partial<MachineCapacity> = {}): MachineCapacity {
  return {
    machineId: 'm_peer', online: true, maxSessions: 10, activeSessionCount: 1, loadVerdict: 'ok', clockSkewStatus: 'ok',
    liveness: { state: 'live', evidenceAgeMs: 5_000, evidenceAt: 'x', source: 'direct' },
    loadReport: { sampleAgeMs: 1_000, sessionsMax: 10 } as never,
    loadReportReceivedAt: new Date(NOW - 1_000).toISOString(),
    quotaState: { blocked: false }, servesChannels: CHAT, seamlessnessFlags: { ws11DeliverReceive: true } as never,
    ...over,
  } as MachineCapacity;
}

function deps(over: Partial<PoolReadinessDeps> = {}, cap: MachineCapacity | null = peer()): PoolReadinessDeps {
  return {
    peerIds: () => ['m_peer'], capacity: () => cap, ownChannels: () => CHAT, durableOwnership: () => true,
    duplicateCheck: () => ({ enabled: true, substrate: { ready: true } }),
    takeover: () => ({ state: 'unknown', reason: 'only a real takeover proves this' }), now: () => NOW,
    ...over,
  };
}

describe('computePoolReadiness', () => {
  it('is ready when every line is ok, and takeover does not count toward ready', () => {
    const r = computePoolReadiness(deps()) ;
    expect(r).toMatchObject({ machines: 2, ready: true });
    expect(r.thisMachine.takeover.state).toBe('unknown');
    expect(r.note).toMatch(/not that a real conversation has been placed/);
  });

  it('a single machine reports that, and is not ready', () => {
    expect(computePoolReadiness(deps({ peerIds: () => [] }))).toEqual({ machines: 1, ready: false, reason: 'single-machine' });
  });

  it.each([
    ['contact', { liveness: { state: 'stale', evidenceAgeMs: 600_000, evidenceAt: 'x', source: 'direct' } }, 'failing'],
    ['contact', { liveness: { state: 'live', evidenceAgeMs: 5_000, evidenceAt: 'x', source: 'relay' } }, 'failing'],
    ['contact', { liveness: undefined }, 'unknown'],
    ['clock', { clockSkewStatus: 'quarantined' }, 'failing'],
    ['capacity', { loadVerdict: 'saturated' }, 'failing'],
    ['capacity', { loadVerdict: 'impaired' }, 'failing'],
    ['capacity', { loadVerdict: 'unknown' }, 'unknown'],
    ['capacity', { loadVerdict: undefined }, 'unknown'],
    ['capacity', { loadReport: { sampleAgeMs: 1_000, sessionsMax: null } }, 'failing'],
    ['capacity', { loadReport: { sampleAgeMs: 1_000, sessionsMax: 10, acceptingWork: false } }, 'failing'],
    ['capacity', { loadReport: undefined }, 'unknown'],
    ['capacity', { loadReportReceivedAt: new Date(NOW - 3_600_000).toISOString() }, 'unknown'],
    ['noStartFailure', { quotaState: { blocked: true, reason: 'session-start-failing' } }, 'failing'],
    ['noStartFailure', { quotaState: undefined }, 'unknown'],
    ['followUps', { seamlessnessFlags: { ws11DeliverReceive: false } }, 'failing'],
    ['followUps', { seamlessnessFlags: undefined }, 'unknown'],
  ])('%s with %j reads %s and blocks ready', (name, over, state) => {
    const r = computePoolReadiness(deps({}, peer(over as Partial<MachineCapacity>)));
    expect(r.peers[0].lines[name].state).toBe(state);
    expect(r.ready).toBe(false);
  });

  it('a join-built peer with no channels fails the channels line: the known gap reads as a gap', () => {
    const r = computePoolReadiness(deps({}, peer({ servesChannels: undefined })));
    expect(r.peers[0].lines.channels.state).toBe('failing');
  });

  it('on the channel-less peer itself, a channel only its partner reports still counts', () => {
    const r = computePoolReadiness(deps({ ownChannels: () => undefined }));
    expect(r.peers[0].lines.channels.state).toBe('ok');
  });

  it('a peer serving one of two channels fails, and no channels anywhere is unknown', () => {
    const two = { telegram: { chatIds: ['-100', '-200'] } };
    expect(computePoolReadiness(deps({ ownChannels: () => two })).peers[0].lines.channels.state).toBe('failing');
    expect(computePoolReadiness(deps({ ownChannels: () => undefined }, peer({ servesChannels: undefined }))).peers[0].lines.channels.state).toBe('unknown');
  });

  it('a peer never reached reads unknown, not an invented ok or failing', () => {
    const r = computePoolReadiness(deps({}, peer({ liveness: undefined, servesChannels: undefined }))).peers[0].lines;
    expect(r.clock.state).toBe('unknown');
    expect(r.channels.state).toBe('unknown');
  });

  it('this machine: memory-only ownership or a stopped duplicate detector blocks ready', () => {
    expect(computePoolReadiness(deps({ durableOwnership: () => false })).ready).toBe(false);
    const off = computePoolReadiness(deps({ duplicateCheck: () => ({ enabled: true, substrate: { ready: false, reason: 'substrate-not-ready' } }) }));
    expect(off).toMatchObject({ ready: false, thisMachine: { duplicateCheck: { state: 'failing' } } });
    expect(computePoolReadiness(deps({ duplicateCheck: () => null })).thisMachine.duplicateCheck.state).toBe('unknown');
  });

  it('one good peer of two is enough; the bad one still shows', () => {
    const r = computePoolReadiness(deps({ peerIds: () => ['a', 'b'], capacity: (id) => (id === 'a' ? peer() : null) }));
    expect(r).toMatchObject({ machines: 3, ready: true });
    expect(r.peers[1].ready).toBe(false);
  });
});

describe('PoolReadinessLog', () => {
  const file = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pool-readiness-')), 'logs', 'pool-readiness.jsonl');

  it('a single machine writes nothing, not even the folder', () => {
    const f = file();
    new PoolReadinessLog(deps({ peerIds: () => [] }), f).tick();
    expect(fs.existsSync(path.dirname(f))).toBe(false);
  });

  it('writes one row an hour, and follows one, two, one, two machines without a restart', () => {
    const f = file();
    let now = NOW; let ids: string[] = [];
    const log = new PoolReadinessLog(deps({ peerIds: () => ids, now: () => now }), f);
    const rows = () => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').length : 0);
    log.tick();
    expect(rows()).toBe(0);
    ids = ['m_peer']; log.tick();
    expect(rows()).toBe(1);
    now += 30_000; log.tick();
    expect(rows()).toBe(1);
    ids = []; now += 3_600_000; log.tick();
    expect(rows()).toBe(1);
    ids = ['m_peer']; now += 30_000; log.tick();
    expect(rows()).toBe(2);
  });

  it('a failing read never throws into the pool beat', () => {
    const log = new PoolReadinessLog(deps({ peerIds: () => { throw new Error('registry unreadable'); } }), file());
    expect(() => log.tick()).not.toThrow();
  });
});

describe('gitLeaseHasNoRemote', () => {
  it('reads an empty remote list as none, a listed one as present, an error as unknown', () => {
    expect(gitLeaseHasNoRemote('/x', () => '')).toBe(true);
    expect(gitLeaseHasNoRemote('/x', () => 'origin\n')).toBe(false);
    expect(gitLeaseHasNoRemote('/x', () => { throw new Error('no git'); })).toBeNull();
  });
});
