/**
 * Tier-3 E2E (§L4 "feature alive"): the deliverMessage receive path wired the
 * PRODUCTION way — the shared createDeliverMessageHandler factory (the exact code
 * server.ts boot uses) over a REAL MeshRpcDispatcher, a REAL /mesh/rpc HTTP route,
 * a REAL SQLite-backed MessageProcessingLedger, and a REAL SessionOwnershipRegistry.
 * Proves the endpoint is alive (200, not 503) and the full ACK contract holds end to
 * end: queued → duplicate (ledger-backed dedupe) → stale-ownership (after the owner
 * epoch advances). This is the single most important test for the L4 receive feature.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { AddressInfo } from 'node:net';
import { createRoutes } from '../../src/server/routes.js';
import { MeshRpcDispatcher, signEnvelope, type MeshCommand } from '../../src/core/MeshRpc.js';
import { createDeliverMessageHandler } from '../../src/core/DeliverMessageHandler.js';
import { SessionOwnershipRegistry, InMemorySessionOwnershipStore } from '../../src/core/SessionOwnershipRegistry.js';
import { MessageProcessingLedger } from '../../src/messaging/MessageProcessingLedger.js';
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

describe('Session Pool deliverMessage — Tier-3 feature alive (§L4)', () => {
  let dir: string;
  let server: Server;
  let ledger: MessageProcessingLedger;
  let registry: SessionOwnershipRegistry;
  const keys: Record<string, { priv: string; pub: string }> = {};

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-e2e-'));
    for (const id of ['ROUTER', 'OWNER']) {
      const kp = generateSigningKeyPair();
      keys[id] = { priv: kp.privateKey, pub: kp.publicKey };
    }
    ledger = MessageProcessingLedger.openMemory();
    const seenOwn = new Set<string>();
    registry = new SessionOwnershipRegistry({ store: new InMemorySessionOwnershipStore(), seenNonce: (k) => seenOwn.has(k), recordNonce: (k) => seenOwn.add(k) });

    // EXACTLY the boot deps shape (src/commands/server.ts deliverMessageHandler wiring).
    const deliverMessageHandler = createDeliverMessageHandler({
      ownerEpochOf: (s) => registry.read(s)?.ownershipEpoch ?? null,
      recordReceipt: (messageId, session) => ledger.record(messageId, { platform: 'mesh', topic: session }).firstSeen,
    });

    const seenMesh = new Set<string>();
    const dispatcher = new MeshRpcDispatcher({
      verify: {
        selfMachineId: 'OWNER',
        verify: (c, s, sender) => !!keys[sender] && verify(c, s, keys[sender].pub),
        isRegisteredPeer: (s) => !!keys[s],
        seenNonce: (s, n) => seenMesh.has(`${s}:${n}`),
        now: () => Date.now(),
      },
      rbac: { routerHolder: () => 'ROUTER', ownerOf: () => 'OWNER', placementTargetOf: () => 'OWNER' },
      recordNonce: (s, n) => seenMesh.add(`${s}:${n}`),
      handlers: { deliverMessage: deliverMessageHandler },
    });
    const ctx: any = { config: { authToken: 'test', stateDir: dir, port: 0 }, stateDir: dir, meshRpcDispatcher: dispatcher };
    const app = express();
    app.use(express.json());
    app.use(createRoutes(ctx));
    server = await listen(app);
  });
  afterEach(async () => {
    await server.close();
    ledger.close?.();
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/e2e/session-pool-delivermessage-e2e.test.ts' });
  });

  let nonce = 0;
  function deliverMessage(messageId: string, session: string, ownershipEpoch: number) {
    const cmd: MeshCommand = { type: 'deliverMessage', session, messageId, payload: { text: 'hi' }, ownershipEpoch };
    const env = signEnvelope({ sender: 'ROUTER', recipient: 'OWNER', command: cmd, epoch: 1, nonce: `d${++nonce}`, timestamp: Date.now() }, (c) => sign(c, keys.ROUTER.priv));
    return fetch(server.url + '/mesh/rpc', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(env) })
      .then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
  }

  it('endpoint is ALIVE: a signed deliverMessage returns 200 + queued ACK; ledger records it', async () => {
    const r = await deliverMessage('evt-1', 'sess', 5);
    expect(r.status).toBe(200);
    expect(r.body.result).toEqual({ messageId: 'evt-1', accepted: 'queued' });
    // The receipt is durable: re-recording the same id is no longer first-seen.
    expect(ledger.record('evt-1', { platform: 'mesh' }).firstSeen).toBe(false);
  });

  it('redelivery → duplicate ACK (real SQLite ledger dedupe), still 200', async () => {
    await deliverMessage('evt-2', 'sess', 5);
    const again = await deliverMessage('evt-2', 'sess', 5);
    expect(again.status).toBe(200);
    expect(again.body.result).toEqual({ messageId: 'evt-2', accepted: 'duplicate' });
  });

  it('stale-ownership: after the owner epoch advances, an older-epoch deliver is rejected as stale', async () => {
    // Seed ownership: place(OWNER) → claim(OWNER) → active at epoch 2.
    registry.cas({ type: 'place', machineId: 'OWNER' }, { sessionKey: 'moved', sender: 'ROUTER', nonce: 'p1' });
    registry.cas({ type: 'claim', machineId: 'OWNER' }, { sessionKey: 'moved', sender: 'OWNER', nonce: 'c1' });
    const epoch = registry.read('moved')!.ownershipEpoch;
    const stale = await deliverMessage('evt-3', 'moved', epoch - 1);
    expect(stale.status).toBe(200);
    expect(stale.body.result.accepted).toBe('stale-ownership');
  });

  it('a non-router sender is refused by RBAC (403) — deliverMessage is router-only', async () => {
    const cmd: MeshCommand = { type: 'deliverMessage', session: 'sess', messageId: 'evt-x', payload: {}, ownershipEpoch: 1 };
    const env = signEnvelope({ sender: 'OWNER', recipient: 'OWNER', command: cmd, epoch: 1, nonce: 'z1', timestamp: Date.now() }, (c) => sign(c, keys.OWNER.priv));
    const r = await fetch(server.url + '/mesh/rpc', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(env) }).then(async (x) => ({ status: x.status, body: await x.json().catch(() => ({})) }));
    expect(r.status).toBe(403);
    expect(r.body.reason).toBe('not-router');
  });
});
