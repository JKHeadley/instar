/**
 * Integration (full HTTP pipeline) — THREADLINE-IDENTITY-DISCOVERY-UNIFICATION.
 *
 * Mounts the real /threadline/health route through express and asserts it
 * publishes a non-empty identityPub + a fingerprint that equals the fingerprint
 * the relay client registers with (the address the relay actually answers to),
 * with the two internally consistent.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { HandshakeManager } from '../../../src/threadline/HandshakeManager.js';
import { createThreadlineRoutes } from '../../../src/threadline/ThreadlineEndpoints.js';
import { IdentityManager } from '../../../src/threadline/client/IdentityManager.js';
import { computeFingerprint } from '../../../src/threadline/client/MessageEncryptor.js';
import { generateIdentityKeyPair } from '../../../src/threadline/ThreadlineCrypto.js';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';

describe('Threadline identity-discovery — /threadline/health integration', () => {
  let tmpDir: string;
  let stateDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-health-id-'));
    stateDir = path.join(tmpDir, '.instar');
    fs.mkdirSync(stateDir, { recursive: true });
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/integration/threadline/identity-discovery-health.test.ts:cleanup' });
  });

  it('health fingerprint equals the relay-registration fingerprint and is consistent with identityPub', async () => {
    // Seed a canonical identity.json (unencrypted).
    const kp = generateIdentityKeyPair();
    fs.writeFileSync(path.join(stateDir, 'identity.json'), JSON.stringify({
      publicKey: kp.publicKey.toString('base64'),
      privateKey: kp.privateKey.toString('base64'),
      privateKeyEncryption: 'none',
      createdAt: new Date().toISOString(),
    }, null, 2));

    // The fingerprint the relay client registers with == IdentityManager.getOrCreate().fingerprint.
    const relayRegistrationFingerprint = new IdentityManager(stateDir).getOrCreate().fingerprint;

    const app = express();
    app.use(express.json());
    app.use(createThreadlineRoutes(new HandshakeManager(stateDir, 'agent'), null, {
      localAgent: 'agent',
      version: '1.0',
      stateDir,
    }));

    const res = await request(app).get('/threadline/health');
    expect(res.status).toBe(200);
    expect(res.body.identityPub).toBeTruthy();
    expect(res.body.identityPub).toHaveLength(64);
    expect(res.body.fingerprint).toBe(relayRegistrationFingerprint);
    expect(computeFingerprint(Buffer.from(res.body.identityPub, 'hex'))).toBe(res.body.fingerprint);
  });
});
