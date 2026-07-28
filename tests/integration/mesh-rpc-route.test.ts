/**
 * Integration ("feature-alive") test for POST /mesh/rpc (Multi-Machine Session
 * Pool §L0). Mounts the real router with a real MeshRpcDispatcher (real Ed25519
 * via MachineIdentity sign/verify) + a router stub + a capacity handler, and
 * drives signed envelopes over HTTP — proving the route + dispatcher + the
 * recipient-binding / RBAC / replay gates work end-to-end.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { AddressInfo } from 'node:net';
import { createRoutes } from '../../src/server/routes.js';
import { MeshRpcDispatcher, signEnvelope, type MeshCommand, type MeshEnvelope } from '../../src/core/MeshRpc.js';
import { generateSigningKeyPair, pemToBase64, sign, verify } from '../../src/core/MachineIdentity.js';
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

describe('POST /mesh/rpc (§L0)', () => {
  let dir: string;
  let server: Server;
  let peerPriv: string;
  let peerPub: string;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-rpc-'));
    const kp = generateSigningKeyPair();
    peerPriv = kp.privateKey;
    peerPub = kp.publicKey; // PEM
    const seenNonces = new Set<string>();
    const dispatcher = new MeshRpcDispatcher({
      verify: {
        selfMachineId: 'SELF',
        verify: (canonical, signature, sender) => sender === 'PEER' && verify(canonical, signature, peerPub),
        isRegisteredPeer: (s) => s === 'PEER',
        seenNonce: (s, n) => seenNonces.has(`${s}:${n}`),
        now: () => Date.now(),
        clockToleranceMs: 30_000,
      },
      rbac: { routerHolder: () => 'ROUTER', ownerOf: () => null, placementTargetOf: () => null },
      recordNonce: (s, n) => seenNonces.add(`${s}:${n}`),
      handlers: { 'capacity-report': () => ({ load: 0.5 }) },
    });
    const ctx: any = { config: { authToken: 'test', stateDir: dir, port: 0 }, stateDir: dir, meshRpcDispatcher: dispatcher };
    const app = express();
    app.use(express.json());
    app.use(createRoutes(ctx));
    server = await listen(app);
  });
  afterEach(async () => {
    await server.close();
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/integration/mesh-rpc-route.test.ts' });
  });

  function sealed(opts: { sender: string; recipient: string; command: MeshCommand; nonce?: string; timestamp?: number }): MeshEnvelope {
    const signer = opts.sender === 'PEER' ? (c: string) => sign(c, peerPriv) : (c: string) => 'bogus';
    return signEnvelope(
      { sender: opts.sender, recipient: opts.recipient, command: opts.command, epoch: 1, nonce: opts.nonce ?? 'n1', timestamp: opts.timestamp ?? Date.now() },
      signer,
    );
  }
  async function post(env: unknown) {
    const res = await fetch(server.url + '/mesh/rpc', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(env) });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  }

  it('is alive: a valid signed capacity-report addressed to this machine → 200 + result', async () => {
    const r = await post(sealed({ sender: 'PEER', recipient: 'SELF', command: { type: 'capacity-report' } }));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, result: { load: 0.5 } });
  });

  it('rejects a command signed for another machine, replayed here → 401 wrong-recipient', async () => {
    const r = await post(sealed({ sender: 'PEER', recipient: 'OTHER', command: { type: 'capacity-report' } }));
    expect(r.status).toBe(401);
    expect(r.body.reason).toBe('wrong-recipient');
  });

  it('rejects a non-router issuing place → 403 not-router', async () => {
    const r = await post(sealed({ sender: 'PEER', recipient: 'SELF', command: { type: 'place', session: 's', machine: 'm' } }));
    expect(r.status).toBe(403);
    expect(r.body.reason).toBe('not-router');
  });

  it('rejects a replayed nonce → first 200, second 409', async () => {
    const env = sealed({ sender: 'PEER', recipient: 'SELF', command: { type: 'capacity-report' }, nonce: 'dup' });
    expect((await post(env)).status).toBe(200);
    expect((await post(env)).status).toBe(409);
  });

  it('rejects a forged signature → 401 signature-invalid', async () => {
    const env = sealed({ sender: 'PEER', recipient: 'SELF', command: { type: 'capacity-report' }, nonce: 'n2' });
    const r = await post({ ...env, signature: 'forged' });
    expect(r.status).toBe(401);
    expect(r.body.reason).toBe('signature-invalid');
  });

  it('400 on a malformed body (no envelope)', async () => {
    const r = await post({ not: 'an envelope' });
    expect(r.status).toBe(400);
  });
});
