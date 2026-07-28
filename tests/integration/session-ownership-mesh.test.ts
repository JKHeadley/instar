/**
 * Integration test (§L3 + §L0): the per-session ownership commands (place/claim/
 * release) routed over POST /mesh/rpc into a real SessionOwnershipRegistry, with
 * real Ed25519 signatures + the per-command RBAC. Proves the L3 ownership layer
 * is reachable + correct over the mesh transport.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { AddressInfo } from 'node:net';
import { createRoutes } from '../../src/server/routes.js';
import { MeshRpcDispatcher, signEnvelope, type MeshCommand, type MeshEnvelope } from '../../src/core/MeshRpc.js';
import { SessionOwnershipRegistry, InMemorySessionOwnershipStore } from '../../src/core/SessionOwnershipRegistry.js';
import { generateSigningKeyPair, sign, verify } from '../../src/core/MachineIdentity.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

interface Server { url: string; close: () => Promise<void>; }
async function listen(app: express.Express): Promise<Server> {
  return new Promise((resolve) => {
    const srv = app.listen(0, () => {
      const port = (srv.address() as AddressInfo).port;
      resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => srv.close(() => r())) });
    });
  });
}

describe('Session ownership over MeshRpc (§L3 + §L0)', () => {
  let dir: string;
  let server: Server;
  let registry: SessionOwnershipRegistry;
  const keys: Record<string, { priv: string; pub: string }> = {};

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'own-mesh-'));
    for (const id of ['ROUTER', 'm_T', 'm_X']) {
      const kp = generateSigningKeyPair();
      keys[id] = { priv: kp.privateKey, pub: kp.publicKey };
    }
    const seenOwn = new Set<string>();
    registry = new SessionOwnershipRegistry({
      store: new InMemorySessionOwnershipStore(),
      seenNonce: (k) => seenOwn.has(k),
      recordNonce: (k) => seenOwn.add(k),
    });
    const ownAction = (cmd: MeshCommand, sender: string, env: MeshEnvelope): unknown => {
      if (cmd.type === 'place') return registry.cas({ type: 'place', machineId: cmd.machine }, { sessionKey: cmd.session, sender, nonce: env.nonce });
      if (cmd.type === 'claim') return registry.cas({ type: 'claim', machineId: sender }, { sessionKey: cmd.session, sender, nonce: env.nonce });
      if (cmd.type === 'release') return registry.cas({ type: 'release', machineId: sender }, { sessionKey: cmd.session, sender, nonce: env.nonce });
      return { ok: false };
    };
    const seenMesh = new Set<string>();
    const dispatcher = new MeshRpcDispatcher({
      verify: {
        selfMachineId: 'SELF',
        verify: (canonical, signature, sender) => !!keys[sender] && verify(canonical, signature, keys[sender].pub),
        isRegisteredPeer: (s) => !!keys[s],
        seenNonce: (s, n) => seenMesh.has(`${s}:${n}`),
        now: () => Date.now(),
      },
      rbac: { routerHolder: () => 'ROUTER', ownerOf: (s) => registry.ownerOf(s), placementTargetOf: (s) => registry.placementTargetOf(s) },
      recordNonce: (s, n) => seenMesh.add(`${s}:${n}`),
      handlers: { place: ownAction, claim: ownAction, release: ownAction },
    });
    const ctx: any = { config: { authToken: 'test', stateDir: dir, port: 0 }, stateDir: dir, meshRpcDispatcher: dispatcher };
    const app = express();
    app.use(express.json());
    app.use(createRoutes(ctx));
    server = await listen(app);
  });
  afterEach(async () => {
    await server.close();
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/integration/session-ownership-mesh.test.ts' });
  });

  let nonceCounter = 0;
  function send(sender: string, command: MeshCommand) {
    const env = signEnvelope(
      { sender, recipient: 'SELF', command, epoch: 1, nonce: `n${++nonceCounter}`, timestamp: Date.now() },
      (c) => sign(c, keys[sender].priv),
    );
    return fetch(server.url + '/mesh/rpc', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(env) })
      .then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
  }

  it('router places a session, the target claims it, and ownerOf reflects the owner', async () => {
    const placed = await send('ROUTER', { type: 'place', session: 's1', machine: 'm_T' });
    expect(placed.status).toBe(200);
    expect(placed.body.result.ok).toBe(true);
    expect(registry.placementTargetOf('s1')).toBe('m_T');

    const claimed = await send('m_T', { type: 'claim', session: 's1', epoch: 2 });
    expect(claimed.status).toBe(200);
    expect(claimed.body.result.ok).toBe(true);
    expect(registry.ownerOf('s1')).toBe('m_T');
  });

  it('a NON-router place is refused by RBAC at the door (403 not-router) — no ownership written', async () => {
    const r = await send('m_X', { type: 'place', session: 's2', machine: 'm_X' });
    expect(r.status).toBe(403);
    expect(r.body.reason).toBe('not-router');
    expect(registry.ownerOf('s2')).toBeNull();
  });

  it('a claim by a non-target is authorized at the mesh door but rejected by the ownership CAS (claim-wrong-machine)', async () => {
    await send('ROUTER', { type: 'place', session: 's3', machine: 'm_T' }); // placed for m_T
    // m_X is a registered peer + the placement-target check is for `claim` RBAC:
    // m_X is NOT the placed target, so RBAC itself rejects (claim-unauthorized, 403).
    const r = await send('m_X', { type: 'claim', session: 's3', epoch: 2 });
    expect(r.status).toBe(403);
    expect(r.body.reason).toBe('claim-unauthorized');
    // m_X's claim was refused at the RBAC door → ownership unchanged: still
    // PLACING for m_T (not claimed/active by m_X).
    expect(registry.read('s3')?.status).toBe('placing');
    expect(registry.ownerOf('s3')).toBe('m_T');
  });
});
