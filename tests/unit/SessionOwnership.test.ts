/**
 * Tier-1 tests for SessionOwnership (Multi-Machine Session Pool §L3): the
 * per-session ownership state machine, the run-fence, the output-exclusion
 * contract, and per-session nonce scoping. Pure logic.
 */
import { describe, it, expect } from 'vitest';
import {
  applyOwnershipAction,
  mayRun,
  mayEmit,
  ownershipNonceKey,
  type SessionOwnershipRecord,
} from '../../src/core/SessionOwnership.js';

const ctx = (over: Partial<{ sessionKey: string; nonce: string; now: number }> = {}) => ({
  sessionKey: 'topic-1',
  nonce: 'n1',
  now: 1_000_000,
  ...over,
});

function place(machineId: string) {
  const r = applyOwnershipAction(null, { type: 'place', machineId }, ctx());
  if (!r.ok) throw new Error(r.reason);
  return r.next;
}
function claim(current: SessionOwnershipRecord, machineId: string) {
  return applyOwnershipAction(current, { type: 'claim', machineId }, ctx());
}

describe('SessionOwnership — state machine (§L3)', () => {
  it('new session: place → claim → active, epoch advances each step', () => {
    const placed = place('m_a');
    expect(placed).toMatchObject({ status: 'placing', ownerMachineId: 'm_a', ownershipEpoch: 1 });
    const claimed = claim(placed, 'm_a');
    expect(claimed.ok).toBe(true);
    if (claimed.ok) expect(claimed.next).toMatchObject({ status: 'active', ownerMachineId: 'm_a', ownershipEpoch: 2 });
  });

  it('place refuses to steal a live (active) session', () => {
    const active = (claim(place('m_a'), 'm_a') as { ok: true; next: SessionOwnershipRecord }).next;
    expect(applyOwnershipAction(active, { type: 'place', machineId: 'm_b' }, ctx())).toEqual({ ok: false, reason: 'already-placed' });
  });

  it('transfer sequence active(S)→transferring→active(T): one owner throughout, claim-before-release', () => {
    const activeS = (claim(place('m_S'), 'm_S') as any).next as SessionOwnershipRecord; // active S e2
    const transferring = applyOwnershipAction(activeS, { type: 'transfer', to: 'm_T' }, ctx());
    expect(transferring.ok).toBe(true);
    if (!transferring.ok) return;
    expect(transferring.next).toMatchObject({ status: 'transferring', ownerMachineId: 'm_S', transferTo: 'm_T', ownershipEpoch: 3 });
    // transferring still names S as the (draining) owner → no no-owner gap.
    expect(mayRun(transferring.next, 'm_S', 3)).toBe(false); // S no longer runs NEW turns
    expect(mayRun(transferring.next, 'm_T', 3)).toBe(false); // T not active yet
    // T claims → active(T, e+3)
    const activeT = applyOwnershipAction(transferring.next, { type: 'claim', machineId: 'm_T' }, ctx());
    expect(activeT.ok).toBe(true);
    if (activeT.ok) expect(activeT.next).toMatchObject({ status: 'active', ownerMachineId: 'm_T', ownershipEpoch: 4 });
  });

  it('rejects an out-of-sequence claim (T claims while still active, before transferring)', () => {
    const activeS = (claim(place('m_S'), 'm_S') as any).next as SessionOwnershipRecord;
    expect(applyOwnershipAction(activeS, { type: 'claim', machineId: 'm_T' }, ctx())).toEqual({ ok: false, reason: 'claim-out-of-sequence' });
  });

  it('rejects a claim from the wrong machine (placing-owner / transfer-target mismatch)', () => {
    const placed = place('m_a');
    expect(claim(placed, 'm_b')).toEqual({ ok: false, reason: 'claim-wrong-machine' });
    const activeS = (claim(place('m_S'), 'm_S') as any).next as SessionOwnershipRecord;
    const transferring = (applyOwnershipAction(activeS, { type: 'transfer', to: 'm_T' }, ctx()) as any).next;
    expect(applyOwnershipAction(transferring, { type: 'claim', machineId: 'm_X' }, ctx())).toEqual({ ok: false, reason: 'claim-wrong-machine' });
  });

  it('transfer requires active; release requires the owner', () => {
    const placed = place('m_a'); // placing (not active)
    expect(applyOwnershipAction(placed, { type: 'transfer', to: 'm_b' }, ctx())).toEqual({ ok: false, reason: 'transfer-not-active' });
    const activeA = (claim(placed, 'm_a') as any).next as SessionOwnershipRecord;
    expect(applyOwnershipAction(activeA, { type: 'release', machineId: 'm_other' }, ctx())).toEqual({ ok: false, reason: 'release-not-owner' });
    const released = applyOwnershipAction(activeA, { type: 'release', machineId: 'm_a' }, ctx());
    expect(released.ok).toBe(true);
    if (released.ok) expect(released.next.status).toBe('released');
  });

  it('no two machines are ever "active owner at the top epoch" simultaneously (run-fence)', () => {
    const activeA = (claim(place('m_a'), 'm_a') as any).next as SessionOwnershipRecord; // active m_a e2
    expect(mayRun(activeA, 'm_a', 2)).toBe(true);
    expect(mayRun(activeA, 'm_b', 2)).toBe(false);
    expect(mayRun(activeA, 'm_a', 1)).toBe(false); // stale epoch does not grant authority
  });
});

