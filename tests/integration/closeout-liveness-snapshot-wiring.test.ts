/**
 * Integration — the post-transfer closeout liveness snapshot against a REAL HTTP
 * peer (spec: post-transfer-closeout-correctness §Tests Tier-2).
 *
 *  - Snapshot refresher wiring: a fake peer serving GET /sessions with a session
 *    bound to topic N → remoteOwnerHasLiveSession(N, machineId) === true; remove
 *    the session → next refresh → false (a fresh, reachable peer with an EMPTY set
 *    — empty ≠ unknown); make the peer unreachable → ages to stale → 'unknown'.
 *  - Owner-id parity: the snapshot keys on the SAME stable machineId the closeout
 *    resolves; a NICKNAMED peer still resolves liveness (the machineId-keying
 *    regression-lock).
 *  - Observability breaker: all peers failing for `threshold` passes raises ONE
 *    deduped attention item, the refresher KEEPS running, resets on first success.
 *  - Dep-presence under the gate: the dep delegates to a real snapshot.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import {
  CloseoutLivenessSnapshot,
  type SnapshotDeps,
  type PeerSessionLike,
} from '../../src/monitoring/closeoutLivenessSnapshot.js';

/** Stand up a fake peer serving GET /sessions from a mutable list. */
function fakePeer(): { url: () => string; setSessions: (s: PeerSessionLike[]) => void; close: () => Promise<void>; setDown: (d: boolean) => void } {
  let sessions: PeerSessionLike[] = [];
  let down = false;
  const app = express();
  app.get('/sessions', (_req, res) => {
    if (down) { res.socket?.destroy(); return; }
    res.json(sessions);
  });
  let server: Server;
  const ready = new Promise<void>((resolve) => { server = app.listen(0, () => resolve()); });
  return {
    url: () => { const a = (server!.address() as { port: number }); return `http://127.0.0.1:${a.port}`; },
    setSessions: (s) => { sessions = s; },
    setDown: (d) => { down = d; },
    close: () => new Promise<void>((r) => server!.close(() => r())),
    // @ts-expect-error — ready is awaited by the caller via the returned promise wrapper below
    _ready: ready,
  } as any;
}

const AUTH = 'test-token';

function realFetchDeps(peerMachineId: string, peerUrl: () => string, over: Partial<SnapshotDeps> = {}): SnapshotDeps {
  return {
    resolvePeerUrls: () => [{ machineId: peerMachineId, url: peerUrl() }],
    fetchPeerSessions: async (peer) => {
      const r = await fetch(`${peer.url}/sessions`, { headers: { Authorization: `Bearer ${AUTH}` }, signal: AbortSignal.timeout(2000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return (await r.json()) as PeerSessionLike[];
    },
    ownerSet: () => [peerMachineId],
    now: () => Date.now(),
    ...over,
  };
}

describe('CloseoutLivenessSnapshot — real HTTP peer wiring', () => {
  let peer: ReturnType<typeof fakePeer>;

  beforeAll(async () => {
    peer = fakePeer();
    await (peer as any)._ready;
  });
  afterAll(async () => { await peer.close(); });

  it('true → false(empty-fresh) across a real GET /sessions fan-out', async () => {
    peer.setSessions([{ platform: 'telegram', platformId: 555, status: 'running' }]);
    const snap = new CloseoutLivenessSnapshot(realFetchDeps('mac-mini-stable-id', peer.url), { tickIntervalSec: 1 });
    await snap.refresh();
    expect(snap.remoteOwnerHasLiveSession(555, 'mac-mini-stable-id').state).toBe(true);
    // Remove the session — a fresh, reachable peer with an EMPTY set is `false`.
    peer.setSessions([]);
    await snap.refresh();
    expect(snap.remoteOwnerHasLiveSession(555, 'mac-mini-stable-id').state).toBe(false);
  });

  it('an unreachable peer ages its entry to stale → unknown', async () => {
    peer.setSessions([{ platform: 'telegram', platformId: 777, status: 'running' }]);
    const now = { v: 1_000_000 };
    const snap = new CloseoutLivenessSnapshot(
      realFetchDeps('mac-mini-stable-id', peer.url, { now: () => now.v }),
      { tickIntervalSec: 1 }, // staleness bound = 2s
    );
    await snap.refresh();
    expect(snap.remoteOwnerHasLiveSession(777, 'mac-mini-stable-id').state).toBe(true);
    // Peer goes dark; the failed fetch does NOT bump reachableAt.
    peer.setDown(true);
    now.v += 1500; await snap.refresh();
    now.v += 1000; // total age > 2s bound
    expect(snap.remoteOwnerHasLiveSession(777, 'mac-mini-stable-id').state).toBe('unknown');
    peer.setDown(false);
  });

  it('owner-id parity: liveness keys on the stable machineId even for a NICKNAMED peer', async () => {
    // The closeout resolves owner via topicOwnerElsewhereInfo → { machineId, displayName }.
    // The snapshot must key on `machineId` (stable), NOT displayName (nickname).
    const stableId = 'mac-mini-7f3a';
    const displayName = 'The Mini'; // nickname — must NOT be the key
    peer.setSessions([{ platform: 'telegram', platformId: 999, status: 'running' }]);
    const snap = new CloseoutLivenessSnapshot(realFetchDeps(stableId, peer.url), { tickIntervalSec: 1 });
    await snap.refresh();
    // Looking up by the stable machineId resolves; by the nickname it would not.
    expect(snap.remoteOwnerHasLiveSession(999, stableId).state).toBe(true);
    expect(snap.remoteOwnerHasLiveSession(999, displayName).state).toBe('unknown'); // wrong key → enqueues, withholds
  });
});

describe('CloseoutLivenessSnapshot — observability breaker over a real failing peer', () => {
  it('raises ONE deduped attention item after the threshold; keeps running; resets on success', async () => {
    const peer = fakePeer();
    await (peer as any)._ready;
    peer.setDown(true);
    const raiseAttention = vi.fn();
    const snap = new CloseoutLivenessSnapshot(
      realFetchDeps('peer-x', peer.url, { raiseAttention }),
      { tickIntervalSec: 1, snapshotBreakerThreshold: 3 },
    );
    await snap.refresh(); await snap.refresh();
    expect(raiseAttention).not.toHaveBeenCalled();
    await snap.refresh(); // 3rd consecutive all-failed → trip
    expect(raiseAttention).toHaveBeenCalledTimes(1);
    expect((raiseAttention.mock.calls[0][0] as { id: string }).id).toBe('closeout-snapshot-breaker');
    await snap.refresh(); // still ONE (deduped, KEPT running)
    expect(raiseAttention).toHaveBeenCalledTimes(1);
    peer.setDown(false);
    peer.setSessions([{ platform: 'telegram', platformId: 1, status: 'running' }]);
    await snap.refresh(); // success → reset
    expect(snap.breakerFired).toBe(false);
    expect(snap.remoteOwnerHasLiveSession(1, 'peer-x').state).toBe(true);
    await peer.close();
  });
});
