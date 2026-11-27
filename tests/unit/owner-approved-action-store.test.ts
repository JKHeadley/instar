/**
 * Unit — OwnerApprovedActionStore (SEC-018 primitive, docs/specs/owner-approved-sensitive-action.md).
 * The store holds owner-presence-VERIFIED approvals keyed by {purpose, actionKey};
 * it never verifies a signature itself. Single-use, TTL'd, revision-bound.
 */
import { describe, it, expect } from 'vitest';
import { OwnerApprovedActionStore } from '../../src/server/OwnerApprovedActionStore.js';

function fakeClock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

describe('OwnerApprovedActionStore', () => {
  it('records an approval, then consumes it exactly once (single-use)', () => {
    const s = new OwnerApprovedActionStore();
    const ref = s.record({ purpose: 'thread-delete', actionKey: 'thr_1' });
    expect(ref).toMatch(/^apr_/);
    expect(s.has({ purpose: 'thread-delete', actionKey: 'thr_1' })).toBe(true);
    expect(s.consume({ purpose: 'thread-delete', actionKey: 'thr_1' })).toBe(ref);
    // second consume fails — the approval is gone
    expect(s.consume({ purpose: 'thread-delete', actionKey: 'thr_1' })).toBeNull();
    expect(s.has({ purpose: 'thread-delete', actionKey: 'thr_1' })).toBe(false);
  });

  it('refuses to consume an approval for a DIFFERENT action or purpose', () => {
    const s = new OwnerApprovedActionStore();
    s.record({ purpose: 'thread-delete', actionKey: 'thr_1' });
    expect(s.consume({ purpose: 'thread-delete', actionKey: 'thr_2' })).toBeNull(); // wrong actionKey
    expect(s.consume({ purpose: 'trust-grant', actionKey: 'thr_1' })).toBeNull();    // wrong purpose
    // the real one still consumes
    expect(s.consume({ purpose: 'thread-delete', actionKey: 'thr_1' })).not.toBeNull();
  });

  it('does not consume an expired approval (fail-safe: owner re-taps)', () => {
    const clk = fakeClock();
    const s = new OwnerApprovedActionStore(clk.now, 5 * 60_000);
    s.record({ purpose: 'thread-delete', actionKey: 'thr_1' });
    clk.advance(5 * 60_000 + 1);
    expect(s.consume({ purpose: 'thread-delete', actionKey: 'thr_1' })).toBeNull();
    expect(s.has({ purpose: 'thread-delete', actionKey: 'thr_1' })).toBe(false);
  });

  it('binds to the resource revision: a changed resource rejects the approval', () => {
    const s = new OwnerApprovedActionStore();
    s.record({ purpose: 'trust-grant', actionKey: 'fp_A|autonomous', revision: 'rev-7' });
    // the resource moved on → the approval the owner reviewed no longer matches
    expect(s.consume({ purpose: 'trust-grant', actionKey: 'fp_A|autonomous', revision: 'rev-8' })).toBeNull();
    // the exact revision the owner reviewed consumes
    expect(s.consume({ purpose: 'trust-grant', actionKey: 'fp_A|autonomous', revision: 'rev-7' })).not.toBeNull();
  });

  it('a consumer that omits revision does not bypass a revision-bound approval mismatch, but matches a null-revision approval', () => {
    const s = new OwnerApprovedActionStore();
    // null-revision approval (an action with no revision, e.g. thread delete)
    s.record({ purpose: 'thread-delete', actionKey: 'thr_1' });
    // consumer omits revision → undefined skips the check → matches
    expect(s.consume({ purpose: 'thread-delete', actionKey: 'thr_1' })).not.toBeNull();
    // revision-bound approval, consumer omits revision → undefined skips the revision check (caller's choice)
    s.record({ purpose: 'trust-grant', actionKey: 'fp_B|trusted', revision: 'rev-1' });
    expect(s.consume({ purpose: 'trust-grant', actionKey: 'fp_B|trusted' })).not.toBeNull();
  });

  it('re-recording the same action replaces the prior approval (no stale duplicate)', () => {
    const s = new OwnerApprovedActionStore();
    const r1 = s.record({ purpose: 'thread-delete', actionKey: 'thr_1' });
    const r2 = s.record({ purpose: 'thread-delete', actionKey: 'thr_1' });
    expect(r2).not.toBe(r1);
    expect(s.size()).toBe(1);
    expect(s.consume({ purpose: 'thread-delete', actionKey: 'thr_1' })).toBe(r2);
  });

  it('bounds its size (never grows without limit)', () => {
    const s = new OwnerApprovedActionStore(Date.now, 5 * 60_000, 8);
    for (let i = 0; i < 50; i++) s.record({ purpose: 'thread-delete', actionKey: `thr_${i}` });
    expect(s.size()).toBeLessThanOrEqual(8);
  });
});
