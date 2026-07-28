/**
 * E2E / wiring-integrity — mesh-endpoint-http-propagation.
 *
 * Proves the recorder is wired to REAL registry deps in the route path (not a no-op),
 * delegating to a REAL MachineIdentityManager — and that the legacy lease/pull behavior
 * is byte-for-byte unchanged when the endpoints field is absent (un-upgraded peer) OR
 * when the recorder is not wired at all (defensive regression).
 *
 * This mirrors the production wiring: server.ts constructs ONE PeerEndpointRecorder with
 * `idMgr.getMachineEndpoints` / `idMgr.updateMachineEndpoints` and the LIVE meshTransport
 * gate, hands it to createMachineRoutes via AgentServer options. Here we construct the
 * same shape over a real registry and assert end-to-end delegation through the HTTP route.
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

const PEER_TS: MeshEndpoint = { kind: 'tailscale', url: 'http://100.64.0.12:4042' };

describe('mesh-endpoint-http-propagation wiring (e2e)', () => {
  let tmpDir: string;
  let identityManager: MachineIdentityManager;
  let receiverId: string;
  let callerId: string;
  let callerSigning: { publicKey: string; privateKey: string };
  let recorderConstructedWithRealDeps: boolean;

  function makeRecorder(): PeerEndpointRecorder {
    // The production deps shape: bound to the REAL MachineIdentityManager methods.
    const getFn = identityManager.getMachineEndpoints.bind(identityManager);
    const updFn = identityManager.updateMachineEndpoints.bind(identityManager);
    recorderConstructedWithRealDeps = typeof getFn === 'function' && typeof updFn === 'function';
    return new PeerEndpointRecorder({
      getPeerEndpoints: (id) => getFn(id),
      updateMachineEndpoints: (id, eps) => updFn(id, eps),
      meshTransportEnabled: () => true,
    });
  }

  function buildApp(opts: { wireRecorder: boolean }): express.Express {
    const aSigning = generateSigningKeyPair();
    const nonceStore = new NonceStore(path.join(tmpDir, 'nonces'));
    const securityLog = new SecurityLog(tmpDir);
    securityLog.initialize();
    const heartbeatManager = new HeartbeatManager(tmpDir, receiverId);
    const authDeps: MachineAuthDeps = { identityManager, nonceStore, securityLog, localMachineId: receiverId };
    const routes = createMachineRoutes({
      identityManager,
      heartbeatManager,
      securityLog,
      authDeps,
      localMachineId: receiverId,
      localSigningKeyPem: aSigning.privateKey,
      onLeaseReceived: () => 5,
      onLeasePullRequest: () => ({ holder: receiverId, epoch: 5, acquiredAt: 'x', expiresAt: 'y', nonce: 1 }),
      peerEndpointRecorder: opts.wireRecorder ? makeRecorder() : undefined,
    });
    const app = express();
    app.use(express.json());
    app.use(routes);
    return app;
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-wire-'));
    identityManager = new MachineIdentityManager(tmpDir);
    recorderConstructedWithRealDeps = false;
    const aSigning = generateSigningKeyPair();
    receiverId = generateMachineId();
    const aIdentity: MachineIdentity = {
      machineId: receiverId, signingPublicKey: pemToBase64(aSigning.publicKey), encryptionPublicKey: 'unused',
      name: 'receiver', platform: 'test', createdAt: new Date().toISOString(), capabilities: ['sessions'],
    };
    callerSigning = generateSigningKeyPair();
    callerId = generateMachineId();
    const bIdentity: MachineIdentity = {
      machineId: callerId, signingPublicKey: pemToBase64(callerSigning.publicKey), encryptionPublicKey: 'unused',
      name: 'caller', platform: 'test', createdAt: new Date().toISOString(), capabilities: ['sessions'],
    };
    fs.mkdirSync(path.join(tmpDir, 'machine'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'machine', 'identity.json'), JSON.stringify(aIdentity));
    identityManager.registerMachine(aIdentity, 'awake');
    identityManager.registerMachine(bIdentity, 'standby');
    identityManager.storeRemoteIdentity(bIdentity);
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/e2e/mesh-endpoint-propagation-wiring.test.ts:afterEach' });
  });

  it('the wired recorder delegates to the REAL registry (write lands on disk, not a no-op)', async () => {
    const app = buildApp({ wireRecorder: true });
    expect(recorderConstructedWithRealDeps).toBe(true);
    const reqNonce = newReqNonce();
    const lease = { holder: callerId, epoch: 5, acquiredAt: 'x', expiresAt: 'y', nonce: 2 };
    const body = { lease, reqNonce, endpoints: [PEER_TS] };
    const headers = signRequest(callerId, callerSigning.privateKey, body, 0);
    const res = await request(app).post('/api/lease').set(headers).send(body);
    expect(res.status).toBe(200);
    // proves the route's recorder reached the real MachineIdentityManager registry
    expect(identityManager.getMachineEndpoints(callerId)).toEqual([PEER_TS]);
    // re-read from a FRESH manager over the same dir ⇒ it persisted to disk, not memory
    const fresh = new MachineIdentityManager(tmpDir);
    expect(fresh.getMachineEndpoints(callerId)).toEqual([PEER_TS]);
  });

  it('REGRESSION — absent endpoints field: lease behavior unchanged, no registry mutation', async () => {
    const app = buildApp({ wireRecorder: true });
    const reqNonce = newReqNonce();
    const lease = { holder: callerId, epoch: 5, acquiredAt: 'x', expiresAt: 'y', nonce: 2 };
    const body = { lease, reqNonce };
    const headers = signRequest(callerId, callerSigning.privateKey, body, 0);
    const res = await request(app).post('/api/lease').set(headers).send(body);
    expect(res.status).toBe(200);
    expect(res.body.ack).toBeDefined(); // accept-ack still issued
    expect(identityManager.getMachineEndpoints(callerId)).toBeUndefined();
  });

  it('REGRESSION — recorder NOT wired: routes still serve the lease normally', async () => {
    const app = buildApp({ wireRecorder: false });
    const reqNonce = newReqNonce();
    const lease = { holder: callerId, epoch: 5, acquiredAt: 'x', expiresAt: 'y', nonce: 2 };
    const body = { lease, reqNonce, endpoints: [PEER_TS] };
    const headers = signRequest(callerId, callerSigning.privateKey, body, 0);
    const res = await request(app).post('/api/lease').set(headers).send(body);
    expect(res.status).toBe(200);
    expect(res.body.ack).toBeDefined();
    expect(identityManager.getMachineEndpoints(callerId)).toBeUndefined(); // no recorder ⇒ no write
  });
});
