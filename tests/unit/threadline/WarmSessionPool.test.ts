/**
 * Unit tests for the Layer 2 warm-session registry. Injected clock → deterministic TTL/LRU.
 * Covers: caps (global + per-peer) with LRU eviction, refresh-in-place, TTL expiry, pressure reap.
 */
import { describe, it, expect } from 'vitest';
import { WarmSessionPool, type WarmSessionPoolConfig } from '../../../src/threadline/WarmSessionPool.js';

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
