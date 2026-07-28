import { describe, it, expect } from 'vitest';
import {
  shouldReleaseOnComplete,
  planClaimOnSpawn,
  ownershipNonce,
} from '../../src/core/ownershipFollowsLiveWork.js';
import {
  SessionOwnershipRegistry,
  InMemorySessionOwnershipStore,
} from '../../src/core/SessionOwnershipRegistry.js';
import type { SessionOwnershipRecord } from '../../src/core/SessionOwnership.js';

/**
 * Ownership Follows Live Work — Tier 1 unit tests for the pure A/B decision helpers
 * (docs/specs/ownership-follows-live-work.md). Both sides of every boundary.
 */

const SELF = 'machine-self';
const PEER = 'machine-peer';

function rec(p: Partial<SessionOwnershipRecord> & { ownerMachineId: string; status: SessionOwnershipRecord['status'] }): SessionOwnershipRecord {
  return {
    sessionKey: '100',
    ownershipEpoch: 1,
    nonce: 'n',
    timestamp: 0,
    updatedAt: new Date(0).toISOString(),
    ...p,
  };
}

// A small in-memory registry to drive the FSM end-to-end where the spec asks for
// real-deps fenced-epoch behavior (the A∥B / B∥transfer / nonce races).
function makeRegistry() {
  const seen = new Set<string>();
  return new SessionOwnershipRegistry({
    store: new InMemorySessionOwnershipStore(),
    seenNonce: (k) => seen.has(k),
    recordNonce: (k) => seen.add(k),
  });
}

describe('Part A — shouldReleaseOnComplete (release-on-complete, both sides)', () => {
  it('flag ON, owner===self + active + no live session bound → RELEASE', () => {
    expect(shouldReleaseOnComplete({
      enabled: true, selfMachineId: SELF,
      record: rec({ ownerMachineId: SELF, status: 'active' }),
      completingStartedAt: '2026-06-24T00:00:00.000Z',
      liveStartedAt: null,
    })).toBe(true);
  });

  it('flag ON, owner is a PEER → NO release', () => {
    expect(shouldReleaseOnComplete({
      enabled: true, selfMachineId: SELF,
      record: rec({ ownerMachineId: PEER, status: 'active' }),
      completingStartedAt: 'x', liveStartedAt: null,
    })).toBe(false);
  });

  it('flag ON, no record → NO release', () => {
    expect(shouldReleaseOnComplete({
      enabled: true, selfMachineId: SELF, record: null,
      completingStartedAt: 'x', liveStartedAt: null,
    })).toBe(false);
  });

  it('flag ON, status released → NO release (FSM would reject; short-circuit)', () => {
    expect(shouldReleaseOnComplete({
      enabled: true, selfMachineId: SELF,
      record: rec({ ownerMachineId: SELF, status: 'released' }),
      completingStartedAt: 'x', liveStartedAt: null,
    })).toBe(false);
  });

  it('flag ON, status transferring → NO release', () => {
    expect(shouldReleaseOnComplete({
      enabled: true, selfMachineId: SELF,
      record: rec({ ownerMachineId: SELF, status: 'transferring' }),
      completingStartedAt: 'x', liveStartedAt: null,
    })).toBe(false);
  });

  it('flag ON, single-machine (selfMachineId null) → NO release', () => {
    expect(shouldReleaseOnComplete({
      enabled: true, selfMachineId: null,
      record: rec({ ownerMachineId: SELF, status: 'active' }),
      completingStartedAt: 'x', liveStartedAt: null,
    })).toBe(false);
  });

  it('FD9 — a DIFFERENT live session is bound (newer startedAt) → NO release (same-machine A∥B clobber)', () => {
    expect(shouldReleaseOnComplete({
      enabled: true, selfMachineId: SELF,
      record: rec({ ownerMachineId: SELF, status: 'active' }),
      completingStartedAt: '2026-06-24T00:00:00.000Z',
      liveStartedAt: '2026-06-24T00:05:00.000Z', // newer = different instance
    })).toBe(false);
  });

  it('FD9 — the SAME instance is bound (same startedAt, reused tmux name) → RELEASE (the completing one IS the live one)', () => {
    expect(shouldReleaseOnComplete({
      enabled: true, selfMachineId: SELF,
      record: rec({ ownerMachineId: SELF, status: 'active' }),
      completingStartedAt: '2026-06-24T00:00:00.000Z',
      liveStartedAt: '2026-06-24T00:00:00.000Z', // identical instance key
    })).toBe(true);
  });

  it('FD9 — instance identity UNPROVABLE (live startedAt empty) → NO release (fail-closed)', () => {
    expect(shouldReleaseOnComplete({
      enabled: true, selfMachineId: SELF,
      record: rec({ ownerMachineId: SELF, status: 'active' }),
      completingStartedAt: '2026-06-24T00:00:00.000Z',
      liveStartedAt: '', // a bound live session whose startedAt is missing → withhold
    })).toBe(false);
  });

  it('FD9 — instance identity UNPROVABLE (completing startedAt missing) → NO release (fail-closed)', () => {
    expect(shouldReleaseOnComplete({
      enabled: true, selfMachineId: SELF,
      record: rec({ ownerMachineId: SELF, status: 'active' }),
      completingStartedAt: undefined,
      liveStartedAt: '2026-06-24T00:00:00.000Z',
    })).toBe(false);
  });

  it('FD9 — new session NOT YET bound (liveStartedAt null) → RELEASE PROCEEDS (best-effort safe direction)', () => {
    // The not-yet-bound interleaving: a respawn has not registered its binding at
    // the completion instant → getSessionForTopic returns nothing → release proceeds;
    // Part B re-establishes ownership for the new session.
    expect(shouldReleaseOnComplete({
      enabled: true, selfMachineId: SELF,
      record: rec({ ownerMachineId: SELF, status: 'active' }),
      completingStartedAt: '2026-06-24T00:00:00.000Z',
      liveStartedAt: null,
    })).toBe(true);
  });

  it('flag OFF → NO release ever (regression-lock)', () => {
    expect(shouldReleaseOnComplete({
      enabled: false, selfMachineId: SELF,
      record: rec({ ownerMachineId: SELF, status: 'active' }),
      completingStartedAt: 'x', liveStartedAt: null,
    })).toBe(false);
  });
});

