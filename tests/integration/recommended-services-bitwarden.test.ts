/**
 * Bitwarden setup through the routes (docs/specs/recommended-services.md, First recipes: Bitwarden).
 * The copy is written by the server on the session's call and refreshed by the regular check; the
 * page lists what gets copied by name; a switch-off undoes only what setup did.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { RecommendedServicesLedger } from '../../src/recommended/RecommendedServicesLedger.js';
import { RECOMMENDED_SERVICE_CATALOG, type CatalogRow } from '../../src/recommended/catalog.js';
import { VAULT_CHECK_ITEM, type BitwardenSurface } from '../../src/recommended/bitwardenVault.js';
import { readSetupStates } from '../../src/recommended/setupState.js';
import { registerRecommendedServiceRoutes } from '../../src/server/recommendedServiceRoutes.js';
import type { MachineKeyLookup, MachineSigner } from '../../src/core/AppRecordSignatures.js';

const { privateKey } = crypto.generateKeyPairSync('ed25519');
const signer: MachineSigner = {
  machineId: () => 'm_a', signerKeyHash: () => 'h',
  sign: (p: string) => ({ machineId: 'm_a', signerKeyHash: 'h', sig: crypto.sign(null, Buffer.from(p), privateKey).toString('base64') }) as ReturnType<MachineSigner['sign']>,
};
const PROVEN: CatalogRow = { ...RECOMMENDED_SERVICE_CATALOG.find((r) => r.id === 'bitwarden')!, setupRecipe: 'bitwarden-v1' };
const BASE = '/recommended-services/bitwarden';

describe('Bitwarden setup through the routes', () => {
  let dir: string;
  let ledger: RecommendedServicesLedger;
  let start: ReturnType<typeof vi.fn>;
  let told: ReturnType<typeof vi.fn>;
  let store: Record<string, string>;
  let vault: { installed: boolean; loggedIn: boolean; accepts: string; items: string[]; writes: string[]; logouts: number; statusFails: boolean };
  let reconcile: () => Promise<void>;
  let running: string[];
  let now: number;

  const surface = (): BitwardenSurface => ({
    status: () => (vault.statusFails ? null : { installed: vault.installed, loggedIn: vault.loggedIn }),
    unlock: (pw) => pw === vault.accepts,
    itemNames: () => [...vault.items],
    put: (key) => { vault.writes.push(key); if (!vault.items.includes(key)) vault.items.push(key); return true; },
    logout: () => { vault.logouts++; vault.loggedIn = false; return true; },
  });
  const app = () => {
    const a = express();
    a.use(express.text({ type: 'text/plain' }));
    a.use(express.json());
    const router = express.Router();
    registerRecommendedServiceRoutes(router, {
      ledger: () => ledger, stateDir: dir, owner: () => '42', catalog: [PROVEN], port: 4040, now: () => now,
      checkPin: () => true, checkConfirmPin: () => true, recordApproval: () => undefined,
      openCommitment: () => 'CMT-1', finishCommitment: () => undefined, withdrawCommitment: () => undefined,
      startSetup: start, stopSetup: () => { running = []; return true; }, sessionForTopic: () => null,
      isSetupRunning: (id) => running.includes(id), notifyStuck: async () => true, clearStuck: () => undefined, tellOwner: told,
      readSecret: (n) => store[n] ?? null, writeSecret: (n, v) => { store[n] = v; }, deleteSecret: (n) => { delete store[n]; },
      readSecretNames: () => Object.keys(store).filter((n) => n !== 'bitwarden_master_password').sort(),
      bitwarden: surface(),
      onReady: (r) => { reconcile = r; },
    });
    a.use(router);
    return a;
  };
  const page = (a: express.Express) => request(a).get(`${BASE}/confirm`);
  const say = async (a: express.Express, what: 'yes' | 'no', shutdown = false) => {
    const { body } = await page(a);
    return request(a).post(`${BASE}/confirm`).set('X-Instar-Request', '1').send({ token: body.token, pin: '1', answer: what, shutdown });
  };
  const key = (a: express.Express, value: string) => request(a).post(`${BASE}/key`).set('X-Instar-Request', '1').type('text/plain').send(value);
  const sync = (a: express.Express) => request(a).post(`${BASE}/sync`).set('X-Instar-Request', '1').send({});
  const verify = (a: express.Express) => request(a).post(`${BASE}/verify`).set('X-Instar-Request', '1').send({});
  const started = () => vi.waitFor(() => expect(readSetupStates(dir).bitwarden?.sessionName).toBe('sess-1'));

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'rec-bw-'));
    ledger = new RecommendedServicesLedger({ stateDir: dir, signer, keyLookup: (() => ({ status: 'unknown' })) as unknown as MachineKeyLookup });
    running = [];
    start = vi.fn(async () => { running.push('sess-1'); return { sessionName: 'sess-1', topicId: 7 }; });
    told = vi.fn();
    store = { authToken: 'A', dashboardPin: '1234', 'tunnel.token': 'T' };
    vault = { installed: true, loggedIn: false, accepts: 'pw', items: [], writes: [], logouts: 0, statusFails: false };
    now = Date.parse('2026-11-07T20:00:00Z');
  });
  afterEach(() => SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/integration/recommended-services-bitwarden.test.ts' }));

  it('the page lists what would be copied, by name only', async () => {
    const { body } = await page(app());
    expect(body.copies).toEqual(['authToken', 'dashboardPin', 'tunnel.token']);
    expect(JSON.stringify(body)).not.toMatch(/"A"|1234|"T"/);
  });

  it('the whole job: a yes starts setup, the session logs in, stores the password, has the server write the copy, and the check passes', async () => {
    const a = app();
    await say(a, 'yes');
    await started();
    expect(readSetupStates(dir).bitwarden?.absentBeforeSetup).toBe(true);
    // Before the login and the password are in place, the copy is refused and nothing is written.
    expect((await sync(a)).status).toBe(503);
    expect(vault.writes).toEqual([]);
    vault.loggedIn = true;
    expect((await key(a, 'pw')).status).toBe(200);
    const copied = await sync(a);
    expect(copied.status).toBe(200);
    expect(copied.body).toMatchObject({ ok: true, copied: ['authToken', 'dashboardPin', 'tunnel.token'] });
    expect(vault.writes).toEqual(['authToken', 'dashboardPin', 'tunnel.token', VAULT_CHECK_ITEM]);
    expect(JSON.stringify(copied.body)).not.toMatch(/"A"|1234/);
    expect(readSetupStates(dir).bitwarden).toMatchObject({ lastSyncAt: expect.any(String), copies: 3 });
    const checked = await verify(a);
    expect(checked.body.result).toBe('pass');
    expect(checked.body.detail).toMatch(/3 items/);
    expect(readSetupStates(dir).bitwarden?.keyStoredBySetup).toBe(true);
  });

  it('the copy route needs the header and a yes on this machine, and refuses a service that keeps no copy', async () => {
    const a = app();
    expect((await request(a).post(`${BASE}/sync`).send({})).status).toBe(403);
    expect((await sync(a)).status).toBe(409);
    expect((await sync(a)).body.error).toBe('not-granted-here');
  });

  it('the regular check refreshes the copy once a day, so a secret stored later reaches the vault', async () => {
    const a = app();
    await say(a, 'yes');
    await started();
    vault.loggedIn = true;
    await key(a, 'pw');
    await sync(a);
    await verify(a);
    store.github_token = 'G';
    vault.writes = [];
    await reconcile();
    expect(vault.writes).toEqual([]);
    now += 25 * 60 * 60_000;
    await reconcile();
    expect(vault.writes).toContain('github_token');
    expect(readSetupStates(dir).bitwarden?.copies).toBe(4);
    expect(told).not.toHaveBeenCalledWith(expect.stringMatching(/copied/));
  });

  it('a failed refresh waits six hours, the third failure re-runs the check, and a real fail restarts setup', async () => {
    const a = app();
    await say(a, 'yes');
    await started();
    vault.loggedIn = true;
    await key(a, 'pw');
    await sync(a);
    await verify(a);
    // The vault's password changes behind our back: refreshes fail.
    vault.accepts = 'changed';
    now += 25 * 60 * 60_000;
    await reconcile();
    expect(readSetupStates(dir).bitwarden?.syncFailures).toBe(1);
    now += 60 * 60_000;
    await reconcile();
    expect(readSetupStates(dir).bitwarden?.syncFailures).toBe(1);
    now += 6 * 60 * 60_000;
    await reconcile();
    expect(readSetupStates(dir).bitwarden?.syncFailures).toBe(2);
    now += 6 * 60 * 60_000;
    await reconcile();
    expect(readSetupStates(dir).bitwarden?.syncFailures).toBe(3);
    expect(readSetupStates(dir).bitwarden?.verified?.result).toBe('pass');
    expect(start).toHaveBeenCalledTimes(1);
    // The re-check: the stored password is refused, so the check fails and setup starts again to ask the person.
    running = [];
    now += 6 * 60 * 60_000;
    await reconcile();
    expect(readSetupStates(dir).bitwarden?.syncFailures).toBeUndefined();
    expect(readSetupStates(dir).bitwarden?.verified?.result).toBe('fail');
    const stoppedWorking = () => told.mock.calls.map((c) => c[0]).filter((t: string) => /stopped working on this machine: Bitwarden refused the stored master password/.test(t)).length;
    expect(stoppedWorking()).toBe(1);
    // The repair is tracked as a promise again.
    expect(readSetupStates(dir).bitwarden?.commitmentId).toBe('CMT-1');
    // The next regular tick sees the fail and restarts setup, which asks the person for what changed; the notice is not repeated.
    await reconcile();
    await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(2));
    await reconcile();
    await reconcile();
    expect(stoppedWorking()).toBe(1);
  });

  it('a program that does not answer never fails a working copy: three such refreshes, then a re-check that passes resumes the refresh', async () => {
    const a = app();
    await say(a, 'yes');
    await started();
    vault.loggedIn = true;
    await key(a, 'pw');
    await sync(a);
    await verify(a);
    // Three failed refreshes from a program that does not answer. The pass is never touched by them.
    vault.statusFails = true;
    for (let i = 0; i < 3; i++) {
      now += (i === 0 ? 25 : 6) * 60 * 60_000;
      await reconcile();
      expect(readSetupStates(dir).bitwarden?.verified?.result).toBe('pass');
    }
    expect(readSetupStates(dir).bitwarden?.syncFailures).toBe(3);
    // Still not answering at the re-check: unknown keeps the pass and tells nobody.
    now += 6 * 60 * 60_000;
    await reconcile();
    expect(readSetupStates(dir).bitwarden?.verified?.result).toBe('pass');
    expect(told).not.toHaveBeenCalledWith(expect.stringMatching(/stopped working/));
    // Back by the next refresh: counters cleared by the unknown re-check, so the refresh resumes.
    vault.statusFails = false;
    vault.writes = [];
    now += 6 * 60 * 60_000;
    await reconcile();
    expect(readSetupStates(dir).bitwarden?.verified?.result).toBe('pass');
    expect(readSetupStates(dir).bitwarden?.syncFailures).toBeUndefined();
    expect(vault.writes.length).toBeGreaterThan(0);
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('a switch-off removes the stored password, signs out a login setup made, and says the copies stay', async () => {
    const a = app();
    await say(a, 'yes');
    await started();
    vault.loggedIn = true;
    await key(a, 'pw');
    await sync(a);
    await verify(a);
    const { body } = await page(a);
    expect(body).toMatchObject({ workingHere: true, switchOffHere: true });
    await request(a).post(`${BASE}/confirm`).set('X-Instar-Request', '1').send({ token: body.token, pin: '1', answer: 'no', shutdown: true });
    await vi.waitFor(() => expect(readSetupStates(dir).bitwarden?.stopped).toBeTruthy());
    expect(store.bitwarden_master_password).toBeUndefined();
    expect(store.authToken).toBe('A');
    expect(vault.logouts).toBe(1);
    expect(vault.items).toContain('authToken');
    expect(told.mock.calls.map((c) => c[0]).some((t: string) => /copies already in your Bitwarden folder stay/.test(t))).toBe(true);
  });

  it('a Bitwarden the person was already logged in to is left alone by a switch-off, and the page offers no box', async () => {
    vault.loggedIn = true;
    store.bitwarden_master_password = 'pw';
    vault.items = ['authToken', VAULT_CHECK_ITEM];
    const a = app();
    await say(a, 'yes');
    await vi.waitFor(() => expect(readSetupStates(dir).bitwarden?.alreadyHeld).toBe(true));
    expect(start).not.toHaveBeenCalled();
    const { body } = await page(a);
    expect(body).toMatchObject({ workingHere: true, switchOffHere: false });
    await request(a).post(`${BASE}/confirm`).set('X-Instar-Request', '1').send({ token: body.token, pin: '1', answer: 'no', shutdown: true });
    await vi.waitFor(() => expect(readSetupStates(dir).bitwarden?.stopped).toBeTruthy());
    expect(store.bitwarden_master_password).toBe('pw');
    expect(vault.logouts).toBe(0);
  });
});
