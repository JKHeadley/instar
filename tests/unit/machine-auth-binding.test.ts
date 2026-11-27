/**
 * SEC-147 stage 1: a request may carry X-Signature-V2, which binds the method,
 * the path and the receiving machine. When present it must verify; a refusal is
 * signed by the receiver and leaves replay state unchanged. A request without it
 * is accepted exactly as before.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { MachineIdentityManager, generateSigningKeyPair, generateMachineId, pemToBase64, sign, verify } from '../../src/core/MachineIdentity.js';
import { NonceStore } from '../../src/core/NonceStore.js';
import { SecurityLog } from '../../src/core/SecurityLog.js';
import {
  machineAuthMiddleware, signRequest, machineAuthV2Message, machineAuthRejectMessage, requestTargetPath,
  machineAuthFormCounts, __resetMachineAuthFormCountsForTests, MACHINE_AUTH_REJECT_HEADER, v2SignatureHash,
} from '../../src/server/machineAuth.js';
import type { MachineAuthDeps } from '../../src/server/machineAuth.js';
import type { MachineIdentity } from '../../src/core/types.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'instar-machine-auth-test-'));
}

function cleanup(dir: string): void {
  SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/machine-auth-binding.test.ts:cleanup' });
}

/**
 * Set up a test environment with two machines (local + remote).
 */
function setupTestEnv(tmpDir: string) {
  const identityManager = new MachineIdentityManager(tmpDir);

  // Generate local machine identity
  const localSigning = generateSigningKeyPair();
  const localId = generateMachineId();
  const localIdentity: MachineIdentity = {
    machineId: localId,
    signingPublicKey: pemToBase64(localSigning.publicKey),
    encryptionPublicKey: 'unused-for-auth-tests',
    name: 'local-machine',
    platform: 'test',
    createdAt: new Date().toISOString(),
    capabilities: ['sessions'],
  };

  // Generate remote machine identity
  const remoteSigning = generateSigningKeyPair();
  const remoteId = generateMachineId();
  const remoteIdentity: MachineIdentity = {
    machineId: remoteId,
    signingPublicKey: pemToBase64(remoteSigning.publicKey),
    encryptionPublicKey: 'unused-for-auth-tests',
    name: 'remote-machine',
    platform: 'test',
    createdAt: new Date().toISOString(),
    capabilities: ['sessions'],
  };

  // Write identities and register machines
  fs.mkdirSync(path.join(tmpDir, 'machine'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, 'machine', 'identity.json'), JSON.stringify(localIdentity));

  identityManager.registerMachine(localIdentity, 'awake');
  identityManager.registerMachine(remoteIdentity, 'standby');
  identityManager.storeRemoteIdentity(remoteIdentity);

  const nonceStore = new NonceStore(path.join(tmpDir, 'nonces'));
  const securityLog = new SecurityLog(tmpDir);
  securityLog.initialize();

  const deps: MachineAuthDeps = {
    identityManager,
    nonceStore,
    securityLog,
    localMachineId: localId,
  };

  return {
    deps,
    localId,
    localSigning,
    remoteId,
    remoteSigning,
    nonceStore,
    securityLog,
    identityManager,
  };
}

/**
 * Create a minimal Express app with the machine auth middleware on a test route.
 */
function createTestApp(deps: MachineAuthDeps) {
  const app = express();
  app.use(express.json());
  app.post('/test', machineAuthMiddleware(deps), (req, res) => {
    const auth = (req as any).machineAuth;
    res.json({ ok: true, machineId: auth.machineId, sequence: auth.sequence });
  });
  return app;
}



/** v1 headers plus a binding signature for (method, path, recipient). */
function boundHeaders(senderId: string, senderKey: string, body: unknown, method: string, p: string, recipient: string) {
  const h = signRequest(senderId, senderKey, body) as unknown as Record<string, string>;
  const bodyHash = crypto.createHash('sha256').update(JSON.stringify(body) || '').digest('hex');
  const v2 = sign(machineAuthV2Message({
    machineId: h['X-Machine-Id'], timestamp: h['X-Timestamp'], nonce: h['X-Nonce'], sequence: h['X-Sequence'],
    bodyHash, method, path: p, recipientMachineId: recipient,
  }), senderKey);
  return { ...h, 'X-Signature-V2': v2 };
}

/** A second receiving machine C that knows the same sender. */
function machineC(sender: MachineIdentity) {
  const tmpC = createTempDir();
  const identityC = new MachineIdentityManager(tmpC);
  fs.mkdirSync(path.join(tmpC, 'machine'), { recursive: true });
  const cKeys = generateSigningKeyPair();
  const cSelf = { ...sender, machineId: generateMachineId(), name: 'c', signingPublicKey: pemToBase64(cKeys.publicKey) } as MachineIdentity;
  fs.writeFileSync(path.join(tmpC, 'machine', 'identity.json'), JSON.stringify(cSelf));
  identityC.registerMachine(cSelf, 'awake');
  identityC.registerMachine(sender, 'standby');
  identityC.storeRemoteIdentity(sender);
  const nonceC = new NonceStore(path.join(tmpC, 'nonces'));
  const logC = new SecurityLog(tmpC); logC.initialize();
  const depsC: MachineAuthDeps = { identityManager: identityC, nonceStore: nonceC, securityLog: logC, localMachineId: cSelf.machineId, localSigningKeyPem: cKeys.privateKey };
  return { tmpC, depsC, cSelf, cKeys, nonceC };
}

