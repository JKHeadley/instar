/**
 * Integration ("feature-alive") tests for the cross-machine secret-sync routes
 * (Multi-Machine Session Pool, spec Phase 4):
 *   GET  /secrets/sync-status  — which secret key-paths this machine holds (NAMES only)
 *                                + the online peers it would sync to. Never a value.
 *   POST /secrets/sync-now     — deterministic push-on-provision lever.
 *
 * Wires the routes with a REAL handle built the same way server.ts builds it: a real
 * SecretStore on disk + a real SecretProvisioner with real X25519 crypto, where the
 * injected `send` is the receiving peer (it decrypts with its own private key and writes
 * into a separate peer vault). So this drives the genuine encrypt→ship→decrypt→store path
 * over HTTP — not a hollow mock — and asserts no secret value ever leaks into a response.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { AddressInfo } from 'node:net';
import { createRoutes } from '../../src/server/routes.js';
import { SecretStore } from '../../src/core/SecretStore.js';
import { SecretProvisioner, secretKeyPaths, type SecretSyncHandle } from '../../src/core/SecretSync.js';
import { generateEncryptionKeyPair } from '../../src/core/MachineIdentity.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

interface Server { url: string; close: () => Promise<void>; }
async function listen(app: express.Express): Promise<Server> {
  return new Promise((resolve) => {
    const srv = app.listen(0, () => {
      const port = (srv.address() as AddressInfo).port;
      resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => srv.close(() => r())) });
    });
  });
}

const SECRET_TOKEN = 'bot-SUPER-SECRET-9f3a';
const SECRET_GH = 'ghp_neverleakthis';

describe('Secret-sync routes (cross-machine secret distribution)', () => {
  let dir: string;
  let localStore: SecretStore; // this machine's vault
  let peerStore: SecretStore;  // the receiving peer's vault
  let peerPriv: crypto.KeyObject;
  let peerPubB64: string;
  let server: Server;

  function buildHandle(enabled: boolean): SecretSyncHandle {
    const provisioner = new SecretProvisioner({
      secretsToSync: () => localStore.read(),
      listPeers: () => [{ machineId: 'm_peer', encryptionPublicKey: peerPubB64 }],
      // The injected send IS the peer: decrypt with the peer's private key + store.
      send: async (_machineId, command) => {
        const { decryptFromSync } = await import('../../src/core/SecretStore.js');
        const payload = JSON.parse(command.encrypted);
        const secrets = decryptFromSync(payload, peerPriv);
        for (const k of secretKeyPaths(secrets)) {
          // walk the decrypted nested object to the leaf value, then store by dot-path
          const value = k.split('.').reduce<unknown>((acc, part) => (acc as Record<string, unknown>)?.[part], secrets);
          peerStore.set(k, value);
        }
        return { ok: true };
      },
    });
    return {
      enabled,
      provisionAll: () => provisioner.provisionAll(),
      localKeyPaths: () => secretKeyPaths(localStore.read()),
      syncTargets: () => [{ machineId: 'm_peer', nickname: 'Laptop' }],
    };
  }

  function mount(handle: SecretSyncHandle | null) {
    const ctx: any = {
      config: { authToken: 'test', stateDir: dir, port: 0 },
      stateDir: dir,
      secretSync: handle,
    };
    const app = express();
    app.use(express.json());
    app.use(createRoutes(ctx));
    return app;
  }

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'secret-sync-'));
    localStore = new SecretStore({ stateDir: path.join(dir, 'local') });
    peerStore = new SecretStore({ stateDir: path.join(dir, 'peer') });
    localStore.write({ telegram: { token: SECRET_TOKEN }, github: SECRET_GH });
    const kp = generateEncryptionKeyPair();
    peerPubB64 = crypto.createPublicKey(kp.publicKey).export({ type: 'spki', format: 'der' }).toString('base64');
    peerPriv = crypto.createPrivateKey(kp.privateKey);
    server = await listen(mount(buildHandle(true)));
  });
  afterEach(async () => {
    await server.close();
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/integration/secret-sync-routes.test.ts' });
  });

  async function api(p: string, init?: RequestInit) {
    const res = await fetch(server.url + p, { ...init, headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) } });
    return { status: res.status, raw: await res.text() };
  }

  it('GET /secrets/sync-status returns key-path NAMES + targets, never a secret value', async () => {
    const r = await api('/secrets/sync-status');
    expect(r.status).toBe(200);
    const body = JSON.parse(r.raw);
    expect(body.enabled).toBe(true);
    expect(body.localKeyPaths.sort()).toEqual(['github', 'telegram.token']);
    expect(body.syncTargets).toEqual([{ machineId: 'm_peer', nickname: 'Laptop' }]);
    // The crux: no secret VALUE ever appears in the response body.
    expect(r.raw).not.toContain(SECRET_TOKEN);
    expect(r.raw).not.toContain(SECRET_GH);
  });

  it('POST /secrets/sync-now encrypts→ships→decrypts into the peer vault, leaks no value', async () => {
    // Peer vault starts empty.
    expect(peerStore.read()).toEqual({});
    const r = await api('/secrets/sync-now', { method: 'POST' });
    expect(r.status).toBe(200);
    const body = JSON.parse(r.raw);
    expect(body.ok).toBe(true);
    expect(body.pushed).toBe(1);
    expect(body.results[0]).toMatchObject({ machineId: 'm_peer', ok: true });
    // The peer now holds the DECRYPTED secrets — proving the real round-trip.
    expect(peerStore.get('telegram.token')).toBe(SECRET_TOKEN);
    expect(peerStore.get('github')).toBe(SECRET_GH);
    // The HTTP response itself never carried a value.
    expect(r.raw).not.toContain(SECRET_TOKEN);
    expect(r.raw).not.toContain(SECRET_GH);
  });

  it('both routes 503 when secret-sync is disabled (dark / single-machine)', async () => {
    await server.close();
    server = await listen(mount(buildHandle(false)));
    expect((await api('/secrets/sync-status')).status).toBe(503);
    expect((await api('/secrets/sync-now', { method: 'POST' })).status).toBe(503);
  });

  it('both routes 503 when the handle is entirely absent', async () => {
    await server.close();
    server = await listen(mount(null));
    expect((await api('/secrets/sync-status')).status).toBe(503);
    expect((await api('/secrets/sync-now', { method: 'POST' })).status).toBe(503);
  });
});