describe('SessionOwnership — output-exclusion (§L3)', () => {
  it('steady-state active owner emits freely', () => {
    const active: SessionOwnershipRecord = { sessionKey: 's', ownerMachineId: 'm_a', ownershipEpoch: 2, status: 'active', nonce: 'n', timestamp: 0, updatedAt: '' };
    expect(mayEmit(active, 'm_a', { now: 5_000_000 })).toEqual({ mayEmit: true, newOutputAllowed: true });
    expect(mayEmit(active, 'm_b', { now: 5_000_000 })).toEqual({ mayEmit: false, newOutputAllowed: false });
  });

  it('draining source: tail-only within the cutoff window, nothing after', () => {
    const transferring: SessionOwnershipRecord = { sessionKey: 's', ownerMachineId: 'm_S', ownershipEpoch: 3, status: 'transferring', transferTo: 'm_T', nonce: 'n', timestamp: 0, updatedAt: '' };
    const startedAt = 1_000_000;
    expect(mayEmit(transferring, 'm_S', { now: startedAt + 500, transferringStartedAt: startedAt, cutoffMs: 1000 })).toEqual({ mayEmit: true, newOutputAllowed: false });
    expect(mayEmit(transferring, 'm_S', { now: startedAt + 1500, transferringStartedAt: startedAt, cutoffMs: 1000 })).toEqual({ mayEmit: false, newOutputAllowed: false });
  });

  it('target holds CONTINUATION until the source drain window closes (disjoint windows)', () => {
    const activeT: SessionOwnershipRecord = { sessionKey: 's', ownerMachineId: 'm_T', ownershipEpoch: 4, status: 'active', nonce: 'n', timestamp: 0, updatedAt: '' };
    const startedAt = 1_000_000;
    expect(mayEmit(activeT, 'm_T', { now: startedAt + 500, transferringStartedAt: startedAt, cutoffMs: 1000 }).mayEmit).toBe(false); // before cutoff
    expect(mayEmit(activeT, 'm_T', { now: startedAt + 1200, transferringStartedAt: startedAt, cutoffMs: 1000 }).mayEmit).toBe(true); // after cutoff
  });
});

describe('SessionOwnership — per-session nonce scoping (§L3)', () => {
  it('same nonce in two sessions → independent keys; same session+epoch+nonce → same key', () => {
    expect(ownershipNonceKey('A', 'm', 1, 'N1')).not.toBe(ownershipNonceKey('B', 'm', 1, 'N1')); // per-session isolation
    expect(ownershipNonceKey('A', 'm', 1, 'N1')).toBe(ownershipNonceKey('A', 'm', 1, 'N1')); // replay within a session → same key
    expect(ownershipNonceKey('A', 'm', 1, 'N1')).not.toBe(ownershipNonceKey('A', 'm', 2, 'N1')); // epoch scopes it too
  });
});

describe('SessionOwnership — release requires active (2026-05-29 review crit)', () => {
  it('REJECTS release while transferring (would orphan the session) and lets T still claim', () => {
    // active(S) → transferring(S→T)
    const placed = place('S');
    const claimed = applyOwnershipAction(placed, { type: 'claim', machineId: 'S' }, ctx({ nonce: 'n2' }));
    if (!claimed.ok) throw new Error(claimed.reason);
    const transferring = applyOwnershipAction(claimed.next, { type: 'transfer', to: 'T' }, ctx({ nonce: 'n3' }));
    if (!transferring.ok) throw new Error(transferring.reason);
    expect(transferring.next.status).toBe('transferring');

    // S attempts to release MID-TRANSFER → rejected (the bug fix).
    const badRelease = applyOwnershipAction(transferring.next, { type: 'release', machineId: 'S' }, ctx({ nonce: 'n4' }));
    expect(badRelease.ok).toBe(false);
    if (!badRelease.ok) expect(badRelease.reason).toBe('release-requires-active');

    // T can still claim from the (intact) transferring record → active(T).
    const tClaim = applyOwnershipAction(transferring.next, { type: 'claim', machineId: 'T' }, ctx({ nonce: 'n5' }));
    expect(tClaim.ok).toBe(true);
    if (tClaim.ok) { expect(tClaim.next.status).toBe('active'); expect(tClaim.next.ownerMachineId).toBe('T'); }
  });

  it('ALLOWS release from active (the normal owner-ends-session path)', () => {
    const claimed = applyOwnershipAction(place('S'), { type: 'claim', machineId: 'S' }, ctx({ nonce: 'n2' }));
    if (!claimed.ok) throw new Error(claimed.reason);
    const rel = applyOwnershipAction(claimed.next, { type: 'release', machineId: 'S' }, ctx({ nonce: 'n3' }));
    expect(rel.ok).toBe(true);
    if (rel.ok) expect(rel.next.status).toBe('released');
  });
});
