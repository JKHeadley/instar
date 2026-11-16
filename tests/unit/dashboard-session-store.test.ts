import { describe, it, expect } from 'vitest';
import { DashboardSessionStore } from '../../src/server/DashboardSessionStore.js';

function fixedClock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

const CFG = { ttlMs: 60_000, absoluteMaxMs: 600_000, maxTokens: 16 };

describe('DashboardSessionStore', () => {
  it('issues an opaque token that verifies, and is NOT the input to verify by value', () => {
    const c = fixedClock();
    const s = new DashboardSessionStore({ ...CFG, now: c.now });
    const t = s.issue();
    expect(t.token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(s.verify(t.token)).toBe(true);
    expect(s.verify('not-a-token')).toBe(false);
    expect(s.verify(undefined)).toBe(false);
  });

  it('a token expires at its per-token TTL', () => {
    const c = fixedClock();
    const s = new DashboardSessionStore({ ...CFG, now: c.now });
    const t = s.issue();
    c.advance(CFG.ttlMs - 1); expect(s.verify(t.token)).toBe(true);
    c.advance(2); expect(s.verify(t.token)).toBe(false);
  });

  it('refresh mints a fresh successor in the SAME family and consumes the old token', () => {
    const c = fixedClock();
    const s = new DashboardSessionStore({ ...CFG, now: c.now });
    const t = s.issue();
    c.advance(CFG.ttlMs - 5);
    const t2 = s.refresh(t.token);
    expect(t2).not.toBeNull();
    expect(t2!.familyId).toBe(t.familyId);
    expect(t2!.token).not.toBe(t.token);
    expect(s.verify(t.token)).toBe(false); // old consumed
    expect(s.verify(t2!.token)).toBe(true);
  });

  it('refresh is REFUSED past the absolute family cap (a stolen token cannot slide forever)', () => {
    const c = fixedClock();
    const s = new DashboardSessionStore({ ...CFG, now: c.now });
    let t = s.issue();
    // keep refreshing right up to the cap
    for (let i = 0; i < 20; i++) {
      c.advance(CFG.ttlMs - 1);
      const n = s.refresh(t.token);
      if (n === null) break;
      t = n;
    }
    // push past the absolute cap and prove refresh + verify both fail
    c.advance(CFG.absoluteMaxMs);
    expect(s.refresh(t.token)).toBeNull();
    expect(s.verify(t.token)).toBe(false);
  });

  it('revokeFamily kills EVERY token refreshed from the same unlock (not just the presented one)', () => {
    const c = fixedClock();
    const s = new DashboardSessionStore({ ...CFG, now: c.now });
    const t1 = s.issue();
    c.advance(10);
    const t2 = s.refresh(t1.token)!; // successor in the same family
    // revoke using t2 → t1 is already consumed, but any live sibling must die; verify family is dead
    s.revokeFamily(t2.token);
    expect(s.verify(t2.token)).toBe(false);
    // a fresh refresh from the revoked family is refused
    expect(s.refresh(t2.token)).toBeNull();
  });

  it('two separate unlocks are independent families — revoking one leaves the other alive', () => {
    const c = fixedClock();
    const s = new DashboardSessionStore({ ...CFG, now: c.now });
    const a = s.issue();
    const b = s.issue();
    s.revokeFamily(a.token);
    expect(s.verify(a.token)).toBe(false);
    expect(s.verify(b.token)).toBe(true);
  });

  it('revokeAll invalidates everything (PIN rotation)', () => {
    const c = fixedClock();
    const s = new DashboardSessionStore({ ...CFG, now: c.now });
    const a = s.issue(); const b = s.issue();
    s.revokeAll();
    expect(s.verify(a.token)).toBe(false);
    expect(s.verify(b.token)).toBe(false);
    expect(s.size()).toBe(0);
  });

  it('an open stream listener fires when its family is invalidated (revoke closes live streams)', () => {
    const c = fixedClock();
    const s = new DashboardSessionStore({ ...CFG, now: c.now });
    const t = s.issue();
    let closed = 0;
    s.onFamilyInvalidated(t.token, () => { closed++; });
    expect(closed).toBe(0);
    s.revokeFamily(t.token);
    expect(closed).toBe(1);
  });

  it('a listener for an already-invalid token fires immediately (fail-safe)', () => {
    const c = fixedClock();
    const s = new DashboardSessionStore({ ...CFG, now: c.now });
    let closed = 0;
    s.onFamilyInvalidated('bogus', () => { closed++; });
    expect(closed).toBe(1);
  });

  it('bounds the token table and rejects an invalid config', () => {
    const c = fixedClock();
    const s = new DashboardSessionStore({ ...CFG, maxTokens: 4, now: c.now });
    for (let i = 0; i < 10; i++) s.issue();
    expect(s.size()).toBeLessThanOrEqual(4);
    expect(() => new DashboardSessionStore({ ttlMs: 10 })).toThrow();
    expect(() => new DashboardSessionStore({ ttlMs: 60_000, absoluteMaxMs: 1000 })).toThrow();
  });
});

describe('DashboardSessionStore — revocation completeness (SEC-044 + SEC-045)', () => {
  it('STRICT reuse: re-presenting a CONSUMED token invalidates the whole family', () => {
    const c = fixedClock();
    const s = new DashboardSessionStore({ ...CFG, now: c.now });
    const t1 = s.issue();
    c.advance(10);
    const t2 = s.refresh(t1.token)!;        // t1 consumed, t2 live
    expect(s.verify(t2.token)).toBe(true);
    // a thief (or a lost-ACK retry) re-presents the already-spent t1 → fork → family dies
    expect(s.refresh(t1.token)).toBeNull();
    expect(s.verify(t2.token)).toBe(false); // the live successor is killed too (fail-safe)
  });

  it('owner logout with an already-CONSUMED token still ends the family (tombstone anchor)', () => {
    const c = fixedClock();
    const s = new DashboardSessionStore({ ...CFG, now: c.now });
    const t1 = s.issue();
    c.advance(10);
    const t2 = s.refresh(t1.token)!;        // t1 consumed; t2 is the "thief's" live successor
    s.revokeFamily(t1.token);               // owner logs out with the ORIGINAL (now-consumed) token
    expect(s.verify(t2.token)).toBe(false); // family ended despite t1 being consumed (SEC-045 core)
  });

  it('owner logout with an EXPIRED unconsumed token still ends the family (tombstone-on-expiry)', () => {
    const c = fixedClock();
    const s = new DashboardSessionStore({ ...CFG, now: c.now });
    const owner = s.issue();
    let closed = 0;
    s.onFamilyInvalidated(owner.token, () => { closed++; });
    c.advance(CFG.ttlMs + 1);               // token expires; family still within its absolute cap
    expect(s.verify(owner.token)).toBe(false); // expired (also tombstones it, family alive)
    s.revokeFamily(owner.token);            // resolves via the tombstone → invalidates
    expect(closed).toBe(1);
  });

  it('a capacity-EVICTED token still revokes its family (tombstone-on-evict)', () => {
    const c = fixedClock();
    const s = new DashboardSessionStore({ ...CFG, maxTokens: 2, maxFamilies: 8, now: c.now });
    const a = s.issue();
    let closed = 0;
    s.onFamilyInvalidated(a.token, () => { closed++; });
    s.issue(); s.issue();                   // mint pressure evicts a.token (oldest) while family A is alive
    expect(s.verify(a.token)).toBe(false);  // gone from the live map
    s.revokeFamily(a.token);                // still resolves via the tombstone
    expect(closed).toBe(1);
  });

  it('per-family tombstone cap fail-safe: a breach invalidates the OFFENDING family', () => {
    const c = fixedClock();
    const s = new DashboardSessionStore({ ...CFG, perFamilyTombstoneCap: 3, now: c.now });
    let t = s.issue();
    let invalidated = false;
    for (let i = 0; i < 10; i++) {
      c.advance(5);
      const n = s.refresh(t.token);
      if (n === null) { invalidated = true; break; }
      t = n;
    }
    expect(invalidated).toBe(true);         // breached the cap; the family was killed, nothing minted
    expect(s.verify(t.token)).toBe(false);
  });

  it('family-COUNT bound: a new unlock past the cap invalidates the OLDEST family', () => {
    const c = fixedClock();
    const s = new DashboardSessionStore({ ...CFG, maxFamilies: 2, maxTokens: 16, now: c.now });
    const a = s.issue();
    let aClosed = 0;
    s.onFamilyInvalidated(a.token, () => { aClosed++; });
    const b = s.issue();
    const d = s.issue();                     // 3rd unlock past cap 2 → oldest (A) invalidated
    expect(aClosed).toBe(1);
    expect(s.verify(a.token)).toBe(false);
    expect(s.verify(b.token)).toBe(true);
    expect(s.verify(d.token)).toBe(true);
    expect(s.familyCount()).toBeLessThanOrEqual(2);
  });

  it('prune() invalidates a past-deadline family and closes its streams without a new unlock', () => {
    const c = fixedClock();
    const s = new DashboardSessionStore({ ...CFG, now: c.now });
    const t = s.issue();
    let closed = 0;
    s.onFamilyInvalidated(t.token, () => { closed++; });
    c.advance(CFG.absoluteMaxMs + 1);        // family past its absolute deadline
    s.prune();                               // scheduled sweep — NOT triggered by an issue()
    expect(closed).toBe(1);                  // stream closed by prune, not by the next unlock
    expect(s.familyCount()).toBe(0);
  });

  it('revokeAll also clears tombstones (full reset)', () => {
    const c = fixedClock();
    const s = new DashboardSessionStore({ ...CFG, now: c.now });
    const t1 = s.issue();
    c.advance(5);
    s.refresh(t1.token);                     // creates a tombstone for t1
    expect(s.tombstoneCount()).toBeGreaterThan(0);
    s.revokeAll();
    expect(s.tombstoneCount()).toBe(0);
    expect(s.familyCount()).toBe(0);
    expect(s.refresh(t1.token)).toBeNull();  // a consumed token after reset is just unknown, not a crash
  });

  it('familyLiveForToken stays TRUE across a token rotation (SSE stream must not over-close)', () => {
    const c = fixedClock();
    const s = new DashboardSessionStore({ ...CFG, now: c.now });
    const t1 = s.issue();
    expect(s.familyLiveForToken(t1.token)).toBe(true);
    c.advance(10);
    const t2 = s.refresh(t1.token)!;         // t1 consumed (tombstoned), family still alive
    // a stream opened with the OLD t1 must still read its family as LIVE (not get force-closed)
    expect(s.familyLiveForToken(t1.token)).toBe(true);
    expect(s.familyLiveForToken(t2.token)).toBe(true);
    // ...until the family is actually revoked
    s.revokeFamily(t2.token);
    expect(s.familyLiveForToken(t1.token)).toBe(false);
    expect(s.familyLiveForToken(t2.token)).toBe(false);
    // and a different family is dead past its absolute deadline
    const u = s.issue();
    c.advance(CFG.absoluteMaxMs + 1);
    expect(s.familyLiveForToken(u.token)).toBe(false);
    expect(s.familyLiveForToken(undefined)).toBe(false);
  });
});

import { isDashboardCredentialRoute } from '../../src/server/middleware.js';

describe('isDashboardCredentialRoute (dst_ step-up deny-list)', () => {
  it('flags credential-management routes (step-up required for a scoped token)', () => {
    expect(isDashboardCredentialRoute('POST', '/credentials/swap')).toBe(true);
    expect(isDashboardCredentialRoute('POST', '/credentials/set-default')).toBe(true);
    expect(isDashboardCredentialRoute('GET', '/credentials/locations')).toBe(true); // reading creds too
    expect(isDashboardCredentialRoute('POST', '/identity-recovery/rotate')).toBe(true);
    expect(isDashboardCredentialRoute('GET', '/secrets/pending')).toBe(true);
    expect(isDashboardCredentialRoute('POST', '/dashboard/pin/change')).toBe(true);
    // trailing slash / case tolerant
    expect(isDashboardCredentialRoute('post', '/credentials/swap/')).toBe(true);
  });
  it('does NOT flag ordinary dashboard routes (no step-up)', () => {
    expect(isDashboardCredentialRoute('GET', '/sessions')).toBe(false);
    expect(isDashboardCredentialRoute('GET', '/jobs')).toBe(false);
    expect(isDashboardCredentialRoute('POST', '/telegram/post-update')).toBe(false);
    expect(isDashboardCredentialRoute('GET', '/secrets/drop/abc')).toBe(false); // public drop, own auth
    expect(isDashboardCredentialRoute('GET', '/pin-something-unrelated')).toBe(false); // GET, not a mutation
  });
});
