/**
 * Integration — multi-transport-mesh-comms receiver accept-ack (Decision 9).
 * Drives the REAL /api/lease + /api/lease/pull routes through the HTTP pipeline
 * and verifies the receiver returns a freshness-bound, signed accept-ack that the
 * caller-side verifyLeaseAck accepts (and that a missing reqNonce yields a bare 200).
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
import { signRequest, verifyLeaseAck, verifyLeaseAckIdentity, newReqNonce } from '../../src/server/machineAuth.js';
import type { MachineAuthDeps } from '../../src/server/machineAuth.js';

describe('mesh accept-ack receiver (integration)', () => {
  let tmpDir: string;
  let app: express.Express;
  let receiverId: string;
  let receiverPubKeyPem: string;
  let callerId: string;
  let callerSigning: { publicKey: string; privateKey: string };
  let foldEpoch: number;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-ack-'));
    const identityManager = new MachineIdentityManager(tmpDir);

    // Receiver (machine A — the server under test)
    const aSigning = generateSigningKeyPair();
    receiverId = generateMachineId();
    receiverPubKeyPem = aSigning.publicKey;
    const aIdentity: MachineIdentity = {
      machineId: receiverId,
      signingPublicKey: pemToBase64(aSigning.publicKey),
      encryptionPublicKey: 'unused',
      name: 'receiver',
      platform: 'test',
      createdAt: new Date().toISOString(),
      capabilities: ['sessions'],
    };

    // Caller (machine B)
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

    const nonceStore = new NonceStore(path.join(tmpDir, 'nonces'));
    const securityLog = new SecurityLog(tmpDir);
    securityLog.initialize();
    const heartbeatManager = new HeartbeatManager(tmpDir, receiverId);
    const authDeps: MachineAuthDeps = { identityManager, nonceStore, securityLog, localMachineId: receiverId };

    foldEpoch = 11;
    const routes = createMachineRoutes({
      identityManager,
      heartbeatManager,
      securityLog,
      authDeps,
      localMachineId: receiverId,
      localSigningKeyPem: aSigning.privateKey,
      onLeaseReceived: () => foldEpoch, // synchronous fold → resulting epoch
      onLeasePullRequest: () => ({ holder: receiverId, epoch: foldEpoch, acquiredAt: 'x', expiresAt: 'y', nonce: 3 }),
    });
    app = express();
    app.use(express.json());
    app.use(routes);
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/integration/mesh-accept-ack.test.ts:afterEach' });
  });

  it('/api/lease returns a signed ack that verifyLeaseAck accepts (epoch match ⇒ confirmed)', async () => {
    const reqNonce = newReqNonce();
    const lease = { holder: callerId, epoch: foldEpoch, acquiredAt: 'x', expiresAt: 'y', nonce: 5 };
    const body = { lease, reqNonce };
    const headers = signRequest(callerId, callerSigning.privateKey, body, 0);
    const res = await request(app).post('/api/lease').set(headers).send(body);
    expect(res.status).toBe(200);
    expect(res.body.ack).toBeDefined();
    const verdict = verifyLeaseAck(res.body.ack, res.body.sig, receiverId, reqNonce, foldEpoch, receiverPubKeyPem);
    expect(verdict).toBe('confirmed');
  });

  it('/api/lease ack with a HIGHER receiver epoch ⇒ higher-epoch (stand down)', async () => {
    foldEpoch = 20; // receiver already at a higher epoch than the caller sends
    const reqNonce = newReqNonce();
    const lease = { holder: callerId, epoch: 11, acquiredAt: 'x', expiresAt: 'y', nonce: 5 };
    const body = { lease, reqNonce };
    const headers = signRequest(callerId, callerSigning.privateKey, body, 0);
    const res = await request(app).post('/api/lease').set(headers).send(body);
    const verdict = verifyLeaseAck(res.body.ack, res.body.sig, receiverId, reqNonce, 11, receiverPubKeyPem);
    expect(verdict).toBe('higher-epoch');
  });

  it('/api/lease with NO reqNonce ⇒ bare 200 (back-compat for an un-upgraded caller)', async () => {
    const lease = { holder: callerId, epoch: foldEpoch, acquiredAt: 'x', expiresAt: 'y', nonce: 5 };
    const body = { lease };
    const headers = signRequest(callerId, callerSigning.privateKey, body, 0);
    const res = await request(app).post('/api/lease').set(headers).send(body);
    expect(res.status).toBe(200);
    expect(res.body.ack).toBeUndefined();
    expect(res.body.ok).toBe(true);
  });

  it('/api/lease/pull returns a signed identity-ack the puller accepts', async () => {
    const reqNonce = newReqNonce();
    const body = { reqNonce };
    const headers = signRequest(callerId, callerSigning.privateKey, body, 0);
    const res = await request(app).post('/api/lease/pull').set(headers).send(body);
    expect(res.status).toBe(200);
    expect(res.body.lease?.epoch).toBe(foldEpoch);
    expect(verifyLeaseAckIdentity(res.body.ack, res.body.sig, receiverId, reqNonce, receiverPubKeyPem)).toBe(true);
  });

  it('a replayed ack (wrong reqNonce) is rejected by the caller', async () => {
    const reqNonce = newReqNonce();
    const lease = { holder: callerId, epoch: foldEpoch, acquiredAt: 'x', expiresAt: 'y', nonce: 5 };
    const body = { lease, reqNonce };
    const headers = signRequest(callerId, callerSigning.privateKey, body, 0);
    const res = await request(app).post('/api/lease').set(headers).send(body);
    const verdict = verifyLeaseAck(res.body.ack, res.body.sig, receiverId, newReqNonce(), foldEpoch, receiverPubKeyPem);
    expect(verdict).toBe(false);
  });
});
