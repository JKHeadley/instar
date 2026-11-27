// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * SEC-129: the bitwarden confirm page's first answer (reachable before any sign-in) carries only the
 * COUNT of secrets the copy would take; the names come only from the PIN-checked `answer: 'names'`,
 * which needs a live page token, never spends it, and changes nothing. Real routes, real ledger.
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
import { type BitwardenSurface } from '../../src/recommended/bitwardenVault.js';
import { registerRecommendedServiceRoutes } from '../../src/server/recommendedServiceRoutes.js';
import type { MachineKeyLookup, MachineSigner } from '../../src/core/AppRecordSignatures.js';

const { privateKey } = crypto.generateKeyPairSync('ed25519');
const signer: MachineSigner = {
  machineId: () => 'm_a', signerKeyHash: () => 'h',
  sign: (p: string) => ({ machineId: 'm_a', signerKeyHash: 'h', sig: crypto.sign(null, Buffer.from(p), privateKey).toString('base64') }) as ReturnType<MachineSigner['sign']>,
};
const PROVEN: CatalogRow = { ...RECOMMENDED_SERVICE_CATALOG.find((r) => r.id === 'bitwarden')!, setupRecipe: 'bitwarden-v1' };
const BASE = '/recommended-services/bitwarden';

describe('SEC-129: secret names on the bitwarden confirm page need the PIN', () => {
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
      checkPin: () => true, checkConfirmPin: (req, res) => { if ((req.body as { pin?: unknown })?.pin === '1') return true; res.status(403).json({ error: 'pin-refused' }); return false; }, recordApproval: () => undefined,
      openCommitment: () => 'CMT-1', finishCommitment: () => undefined, withdrawCommitment: () => undefined,
      startSetup: start, stopSetup: () => { running = []; return true; }, sessionForTopic: () => null,
      isSetupRunning: (id) => running.includes(id), notifyStuck: async () => true, clearStuck: () => undefined, tellOwner: told,
      readSecret: (n) => store[n] ?? null, writeSecret: (n, v) => { store[n] = v; }, deleteSecret: (n) => { delete store[n]; },
      readSecretNames: () => [...Object.keys(store).filter((n) => n !== 'bitwarden_master_password'), 'config.authToken'].sort(),
      readCopyValue: (n) => (n === 'config.authToken' ? 'CFG-A' : store[n] ?? null),
      bitwarden: surface(),
      onReady: (r) => { reconcile = r; },
    });
    a.use(router);
    return a;
  };
  const page = (a: express.Express) => request(a).get(`${BASE}/confirm`);
  const ask = (a: express.Express, body: Record<string, unknown>) => request(a).post(`${BASE}/confirm`).set('X-Instar-Request', '1').send(body);

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'sec129-'));
    ledger = new RecommendedServicesLedger({ stateDir: dir, signer, keyLookup: (() => ({ status: 'unknown' })) as unknown as MachineKeyLookup });
    running = [];
    start = vi.fn(async () => { running.push('sess-1'); return { sessionName: 'sess-1', topicId: 7 }; });
    told = vi.fn();
    store = { authToken: 'A', dashboardPin: '1234', 'tunnel.token': 'T' };
    vault = { installed: true, loggedIn: false, accepts: 'pw', items: [], writes: [], logouts: 0, statusFails: false };
    now = Date.parse('2026-11-07T20:00:00Z');
  });
  afterEach(() => SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/recommended-services-copies-pin.test.ts' }));

  it('the public page answer carries the count, never the names', async () => {
    const { status, body } = await page(app());
    expect(status).toBe(200);
    expect(body.copiesCount).toBe(4);
    expect(body.copies).toBeUndefined();
    expect(JSON.stringify(body)).not.toMatch(/authToken|dashboardPin|tunnel\.token/);
  });

  it('the names come with the live token and the PIN, without spending the token', async () => {
    const a = app();
    const { body } = await page(a);
    const names = await ask(a, { token: body.token, pin: '1', answer: 'names' });
    expect(names.status).toBe(200);
    expect(names.body.copies).toEqual(['authToken', 'config.authToken', 'dashboardPin', 'tunnel.token']);
    expect(JSON.stringify(names.body)).not.toMatch(/"A"|1234|"T"|CFG-A/);
    // The token is still live: the same page can still answer.
    const no = await ask(a, { token: body.token, pin: '1', answer: 'no' });
    expect(no.status).toBe(200);
  });

  it('refuses the names with a wrong PIN, a dead token, or no token', async () => {
    const a = app();
    const { body } = await page(a);
    expect((await ask(a, { token: body.token, pin: '9', answer: 'names' })).status).toBe(403);
    expect((await ask(a, { token: 'not-a-live-token', pin: '1', answer: 'names' })).status).toBe(409);
    expect((await ask(a, { pin: '1', answer: 'names' })).status).toBe(400);
  });

  it('asking for the names records nothing in the ledger', async () => {
    const a = app();
    const { body } = await page(a);
    const before = JSON.stringify(ledger.effective('bitwarden'));
    expect((await ask(a, { token: body.token, pin: '1', answer: 'names' })).status).toBe(200);
    expect(JSON.stringify(ledger.effective('bitwarden'))).toBe(before);
    expect(start).not.toHaveBeenCalled();
  });
});