describe('Part B — planClaimOnSpawn (claim-on-spawn, both sides)', () => {
  it('flag ON, never-seen topic (null record) → place-then-claim', () => {
    expect(planClaimOnSpawn({ enabled: true, selfMachineId: SELF, record: null }))
      .toEqual({ action: 'place-then-claim' });
  });

  it('flag ON, released record → place-then-claim', () => {
    expect(planClaimOnSpawn({ enabled: true, selfMachineId: SELF, record: rec({ ownerMachineId: PEER, status: 'released' }) }))
      .toEqual({ action: 'place-then-claim' });
  });

  it('flag ON, active+self → noop (no duplicate CAS)', () => {
    expect(planClaimOnSpawn({ enabled: true, selfMachineId: SELF, record: rec({ ownerMachineId: SELF, status: 'active' }) }))
      .toEqual({ action: 'noop' });
  });

  it('flag ON, active+PEER (post-gate race) → audit-owned-elsewhere (NO force-claim, FD3)', () => {
    expect(planClaimOnSpawn({ enabled: true, selfMachineId: SELF, record: rec({ ownerMachineId: PEER, status: 'active' }) }))
      .toEqual({ action: 'audit-owned-elsewhere', owner: PEER, status: 'active' });
  });

  it('flag ON, transferring (peer) → audit-owned-elsewhere (NO force-claim)', () => {
    expect(planClaimOnSpawn({ enabled: true, selfMachineId: SELF, record: rec({ ownerMachineId: PEER, status: 'transferring' }) }))
      .toEqual({ action: 'audit-owned-elsewhere', owner: PEER, status: 'transferring' });
  });

  it('flag ON, single-machine (selfMachineId null) → noop', () => {
    expect(planClaimOnSpawn({ enabled: true, selfMachineId: null, record: null }))
      .toEqual({ action: 'noop' });
  });

  it('flag OFF → noop (regression-lock: no place/claim CAS ever)', () => {
    expect(planClaimOnSpawn({ enabled: false, selfMachineId: SELF, record: null }))
      .toEqual({ action: 'noop' });
  });

  it('force-claim contract guard: the plan NEVER yields a force-claim regardless of state', () => {
    const states: SessionOwnershipRecord['status'][] = ['active', 'transferring', 'placing', 'released'];
    for (const owner of [SELF, PEER]) {
      for (const status of states) {
        const plan = planClaimOnSpawn({ enabled: true, selfMachineId: SELF, record: rec({ ownerMachineId: owner, status }) });
        expect(plan.action).not.toMatch(/force/);
      }
    }
  });
});

