/**
 * F7 Piece 1 — SpawningTopicsRegistry (docs/specs/verify-after-reachability.md §Piece 1).
 *
 * Locks the ABA token-guard (a late `.finally` from a superseded spawn cannot delete a
 * newer entry), the `.finally`-is-the-sole-clearer property (no timeout/sweep), and the
 * stuck-detection seam the verifier reads.
 */
import { describe, it, expect } from 'vitest';
import { SpawningTopicsRegistry } from '../../src/core/SpawningTopicsRegistry.js';

describe('SpawningTopicsRegistry', () => {
  it('add → has true; clear with the right token → has false', () => {
    const r = new SpawningTopicsRegistry();
    const t = r.add(42);
    expect(r.has(42)).toBe(true);
    r.clear(42, t);
    expect(r.has(42)).toBe(false);
  });

  it('clear with a STALE token is a no-op (does not delete a newer entry — the ABA fix)', () => {
    const r = new SpawningTopicsRegistry();
    const tokenA = r.add(7); // spawn A
    const tokenB = r.add(7); // spawn B supersedes A (e.g. A wedged, registry re-added)
    expect(tokenA).not.toBe(tokenB);
    // A's late .finally fires with A's token → must NOT delete B's entry
    r.clear(7, tokenA);
    expect(r.has(7)).toBe(true);
    // B's own .finally clears it
    r.clear(7, tokenB);
    expect(r.has(7)).toBe(false);
  });

  it('clear is the SOLE clearer — nothing else removes an entry over time', () => {
    let now = 1000;
    const r = new SpawningTopicsRegistry({ now: () => now });
    r.add(9);
    now += 10 * 60_000; // 10 minutes pass — no timeout, no sweep
    expect(r.has(9)).toBe(true); // a hung spawn KEEPS its flag (surfaced, never auto-cleared)
  });

  it('stuckSinceMs returns the in-flight age; undefined for an unknown topic', () => {
    let now = 5000;
    const r = new SpawningTopicsRegistry({ now: () => now });
    r.add(3);
    now = 5000 + 190_000; // 190s later
    expect(r.stuckSinceMs(3, now)).toBe(190_000);
    expect(r.stuckSinceMs(999, now)).toBeUndefined();
  });

  it('entries() snapshots currently-spawning topics with their start time', () => {
    let now = 100;
    const r = new SpawningTopicsRegistry({ now: () => now });
    r.add(1);
    now = 250;
    r.add(2);
    const e = r.entries().sort((a, b) => a.topic - b.topic);
    expect(e).toEqual([
      { topic: 1, startedAtMs: 100 },
      { topic: 2, startedAtMs: 250 },
    ]);
    expect(r.size()).toBe(2);
  });
});
