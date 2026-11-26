/**
 * Integration — the COLD PROOF against the local WebAuthn fixture with REAL headless Chrome.
 * Spec docs/specs/agent-held-google-passkey.md §3.8: cleared + confirmed signed out before the key is
 * added; `ready` only from an observed assertion for the stored id + a single credential + the
 * expected identity signed in; teardown (remove + sign out) on every path; the same proof-only profile
 * reused across proofs (device-stable). Also the wired route with the real browser factory.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ChromeCdpReloginBrowser, resolveChromeExecutable, type WebAuthnCredential } from '../../src/core/ChromeCdpReloginBrowser.js';
import { startPasskeyFixture, type PasskeyFixture } from '../../src/core/PasskeyWebAuthnFixture.js';
import { runPasskeyColdProof } from '../../src/core/PasskeyColdProof.js';
import { PasskeyCredentialStore } from '../../src/core/PasskeyCredentialStore.js';
import { PlaywrightSeatLease } from '../../src/core/PlaywrightSeatLease.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { createRoutes } from '../../src/server/routes.js';
import { authMiddleware } from '../../src/server/middleware.js';

const HAS_CHROME = resolveChromeExecutable() !== null;
const LAUNCH = { headless: true, launchTimeoutMs: 30_000, operationTimeoutMs: 20_000 } as const;
const EMAIL = 'agent@example.com';

describe.skipIf(!HAS_CHROME)('cold proof against the WebAuthn fixture (real Chrome)', () => {
  let fixture: PasskeyFixture;
  let minted: WebAuthnCredential;
  const dirs: string[] = [];
  const tmp = (prefix: string) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); dirs.push(d); return d; };
  const factory = (profileDir: string) => new ChromeCdpReloginBrowser({ userDataDir: profileDir, passkeyMode: true, originPolicy: fixture.policy, ...LAUNCH });
  const urls = (target: 'self' | 'other' = 'self') => ({ signInUrl: `${fixture.holderOrigin}/v3/signin/identifier?flow=proof&target=${target}`, signOutUrl: `${fixture.holderOrigin}/Logout` });
  const record = (cred: WebAuthnCredential) => ({ credentialId: cred.credentialId, rpId: cred.rpId, privateKey: cred.privateKey, userHandle: cred.userHandle, signCount: cred.signCount });

  beforeAll(async () => {
    fixture = await startPasskeyFixture();
    // Mint ONE resident credential on the holder origin (what enrollment will do) and export it.
    const b = factory(tmp('pk-proof-mint-'));
    await b.open(`${fixture.holderOrigin}/`);
    await b.runInPage<string>(`window.__create(${JSON.stringify(EMAIL)})`);
    const creds = await b.exportCredentials();
    expect(creds).toHaveLength(1);
    minted = creds[0];
    await b.close();
  }, 90_000);
  afterAll(async () => { await fixture.close(); });
  afterEach(async () => {
    for (const dir of dirs.splice(0)) {
      const deadline = Date.now() + 30_000;
      for (;;) {
        try { await SafeFsExecutor.safeRm(dir, { recursive: true, force: true, maxRetries: 0, operation: 'passkey-cold-proof-fixture.test cleanup' }); break; }
        catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (!['ENOTEMPTY', 'EBUSY', 'EPERM'].includes(code ?? '') || Date.now() >= deadline) throw error;
          await new Promise((r) => setTimeout(r, 250));
        }
      }
    }
  }, 40_000);

  it('ready: identifier → passkey prompt → assertion with the stored id → the expected identity signed in; the SAME profile proves again after teardown', async () => {
    const profileDir = tmp('pk-proof-profile-');
    const log: string[] = [];
    const r = await runPasskeyColdProof({ openBrowser: () => factory(profileDir), log: (l) => log.push(l) }, { canonicalEmail: EMAIL, record: record(minted), ...urls('self') });
    expect(r).toMatchObject({ outcome: 'ready', reason: 'signed-in', observedAssertion: true, singleCredential: true, signedInIdentity: 'match', riskPage: false, throttled: false, teardown: { credentialRemoved: true, signedOut: true } });
    expect(r.steps.slice(0, 2).map((s) => `${s.pageClass}:${s.action}`)).toEqual(['google-account-identity:fill-email', 'google-passkey-challenge:click-passkey-continue']);
    expect(r.steps[r.steps.length - 1].action).toBe('stop');
    expect(fs.existsSync(path.join(profileDir, 'DevToolsActivePort'))).toBe(false);
    // States only in the log: never the email.
    expect(log.join('\n')).not.toContain(EMAIL);
    expect(log.join('\n')).toContain('outcome=ready');
    // Device-stable: the profile directory survives and a second proof from it is cleared, confirmed signed out, and ready again.
    expect(fs.existsSync(profileDir)).toBe(true);
    const again = await runPasskeyColdProof({ openBrowser: () => factory(profileDir) }, { canonicalEmail: EMAIL, record: record(minted), ...urls('self') });
    expect(again.outcome).toBe('ready');
  }, 120_000);

  it('security: the same key signs in as a DIFFERENT account (fixture target=other) — never ready, custody flagged', async () => {
    const r = await runPasskeyColdProof({ openBrowser: () => factory(tmp('pk-proof-sec-')) }, { canonicalEmail: EMAIL, record: record(minted), ...urls('other') });
    expect(r).toMatchObject({ outcome: 'security', reason: 'different-identity', signedInIdentity: 'other', observedAssertion: true, teardown: { credentialRemoved: true, signedOut: true } });
  }, 90_000);

  it('credential-rejected: a key the relying party does not accept lands on the not-recognised page (no identity, no ready)', async () => {
    // A credential for another relying party: the fixture's WebAuthn get() finds nothing usable and rejects.
    const foreign = { ...record(minted), rpId: 'example.org' };
    const r = await runPasskeyColdProof({ openBrowser: () => factory(tmp('pk-proof-rej-')) }, { canonicalEmail: EMAIL, record: foreign, ...urls('self') });
    expect(r).toMatchObject({ outcome: 'credential-rejected', reason: 'google-credential-not-recognized', finalPageClass: 'google-credential-not-recognized', signedInIdentity: 'none', teardown: { credentialRemoved: true, signedOut: true } });
    // A pending Google-side removal turns the same page into removed-on-google (never counted against the cell).
    const pending = await runPasskeyColdProof({ openBrowser: () => factory(tmp('pk-proof-rej2-')) }, { canonicalEmail: EMAIL, record: foreign, ...urls('self'), googleSideRemoval: 'pending' });
    expect(pending.outcome).toBe('removed-on-google');
  }, 120_000);

  it('the wired route: POST /passkeys/prove with the real browser factory proves a granted, stored cell in its proof-only profile under the passkey secrets dir', async () => {
    const dir = tmp('pk-proof-route-');
    const stateDir = path.join(dir, '.instar'); fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), '{}\n');
    const AUTH = 'pk-proof-fixture-bearer'; const PIN = '112358';
    const seat = new PlaywrightSeatLease({ filePath: path.join(stateDir, 'state', 'seat.json') });
    const ctx = {
      config: { projectName: 'pk', projectDir: dir, stateDir, port: 0, authToken: AUTH, developmentAgent: true, dashboardPin: PIN, sessions: {}, scheduler: {}, secrets: { forceFileKey: true } },
      sessionManager: { listRunningSessions: () => [] }, state: { getJobState: () => null, getSession: () => null },
      sessionRefresh: null, startTime: new Date(), meshSelfId: 'solo',
      playwrightSeatLease: () => seat,
      passkeyProofBrowser: factory,
      passkeyProofUrls: { signIn: urls('self').signInUrl, signOut: urls('self').signOutUrl },
    };
    const app = express(); app.use(express.json()); app.use(authMiddleware(AUTH)); app.use('/', createRoutes(ctx as never));
    const auth = { Authorization: `Bearer ${AUTH}` };
    expect((await request(app).post('/passkeys/grant').set(auth).send({ pin: PIN, email: EMAIL })).status).toBe(200);
    const store = new PasskeyCredentialStore({ stateDir, machineId: 'solo', forceFileKey: true });
    await store.put({ ...record(minted), canonicalEmail: EMAIL, mintedOnMachineId: 'solo', mintedByAgent: 'echo', mintedAt: new Date().toISOString(), provenance: 'minted', quarantined: false });
    const res = await request(app).post('/passkeys/prove').set(auth).send({ pin: PIN, email: EMAIL });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ outcome: 'ready', observedAssertion: true, singleCredential: true, signedInIdentity: 'match', pauses: [], cell: { state: 'healthy', lastProofOutcome: 'ready' } });
    const profileDir = path.join(stateDir, 'secrets', 'passkeys', 'profiles', `${store.emailKey(EMAIL)}-proof`);
    expect(fs.existsSync(profileDir)).toBe(true);
    expect(fs.statSync(profileDir).mode & 0o777).toBe(0o700);
    expect(seat.acquire('after', 'after the proof').acquired).toBe(true);
    expect((await request(app).get('/passkeys/health').set(auth)).body.cells[0]).toMatchObject({ state: 'healthy', lastProofOutcome: 'ready' });
  }, 120_000);
});
