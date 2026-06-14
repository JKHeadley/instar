/**
 * Tier-2 integration for the snapshot-then-tail substrate (WS2 replicated-store
 * foundation, build-order step 3). Two things a unit test in-process cannot prove:
 *
 *   1. The PROD off-event-loop worker path resolves — `new URL(
 *      './storeSnapshotBuild.worker.js', import.meta.url)` from the engine's dist
 *      import.meta.url builds a bounded snapshot on a real worker thread and does
 *      NOT starve the main event loop (the instar#1069 requirement, mirroring
 *      cartographer-eventloop-worker.test.ts).
 *   2. The `state-snapshot` mesh verb flows through the FULL dispatcher (verify
 *      THEN RBAC THEN handler) as a read/observe-class command — a registered
 *      peer's signed envelope is accepted and routed to the handler, and the
 *      single-origin invariant holds (the holder serves only ITS OWN records).
 *
 * Spec: docs/specs/multi-machine-replicated-store-foundation.md §6.1 (single-
 * origin), §6.3 (cutover off-loop build + breaker), §6.6 (watermark vector).
 *
 * Loaded FROM dist (built by the integration globalSetup) so the worker resolves
 * via the engine's dist import.meta.url — proving the PROD path.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  acceptEnvelope,
  MeshRpcDispatcher,
  type MeshCommand,
  type MeshEnvelope,
  type VerifyEnvelopeDeps,
  type RbacDeps,
} from '../../src/core/MeshRpc.js';
import type { HlcTimestamp } from '../../src/core/HybridLogicalClock.js';
import type {
  StoreSnapshotEngine as StoreSnapshotEngineT,
  SnapshotCache as SnapshotCacheT,
  SnapshotRebuildBreaker as SnapshotRebuildBreakerT,
  RawJournalEntry,
} from '../../src/core/StoreSnapshot.js';

type SnapMod = typeof import('../../src/core/StoreSnapshot.js');
let SnapshotCache: typeof SnapshotCacheT;
let SnapshotRebuildBreaker: typeof SnapshotRebuildBreakerT;
let StoreSnapshotEngine: typeof StoreSnapshotEngineT;

const DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist', 'core');
// These proofs spin up the engine's REAL worker_thread, which can only load the
// COMPILED .js (a worker can't run vitest-transformed TS source). That requires
// `npm run build` first. CI's unit + integration jobs do NOT build dist, so when
// the compiled artifact is absent we SKIP — loudly, never silently — because the
// StoreSnapshot logic is already covered by tests/unit/StoreSnapshot.test.ts and
// the mesh verb by tests/unit/MeshRpc.test.ts. These integration proofs run
// locally (where dist is built) and in any dist-built environment.
const DIST_BUILT = fs.existsSync(path.join(DIST, 'StoreSnapshot.js'));
if (!DIST_BUILT) {
  console.warn(
    '[store-snapshot-mesh] SKIPPED real-worker + mesh-dispatch proofs: dist/core/StoreSnapshot.js ' +
      'not built (run `npm run build`). Logic is covered by tests/unit/StoreSnapshot.test.ts + ' +
      'tests/unit/MeshRpc.test.ts; this file proves the compiled worker_threads prod path.',
  );
}
const describeBuilt = DIST_BUILT ? describe : describe.skip;
beforeAll(async () => {
  if (!DIST_BUILT) return;
  const mod = (await import(/* @vite-ignore */ path.join(DIST, 'StoreSnapshot.js'))) as SnapMod;
  SnapshotCache = mod.SnapshotCache;
  SnapshotRebuildBreaker = mod.SnapshotRebuildBreaker;
  StoreSnapshotEngine = mod.StoreSnapshotEngine;
});

function hlc(physical: number, logical: number, node: string): HlcTimestamp {
  return { physical, logical, node };
}
function entry(seq: number, machine: string, recordKey: string, h: HlcTimestamp): RawJournalEntry {
  return { seq, ts: new Date(h.physical).toISOString(), machine, kind: 'pref-record', data: { recordKey, hlc: h, op: 'put', origin: machine } };
}

describeBuilt('store-snapshot — REAL dist worker (off the event loop, instar#1069)', () => {
  it('builds a bounded snapshot on a real worker thread and serves it', async () => {
    const M = 'machine-A';
    const cache = new SnapshotCache({ maxCachedSnapshots: 4, maxCacheBytes: 1_000_000 });
    const breaker = new SnapshotRebuildBreaker({ now: () => Date.now() });
    const entries: RawJournalEntry[] = [];
    for (let i = 0; i < 2000; i++) entries.push(entry(i + 1, M, `k${i}`, hlc(100 + i, 0, M)));
    const engine = new StoreSnapshotEngine({
      cache,
      breaker,
      seams: { loadOwnEntries: () => ({ 'pref-record': entries }), now: () => Date.now() },
      // runInline omitted ⇒ the real worker path (the instar#1069 off-loop build).
      buildTimeoutMs: 30_000,
    });
    const r = await engine.serveSnapshot('peer', M, 'pref');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.source).toBe('built');
      expect(r.snapshot.origin).toBe(M);
      expect(r.snapshot.records).toHaveLength(2000);
      expect(r.snapshot.watermark.kinds['pref-record'].snapshotSeq).toBe(2000);
    }
  }, 40_000);

  it('a large build does NOT starve the main event loop (max sampled lag < 250ms)', async () => {
    const M = 'machine-A';
    const cache = new SnapshotCache({ maxCachedSnapshots: 4, maxCacheBytes: 256 * 1024 * 1024 });
    const breaker = new SnapshotRebuildBreaker({ now: () => Date.now() });
    const entries: RawJournalEntry[] = [];
    for (let i = 0; i < 60000; i++) entries.push(entry(i + 1, M, `k${i}`, hlc(100 + i, 0, M)));
    const engine = new StoreSnapshotEngine({
      cache,
      breaker,
      seams: { loadOwnEntries: () => ({ 'pref-record': entries }), now: () => Date.now() },
      buildTimeoutMs: 60_000,
    });
    const SAMPLE_MS = 20;
    let maxLag = 0;
    let last = Date.now();
    const timer = setInterval(() => { const now = Date.now(); maxLag = Math.max(maxLag, now - last - SAMPLE_MS); last = now; }, SAMPLE_MS);
    last = Date.now();
    try {
      await engine.serveSnapshot('peer', M, 'pref');
    } finally {
      clearInterval(timer);
    }
    // With the build in the worker, the main loop stays responsive. A main-thread
    // 60k-record fold would spike well past 250ms (the #1069 regression guard).
    expect(maxLag).toBeLessThan(250);
  }, 70_000);
});

