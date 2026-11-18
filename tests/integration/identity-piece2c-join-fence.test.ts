/**
 * identity-security piece 2c §4: after enrolment, POST /api/pair refuses a joiner below the minimum build
 * (or one that sends no build, as older joiners don't), naming the build needed. Before enrolment, nothing changes.
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
import { PeerBuildLedger } from '../../src/core/identityBuildFence.js';

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
    stateDir: tmpDir,
  });
  const app = express();
  app.use(express.json());
  app.use(routes);
  return { app, identityManager, awake, pairingStore: new PairingSessionStore(tmpDir) };
}

describe('POST /api/pair with the minimum-build fence (piece 2c)', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pair-fence-')); });
  afterEach(() => { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/integration/identity-piece2c-join-fence.test.ts:afterEach' }); });

  const join = (app: Parameters<typeof request>[0], code: string, extra: Record<string, unknown> = {}) => {
    const joiner = makeIdentity('joiner');
    return request(app).post('/api/pair').send({ pairingCode: code, machineIdentity: joiner, ephemeralPublicKey: joiner.encryptionPublicKey, ...extra });
  };

  it('before enrolment (no fence) a joiner with no build still pairs', async () => {
    const { app, pairingStore } = makeApp(dir);
    pairingStore.save(createPairingSession({ code: 'OPEN-DOOR-1111', expiryMs: 600000 }));
    expect((await join(app, 'OPEN-DOOR-1111')).status).toBe(200);
  });

  it('after enrolment, a joiner with no build or an older one is refused, naming the build needed', async () => {
    const { app, pairingStore } = makeApp(dir);
    PeerBuildLedger.at(dir).setLastVerifiedFence('1.3.1900');
    pairingStore.save(createPairingSession({ code: 'FENCE-CODE-2222', expiryMs: 600000 }));
    let res = await join(app, 'FENCE-CODE-2222');
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: 'below-minimum-build', needed: '1.3.1900' });
    res = await join(app, 'FENCE-CODE-2222', { instarVersion: '1.3.1800' });
    expect(res.status).toBe(409);
  });

  it('after enrolment, a joiner at the build pairs', async () => {
    const { app, pairingStore } = makeApp(dir);
    PeerBuildLedger.at(dir).setLastVerifiedFence('1.3.1900');
    pairingStore.save(createPairingSession({ code: 'FENCE-CODE-3333', expiryMs: 600000 }));
    expect((await join(app, 'FENCE-CODE-3333', { instarVersion: '1.3.1900' })).status).toBe(200);
  });
});
