/**
 * Unit tests for the Layer 2 warm-session registry. Injected clock → deterministic TTL/LRU.
 * Covers: caps (global + per-peer) with LRU eviction, refresh-in-place, TTL expiry, pressure reap.
 */
import { describe, it, expect } from 'vitest';
import {
  WarmSessionPool,
  WarmSessionPeerConflictError,
  type WarmSessionPoolConfig,
} from '../../../src/threadline/WarmSessionPool.js';

const CFG: WarmSessionPoolConfig = { globalCap: 3, perPeerCap: 2, ttlMs: 10_000 };

function mk(over: Partial<WarmSessionPoolConfig> = {}) {
  const clock = { t: 0 };
  const pool = new WarmSessionPool({ ...CFG, ...over }, () => clock.t);
  return { pool, clock };
}

describe('WarmSessionPool', () => {
  it('admits under the caps with no eviction', () => {
    const { pool } = mk();
    expect(pool.admit({ threadId: 'a', peerId: 'p1', sessionName: 's-a' })).toEqual([]);
    expect(pool.admit({ threadId: 'b', peerId: 'p2', sessionName: 's-b' })).toEqual([]);
    expect(pool.size()).toBe(2);
  });

  it('refreshes an existing thread in place (no eviction, updates sessionName + LRU)', () => {
    const { pool, clock } = mk();
    pool.admit({ threadId: 'a', peerId: 'p1', sessionName: 's-a' });
    clock.t = 5_000;
    const evicted = pool.admit({ threadId: 'a', peerId: 'p1', sessionName: 's-a2' });
    expect(evicted).toEqual([]);
    expect(pool.get('a')?.sessionName).toBe('s-a2');
    expect(pool.size()).toBe(1);
  });

  it('refuses to cross-bind an existing thread to a DIFFERENT peer (security)', () => {
    const { pool } = mk();
    pool.admit({ threadId: 'a', peerId: 'p1', sessionName: 's-a' });
    // A different peer presenting the same threadId must NOT overwrite the owner.
    expect(() => pool.admit({ threadId: 'a', peerId: 'EVIL', sessionName: 's-evil' }))
      .toThrow(WarmSessionPeerConflictError);
    // Owner's record is untouched: same peer, original sessionName.
    const rec = pool.get('a');
    expect(rec?.peerId).toBe('p1');
    expect(rec?.sessionName).toBe('s-a');
    expect(pool.size()).toBe(1);
  });

  it('the peer-conflict error carries the threadId + both peer ids', () => {
    const { pool } = mk();
    pool.admit({ threadId: 'a', peerId: 'p1', sessionName: 's-a' });
    try {
      pool.admit({ threadId: 'a', peerId: 'p2', sessionName: 's-b' });
      throw new Error('expected WarmSessionPeerConflictError');
    } catch (err) {
      expect(err).toBeInstanceOf(WarmSessionPeerConflictError);
      const e = err as WarmSessionPeerConflictError;
      expect(e.threadId).toBe('a');
      expect(e.existingPeerId).toBe('p1');
      expect(e.attemptedPeerId).toBe('p2');
    }
  });

  it('same-peer refresh after a would-be conflict still works (no false positive)', () => {
    const { pool, clock } = mk();
    pool.admit({ threadId: 'a', peerId: 'p1', sessionName: 's-a' });
    clock.t = 1_000;
    // Same peer → in-place refresh, never throws.
    expect(() => pool.admit({ threadId: 'a', peerId: 'p1', sessionName: 's-a2' })).not.toThrow();
    expect(pool.get('a')?.sessionName).toBe('s-a2');
  });

  it('evicts the peer LRU when the per-peer cap would be exceeded', () => {
    const { pool, clock } = mk();
    pool.admit({ threadId: 'a', peerId: 'p1', sessionName: 's-a' }); // t0
    clock.t = 1_000;
    pool.admit({ threadId: 'b', peerId: 'p1', sessionName: 's-b' }); // p1 now at cap (2)
    clock.t = 2_000;
    const evicted = pool.admit({ threadId: 'c', peerId: 'p1', sessionName: 's-c' });
    // p1's LRU ('a') is evicted to make room for 'c'
    expect(evicted.map(r => r.threadId)).toEqual(['a']);
    expect(pool.get('a')).toBeUndefined();
    expect(pool.get('b')).toBeDefined();
    expect(pool.get('c')).toBeDefined();
  });

  it('evicts the global LRU when the global cap would be exceeded (across peers)', () => {
    const { pool, clock } = mk();
    pool.admit({ threadId: 'a', peerId: 'p1', sessionName: 's-a' }); // t0 (global LRU)
    clock.t = 1_000;
    pool.admit({ threadId: 'b', peerId: 'p2', sessionName: 's-b' });
    clock.t = 2_000;
    pool.admit({ threadId: 'c', peerId: 'p3', sessionName: 's-c' }); // global now at cap (3)
    clock.t = 3_000;
    const evicted = pool.admit({ threadId: 'd', peerId: 'p4', sessionName: 's-d' });
    expect(evicted.map(r => r.threadId)).toEqual(['a']); // global LRU
    expect(pool.size()).toBe(3);
  });

  it('treats a session past its idle TTL as absent', () => {
    const { pool, clock } = mk();
    pool.admit({ threadId: 'a', peerId: 'p1', sessionName: 's-a' });
    clock.t = 9_999;
    expect(pool.get('a')).toBeDefined();
    clock.t = 10_000; // == ttlMs since lastUsed
    expect(pool.get('a')).toBeUndefined();
  });

  it('touch refreshes the idle clock', () => {
    const { pool, clock } = mk();
    pool.admit({ threadId: 'a', peerId: 'p1', sessionName: 's-a' });
    clock.t = 8_000;
    pool.touch('a');
    clock.t = 17_000; // 9s since touch < ttl
    expect(pool.get('a')).toBeDefined();
  });

  it('reapExpired returns and removes only the idle-past-TTL sessions', () => {
    const { pool, clock } = mk();
    pool.admit({ threadId: 'a', peerId: 'p1', sessionName: 's-a' }); // t0
    clock.t = 5_000;
    pool.admit({ threadId: 'b', peerId: 'p2', sessionName: 's-b' }); // t5000
    clock.t = 12_000; // 'a' idle 12s (>10), 'b' idle 7s (<10)
    const reaped = pool.reapExpired();
    expect(reaped.map(r => r.threadId)).toEqual(['a']);
    expect(pool.size()).toBe(1);
  });

  it('peek returns the raw record IGNORING the idle TTL (unlike get)', () => {
    const { pool, clock } = mk();
    pool.admit({ threadId: 'a', peerId: 'p1', sessionName: 's-a' });
    clock.t = 10_000; // past TTL — get() would return undefined
    expect(pool.get('a')).toBeUndefined();
    // peek still resolves the record (used for pre-spawn peer-conflict checks).
    expect(pool.peek('a')?.peerId).toBe('p1');
    expect(pool.peek('missing')).toBeUndefined();
  });

  it('reapUnderPressure evicts the n global LRU', () => {
    const { pool, clock } = mk({ globalCap: 5, perPeerCap: 5 });
    pool.admit({ threadId: 'a', peerId: 'p1', sessionName: 's-a' }); // t0 oldest
    clock.t = 1_000;
    pool.admit({ threadId: 'b', peerId: 'p1', sessionName: 's-b' });
    clock.t = 2_000;
    pool.admit({ threadId: 'c', peerId: 'p1', sessionName: 's-c' });
    const reaped = pool.reapUnderPressure(2);
    expect(reaped.map(r => r.threadId)).toEqual(['a', 'b']); // 2 LRU
    expect(pool.size()).toBe(1);
  });
});