describeBuilt('state-snapshot mesh verb — full dispatcher (verify → rbac → handler)', () => {
  // A trivial in-test sign/verify (HMAC-free shared secret) so the dispatcher's
  // 5-step receipt runs end-to-end without real Ed25519 (the crypto is the same
  // injected seam the prod wiring fills — this proves the VERB routes, not crypto).
  const SELF = 'machine-A';
  const PEER = 'machine-B';
  const sign = (canonical: string): string => `sig:${canonical.length}`;
  const verify = (canonical: string, signature: string): boolean => signature === `sig:${canonical.length}`;

  function envFor(command: MeshCommand): MeshEnvelope {
    const parts = { sender: PEER, recipient: SELF, command, epoch: 1, nonce: `n-${Math.random()}`, timestamp: Date.now() };
    return { ...parts, signature: sign(JSON.stringify([parts.sender, parts.recipient, parts.command, parts.epoch, parts.nonce, parts.timestamp])) };
  }

  const verifyDeps = (): VerifyEnvelopeDeps => ({
    selfMachineId: SELF,
    verify: (c, s) => verify(c, s),
    isRegisteredPeer: (s) => s === PEER,
    seenNonce: () => false,
    now: () => Date.now(),
  });
  const rbacDeps: RbacDeps = { routerHolder: () => SELF, ownerOf: () => null, placementTargetOf: () => null };

  it('a signed state-snapshot from a registered peer is ACCEPTED at the gate (read/observe RBAC)', () => {
    const env = envFor({ type: 'state-snapshot', request: { store: 'pref' } });
    expect(acceptEnvelope(env, verifyDeps(), rbacDeps)).toEqual({ ok: true, reason: 'ok' });
  });

  it('routes to a handler that serves a SINGLE-ORIGIN snapshot of the holder (origin === SELF)', async () => {
    const cache = new SnapshotCache({ maxCachedSnapshots: 4, maxCacheBytes: 1_000_000 });
    const breaker = new SnapshotRebuildBreaker({ now: () => Date.now() });
    const engine = new StoreSnapshotEngine({
      cache,
      breaker,
      // The holder serves only its OWN records (single-origin). The loader returns
      // SELF-authored entries; a foreign-origin entry would be dropped anyway.
      seams: { loadOwnEntries: () => ({ 'pref-record': [entry(1, SELF, 'k1', hlc(100, 0, SELF))] }), now: () => Date.now() },
      runInline: true,
    });

    const dispatcher = new MeshRpcDispatcher({
      verify: verifyDeps(),
      rbac: rbacDeps,
      recordNonce: () => {},
      handlers: {
        'state-snapshot': async (cmd, sender) => {
          const c = cmd as MeshCommand & { type: 'state-snapshot' };
          // The origin is ALWAYS this holder (SELF) — never a peer-supplied field.
          const r = await engine.serveSnapshot(sender, SELF, c.request.store);
          if (!r.ok) return { ok: false, reason: r.reason };
          return { ok: true, snapshot: r.snapshot, source: r.source };
        },
      },
    });

    const res = await dispatcher.dispatch(envFor({ type: 'state-snapshot', request: { store: 'pref' } }));
    expect(res.ok).toBe(true);
    if (res.ok) {
      const out = res.result as { ok: boolean; snapshot: { origin: string; records: unknown[] } };
      expect(out.ok).toBe(true);
      expect(out.snapshot.origin).toBe(SELF); // single-origin: the holder's own id
      expect(out.snapshot.records).toHaveLength(1);
    }
  });

  it('the Step-3 substrate handler answers no-entries when no store kind is registered (strict no-op)', async () => {
    const cache = new SnapshotCache({ maxCachedSnapshots: 4, maxCacheBytes: 1_000_000 });
    const breaker = new SnapshotRebuildBreaker({ now: () => Date.now() });
    const engine = new StoreSnapshotEngine({
      cache,
      breaker,
      seams: { loadOwnEntries: () => ({}), now: () => Date.now() }, // empty registry = no contributing kinds
      runInline: true,
    });
    const dispatcher = new MeshRpcDispatcher({
      verify: verifyDeps(),
      rbac: rbacDeps,
      recordNonce: () => {},
      handlers: {
        'state-snapshot': async (cmd, sender) => {
          const c = cmd as MeshCommand & { type: 'state-snapshot' };
          const r = await engine.serveSnapshot(sender, SELF, c.request.store);
          if (!r.ok) return { ok: false, reason: r.reason };
          return { ok: true };
        },
      },
    });
    const res = await dispatcher.dispatch(envFor({ type: 'state-snapshot', request: { store: 'pref' } }));
    expect(res.ok).toBe(true);
    if (res.ok) expect((res.result as { ok: boolean; reason?: string })).toEqual({ ok: false, reason: 'no-entries' });
  });
});
