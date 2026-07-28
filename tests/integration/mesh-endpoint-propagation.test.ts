/**
 * Integration — mesh-endpoint-http-propagation receiver path.
 *
 * Drives the REAL /api/lease + /api/lease/pull routes through the HTTP pipeline with a
 * REAL PeerEndpointRecorder wired to a REAL MachineIdentityManager registry, and verifies:
 *   - POST /api/lease records the authenticated SENDER's endpoints into that peer's entry;
 *   - POST /api/lease/pull records the authenticated PULLER's endpoints AND serves this
 *     machine's own endpoints back in the RESPONSE (the live-bug fix direction);
 *   - meshTransport OFF ⇒ records nothing (strict no-op);
 *   - an absent endpoints field ⇒ no-op (un-upgraded peer, no corruption).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MachineIdentityManager, generateSigningKeyPair, generateMachineId, pemToBase64, type MachineIdentity } from '../../src/core/MachineIdentity.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { NonceStore } from '../../src/core/NonceStore.js';
import { SecurityLog } from '../../src/core/SecurityLog.js';
import { HeartbeatManager } from '../../src/core/HeartbeatManager.js';
import { createMachineRoutes } from '../../src/server/machineRoutes.js';
import { PeerEndpointRecorder } from '../../src/core/PeerEndpointRecorder.js';
import { signRequest, newReqNonce } from '../../src/server/machineAuth.js';
import type { MachineAuthDeps } from '../../src/server/machineAuth.js';
import type { MeshEndpoint } from '../../src/core/types.js';

const PEER_TS: MeshEndpoint = { kind: 'tailscale', url: 'http://100.64.0.9:4042' };
const PEER_LAN: MeshEndpoint = { kind: 'lan', url: 'http://192.168.87.61:4042' };
const SELF_TS: MeshEndpoint = { kind: 'tailscale', url: 'http://100.64.165.27:4042' };
const SELF_LAN: MeshEndpoint = { kind: 'lan', url: 'http://192.168.87.60:4042' };

describe('mesh-endpoint-http-propagation receiver (integration)', () => {
  let tmpDir: string;
  let identityManager: MachineIdentityManager;
  let receiverId: string;
  let callerId: string;
  let callerSigning: { publicKey: string; privateKey: string };
  let meshOn: boolean;

  function buildApp(): express.Express {
    const aSigning = generateSigningKeyPair();
    const nonceStore = new NonceStore(path.join(tmpDir, 'nonces'));
    const securityLog = new SecurityLog(tmpDir);
    securityLog.initialize();
    const heartbeatManager = new HeartbeatManager(tmpDir, receiverId);
    const authDeps: MachineAuthDeps = { identityManager, nonceStore, securityLog, localMachineId: receiverId };

    const recorder = new PeerEndpointRecorder({
      getPeerEndpoints: (id) => identityManager.getMachineEndpoints(id),
      updateMachineEndpoints: (id, eps) => identityManager.updateMachineEndpoints(id, eps),
      meshTransportEnabled: () => meshOn,
    });

    const routes = createMachineRoutes({
      identityManager,
      heartbeatManager,
      securityLog,
      authDeps,
      localMachineId: receiverId,
      localSigningKeyPem: aSigning.privateKey,
      onLeaseReceived: () => 11,
      onLeasePullRequest: () => ({ holder: receiverId, epoch: 11, acquiredAt: 'x', expiresAt: 'y', nonce: 3 }),
      peerEndpointRecorder: recorder,
      getSelfMeshEndpoints: () => identityManager.getMachineEndpoints(receiverId),
    });
    const app = express();
    app.use(express.json());
    app.use(routes);
    return app;
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-prop-'));
    identityManager = new MachineIdentityManager(tmpDir);
    meshOn = true;

    const aSigning = generateSigningKeyPair();
    receiverId = generateMachineId();
    const aIdentity: MachineIdentity = {
      machineId: receiverId,
      signingPublicKey: pemToBase64(aSigning.publicKey),
      encryptionPublicKey: 'unused',
      name: 'receiver',
      platform: 'test',
      createdAt: new Date().toISOString(),
      capabilities: ['sessions'],
    };

    callerSigning = generateSigningKeyPair();
    callerId = generateMachineId();
    const bIdentity: MachineIdentity = {
      machineId: callerId,
      signingPublicKey: pemToBase64(callerSigning.publicKey),
      encryptionPublicKey: 'unused',
      name: 'caller',
      platform: 'test',
      createdAt: new Date().toISOString(),
      capabilities: ['sessions'],
    };

    fs.mkdirSync(path.join(tmpDir, 'machine'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'machine', 'identity.json'), JSON.stringify(aIdentity));
    identityManager.registerMachine(aIdentity, 'awake');
    identityManager.registerMachine(bIdentity, 'standby');
    identityManager.storeRemoteIdentity(bIdentity);
    // The receiver advertises its OWN endpoints (served back on pull).
    identityManager.updateMachineEndpoints(receiverId, [SELF_TS, SELF_LAN]);
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/integration/mesh-endpoint-propagation.test.ts:afterEach' });
  });

  it('POST /api/lease records the authenticated sender\'s endpoints for that peer', async () => {
    const app = buildApp();
    const reqNonce = newReqNonce();
    const lease = { holder: callerId, epoch: 11, acquiredAt: 'x', expiresAt: 'y', nonce: 5 };
    const body = { lease, reqNonce, endpoints: [PEER_TS, PEER_LAN] };
    const headers = signRequest(callerId, callerSigning.privateKey, body, 0);
    const res = await request(app).post('/api/lease').set(headers).send(body);
    expect(res.status).toBe(200);
    expect(identityManager.getMachineEndpoints(callerId)).toEqual([PEER_TS, PEER_LAN]);
  });

  it('POST /api/lease with meshTransport OFF records nothing (strict no-op)', async () => {
    meshOn = false;
    const app = buildApp();
    const reqNonce = newReqNonce();
    const lease = { holder: callerId, epoch: 11, acquiredAt: 'x', expiresAt: 'y', nonce: 5 };
    const body = { lease, reqNonce, endpoints: [PEER_TS, PEER_LAN] };
    const headers = signRequest(callerId, callerSigning.privateKey, body, 0);
    const res = await request(app).post('/api/lease').set(headers).send(body);
    expect(res.status).toBe(200);
    expect(identityManager.getMachineEndpoints(callerId)).toBeUndefined();
  });

  it('POST /api/lease with NO endpoints field leaves the peer entry untouched (un-upgraded sender)', async () => {
    identityManager.updateMachineEndpoints(callerId, [PEER_TS]); // a prior set
    const app = buildApp();
    const reqNonce = newReqNonce();
    const lease = { holder: callerId, epoch: 11, acquiredAt: 'x', expiresAt: 'y', nonce: 5 };
    const body = { lease, reqNonce };
    const headers = signRequest(callerId, callerSigning.privateKey, body, 0);
    const res = await request(app).post('/api/lease').set(headers).send(body);
    expect(res.status).toBe(200);
    expect(identityManager.getMachineEndpoints(callerId)).toEqual([PEER_TS]); // intact, never wiped
  });

  it('POST /api/lease/pull records the puller\'s endpoints AND serves our own back in the response', async () => {
    const app = buildApp();
    const reqNonce = newReqNonce();
    const body = { reqNonce, endpoints: [PEER_TS, PEER_LAN] };
    const headers = signRequest(callerId, callerSigning.privateKey, body, 0);
    const res = await request(app).post('/api/lease/pull').set(headers).send(body);
    expect(res.status).toBe(200);
    // request direction: the puller's endpoints recorded
    expect(identityManager.getMachineEndpoints(callerId)).toEqual([PEER_TS, PEER_LAN]);
    // response direction: our own endpoints served back (the live-bug fix)
    expect(res.body.endpoints).toEqual([SELF_TS, SELF_LAN]);
    // and the existing ack semantics still hold
    expect(res.body.ack).toBeDefined();
    expect(res.body.lease?.epoch).toBe(11);
  });

  it('an over-cap / partly-invalid sender set is sanitized at ingest (valid subset only)', async () => {
    const app = buildApp();
    const reqNonce = newReqNonce();
    const dirty = [PEER_TS, { kind: 'lan', url: 'http://8.8.8.8:4042' }, PEER_LAN];
    const lease = { holder: callerId, epoch: 11, acquiredAt: 'x', expiresAt: 'y', nonce: 5 };
    const body = { lease, reqNonce, endpoints: dirty };
    const headers = signRequest(callerId, callerSigning.privateKey, body, 0);
    await request(app).post('/api/lease').set(headers).send(body);
    expect(identityManager.getMachineEndpoints(callerId)).toEqual([PEER_TS, PEER_LAN]);
  });
});