describe('SEC-147 stage 1: the binding signature', () => {
  let tmp: string;
  let env: ReturnType<typeof setupTestEnv>;
  let invalid: string[];
  beforeEach(() => {
    __resetMachineAuthFormCountsForTests();
    tmp = createTempDir();
    env = setupTestEnv(tmp);
    invalid = [];
    env.deps.onSignatureInvalid = (id) => { invalid.push(id); };
    env.deps.localSigningKeyPem = env.localSigning.privateKey;
    return () => { env.nonceStore.destroy(); cleanup(tmp); };
  });

  it('accepts a request with no binding signature exactly as before, and counts it', async () => {
    const body = { a: 1 };
    const res = await request(createTestApp(env.deps)).post('/test').set(signRequest(env.remoteId, env.remoteSigning.privateKey, body)).send(body);
    expect(res.status).toBe(200);
    expect(machineAuthFormCounts()[env.remoteId]).toMatchObject({ v1OnlyAdmitted: 1, v2Admitted: 0 });
  });

  it('accepts a binding signature over this method, path and machine, and counts it', async () => {
    const body = { a: 1 };
    const res = await request(createTestApp(env.deps)).post('/test').set(boundHeaders(env.remoteId, env.remoteSigning.privateKey, body, 'POST', '/test', env.localId)).send(body);
    expect(res.status).toBe(200);
    const c = machineAuthFormCounts()[env.remoteId];
    expect(c.v2Admitted).toBe(1);
    expect(c.lastV2At).not.toBeNull();
  });

  for (const [what, method, p, recipient] of [
    ['method', 'PUT', '/test', null],
    ['path', 'POST', '/other', null],
    ['recipient', 'POST', '/test', 'm_someone_else'],
  ] as const) {
    it(`refuses a binding signed for another ${what}, as binding-mismatch, without key evidence`, async () => {
      const body = {};
      const headers = boundHeaders(env.remoteId, env.remoteSigning.privateKey, body, method, p, recipient ?? env.localId);
      const res = await request(createTestApp(env.deps)).post('/test').set(headers).send(body);
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('binding-mismatch');
      expect(invalid).toEqual([]);
      expect(machineAuthFormCounts()[env.remoteId].bindingMismatch).toBe(1);
    });
  }

  it('signs the rejection with the receiving machine key over the refused nonce', async () => {
    const body = {};
    const headers = boundHeaders(env.remoteId, env.remoteSigning.privateKey, body, 'POST', '/elsewhere', env.localId);
    const res = await request(createTestApp(env.deps)).post('/test').set(headers).send(body);
    const raw = res.headers[MACHINE_AUTH_REJECT_HEADER.toLowerCase()] as string;
    expect(raw).toBeTruthy();
    const dot = raw.indexOf('.');
    expect(raw.slice(0, dot)).toBe(env.localId);
    const bodyHash = crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex');
    const sigHash = v2SignatureHash(headers['X-Signature-V2']);
    expect(verify(machineAuthRejectMessage(env.localId, headers['X-Nonce'], bodyHash, sigHash), raw.slice(dot + 1), env.localSigning.publicKey)).toBe(true);
    expect(verify(machineAuthRejectMessage(env.localId, 'another-nonce', bodyHash, sigHash), raw.slice(dot + 1), env.localSigning.publicKey)).toBe(false);
    expect(verify(machineAuthRejectMessage(env.localId, headers['X-Nonce'], 'other-body', sigHash), raw.slice(dot + 1), env.localSigning.publicKey)).toBe(false);
  });

  it('never signs a rejection for a request it already admitted, or one outside the window', async () => {
    const body = {};
    const app = createTestApp(env.deps);
    const good = boundHeaders(env.remoteId, env.remoteSigning.privateKey, body, 'POST', '/test', env.localId);
    expect((await request(app).post('/test').set(good).send(body)).status).toBe(200);
    // The admitted request replayed with a garbage binding: an anti-replay refusal, no signed rejection.
    const replay = await request(app).post('/test').set({ ...good, 'X-Signature-V2': good['X-Signature'] }).send(body);
    expect(replay.status).toBe(403);
    expect(replay.body.error).toMatch(/Anti-replay/);
    expect(replay.headers[MACHINE_AUTH_REJECT_HEADER.toLowerCase()]).toBeUndefined();
    expect(machineAuthFormCounts()[env.remoteId].bindingMismatch).toBe(0);
  });

  it('gives a stale request with a bad binding the anti-replay answer, not a signed rejection', async () => {
    const body = {};
    const nonce = crypto.randomBytes(16).toString('hex');
    const timestamp = String(Math.floor(Date.now() / 1000) - 120);
    const sequence = String(Date.now());
    const bodyHash = crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex');
    const v1 = sign(`${env.remoteId}|${timestamp}|${nonce}|${sequence}|${bodyHash}`, env.remoteSigning.privateKey);
    const res = await request(createTestApp(env.deps)).post('/test').set({
      'X-Machine-Id': env.remoteId, 'X-Timestamp': timestamp, 'X-Nonce': nonce, 'X-Sequence': sequence, 'X-Signature': v1, 'X-Signature-V2': v1,
    }).send(body);
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/Anti-replay/);
    expect(res.headers[MACHINE_AUTH_REJECT_HEADER.toLowerCase()]).toBeUndefined();
  });

  it('sends no rejection signature when it holds no signing key', async () => {
    env.deps.localSigningKeyPem = undefined;
    const body = {};
    const res = await request(createTestApp(env.deps)).post('/test').set(boundHeaders(env.remoteId, env.remoteSigning.privateKey, body, 'POST', '/x', env.localId)).send(body);
    expect(res.status).toBe(403);
    expect(res.headers[MACHINE_AUTH_REJECT_HEADER.toLowerCase()]).toBeUndefined();
  });

  it('leaves replay state unchanged on a refusal, so the correctly bound request is still admitted', async () => {
    const body = {};
    const wrong = boundHeaders(env.remoteId, env.remoteSigning.privateKey, body, 'POST', '/x', env.localId);
    const app = createTestApp(env.deps);
    expect((await request(app).post('/test').set(wrong).send(body)).status).toBe(403);
    // Same nonce and sequence, now bound to the real route: the refusal claimed nothing.
    const bodyHash = crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex');
    const right = { ...wrong, 'X-Signature-V2': sign(machineAuthV2Message({
      machineId: wrong['X-Machine-Id'], timestamp: wrong['X-Timestamp'], nonce: wrong['X-Nonce'], sequence: wrong['X-Sequence'],
      bodyHash, method: 'POST', path: '/test', recipientMachineId: env.localId,
    }), env.remoteSigning.privateKey) };
    expect((await request(app).post('/test').set(right).send(body)).status).toBe(200);
    // And the admitted one cannot be replayed.
    expect((await request(app).post('/test').set(right).send(body)).status).toBe(403);
  });

  it('never accepts a v1 signature in the binding header (domain separation)', async () => {
    const body = {};
    const h = signRequest(env.remoteId, env.remoteSigning.privateKey, body) as unknown as Record<string, string>;
    const res = await request(createTestApp(env.deps)).post('/test').set({ ...h, 'X-Signature-V2': h['X-Signature'] }).send(body);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('binding-mismatch');
  });

  it('verifies the binding over the full mounted path, query included', async () => {
    const app = express();
    app.use(express.json());
    const router = express.Router();
    router.post('/handoff/yield', machineAuthMiddleware(env.deps), (_req, res) => { res.json({ ok: true }); });
    app.use('/api', router);
    const body = {};
    const ok = await request(app).post('/api/handoff/yield?x=1').set(boundHeaders(env.remoteId, env.remoteSigning.privateKey, body, 'POST', '/api/handoff/yield?x=1', env.localId)).send(body);
    expect(ok.status).toBe(200);
    const noPrefix = await request(app).post('/api/handoff/yield').set(boundHeaders(env.remoteId, env.remoteSigning.privateKey, body, 'POST', '/handoff/yield', env.localId)).send(body);
    expect(noPrefix.status).toBe(403);
  });

  it('reads the target from url when there is no originalUrl (the raw WebSocket upgrade)', () => {
    expect(requestTargetPath({ url: '/desktop/stream?t=1' })).toBe('/desktop/stream?t=1');
    expect(requestTargetPath({ originalUrl: '/api/x', url: '/x' })).toBe('/api/x');
  });

  it('SEC-147 repro, with the binding: a request bound for B is refused at C on another route', async () => {
    const sender = { machineId: env.remoteId, signingPublicKey: pemToBase64(env.remoteSigning.publicKey), encryptionPublicKey: 'x', name: 'sender', platform: 'test', createdAt: new Date().toISOString(), capabilities: ['sessions'] } as MachineIdentity;
    const c = machineC(sender);
    try {
      const appC = express();
      appC.use(express.json());
      appC.post('/api/handoff/yield', machineAuthMiddleware(c.depsC), (_req, res) => { res.json({ reached: 'yield' }); });
      const body = {};
      const headers = boundHeaders(env.remoteId, env.remoteSigning.privateKey, body, 'POST', '/test', env.localId);
      expect((await request(createTestApp(env.deps)).post('/test').set(headers).send(body)).status).toBe(200);
      const atC = await request(appC).post('/api/handoff/yield').set(headers).send(body);
      expect(atC.status).toBe(403);
      expect(atC.body.error).toBe('binding-mismatch');
      // Stage 1 states its window: with the binding stripped, C still accepts the old form.
      const { ['X-Signature-V2']: _drop, ...stripped } = headers;
      expect((await request(appC).post('/api/handoff/yield').set(stripped).send(body)).status).toBe(200);
    } finally {
      c.nonceC.destroy(); cleanup(c.tmpC);
    }
  });
});
