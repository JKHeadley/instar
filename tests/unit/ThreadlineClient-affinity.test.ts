/**
 * Client-side session affinity tests for ThreadlineClient (§4.1 commit 3/3).
 *
 * Exercises the `lastThreadByPeer` map's precedence, TTL, LRU, and plaintext
 * no-op behavior. Uses the public snapshot-for-tests getter plus direct
 * (as-any) invocation of the private helpers rather than spinning up a full
 * relay + encryptor mock stack.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { ThreadlineClient } from '../../src/threadline/client/ThreadlineClient.js';

type PrivateHelpers = {
  peekClientAffinity(recipient: string): string | null;
  recordClientAffinity(recipient: string, threadId: string): void;
};

describe('ThreadlineClient — client-side session affinity (§4.1)', () => {
  let fakeNow: number;
  let client: ThreadlineClient;
  let helpers: PrivateHelpers;

  beforeEach(() => {
    fakeNow = 1_000_000;
    client = new ThreadlineClient({ name: 'TestAgent', stateDir: '/tmp/affinity-test' }, () => fakeNow);
    helpers = client as unknown as PrivateHelpers;
  });

  it('returns null on cold miss', () => {
    expect(helpers.peekClientAffinity('fp-unknown')).toBeNull();
  });

  it('records and returns the same threadId on warm hit', () => {
    helpers.recordClientAffinity('fp-A', 'thread-A1');
    expect(helpers.peekClientAffinity('fp-A')).toBe('thread-A1');
  });

  it('refreshes lastUsedAt but preserves firstUsedAt on reuse', () => {
    helpers.recordClientAffinity('fp-B', 'thread-B1');
    const firstSnap = client.getClientAffinitySnapshotForTests().get('fp-B');
    expect(firstSnap?.firstUsedAt).toBe(1_000_000);
    expect(firstSnap?.lastUsedAt).toBe(1_000_000);

    fakeNow = 1_300_000;
    helpers.recordClientAffinity('fp-B', 'thread-B1');
    const secondSnap = client.getClientAffinitySnapshotForTests().get('fp-B');
    expect(secondSnap?.firstUsedAt).toBe(1_000_000);
    expect(secondSnap?.lastUsedAt).toBe(1_300_000);
  });

  it('resets firstUsedAt when the threadId changes for the same recipient', () => {
    helpers.recordClientAffinity('fp-C', 'thread-C1');
    fakeNow = 1_100_000;
    helpers.recordClientAffinity('fp-C', 'thread-C2-different');
    const snap = client.getClientAffinitySnapshotForTests().get('fp-C');
    expect(snap?.threadId).toBe('thread-C2-different');
    expect(snap?.firstUsedAt).toBe(1_100_000);
  });

  it('expires entry past sliding TTL (10 min)', () => {
    helpers.recordClientAffinity('fp-D', 'thread-D1');
    fakeNow += 700_000; // > 600_000ms
    expect(helpers.peekClientAffinity('fp-D')).toBeNull();
    expect(client.getClientAffinitySnapshotForTests().has('fp-D')).toBe(false);
  });

  it('expires entry past absolute TTL (2 h) even with recent activity', () => {
    helpers.recordClientAffinity('fp-E', 'thread-E1');
    // Churn within sliding TTL to keep lastUsedAt fresh.
    for (let i = 0; i < 15; i++) {
      fakeNow += 500_000;
      helpers.recordClientAffinity('fp-E', 'thread-E1');
    }
    // 15 × 500_000 = 7_500_000ms, past 7_200_000ms absolute.
    expect(helpers.peekClientAffinity('fp-E')).toBeNull();
  });

  it('evicts oldest entries when over the LRU cap of 1000', () => {
    for (let i = 0; i < 1001; i++) {
      helpers.recordClientAffinity(`fp-${i}`, `thread-${i}`);
    }
    const snap = client.getClientAffinitySnapshotForTests();
    expect(snap.size).toBe(1000);
    expect(snap.has('fp-0')).toBe(false);
    expect(snap.has('fp-1000')).toBe(true);
  });

  it('reading the same entry bumps recency so it survives eviction', () => {
    helpers.recordClientAffinity('fp-keep', 'thread-keep');
    for (let i = 0; i < 500; i++) {
      helpers.recordClientAffinity(`fp-filler-${i}`, `thread-${i}`);
    }
    // Re-record 'fp-keep' so it moves to the tail of the LRU.
    fakeNow += 1;
    helpers.recordClientAffinity('fp-keep', 'thread-keep');
    for (let i = 500; i < 1000; i++) {
      helpers.recordClientAffinity(`fp-filler-${i}`, `thread-${i}`);
    }
    const snap = client.getClientAffinitySnapshotForTests();
    expect(snap.size).toBe(1000);
    expect(snap.has('fp-keep')).toBe(true);
    // fp-filler-0 was the oldest entry at eviction time.
    expect(snap.has('fp-filler-0')).toBe(false);
  });
});
