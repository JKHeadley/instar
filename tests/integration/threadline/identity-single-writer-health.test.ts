/**
 * Integration (full HTTP pipeline) — threadline identity single writer (ACT-062).
 * Spec: docs/specs/threadline-identity-single-writer.md
 *
 * Serves the real /threadline/health route on a real port and points the real
 * consumers at it:
 *   - AgentDiscovery (ping + verify), over real HTTP;
 *   - the fingerprint-addressed local-route check (backupRoutes).
 *
 * With no identity, health omits identityPub and fingerprint, creates nothing,
 * and every consumer answers "not verifiable / no local route" without
 * throwing. With a poisoned (hex) identity, health repairs it and advertises
 * the 32-byte key with the matching fingerprint.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { HandshakeManager } from '../../../src/threadline/HandshakeManager.js';
import { createThreadlineRoutes } from '../../../src/threadline/ThreadlineEndpoints.js';
import { AgentDiscovery } from '../../../src/threadline/AgentDiscovery.js';
import { checkFingerprintHealth } from '../../../src/threadline/backupRoutes.js';
import { IdentityManager } from '../../../src/threadline/client/IdentityManager.js';
import { computeFingerprint } from '../../../src/threadline/client/MessageEncryptor.js';
import { generateIdentityKeyPair } from '../../../src/threadline/ThreadlineCrypto.js';
import { computeCanonicalId, computeDisplayFingerprint } from '../../../src/identity/types.js';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';

describe('threadline identity single writer — /threadline/health and its consumers', () => {
  let tmpDir: string;
  let stateDir: string;
  let observerDir: string;
  let server: http.Server;
  let port: number;
  let discovery: AgentDiscovery;

  const legacyFile = (): string => path.join(stateDir, 'threadline', 'identity.json');
  const canonicalFile = (): string => path.join(stateDir, 'identity.json');
  const health = async (): Promise<{ status: number; body: Record<string, unknown> }> => {
    const res = await fetch(`http://localhost:${port}/threadline/health`);
    return { status: res.status, body: await res.json() as Record<string, unknown> };
  };

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-single-writer-http-'));
    stateDir = path.join(tmpDir, 'agent', '.instar');
    observerDir = path.join(tmpDir, 'observer', '.instar');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.mkdirSync(observerDir, { recursive: true });

    const app = express();
    app.use(express.json());
    app.use(createThreadlineRoutes(new HandshakeManager(stateDir, 'agent'), null, {
      localAgent: 'agent',
      version: '1.0',
      stateDir,
      relayStatus: () => ({ connectionState: 'connected', lastEvent: null }),
    }));
    await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', () => resolve()); });
    port = (server.address() as AddressInfo).port;

    // A different local agent looking at this one, over real HTTP.
    discovery = new AgentDiscovery({
      stateDir: observerDir,
      selfPath: path.join(tmpDir, 'observer'),
      selfName: 'observer',
      selfPort: 1,
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/integration/threadline/identity-single-writer-health.test.ts:cleanup' });
  });

  describe('no identity on disk', () => {
    it('health is 200, omits identityPub and fingerprint, and repeated polling creates no identity', async () => {
      for (let i = 0; i < 3; i++) {
        const res = await health();
        expect(res.status).toBe(200);
        expect(res.body.protocol).toBe('threadline');
        expect(res.body.agent).toBe('agent');
        expect(res.body).not.toHaveProperty('identityPub');
        expect(res.body).not.toHaveProperty('fingerprint');
      }
      expect(fs.existsSync(legacyFile())).toBe(false);
      expect(fs.existsSync(canonicalFile())).toBe(false);
    });

    it('discovery ping copes: the agent is listed as threadline-enabled with no key', async () => {
      const ping = (discovery as unknown as {
        pingThreadlineHealth: (e: { name: string; port: number; path: string }) => Promise<Record<string, unknown> | null>;
      }).pingThreadlineHealth.bind(discovery);
      const info = await ping({ name: 'agent', port, path: path.join(tmpDir, 'agent') });
      expect(info).not.toBeNull();
      expect(info!.threadlineEnabled).toBe(true);
      expect(info!.publicKey).toBeUndefined();
      expect(info!.fingerprint).toBeUndefined();
      expect(fs.existsSync(legacyFile())).toBe(false);
    });

    it('discovery verify copes: an agent with no key is not verified (null), no throw', async () => {
      await expect(discovery.verifyAgent('agent', port)).resolves.toBeNull();
    });

    it('the fingerprint-addressed local route answers "fingerprint-absent" → the relay is used', async () => {
      const res = await health();
      expect(checkFingerprintHealth(true, res.body, 'a'.repeat(32))).toEqual({ ok: false, reason: 'fingerprint-absent' });
    });
  });

  describe('an identity exists', () => {
    it('health advertises it, discovery verifies it, and the local-route check matches it', async () => {
      const id = new IdentityManager(stateDir).getOrCreate();
      const res = await health();
      expect(res.body.fingerprint).toBe(id.fingerprint);
      expect(Buffer.from(res.body.identityPub as string, 'hex').equals(id.publicKey)).toBe(true);

      const verified = await discovery.verifyAgent('agent', port);
      expect(verified?.fingerprint).toBe(id.fingerprint);
      expect(checkFingerprintHealth(true, res.body, id.fingerprint)).toEqual({ ok: true });
    });
  });

  describe('a poisoned agent (hex legacy file + hex canonical file)', () => {
    it('health repairs both files and advertises the 32-byte key with its fingerprint', async () => {
      const kp = generateIdentityKeyPair();
      fs.mkdirSync(path.dirname(legacyFile()), { recursive: true });
      fs.writeFileSync(legacyFile(), JSON.stringify({
        publicKey: kp.publicKey.toString('hex'),
        privateKey: kp.privateKey.toString('hex'),
      }, null, 2));
      const badId = computeCanonicalId(Buffer.from(kp.publicKey.toString('hex'), 'base64'));
      fs.writeFileSync(canonicalFile(), JSON.stringify({
        version: 1,
        publicKey: kp.publicKey.toString('hex'),
        privateKey: kp.privateKey.toString('hex'),
        privateKeyEncryption: 'none',
        canonicalId: badId,
        displayFingerprint: computeDisplayFingerprint(badId),
        createdAt: '2026-10-01T00:00:00.000Z',
      }, null, 2));

      const res = await health();
      const advertised = Buffer.from(res.body.identityPub as string, 'hex');
      expect(advertised.length).toBe(32);
      expect(advertised.equals(kp.publicKey)).toBe(true);
      expect(res.body.fingerprint).toBe(computeFingerprint(kp.publicKey));

      for (const file of [legacyFile(), canonicalFile()]) {
        const stored = JSON.parse(fs.readFileSync(file, 'utf-8'));
        expect(Buffer.from(stored.publicKey, 'base64').equals(kp.publicKey)).toBe(true);
        expect(Buffer.from(stored.privateKey, 'base64').equals(kp.privateKey)).toBe(true);
        expect(fs.statSync(file).mode & 0o777).toBe(0o600);
      }

      const verified = await discovery.verifyAgent('agent', port);
      expect(verified?.fingerprint).toBe(computeFingerprint(kp.publicKey));
    });
  });

  describe('an unusable identity file', () => {
    it('health omits the fields, leaves the file untouched, and mints nothing', async () => {
      fs.writeFileSync(canonicalFile(), '{"publicKey":"zz"}');
      const res = await health();
      expect(res.status).toBe(200);
      expect(res.body).not.toHaveProperty('identityPub');
      expect(res.body).not.toHaveProperty('fingerprint');
      expect(fs.readFileSync(canonicalFile(), 'utf-8')).toBe('{"publicKey":"zz"}');
      expect(fs.existsSync(legacyFile())).toBe(false);
      await expect(discovery.verifyAgent('agent', port)).resolves.toBeNull();
    });

    it('an unusable canonical file beside a valid legacy file: the legacy identity is advertised and verifiable', async () => {
      const legacy = new IdentityManager(stateDir).getOrCreate();
      fs.writeFileSync(canonicalFile(), '{"publicKey":"zz"}');

      const res = await health();
      expect(res.body.fingerprint).toBe(legacy.fingerprint);
      expect(Buffer.from(res.body.identityPub as string, 'hex').equals(legacy.publicKey)).toBe(true);
      expect((await discovery.verifyAgent('agent', port))?.fingerprint).toBe(legacy.fingerprint);
      expect(checkFingerprintHealth(true, res.body, legacy.fingerprint)).toEqual({ ok: true });
      expect(fs.readFileSync(canonicalFile(), 'utf-8')).toBe('{"publicKey":"zz"}');

      const mgr = new IdentityManager(stateDir);
      expect(mgr.get()?.fingerprint).toBe(legacy.fingerprint);
      expect(mgr.problem?.filePath).toBe(canonicalFile());
    });
  });
});
