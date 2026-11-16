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
