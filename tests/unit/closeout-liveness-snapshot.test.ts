/**
 * CloseoutLivenessSnapshot — the machine-local liveness snapshot backing the
 * post-transfer closeout liveness gate (post-transfer-closeout-correctness §Part C).
 *
 * Covers: the empty-fresh-set-is-false rule (NOT unknown), stale→unknown,
 * absent→unknown (+ enqueue for next pass), the terminal-session exclusion +
 * opaque-counts-as-listed predicate, owner-scoped fan-out (zero http when no
 * leftovers), per-pass eviction of departed peers, and the observability breaker
 * (surfaces, never stops; resets on first success).
 */

import { describe, it, expect, vi } from 'vitest';
import {
  CloseoutLivenessSnapshot,
  topicOfPeerSession,
  isTerminalPeerSession,
  type SnapshotDeps,
  type PeerSessionLike,
} from '../../src/monitoring/closeoutLivenessSnapshot.js';

function mkDeps(over: Partial<SnapshotDeps> = {}): { deps: SnapshotDeps; now: { v: number } } {
  const now = { v: 1_000_000 };
  const deps: SnapshotDeps = {
    resolvePeerUrls: () => [{ machineId: 'mac', url: 'http://mac' }],
    fetchPeerSessions: async () => [],
    ownerSet: () => ['mac'],
    now: () => now.v,
    ...over,
  };
  return { deps, now };
}

describe('topicOfPeerSession / isTerminalPeerSession predicates', () => {
  it('extracts a telegram-bound topic id (number or numeric string)', () => {
    expect(topicOfPeerSession({ platform: 'telegram', platformId: 42 })).toBe(42);
    expect(topicOfPeerSession({ platform: 'telegram', platformId: '42' })).toBe(42);
    expect(topicOfPeerSession({ platform: 'headless', platformId: 42 })).toBeNull();
    expect(topicOfPeerSession({ platform: 'telegram' })).toBeNull();
  });
  it('excludes ONLY clearly-terminal statuses; opaque counts as listed', () => {
    expect(isTerminalPeerSession({ status: 'completed' })).toBe(true);
    expect(isTerminalPeerSession({ status: 'killed' })).toBe(true);
    expect(isTerminalPeerSession({ status: 'failed' })).toBe(true);
    expect(isTerminalPeerSession({ status: 'running' })).toBe(false);
    expect(isTerminalPeerSession({ status: 'who-knows' })).toBe(false); // opaque = listed
    expect(isTerminalPeerSession({})).toBe(false);
  });
});

