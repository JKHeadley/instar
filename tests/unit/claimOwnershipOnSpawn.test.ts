/**
 * createClaimOwnershipOnSpawn — the single claim-on-spawn action shared by the
 * autonomous-respawn path and POST /sessions/spawn (Echo Bugs topic
 * 10000001485: a topic-bound spawn left the topic "unowned", so a peer's
 * router started a second copy). Real SessionOwnershipRegistry; both sides of
 * every boundary.
 */
import { describe, it, expect } from 'vitest';
import { createClaimOwnershipOnSpawn } from '../../src/core/ownershipFollowsLiveWork.js';
import { SessionOwnershipRegistry, InMemorySessionOwnershipStore } from '../../src/core/SessionOwnershipRegistry.js';

const SELF = 'm_self';
const PEER = 'm_peer';

function setup(over: { enabled?: boolean; self?: string | null } = {}) {
  const seen = new Set<string>();
  const ownReg = new SessionOwnershipRegistry({
    store: new InMemorySessionOwnershipStore(),
    seenNonce: (k) => seen.has(k),
    recordNonce: (k) => seen.add(k),
  });
  const emits: Array<{ sk: string; ok: boolean; reason: string; prev?: string }> = [];
  const audits: Array<{ topicId: number; owner: string | null; status: string }> = [];
  const claim = createClaimOwnershipOnSpawn({
    enabled: over.enabled ?? true,
    selfMachineId: over.self === undefined ? SELF : over.self,
    ownReg,
    emitPlacement: (sk, r, reason, prev) => emits.push({ sk, ok: r.ok, reason, prev }),
    auditOwnedElsewhere: (row) => audits.push(row),
  });
  return { ownReg, emits, audits, claim };
}

describe('createClaimOwnershipOnSpawn', () => {
  it('an unowned topic becomes active on THIS machine, with both CAS steps journaled', () => {
    const { ownReg, emits, claim } = setup();
    expect(claim(10000001485)).toBe('claimed');
    const r = ownReg.read('10000001485');
    expect(r?.ownerMachineId).toBe(SELF);
    expect(r?.status).toBe('active');
    expect(emits.map((e) => e.ok)).toEqual([true, true]);
    expect(emits.every((e) => e.reason === 'placed')).toBe(true);
  });

  it('a second call on an already-owned topic is a no-op (idempotent)', () => {
    const { ownReg, emits, claim } = setup();
    claim(7);
    const epoch = ownReg.read('7')!.ownershipEpoch;
    expect(claim(7)).toBe('already-owned');
    expect(ownReg.read('7')!.ownershipEpoch).toBe(epoch);
    expect(emits).toHaveLength(2);
  });

  it('a released topic is re-claimed', () => {
    const { ownReg, claim } = setup();
    claim(8);
    ownReg.cas({ type: 'release', machineId: SELF }, { sessionKey: '8', sender: SELF, nonce: 'rel-8' });
    expect(ownReg.read('8')!.status).toBe('released');
    expect(claim(8)).toBe('claimed');
    expect(ownReg.read('8')!.status).toBe('active');
  });

  it('a topic actively owned by a PEER is never taken; one audit row', () => {
    const { ownReg, audits, emits, claim } = setup();
    ownReg.cas({ type: 'place', machineId: PEER }, { sessionKey: '9', sender: 'ROUTER', nonce: 'p9' });
    ownReg.cas({ type: 'claim', machineId: PEER }, { sessionKey: '9', sender: PEER, nonce: 'c9' });
    expect(claim(9)).toBe('owned-elsewhere');
    expect(ownReg.read('9')!.ownerMachineId).toBe(PEER);
    expect(audits).toEqual([{ topicId: 9, owner: PEER, status: 'active' }]);
    expect(emits).toHaveLength(0);
  });

  it('placing@self → in-flight: no CAS, no audit row, record left for route() to claim', () => {
    const { ownReg, emits, audits, claim } = setup();
    ownReg.cas({ type: 'place', machineId: SELF }, { sessionKey: '13', sender: 'ROUTER', nonce: 'p13' });
    expect(claim(13)).toBe('in-flight');
    expect(ownReg.read('13')!.status).toBe('placing');
    expect(emits).toHaveLength(0);
    expect(audits).toHaveLength(0);
  });

  it('place wins but claim loses → lost, both CAS results journaled', () => {
    const emits: boolean[] = [];
    let n = 0;
    const claim = createClaimOwnershipOnSpawn({
      enabled: true,
      selfMachineId: SELF,
      ownReg: { read: () => null, cas: () => ({ ok: n++ === 0 }) },
      emitPlacement: (_sk, r) => emits.push(r.ok),
    });
    expect(claim(14)).toBe('lost');
    expect(emits).toEqual([true, false]);
  });

  it('flag off or single-machine → dark, nothing written', () => {
    for (const s of [setup({ enabled: false }), setup({ self: null })]) {
      expect(s.claim(11)).toBe('dark');
      expect(s.ownReg.read('11')).toBeNull();
      expect(s.emits).toHaveLength(0);
    }
  });

  it('a registry that throws reports error and never throws into the spawn', () => {
    const claim = createClaimOwnershipOnSpawn({
      enabled: true,
      selfMachineId: SELF,
      ownReg: { read: () => { throw new Error('disk'); }, cas: () => ({ ok: true }) },
      emitPlacement: () => {},
    });
    expect(claim(12)).toBe('error');
  });
});
