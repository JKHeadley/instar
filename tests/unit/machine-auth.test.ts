/**
 * Unit tests for machine-to-machine authentication.
 *
 * Tests:
 * - signRequest produces valid headers
 * - machineAuthMiddleware validates requests
 * - Missing headers → 401
 * - Unknown/revoked machine → 403
 * - Replay detection (nonce, sequence, timestamp)
 * - Invalid signature → 403
 * - ChallengeStore lifecycle (generate, consume, expire, single-use)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { MachineIdentityManager, generateSigningKeyPair, generateMachineId, pemToBase64 } from '../../src/core/MachineIdentity.js';
import { NonceStore } from '../../src/core/NonceStore.js';
import { SecurityLog } from '../../src/core/SecurityLog.js';
import { machineAuthMiddleware, signRequest, ChallengeStore } from '../../src/server/machineAuth.js';
import type { MachineAuthDeps } from '../../src/server/machineAuth.js';
import type { MachineIdentity } from '../../src/core/types.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'instar-machine-auth-test-'));
}

function cleanup(dir: string): void {
  SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/machine-auth.test.ts:34' });
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

describe('machineAuthMiddleware', () => {
  let tmpDir: string;
  let env: ReturnType<typeof setupTestEnv>;
  let app: express.Express;

  beforeEach(() => {
    tmpDir = createTempDir();
    env = setupTestEnv(tmpDir);
    app = createTestApp(env.deps);
  });

  afterEach(() => {
    env.nonceStore.destroy();
    cleanup(tmpDir);
  });

  // ── Happy path ─────────────────────────────────────────────────

  it('accepts a properly signed request', async () => {
    const body = { data: 'test-payload' };
    const headers = signRequest(env.remoteId, env.remoteSigning.privateKey, body, 0);

    const res = await request(app)
      .post('/test')
      .set(headers)
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.machineId).toBe(env.remoteId);
    // signRequest now assigns a process-global monotonic sequence (the passed
    // arg is ignored — per-caller counters were the 2026-05-31 cross-transport
    // replay-collision bug), so it's a large positive number, not the passed 0.
    expect(res.body.sequence).toBeGreaterThan(0);
  });

  it('accepts sequential requests (monotonic shared sequence)', async () => {
    const body = { data: 'first' };
    const h1 = signRequest(env.remoteId, env.remoteSigning.privateKey, body, 0);
    const r1 = await request(app).post('/test').set(h1).send(body);
    expect(r1.status).toBe(200);

    const body2 = { data: 'second' };
    const h2 = signRequest(env.remoteId, env.remoteSigning.privateKey, body2, 1);
    const r2 = await request(app).post('/test').set(h2).send(body2);
    expect(r2.status).toBe(200);
    expect(r2.body.sequence).toBeGreaterThan(r1.body.sequence); // global counter increases
  });

  // ── Missing headers ────────────────────────────────────────────

  it('rejects request with no headers', async () => {
    const res = await request(app).post('/test').send({ data: 'test' });
    expect(res.status).toBe(401);
    expect(res.body.error).toContain('Missing');
  });

  it('rejects request with partial headers', async () => {
    const res = await request(app)
      .post('/test')
      .set('X-Machine-Id', env.remoteId)
      .set('X-Timestamp', Math.floor(Date.now() / 1000).toString())
      .send({ data: 'test' });
    expect(res.status).toBe(401);
  });

  // ── Unknown / revoked machine ──────────────────────────────────

  it('rejects unknown machine', async () => {
    const unknownId = generateMachineId();
    const body = { data: 'test' };
    const headers = signRequest(unknownId, env.remoteSigning.privateKey, body, 0);

    const res = await request(app).post('/test').set(headers).send(body);
    expect(res.status).toBe(403);
    expect(res.body.error).toContain('not authorized');
  });

  it('rejects revoked machine', async () => {
    env.identityManager.revokeMachine(env.remoteId, env.localId, 'test revocation');

    const body = { data: 'test' };
    const headers = signRequest(env.remoteId, env.remoteSigning.privateKey, body, 0);

    const res = await request(app).post('/test').set(headers).send(body);
    expect(res.status).toBe(403);
  });

  // ── Replay detection ───────────────────────────────────────────

  it('rejects replayed request (same nonce)', async () => {
    const body = { data: 'test' };
    const headers = signRequest(env.remoteId, env.remoteSigning.privateKey, body, 0);

    // First request succeeds
    await request(app).post('/test').set(headers).send(body).expect(200);

    // Same headers (same nonce) → rejected
    const res = await request(app).post('/test').set(headers).send(body);
    expect(res.status).toBe(403);
    expect(res.body.error).toContain('Anti-replay');
  });

  it('NonceStore rejects a stale (out-of-order) sequence for a peer', () => {
    // The receiver's stale-sequence rejection is still enforced (NonceStore is
    // unchanged). Tested directly now that signRequest no longer lets a caller
    // craft a lower sequence (it draws from a process-global monotonic counter).
    expect(env.nonceStore.validate(Date.now(), 'n-hi', 100, 'peerX').valid).toBe(true);
    expect(env.nonceStore.validate(Date.now(), 'n-lo', 50, 'peerX').valid).toBe(false);
  });

  it('signRequest keeps sequences monotonic across interleaved channels (regression: 2026-05-31 cross-transport replay)', () => {
    // Two logical channels both signing via signRequest must NOT collide on the
    // receiver's per-machine sequence watermark — they share ONE process-global
    // counter, so the second is strictly greater regardless of the passed arg.
    const lease = signRequest(env.remoteId, env.remoteSigning.privateKey, { ch: 'lease' }, 999);
    const heartbeat = signRequest(env.remoteId, env.remoteSigning.privateKey, { ch: 'heartbeat' }, 1);
    expect(Number(heartbeat['X-Sequence'])).toBeGreaterThan(Number(lease['X-Sequence']));
  });

  // ── Invalid signature ──────────────────────────────────────────

  it('rejects request signed with wrong key', async () => {
    // Sign with a different key pair
    const wrongKey = generateSigningKeyPair();
    const body = { data: 'test' };
    const headers = signRequest(env.remoteId, wrongKey.privateKey, body, 0);

    const res = await request(app).post('/test').set(headers).send(body);
    expect(res.status).toBe(403);
    expect(res.body.error).toContain('Invalid signature');
  });

  it('rejects request with tampered body', async () => {
    const body = { data: 'original' };
    const headers = signRequest(env.remoteId, env.remoteSigning.privateKey, body, 0);

    // Send a different body than what was signed
    const res = await request(app).post('/test').set(headers).send({ data: 'tampered' });
    expect(res.status).toBe(403);
  });

  // ── Invalid sequence format ────────────────────────────────────

  it('rejects non-numeric sequence', async () => {
    const body = { data: 'test' };
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const nonce = crypto.randomBytes(16).toString('hex');

    const res = await request(app)
      .post('/test')
      .set('X-Machine-Id', env.remoteId)
      .set('X-Timestamp', timestamp)
      .set('X-Nonce', nonce)
      .set('X-Sequence', 'not-a-number')
      .set('X-Signature', 'fake-sig')
      .send(body);
    expect(res.status).toBe(400);
  });
});

// ── signRequest ──────────────────────────────────────────────────

describe('signRequest', () => {
  it('produces all required headers', () => {
    const signing = generateSigningKeyPair();
    const headers = signRequest('m_test123', signing.privateKey, { data: 'test' }, 42);

    expect(headers['X-Machine-Id']).toBe('m_test123');
    expect(headers['X-Timestamp']).toBeTruthy();
    expect(headers['X-Nonce']).toHaveLength(32); // 16 bytes hex
    // The passed sequence (42) is ignored; a process-global monotonic value is
    // assigned instead, so just assert it's a positive integer string.
    expect(Number(headers['X-Sequence'])).toBeGreaterThan(0);
    expect(headers['X-Signature']).toBeTruthy();
  });

  it('produces unique nonces on each call', () => {
    const signing = generateSigningKeyPair();
    const h1 = signRequest('m_test', signing.privateKey, {}, 0);
    const h2 = signRequest('m_test', signing.privateKey, {}, 1);
    expect(h1['X-Nonce']).not.toBe(h2['X-Nonce']);
  });

  it('timestamp is within 2 seconds of current time', () => {
    const signing = generateSigningKeyPair();
    const headers = signRequest('m_test', signing.privateKey, {}, 0);
    const ts = parseInt(headers['X-Timestamp'], 10);
    const now = Math.floor(Date.now() / 1000);
    expect(Math.abs(ts - now)).toBeLessThanOrEqual(2);
  });
});

// ── ChallengeStore ───────────────────────────────────────────────

describe('ChallengeStore', () => {
  let store: ChallengeStore;

  beforeEach(() => {
    store = new ChallengeStore();
  });

  afterEach(() => {
    store.destroy();
  });

  it('generates unique challenges', () => {
    const c1 = store.generate();
    const c2 = store.generate();
    expect(c1.challenge).not.toBe(c2.challenge);
    expect(c1.challenge).toHaveLength(64); // 32 bytes hex
  });

  it('consumes a valid challenge', () => {
    const c = store.generate();
    expect(store.consume(c.challenge)).toBe(true);
  });

  it('rejects unknown challenge', () => {
    expect(store.consume('nonexistent-challenge')).toBe(false);
  });

  it('rejects already-consumed challenge (single-use)', () => {
    const c = store.generate();
    expect(store.consume(c.challenge)).toBe(true);
    expect(store.consume(c.challenge)).toBe(false);
  });

  it('rejects expired challenge', async () => {
    // Create a challenge with very short expiry by manipulating the store
    const c = store.generate();
    // Override expiry to be in the past
    (store as any).challenges.get(c.challenge)!.expiresAt = Date.now() - 1;
    expect(store.consume(c.challenge)).toBe(false);
  });

  it('challenge has correct expiry (~10 seconds)', () => {
    const before = Date.now();
    const c = store.generate();
    const after = Date.now();

    expect(c.expiresAt).toBeGreaterThanOrEqual(before + 9_000);
    expect(c.expiresAt).toBeLessThanOrEqual(after + 11_000);
  });
});