describe('CloseoutLivenessSnapshot — liveness resolution', () => {
  it('a FRESH reached peer with the topic listed → true', async () => {
    const { deps } = mkDeps({
      fetchPeerSessions: async () => [{ platform: 'telegram', platformId: 42, status: 'running' }],
    });
    const snap = new CloseoutLivenessSnapshot(deps, { tickIntervalSec: 120 });
    await snap.refresh();
    expect(snap.remoteOwnerHasLiveSession(42, 'mac').state).toBe(true);
  });

  it('a FRESH reached peer with an EMPTY session set → false (NOT unknown)', async () => {
    const { deps } = mkDeps({ fetchPeerSessions: async () => [] });
    const snap = new CloseoutLivenessSnapshot(deps, { tickIntervalSec: 120 });
    await snap.refresh();
    expect(snap.remoteOwnerHasLiveSession(42, 'mac').state).toBe(false);
  });

  it('a terminal remote session for the topic does NOT count as live → false', async () => {
    const { deps } = mkDeps({
      fetchPeerSessions: async () => [{ platform: 'telegram', platformId: 42, status: 'completed' }],
    });
    const snap = new CloseoutLivenessSnapshot(deps, { tickIntervalSec: 120 });
    await snap.refresh();
    expect(snap.remoteOwnerHasLiveSession(42, 'mac').state).toBe(false);
  });

  it('an ABSENT owner → unknown AND enqueues it for the next pass', async () => {
    const fetched: string[] = [];
    const { deps, now } = mkDeps({
      ownerSet: () => [], // owner not in the regular set this pass
      resolvePeerUrls: () => [{ machineId: 'mac', url: 'http://mac' }],
      fetchPeerSessions: async (p) => { fetched.push(p.machineId); return [{ platform: 'telegram', platformId: 42, status: 'running' }]; },
    });
    const snap = new CloseoutLivenessSnapshot(deps, { tickIntervalSec: 120 });
    await snap.refresh(); // no owners → no fetch
    expect(fetched).toHaveLength(0);
    expect(snap.remoteOwnerHasLiveSession(42, 'mac').state).toBe('unknown'); // enqueues 'mac'
    now.v += 1000;
    await snap.refresh(); // the enqueued owner is now fetched
    expect(fetched).toEqual(['mac']);
    expect(snap.remoteOwnerHasLiveSession(42, 'mac').state).toBe(true);
  });

  it('a STALE entry (older than 2× cadence) → unknown', async () => {
    const { deps, now } = mkDeps({
      fetchPeerSessions: async () => [{ platform: 'telegram', platformId: 42, status: 'running' }],
    });
    const snap = new CloseoutLivenessSnapshot(deps, { tickIntervalSec: 120 }); // bound = 240s
    await snap.refresh();
    expect(snap.remoteOwnerHasLiveSession(42, 'mac').state).toBe(true);
    now.v += 241_000; // age past the bound
    expect(snap.remoteOwnerHasLiveSession(42, 'mac').state).toBe('unknown');
  });

  it('a FAILED fetch does NOT refresh reachableAt → the entry ages to stale → unknown', async () => {
    let fail = false;
    const { deps, now } = mkDeps({
      fetchPeerSessions: async () => { if (fail) throw new Error('down'); return [{ platform: 'telegram', platformId: 42, status: 'running' }]; },
    });
    const snap = new CloseoutLivenessSnapshot(deps, { tickIntervalSec: 120 });
    await snap.refresh();
    expect(snap.remoteOwnerHasLiveSession(42, 'mac').state).toBe(true);
    fail = true;
    now.v += 100_000; await snap.refresh(); // failed → reachableAt NOT bumped
    now.v += 200_000; // total age now > 240s
    expect(snap.remoteOwnerHasLiveSession(42, 'mac').state).toBe('unknown');
  });
});

describe('CloseoutLivenessSnapshot — bounded fan-out + eviction', () => {
  it('does ZERO http when there are no owned-elsewhere leftovers', async () => {
    const fetch = vi.fn(async () => []);
    const { deps } = mkDeps({ ownerSet: () => [], fetchPeerSessions: fetch });
    const snap = new CloseoutLivenessSnapshot(deps, { tickIntervalSec: 120 });
    await snap.refresh();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('evicts a snapshot entry for a peer no longer registered', async () => {
    let registered = [{ machineId: 'mac', url: 'http://mac' }];
    const { deps } = mkDeps({
      resolvePeerUrls: () => registered,
      ownerSet: () => ['mac'],
      fetchPeerSessions: async () => [{ platform: 'telegram', platformId: 42, status: 'running' }],
    });
    const snap = new CloseoutLivenessSnapshot(deps, { tickIntervalSec: 120 });
    await snap.refresh();
    expect(snap.peek('mac')).toBeDefined();
    registered = []; // peer left the pool
    await snap.refresh();
    expect(snap.peek('mac')).toBeUndefined();
  });
});

describe('CloseoutLivenessSnapshot — observability breaker (surface, never stop)', () => {
  it('raises ONE deduped attention item after the threshold; keeps running; resets on first success', async () => {
    let fail = true;
    const raiseAttention = vi.fn();
    const { deps } = mkDeps({
      raiseAttention,
      fetchPeerSessions: async () => { if (fail) throw new Error('down'); return [{ platform: 'telegram', platformId: 42, status: 'running' }]; },
    });
    const snap = new CloseoutLivenessSnapshot(deps, { tickIntervalSec: 120, snapshotBreakerThreshold: 3 });
    await snap.refresh(); await snap.refresh(); // 2 failed passes — below threshold
    expect(raiseAttention).not.toHaveBeenCalled();
    await snap.refresh(); // 3rd failed → breaker trips ONCE
    expect(raiseAttention).toHaveBeenCalledTimes(1);
    expect(snap.breakerFired).toBe(true);
    await snap.refresh(); // 4th failed → still ONE item (deduped, refresher KEPT running)
    expect(raiseAttention).toHaveBeenCalledTimes(1);
    fail = false;
    await snap.refresh(); // success → reset
    expect(snap.breakerFired).toBe(false);
    expect(snap.remoteOwnerHasLiveSession(42, 'mac').state).toBe(true);
  });
});
