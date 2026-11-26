/**
 * E2E (HTTP) lifecycle test — the passkey COLD PROOF surface is ALIVE. Tier-3: a REAL Express server
 * on a real port through createRoutes() (the production route factory server.ts mounts), real on-disk
 * config.json + grant / credential / attempt / health files, real HTTP calls, the proof browser injected
 * through the same `passkeyProofBrowser` seam server.ts fills with the real Chrome factory.
 *
 * Key assertions: on a dev agent `POST /passkeys/prove` answers 200 (not 404/503) and a ready proof lands
 * in the cell's health; on a fleet config it answers 503 (dark).
 *
 * Spec: docs/specs/agent-held-google-passkey.md §3.8 / §3.6 / §5.1.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRoutes } from '../../src/server/routes.js';
import { authMiddleware } from '../../src/server/middleware.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { PasskeyCredentialStore } from '../../src/core/PasskeyCredentialStore.js';
import { PlaywrightSeatLease } from '../../src/core/PlaywrightSeatLease.js';
import type { ProofBrowser } from '../../src/core/PasskeyColdProof.js';
import type { ReloginBrowserSnapshot } from '../../src/core/AnthropicReloginBrowserDriver.js';

const AUTH_TOKEN = 'pk-proof-e2e';
const PIN = '141421';
const hdr = { Authorization: `Bearer ${AUTH_TOKEN}`, 'Content-Type': 'application/json' };

/** A scripted browser: identifier → passkey prompt → signed-in landing that matches. */
function scriptedReadyBrowser(): ProofBrowser & { profileDir: string | null } {
  const pages: ReloginBrowserSnapshot['pageClass'][] = ['google-account-identity', 'google-passkey-challenge', 'unknown'];
  const identity: Array<'match' | 'none'> = ['none', 'none', 'match'];
  let i = -1; let asserted = false;
  const snap = (pageClass: ReloginBrowserSnapshot['pageClass']): ReloginBrowserSnapshot => ({ origin: 'https://accounts.google.com', pageClass, expectedAccountVisible: false, hasGoogleSignIn: false, hasNext: true, hasAuthorize: false, requestedScopes: [] });
  return {
    profileDir: null,
    open: async () => {}, navigateTo: async () => {}, clearBrowsingData: async () => {},
    snapshot: async () => { i = Math.min(i + 1, pages.length - 1); return snap(pages[i]); },
    click: async (a) => { if (a === 'passkey-continue') asserted = true; },
    chooseExpectedAccount: async () => {}, fillPublic: async () => {}, wait: async () => {},
    addCredential: async () => {}, removeCredential: async () => {}, credentialCount: async () => 1,
    observedAssertion: () => asserted,
    readSignedInIdentity: async () => identity[Math.max(0, i)] ?? 'none',
    close: async () => {},
  };
}

interface TestServer { url: string; close: () => Promise<void>; profileDirs: string[]; stateDir: string }
async function bootServer(projectDir: string, developmentAgent: boolean): Promise<TestServer> {
  const stateDir = path.join(projectDir, '.instar');
  const app = express(); app.use(express.json()); app.use(authMiddleware(AUTH_TOKEN));
  const profileDirs: string[] = [];
  const ctx: any = {
    config: { projectName: 'echo', projectDir, stateDir, port: 0, authToken: AUTH_TOKEN, developmentAgent, dashboardPin: PIN, secrets: { forceFileKey: true } },
    sessionManager: { listRunningSessions: () => [] }, state: { getJobState: () => null, getSession: () => null },
    sessionRefresh: null, startTime: new Date(), meshSelfId: 'solo',
    playwrightSeatLease: () => new PlaywrightSeatLease({ filePath: path.join(stateDir, 'state', 'seat.json') }),
    // The production seam (server.ts fills it with the real Chrome factory); the URLs default to accounts.google.com.
    passkeyProofBrowser: (profileDir: string) => { profileDirs.push(profileDir); return scriptedReadyBrowser(); },
  };
  app.use(createRoutes(ctx));
  return new Promise((resolve) => {
    const srv = app.listen(0, () => {
      const port = (srv.address() as AddressInfo).port;
      resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => srv.close(() => r())), profileDirs, stateDir });
    });
  });
}

