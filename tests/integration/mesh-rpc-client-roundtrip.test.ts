/**
 * Integration test (§L0): MeshRpcClient (send) → real MeshRpcDispatcher (receive)
 * over a loopback /mesh/rpc, with real Ed25519 keys. Proves the full m2m round-trip:
 * a signed, recipient-bound command is accepted + handled (200 + result), RBAC
 * rejections map to the typed reason/status (403 not-router), and a transport error
 * throws (so the caller's retry loop can catch it).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { AddressInfo } from 'node:net';
import { createRoutes } from '../../src/server/routes.js';
import { MeshRpcDispatcher, type MeshCommand } from '../../src/core/MeshRpc.js';
import { MeshRpcClient } from '../../src/core/MeshRpcClient.js';
import { generateSigningKeyPair, sign, verify } from '../../src/core/MachineIdentity.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

interface Server { url: string; close: () => Promise<void>; }
async function listen(app: express.Express): Promise<Server> {
  return new Promise((resolve) => {
    const srv = app.listen(0, () => resolve({ url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`, close: () => new Promise<void>((r) => srv.close(() => r())) }));
  });
}

describe('MeshRpcClient → MeshRpcDispatcher round-trip (§L0)', () => {
  let dir: string;
  let server: Server;
  let delivered: string[];
  const keys: Record<string, { priv: string; pub: string }> = {};

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-client-'));
    delivered = [];
    for (const id of ['ROUTER', 'OWNER']) { const kp = generateSigningKeyPair(); keys[id] = { priv: kp.privateKey, pub: kp.publicKey }; }
    const seen = new Set<string>();
    const dispatcher = new MeshRpcDispatcher({
      verify: {
        selfMachineId: 'OWNER',
        verify: (c, s, sender) => !!keys[sender] && verify(c, s, keys[sender].pub),
        isRegisteredPeer: (s) => !!keys[s],
        seenNonce: (s, n) => seen.has(`${s}:${n}`),
        now: () => Date.now(),
      },
      rbac: { routerHolder: () => 'ROUTER', ownerOf: () => 'OWNER', placementTargetOf: () => 'OWNER' },
      recordNonce: (s, n) => seen.add(`${s}:${n}`),
      handlers: {
        deliverMessage: (cmd: MeshCommand) => { if (cmd.type === 'deliverMessage') { delivered.push(cmd.messageId); return { messageId: cmd.messageId, accepted: 'queued' }; } return {}; },
      },
    });
    const ctx: any = { config: { authToken: 'test', stateDir: dir, port: 0 }, stateDir: dir, meshRpcDispatcher: dispatcher };
    const app = express(); app.use(express.json()); app.use(createRoutes(ctx));
    server = await listen(app);
  });
  afterEach(async () => { await server.close(); SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/integration/mesh-rpc-client-roundtrip.test.ts' }); });

  let n = 0;
  function client(self: string) {
    return new MeshRpcClient({ selfMachineId: self, sign: (c) => sign(c, keys[self].priv), nonce: () => `n${++n}`, now: () => Date.now() });
  }

  it('delivers a router→owner deliverMessage end-to-end (200 + result; owner handler ran)', async () => {
    const r = await client('ROUTER').send({ machineId: 'OWNER', url: server.url }, { type: 'deliverMessage', session: 's1', messageId: 'evt-1', payload: { t: 'hi' }, ownershipEpoch: 3 }, 1);
    expect(r).toMatchObject({ status: 200, ok: true });
    expect(r.result).toEqual({ messageId: 'evt-1', accepted: 'queued' });
    expect(delivered).toEqual(['evt-1']);
  });

  it('maps an RBAC rejection to reason/status (non-router place → 403 not-router), no handler run', async () => {
    const r = await client('OWNER').send({ machineId: 'OWNER', url: server.url }, { type: 'place', session: 's2', machine: 'OWNER' }, 1);
    expect(r).toMatchObject({ status: 403, ok: false, reason: 'not-router' });
  });

  it('a replayed nonce is rejected on the second send (409 replayed-nonce)', async () => {
    const c = client('ROUTER');
    const env = c.buildEnvelope({ machineId: 'OWNER', url: server.url }, { type: 'deliverMessage', session: 's3', messageId: 'evt-9', payload: {}, ownershipEpoch: 1 }, 1);
    const post = (body: unknown) => fetch(server.url + '/mesh/rpc', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((x) => x.status);
    expect(await post(env)).toBe(200);
    expect(await post(env)).toBe(409); // same nonce replayed → rejected
  });

  it('throws on a transport error (so the caller retry loop can catch it)', async () => {
    await expect(client('ROUTER').send({ machineId: 'OWNER', url: 'http://127.0.0.1:1' }, { type: 'capacity-report' }, 1)).rejects.toBeDefined();
  });
});
