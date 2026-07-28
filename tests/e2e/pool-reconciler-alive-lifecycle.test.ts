/**
 * Tier-3 "feature is alive" E2E for the WS1.3 OwnershipReconciler — the cross-machine
 * stuck-move fix (root causes #1/#2/#3). Per CLAUDE.md the Tier-3 test is "the single
 * most important test for any feature with API routes": it proves GET /pool/reconciler
 * is reachable through the REAL AgentServer stack (auth middleware, error handling) and
 * returns 200 — NOT 503 because the reconciler wasn't wired — AND that the reconciler
 * actually CONVERGES a pinned topic (owner != pin -> transfer) through the real stack.
 *
 * WHY THIS TIER EXISTS HERE: the reconciler had NO tests/e2e/ coverage proving the
 * /pool/reconciler route is alive (200, not 503) and the reconciler actually converges
 * through the real AgentServer stack — only unit + integration tests that construct the
 * reconciler by hand. A feature-alive E2E is the category that catches "the dep wasn't
 * wired" defects — the same class as the boot-ordering bugs (#1312/#1313) that shipped
 * because nothing exercised the reconciler as a live wired dependency (those were caught
 * only by a live two-machine run). Like its sibling pool-placement-transfer-alive, this
 * wires AgentServer directly (it does not re-run server.ts's boot sequence), so it proves
 * the route + the convergence are alive end-to-end; the server.ts construction ordering
 * itself is asserted by OwnershipReconciler.test.ts's late-bound-dep regression tests.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { SessionManager } from '../../src/core/SessionManager.js';
import { SessionOwnershipRegistry, InMemorySessionOwnershipStore } from '../../src/core/SessionOwnershipRegistry.js';
import { TopicPlacementPinStore } from '../../src/core/TopicPlacementPinStore.js';
import { OwnershipReconciler } from '../../src/core/OwnershipReconciler.js';
import type { InstarConfig } from '../../src/core/types.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

describe('E2E: OwnershipReconciler is ALIVE + converges through the real AgentServer', () => {
  const PORT = 47261;
  const SELF = 'm_a'; // owns topic 700
  const PEER = 'm_b'; // pin target — the reconciler should transfer 700 SELF -> PEER
  const TOKEN = 'e2e-recon-token';
  let dir: string;
  let server: AgentServer;
  let reconciler: OwnershipReconciler;
  let ownReg: SessionOwnershipRegistry;
  const base = `http://127.0.0.1:${PORT}`;
  const auth = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recon-alive-e2e-'));
    const seen = new Set<string>();
    ownReg = new SessionOwnershipRegistry({
      store: new InMemorySessionOwnershipStore(),
      seenNonce: (k) => seen.has(k),
      recordNonce: (k) => seen.add(k),
    });
    // SELF actively owns topic 700.
    ownReg.cas({ type: 'place', machineId: SELF }, { sessionKey: '700', sender: SELF, nonce: 'p' });
    ownReg.cas({ type: 'claim', machineId: SELF }, { sessionKey: '700', sender: SELF, nonce: 'c' });
    const pinStore = new TopicPlacementPinStore({ filePath: path.join(dir, 'topic-pins.json') });
    pinStore.set('700', PEER); // pinned away -> the reconciler must transfer 700 to PEER

    reconciler = new OwnershipReconciler({
      enabled: () => true,
      dryRun: () => false,
      selfMachineId: () => SELF,
      pinStore: () => pinStore,
      ownership: ownReg,
      machines: () => [
        { machineId: SELF, online: true, lastSeenMs: Date.now() },
        { machineId: PEER, online: true, lastSeenMs: Date.now() },
      ],
      isTopicBusy: () => false,
      emitPlacement: () => {},
      debounceMs: 0,
    });

    const config = {
      projectName: 'recon-alive-e2e',
      projectDir: dir,
      stateDir: dir,
      port: PORT,
      authToken: TOKEN,
    } as unknown as InstarConfig;

    server = new AgentServer({
      config,
      sessionManager: new SessionManager({ projectDir: dir, port: PORT }),
      state: new StateManager(dir),
      sessionOwnershipRegistry: ownReg,
      ownershipReconciler: reconciler,
      meshSelfId: SELF,
    });
    await server.start();
  }, 20000);

  afterAll(async () => {
    await server?.stop();
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/e2e/pool-reconciler-alive-lifecycle.test.ts' });
  });

  it('GET /pool/reconciler is ALIVE (200, not 503) — the reconciler is wired through the real stack', async () => {
    const res = await fetch(`${base}/pool/reconciler`, { headers: auth });
    expect(res.status).toBe(200); // 503 here is the boot-ordering "never constructed" bug
    const body = await res.json();
    expect(body.status).toBeTruthy();
    expect(body.status.machinesCount).toBe(2);
    expect(body.status.selfMachineId).toBe(SELF);
    expect(body.status.enabled).toBe(true);
  });

  it('GET /pool/reconciler?topic=N explains the convergence decision (owner != pin -> transfer)', async () => {
    const res = await fetch(`${base}/pool/reconciler?topic=700`, { headers: auth });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.topic.decision).toBe('transfer');
    expect(body.topic.preferredMachine).toBe(PEER);
  });

  it('the reconciler CONVERGES the pinned topic: one tick transfers 700 SELF -> PEER through the real stack', async () => {
    reconciler.tick();
    // The owner set the topic transferring toward the pin target (the cross-machine handoff start).
    const rec = ownReg.read('700');
    expect(rec?.status).toBe('transferring');
    expect(rec?.transferTo).toBe(PEER);
    // And the live status route reflects the transfer the reconciler just performed.
    const res = await fetch(`${base}/pool/reconciler`, { headers: auth });
    const body = await res.json();
    expect(body.status.lastReport?.transfers).toBe(1);
  });

  it('GET /pool/reconciler sits behind auth (401/403 without a Bearer token) — proves the real middleware stack', async () => {
    const res = await fetch(`${base}/pool/reconciler`);
    expect([401, 403]).toContain(res.status);
  });
});