describe('FD10 — ownershipNonce collision-resistance', () => {
  it('two calls for the SAME machine+verb+sessionKey within the same ms are DISTINCT', () => {
    // Freeze Date.now so both calls share a millisecond — the collision the helper closes.
    const realNow = Date.now;
    Date.now = () => 1_000_000;
    try {
      const a = ownershipNonce('m', 'rel-complete', '100');
      const b = ownershipNonce('m', 'rel-complete', '100');
      expect(a).not.toBe(b); // counter + UUID suffix guarantees uniqueness
    } finally {
      Date.now = realNow;
    }
  });

  it('embeds the machine, verb, and sessionKey (format stability)', () => {
    const n = ownershipNonce('machine-x', 'auto-claim', '42');
    expect(n.startsWith('machine-x:auto-claim:42:')).toBe(true);
  });
});

describe('Part A+B against the REAL registry FSM (fenced-epoch / race correctness)', () => {
  it('Part A release advances the record to released → ownerOf becomes null', () => {
    const reg = makeRegistry();
    reg.cas({ type: 'place', machineId: SELF }, { sessionKey: '100', sender: SELF, nonce: 'a' });
    reg.cas({ type: 'claim', machineId: SELF }, { sessionKey: '100', sender: SELF, nonce: 'b' });
    expect(reg.ownerOf('100')).toBe(SELF);
    // helper says release; perform it
    expect(shouldReleaseOnComplete({
      enabled: true, selfMachineId: SELF, record: reg.read('100'),
      completingStartedAt: 's', liveStartedAt: null,
    })).toBe(true);
    const r = reg.cas({ type: 'release', machineId: SELF }, { sessionKey: '100', sender: SELF, nonce: 'c' });
    expect(r.ok).toBe(true);
    expect(reg.ownerOf('100')).toBeNull();
  });

  it('Part B place→claim moves ownership onto self', () => {
    const reg = makeRegistry();
    const plan = planClaimOnSpawn({ enabled: true, selfMachineId: SELF, record: reg.read('100') });
    expect(plan.action).toBe('place-then-claim');
    const rp = reg.cas({ type: 'place', machineId: SELF }, { sessionKey: '100', sender: SELF, nonce: 'p' });
    expect(rp.ok).toBe(true);
    const rc = reg.cas({ type: 'claim', machineId: SELF }, { sessionKey: '100', sender: SELF, nonce: 'c' });
    expect(rc.ok).toBe(true);
    expect(reg.ownerOf('100')).toBe(SELF);
  });

  it('B∥transfer race: an autonomous claim that would advance past a higher-epoch transfer LOSES the CAS', () => {
    const reg = makeRegistry();
    // self owns the topic active
    reg.cas({ type: 'place', machineId: SELF }, { sessionKey: '100', sender: SELF, nonce: 'p' });
    reg.cas({ type: 'claim', machineId: SELF }, { sessionKey: '100', sender: SELF, nonce: 'c' });
    // a transfer to PEER advances the epoch (transferring), then PEER claims active
    reg.cas({ type: 'transfer', to: PEER }, { sessionKey: '100', sender: SELF, nonce: 't' });
    const claimPeer = reg.cas({ type: 'claim', machineId: PEER }, { sessionKey: '100', sender: PEER, nonce: 'cp' });
    expect(claimPeer.ok).toBe(true);
    expect(reg.ownerOf('100')).toBe(PEER);
    // a stale autonomous place/claim by SELF must NOT steal it back — place is rejected
    // (already-placed: the record is active, not released), so the transfer target wins.
    const stalePlace = reg.cas({ type: 'place', machineId: SELF }, { sessionKey: '100', sender: SELF, nonce: 'sp' });
    expect(stalePlace.ok).toBe(false);
    expect(reg.ownerOf('100')).toBe(PEER);
  });

  it('A∥B same-record race: release and a competing claim resolve to ONE record at the highest epoch (no torn state)', () => {
    const reg = makeRegistry();
    reg.cas({ type: 'place', machineId: SELF }, { sessionKey: '100', sender: SELF, nonce: 'p' });
    reg.cas({ type: 'claim', machineId: SELF }, { sessionKey: '100', sender: SELF, nonce: 'c' });
    // A releases first
    const rel = reg.cas({ type: 'release', machineId: SELF }, { sessionKey: '100', sender: SELF, nonce: 'r' });
    expect(rel.ok).toBe(true);
    // B then place→claim onto self (released → place is legal)
    const place = reg.cas({ type: 'place', machineId: SELF }, { sessionKey: '100', sender: SELF, nonce: 'p2' });
    expect(place.ok).toBe(true);
    const claim = reg.cas({ type: 'claim', machineId: SELF }, { sessionKey: '100', sender: SELF, nonce: 'c2' });
    expect(claim.ok).toBe(true);
    // single consistent record at the top epoch, owned by self.
    expect(reg.ownerOf('100')).toBe(SELF);
    expect(reg.read('100')!.status).toBe('active');
  });
});