describe('Passkey cold proof — (E2E over HTTP)', () => {
  let tmpDir: string; let server: TestServer | undefined;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-proof-e2e-'));
    fs.mkdirSync(path.join(tmpDir, '.instar'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.instar', 'config.json'), '{}\n');
  });
  afterEach(async () => { await server?.close(); server = undefined; SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/e2e/passkeys-cold-proof-lifecycle.test.ts:afterEach' }); });

  it('FEATURE IS ALIVE on a dev agent: POST /passkeys/prove answers 200 for a granted, stored cell; the proof runs in the proof-only profile and lands in the cell health', async () => {
    server = await bootServer(tmpDir, true);
    const email = 'a@example.com';
    const grant = await fetch(`${server.url}/passkeys/grant`, { method: 'POST', headers: hdr, body: JSON.stringify({ pin: PIN, email }) });
    expect(grant.status).toBe(200);
    // Before a credential exists the route is alive but honest: 409 no-credential, and it creates no store.
    const early = await fetch(`${server.url}/passkeys/prove`, { method: 'POST', headers: hdr, body: JSON.stringify({ pin: PIN, email }) });
    expect(early.status).toBe(409);
    expect(await early.json()).toMatchObject({ error: 'no-credential' });
    const store = new PasskeyCredentialStore({ stateDir: server.stateDir, machineId: 'solo', forceFileKey: true });
    await store.put({ credentialId: 'cred-e2e', rpId: 'google.com', privateKey: 'pk', userHandle: 'uh', signCount: 0, canonicalEmail: email, mintedOnMachineId: 'solo', mintedByAgent: 'echo', mintedAt: new Date().toISOString(), provenance: 'minted', quarantined: false });
    const res = await fetch(`${server.url}/passkeys/prove`, { method: 'POST', headers: hdr, body: JSON.stringify({ pin: PIN, email }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ outcome: 'ready', observedAssertion: true, singleCredential: true, signedInIdentity: 'match', pauses: [], teardown: { credentialRemoved: true, signedOut: true }, cell: { state: 'healthy', lastProofOutcome: 'ready' } });
    expect(server.profileDirs).toEqual([path.join(server.stateDir, 'secrets', 'passkeys', 'profiles', `${store.emailKey(email)}-proof`)]);
    expect(fs.existsSync(server.profileDirs[0])).toBe(true);
    // The outcome is readable back through the health surface and the pool state.
    const health = await (await fetch(`${server.url}/passkeys/health`, { headers: hdr })).json();
    expect(health.cells).toEqual([expect.objectContaining({ canonicalEmail: email, state: 'healthy', lastProofOutcome: 'ready' })]);
    const pool = await (await fetch(`${server.url}/passkeys/pool-state`, { headers: hdr })).json();
    expect(pool.attempts).toEqual([expect.objectContaining({ canonicalEmail: email, kind: 'proof' })]);
    // PIN is the authority: a Bearer-only call cannot trigger a proof.
    expect((await fetch(`${server.url}/passkeys/prove`, { method: 'POST', headers: hdr, body: JSON.stringify({ email }) })).status).toBe(403);
  });

  it('DARK on the fleet: POST /passkeys/prove answers 503', async () => {
    server = await bootServer(tmpDir, false);
    const res = await fetch(`${server.url}/passkeys/prove`, { method: 'POST', headers: hdr, body: JSON.stringify({ pin: PIN, email: 'a@example.com' }) });
    expect(res.status).toBe(503);
    expect(server.profileDirs).toHaveLength(0);
  });
});
