import { describe, it, expect } from 'vitest';
import { createProfileRuntimeFence, markProfileRuntimeOwnedStop, assertProfileRuntimeGuard, ProfileRuntimeOwnershipChangedError } from '../../src/core/ProfileRuntimeGuard.js';

describe('profile runtime incarnation fence', () => {
  const harness = () => {
    let session: string | null = 'original'; let epoch = 1; let unreadable = false;
    const guard = createProfileRuntimeFence({ sessionId: 'original', readSessionId: () => { if (unreadable) throw Error('unknown'); return session; }, validAssignment: () => epoch === 1 });
    return { guard, session: (v: string | null) => { session = v; }, epoch: (v: number) => { epoch = v; }, unknown: () => { unreadable = true; } };
  };
  it('permits only its own verified kill transition before replacement creation', () => {
    const h = harness(); expect(h.guard()).toBe(true); h.session(null);
    markProfileRuntimeOwnedStop(h.guard); expect(h.guard()).toBe(true); assertProfileRuntimeGuard(h.guard);
  });
  it('refuses unowned absence permanently', () => {
    const h = harness(); h.session(null); expect(h.guard()).toBe(false); h.session('original'); expect(h.guard()).toBe(false);
  });
  it('refuses a competing replacement during asynchronous preparation', async () => {
    const h = harness(); h.session(null); markProfileRuntimeOwnedStop(h.guard);
    await Promise.resolve(); h.session('replacement');
    expect(() => assertProfileRuntimeGuard(h.guard)).toThrow(ProfileRuntimeOwnershipChangedError);
  });
  it('does not let a failed or competing kill claim owned absence', () => {
    const h = harness(); expect(() => markProfileRuntimeOwnedStop(h.guard)).toThrow(ProfileRuntimeOwnershipChangedError);
  });
  it('fails closed on unreadable session identity', () => { const h = harness(); h.unknown(); expect(h.guard()).toBe(false); });
  it('invalidates the old execution epoch even when assignment values return to A', () => {
    const h = harness(); h.epoch(3); expect(h.guard()).toBe(false); h.epoch(1); expect(h.guard()).toBe(false);
  });
  it('preserves an unchanged execution epoch on reaffirmation', () => { const h = harness(); h.epoch(1); expect(h.guard()).toBe(true); });
  it('does not reinterpret plain existing guard closures as incarnation fences', () => { markProfileRuntimeOwnedStop(() => true); });
});
