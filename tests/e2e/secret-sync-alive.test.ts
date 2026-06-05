/**
 * Tier-3 "feature is alive" E2E for the cross-machine secret-sync routes
 * (Multi-Machine Session Pool, spec Phase 4). Per CLAUDE.md the Tier-3 test is "the
 * single most important test for any feature with API routes": it proves the routes are
 * reachable through the REAL AgentServer stack (auth middleware, error handling) and
 * return 200 — not 503 because a dep wasn't wired.
 *
 * Spins up one real AgentServer with the secretSync handle wired (built exactly as
 * server.ts builds it: a real SecretStore + a real SecretProvisioner over real X25519
 * crypto, where the injected `send` is the receiving peer). Drives GET /secrets/sync-status
 * + POST /secrets/sync-now over HTTP with Bearer auth, asserts the real encrypt→decrypt
 * round-trip lands in the peer vault, and that NO secret value ever appears in a response.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { SessionManager } from '../../src/core/SessionManager.js';
import { SecretStore } from '../../src/core/SecretStore.js';
import { SecretProvisioner, secretKeyPaths, type SecretSyncHandle } from '../../src/core/SecretSync.js';
import { generateEncryptionKeyPair } from '../../src/core/MachineIdentity.js';
import type { InstarConfig } from '../../src/core/types.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

describe('E2E: secret-sync routes are ALIVE through the real AgentServer', () => {
  const PORT = 47221;
  const TOKEN = 'e2e-secret-token';
  const SECRET = 'bot-LIVE-SECRET-7c21';
  let dir: string;
  let server: AgentServer;
  let peerStore: SecretStore;
  const base = `http://127.0.0.1:${PORT}`;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'secret-sync-e2e-'));
    const localStore = new SecretStore({ stateDir: path.join(dir, 'local') });
    peerStore = new SecretStore({ stateDir: path.join(dir, 'peer') });
    localStore.write({ telegram: { token: SECRET } });

    const kp = generateEncryptionKeyPair();
    const peerPubB64 = crypto.createPublicKey(kp.publicKey).export({ type: 'spki', format: 'der' }).toString('base64');
    const peerPriv = crypto.createPrivateKey(kp.privateKey);

    const provisioner = new SecretProvisioner({
      secretsToSync: () => localStore.read(),
      listPeers: () => [{ machineId: 'm_peer', encryptionPublicKey: peerPubB64 }],
      send: async (_machineId, command) => {
        const { decryptFromSync } = await import('../../src/core/SecretStore.js');
        const secrets = decryptFromSync(JSON.parse(command.encrypted), peerPriv);
        for (const k of secretKeyPaths(secrets)) {
          const value = k.split('.').reduce<unknown>((acc, part) => (acc as Record<string, unknown>)?.[part], secrets);
          peerStore.set(k, value);
        }
        return { ok: true };
      },
    });
    const handle: SecretSyncHandle = {
      enabled: true,
      provisionAll: () => provisioner.provisionAll(),
      localKeyPaths: () => secretKeyPaths(localStore.read()),
      syncTargets: () => [{ machineId: 'm_peer', nickname: 'Laptop' }],
    };

    const config = {
      projectName: 'secret-sync-e2e',
      projectDir: dir,
      stateDir: dir,
      port: PORT,
      authToken: TOKEN,
    } as unknown as InstarConfig;

    server = new AgentServer({
      config,
      sessionManager: new SessionManager({ projectDir: dir, port: PORT }),
      state: new StateManager(dir),
      secretSync: handle,
    });
    await server.start();
  }, 20000);

  afterAll(async () => {
    await server?.stop();
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/e2e/secret-sync-alive.test.ts' });
  });

  const auth = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };

  it('GET /secrets/sync-status is ALIVE (200, not 503) and leaks no value', async () => {
    const res = await fetch(`${base}/secrets/sync-status`, { headers: auth });
    expect(res.status).toBe(200);
    const raw = await res.text();
    const body = JSON.parse(raw);
    expect(body.enabled).toBe(true);
    expect(body.localKeyPaths).toContain('telegram.token');
    expect(raw).not.toContain(SECRET);
  });

  it('POST /secrets/sync-now is ALIVE (200) and completes the real round-trip into the peer vault', async () => {
    expect(peerStore.read()).toEqual({});
    const res = await fetch(`${base}/secrets/sync-now`, { method: 'POST', headers: auth });
    expect(res.status).toBe(200);
    const raw = await res.text();
    const body = JSON.parse(raw);
    expect(body.ok).toBe(true);
    expect(body.pushed).toBe(1);
    expect(peerStore.get('telegram.token')).toBe(SECRET); // decrypted on the peer side
    expect(raw).not.toContain(SECRET); // never in the HTTP response
  });

  it('routes sit behind auth (401/403 without a Bearer token) — proves the real middleware stack', async () => {
    const res = await fetch(`${base}/secrets/sync-status`);
    expect([401, 403]).toContain(res.status);
  });
});
