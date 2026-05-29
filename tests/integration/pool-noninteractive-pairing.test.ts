/**
 * Integration test for the non-interactive, code-authenticated pool join
 * (operator's "Proceed with A" trust model).
 *
 * Before: /api/pair was "signal-only" — it never validated the code or
 * registered the joiner; pairing completed only via interactive SAS, so a
 * headless join left the awake machine NOT knowing the joiner (one-directional).
 *
 * After: /api/pair validates the persisted pairing code (single-use,
 * attempt-capped, TTL'd) and, on success, registers the joiner as STANDBY,
 * stores its public keys, records its advertised URL, and burns the code.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import express from 'express';
import request from 'supertest';
import {
  MachineIdentityManager, generateSigningKeyPair, generateEncryptionKeyPair,
  generateMachineId, pemToBase64,
} from '../../src/core/MachineIdentity.js';
import { HeartbeatManager } from '../../src/core/HeartbeatManager.js';
import { NonceStore } from '../../src/core/NonceStore.js';
import { SecurityLog } from '../../src/core/SecurityLog.js';
import { createMachineRoutes } from '../../src/server/machineRoutes.js';
import { PairingSessionStore } from '../../src/core/PairingSessionStore.js';
import { createPairingSession } from '../../src/core/PairingProtocol.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { MachineIdentity } from '../../src/core/types.js';
import type { MachineAuthDeps } from '../../src/server/machineAuth.js';

function makeIdentity(name: string): MachineIdentity {
  return {
    machineId: generateMachineId(),
    signingPublicKey: pemToBase64(generateSigningKeyPair().publicKey),
    encryptionPublicKey: pemToBase64(generateEncryptionKeyPair().publicKey),
    name,
    platform: 'test',
    createdAt: new Date().toISOString(),
    capabilities: ['sessions'],
  };
}

function makeApp(tmpDir: string) {
  const identityManager = new MachineIdentityManager(tmpDir);
  const awake = makeIdentity('awake-machine');
  fs.mkdirSync(path.join(tmpDir, 'machine'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, 'machine', 'identity.json'), JSON.stringify(awake));
  identityManager.registerMachine(awake, 'awake');

  const securityLog = new SecurityLog(tmpDir);
  securityLog.initialize();
  const authDeps: MachineAuthDeps = {
    identityManager,
    nonceStore: new NonceStore(path.join(tmpDir, 'nonces')),
    securityLog,
    localMachineId: awake.machineId,
  };
  const routes = createMachineRoutes({
    identityManager,
    heartbeatManager: new HeartbeatManager(tmpDir, awake.machineId),
    securityLog,
    authDeps,
    localMachineId: awake.machineId,
    localSigningKeyPem: '',
  });
  const app = express();
  app.use(express.json());
  app.use(routes);
  return { app, identityManager, awake, pairingStore: new PairingSessionStore(tmpDir) };
}

describe('non-interactive code-authenticated pool join (POST /api/pair)', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pool-pair-')); });
  afterEach(() => { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/integration/pool-noninteractive-pairing.test.ts:afterEach' }); });

  it('registers the joiner as STANDBY on a valid code + records its URL + returns the awake identity', async () => {
    const { app, identityManager, awake, pairingStore } = makeApp(dir);
    pairingStore.save(createPairingSession({ code: 'VIPER-PLAIN-3738', expiryMs: 600000 }));
    const joiner = makeIdentity('mac-mini');

    const res = await request(app).post('/api/pair').send({
      pairingCode: 'VIPER-PLAIN-3738',
      machineIdentity: joiner,
      ephemeralPublicKey: joiner.encryptionPublicKey,
      advertisedUrl: 'https://echo-mini.dawn-tunnel.dev',
    });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('paired');
    expect(res.body.machineIdentity.machineId).toBe(awake.machineId); // joiner learns the awake identity

    // The awake machine now KNOWS the joiner (the one-directional gap is closed).
    const reg = identityManager.loadRegistry().machines[joiner.machineId];
    expect(reg).toBeTruthy();
    expect(reg.role).toBe('standby'); // a joiner can never claim awake here
    expect(identityManager.getMachineUrl(joiner.machineId)).toBe('https://echo-mini.dawn-tunnel.dev');
    // Its public keys are persisted so MeshRpc can verify its signatures.
    expect(identityManager.loadRemoteIdentity(joiner.machineId)?.signingPublicKey).toBe(joiner.signingPublicKey);
    // Single-use: the code is now consumed.
    expect(pairingStore.load()!.consumed).toBe(true);
  });

  it('rejects a wrong code (403) and increments the persisted failed-attempt count', async () => {
    const { app, identityManager, pairingStore } = makeApp(dir);
    pairingStore.save(createPairingSession({ code: 'RIGHT-CODE-0001', expiryMs: 600000 }));
    const joiner = makeIdentity('intruder');

    const res = await request(app).post('/api/pair').send({
      pairingCode: 'WRONG-CODE-9999', machineIdentity: joiner, ephemeralPublicKey: joiner.encryptionPublicKey,
    });
    expect(res.status).toBe(403);
    expect(pairingStore.load()!.failedAttempts).toBe(1);
    expect(identityManager.loadRegistry().machines[joiner.machineId]).toBeUndefined(); // NOT registered
  });

  it('locks out after maxAttempts wrong codes (brute-force cap)', async () => {
    const { app, pairingStore } = makeApp(dir);
    pairingStore.save(createPairingSession({ code: 'SECRET-CODE-1234', maxAttempts: 3, expiryMs: 600000 }));
    const joiner = makeIdentity('brute');
    for (let i = 0; i < 3; i++) {
      await request(app).post('/api/pair').send({ pairingCode: 'NOPE-NOPE-0000', machineIdentity: joiner, ephemeralPublicKey: 'x' });
    }
    // Even the CORRECT code is now rejected — the session is locked.
    const res = await request(app).post('/api/pair').send({ pairingCode: 'SECRET-CODE-1234', machineIdentity: joiner, ephemeralPublicKey: 'x' });
    expect(res.status).toBe(403);
  });

  it('rejects when there is no active pairing session (403)', async () => {
    const { app } = makeApp(dir);
    const joiner = makeIdentity('uninvited');
    const res = await request(app).post('/api/pair').send({
      pairingCode: 'ANY-CODE-0000', machineIdentity: joiner, ephemeralPublicKey: joiner.encryptionPublicKey,
    });
    expect(res.status).toBe(403);
  });

  it('rejects a consumed (already-used) code (403)', async () => {
    const { app, pairingStore } = makeApp(dir);
    const session = createPairingSession({ code: 'ONCE-ONLY-0001', expiryMs: 600000 });
    session.consumed = true;
    pairingStore.save(session);
    const joiner = makeIdentity('replay');
    const res = await request(app).post('/api/pair').send({ pairingCode: 'ONCE-ONLY-0001', machineIdentity: joiner, ephemeralPublicKey: 'x' });
    expect(res.status).toBe(403);
  });

  it('rejects a malformed machineIdentity (400) before persisting anything', async () => {
    const { app, pairingStore } = makeApp(dir);
    pairingStore.save(createPairingSession({ code: 'GOOD-CODE-0001', expiryMs: 600000 }));
    const res = await request(app).post('/api/pair').send({
      pairingCode: 'GOOD-CODE-0001', machineIdentity: { machineId: 'm_x' }, ephemeralPublicKey: 'x',
    });
    expect(res.status).toBe(400);
  });
});
