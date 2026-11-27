/**
 * messages-reach-renamed-sessions §D (PR-B): the relay route over HTTP.
 * machineAuth → route → MessageRouter.relayFromMachine → a SIGNED ack/nack bound to
 * this machine, the message id and the request nonce. Both the current path and the
 * legacy alias require machine auth.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import express from 'express';
import request from 'supertest';
import { MachineIdentityManager, generateSigningKeyPair, generateMachineId, pemToBase64 } from '../../src/core/MachineIdentity.js';
import { HeartbeatManager } from '../../src/core/HeartbeatManager.js';
import { NonceStore } from '../../src/core/NonceStore.js';
import { SecurityLog } from '../../src/core/SecurityLog.js';
import { signRequest, verifyRelayAnswer } from '../../src/server/machineAuth.js';
import { createMachineRoutes } from '../../src/server/machineRoutes.js';
import type { MachineAuthDeps } from '../../src/server/machineAuth.js';
import type { MachineIdentity } from '../../src/core/types.js';
import { RELAY_MACHINE_PATH, RELAY_MACHINE_LEGACY_PATH } from '../../src/messaging/types.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

describe('relay-machine route (signed answers)', () => {
  let dir: string;
  let app: express.Express;
  let aId: string, bId: string;
  let aPub: string, bPriv: string;
  let nonceStore: NonceStore;
  const calls: Array<{ id: string; signer: string }> = [];
  let outcome: { outcome: 'stored' | 'duplicate' } | { outcome: 'refused'; code: string } = { outcome: 'stored' };

  beforeEach(() => {
    calls.length = 0;
    outcome = { outcome: 'stored' };
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-route-'));
    const idm = new MachineIdentityManager(dir);
    const a = generateSigningKeyPair(); const b = generateSigningKeyPair();
    aId = generateMachineId(); bId = generateMachineId();
    aPub = a.publicKey; bPriv = b.privateKey;
    const mk = (id: string, pub: string, name: string): MachineIdentity => ({ machineId: id, signingPublicKey: pemToBase64(pub), encryptionPublicKey: 'unused', name, platform: 'test', createdAt: new Date().toISOString(), capabilities: ['sessions'] });
    fs.mkdirSync(path.join(dir, 'machine'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'machine', 'identity.json'), JSON.stringify(mk(aId, a.publicKey, 'a')));
    idm.registerMachine(mk(aId, a.publicKey, 'a'), 'awake');
    idm.registerMachine(mk(bId, b.publicKey, 'b'), 'standby');
    idm.storeRemoteIdentity(mk(bId, b.publicKey, 'b'));
    nonceStore = new NonceStore(path.join(dir, 'nonces'));
    const securityLog = new SecurityLog(dir); securityLog.initialize();
    const authDeps: MachineAuthDeps = { identityManager: idm, nonceStore, securityLog, localMachineId: aId };
    const routes = createMachineRoutes({
      identityManager: idm, heartbeatManager: new HeartbeatManager(dir, aId), securityLog, authDeps,
      localMachineId: aId, localSigningKeyPem: a.privateKey,
      messageRouter: {
        relayFromMachine: async (env: any, signer: string) => { calls.push({ id: env.message.id, signer }); return outcome; },
      } as any,
    } as any);
    app = express(); app.use(express.json()); app.use(routes);
  });
  afterEach(() => { nonceStore.destroy(); SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/integration/messages-relay-machine-route.test.ts' }); });

  const env = { message: { id: 'msg-1' } };

  it('refuses an unsigned request on both the current and the legacy path', async () => {
    expect((await request(app).post(RELAY_MACHINE_PATH).send(env)).status).toBe(401);
    expect((await request(app).post(RELAY_MACHINE_LEGACY_PATH).send(env)).status).toBe(401);
    expect(calls).toEqual([]);
  });

  it('a stored relay answers with an ack signed by this machine, bound to the message and nonce', async () => {
    const headers = signRequest(bId, bPriv, env);
    const res = await request(app).post(RELAY_MACHINE_PATH).set(headers).send(env);
    expect(res.status).toBe(200);
    expect(calls).toEqual([{ id: 'msg-1', signer: bId }]);
    expect(verifyRelayAnswer(res.body.ack, res.body.sig, aId, 'msg-1', headers['X-Nonce'], aPub)).toBe('ack');
    expect(verifyRelayAnswer(res.body.ack, res.body.sig, aId, 'msg-1', 'other-nonce', aPub)).toBe(false);
  });

  it('the legacy path reaches the same handler', async () => {
    const headers = signRequest(bId, bPriv, env);
    const res = await request(app).post(RELAY_MACHINE_LEGACY_PATH).set(headers).send(env);
    expect(res.status).toBe(200);
    expect(verifyRelayAnswer(res.body.ack, res.body.sig, aId, 'msg-1', headers['X-Nonce'], aPub)).toBe('ack');
  });

  it('a refusal answers 409 with a signed nack carrying the code', async () => {
    outcome = { outcome: 'refused', code: 'relay-wrong-agent' };
    const headers = signRequest(bId, bPriv, env);
    const res = await request(app).post(RELAY_MACHINE_PATH).set(headers).send(env);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('relay-wrong-agent');
    expect(verifyRelayAnswer(res.body.nack, res.body.sig, aId, 'msg-1', headers['X-Nonce'], aPub)).toBe('nack');
  });
});
