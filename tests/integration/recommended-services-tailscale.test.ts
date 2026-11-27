/**
 * The Tailscale recipe through the real routes (docs/specs/recommended-services.md, First recipes).
 * Its check reads Tailscale's own status; it keeps no secret, so the key route refuses it.
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
import type { TailscaleStatusRead } from '../../src/recommended/recipes.js';
import { loadCapturedFixture } from '../helpers/loadCapturedFixture.js';
import { readSetupStates } from '../../src/recommended/setupState.js';
import { registerRecommendedServiceRoutes } from '../../src/server/recommendedServiceRoutes.js';
import type { MachineKeyLookup, MachineSigner } from '../../src/core/AppRecordSignatures.js';

const { privateKey } = crypto.generateKeyPairSync('ed25519');
const signer: MachineSigner = {
  machineId: () => 'm_a', signerKeyHash: () => 'h',
  sign: (p: string) => ({ machineId: 'm_a', signerKeyHash: 'h', sig: crypto.sign(null, Buffer.from(p), privateKey).toString('base64') }) as ReturnType<MachineSigner['sign']>,
};
const PROVEN: CatalogRow = { ...RECOMMENDED_SERVICE_CATALOG.find((r) => r.id === 'tailscale')!, setupRecipe: 'tailscale-v1' };

describe('Tailscale setup through the routes', () => {
  let dir: string;
  let ledger: RecommendedServicesLedger;
  let start: ReturnType<typeof vi.fn>;
  let finish: ReturnType<typeof vi.fn>;
  let withdraw: ReturnType<typeof vi.fn>;
  let stop: ReturnType<typeof vi.fn>;
  let stuck: ReturnType<typeof vi.fn>;
  let cleared: ReturnType<typeof vi.fn>;
  let told: ReturnType<typeof vi.fn>;
  let secret: string | null;
  let status: TailscaleStatusRead;
  let reconcile: () => Promise<void>;
  let running: string[];
  let topicSession: string | null;
  let now: number;
  let logouts: number;

  const app = () => {
    const a = express();
    a.use(express.text({ type: 'text/plain' }));
    a.use(express.json());
    const router = express.Router();
    registerRecommendedServiceRoutes(router, {
      ledger: () => ledger, stateDir: dir, owner: () => '42', catalog: [PROVEN], port: 4040, now: () => now,
      checkPin: () => true, checkConfirmPin: () => true, recordApproval: () => undefined,
      openCommitment: () => 'CMT-1', finishCommitment: finish, withdrawCommitment: withdraw, startSetup: start, stopSetup: stop,
      sessionForTopic: () => topicSession,
      isSetupRunning: (id) => running.includes(id), notifyStuck: stuck, clearStuck: cleared, tellOwner: told,
      readSecret: () => secret, writeSecret: (_n, v) => { secret = v; },
      tailscaleStatus: async () => status,
      tailscaleLogout: async () => { logouts++; status = { kind: 'ok', stdout: signedOut }; return true; },
      onReady: (r) => { reconcile = r; },
    });
    a.use(router);
    return a;
  };
  const say = async (a: express.Express, what: 'yes' | 'no') => {
    const { body } = await request(a).get('/recommended-services/tailscale/confirm');
    return request(a).post('/recommended-services/tailscale/confirm').set('X-Instar-Request', '1').send({ token: body.token, pin: '1', answer: what });
  };
  const verify = (a: express.Express) => request(a).post('/recommended-services/tailscale/verify').set('X-Instar-Request', '1').send({});
  const signedIn = loadCapturedFixture('tailscale-status', 'status-full');
  const signedOut = loadCapturedFixture('tailscale-status', 'status-needslogin');

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'rec-ts-'));
    ledger = new RecommendedServicesLedger({ stateDir: dir, signer, keyLookup: (() => ({ status: 'unknown' })) as unknown as MachineKeyLookup });
    running = [];
    topicSession = null;
    logouts = 0;
    start = vi.fn(async () => { running.push('sess-1'); return { sessionName: 'sess-1', topicId: 7 }; });
    finish = vi.fn(); withdraw = vi.fn(); stuck = vi.fn(async () => true); cleared = vi.fn(); told = vi.fn();
    stop = vi.fn(() => { running = []; return true; });
    secret = null; status = { kind: 'ok', stdout: signedOut }; now = Date.parse('2026-11-06T12:00:00Z');
  });
  afterEach(() => SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/integration/recommended-services-tailscale.test.ts' }));

  it('a yes on a signed-out machine starts a session with the Tailscale brief', async () => {
    await say(app(), 'yes');
    await vi.waitFor(() => expect(readSetupStates(dir).tailscale?.sessionName).toBe('sess-1'));
    const [service, name, brief] = start.mock.calls[0];
    expect(service).toBe('tailscale');
    expect(name).toBe('Tailscale');
    expect(brief).toContain('https://login.tailscale.com/');
    expect(brief).toContain('http://localhost:4040/recommended-services/tailscale/verify');
  });

  it('a machine already on a tailnet starts nothing and is told so', async () => {
    status = { kind: 'ok', stdout: signedIn };
    await say(app(), 'yes');
    await vi.waitFor(() => expect(readSetupStates(dir).tailscale?.verified?.result).toBe('pass'));
    expect(start).not.toHaveBeenCalled();
    expect(told).toHaveBeenCalledWith(expect.stringContaining('Tailscale was already working'));
  });

  it('a hung Tailscale starts nothing and costs nothing', async () => {
    status = { kind: 'timeout' };
    await say(app(), 'yes');
    await new Promise((r) => setTimeout(r, 15));
    expect(start).not.toHaveBeenCalled();
    expect(readSetupStates(dir).tailscale?.attempts).toBeUndefined();
  });

  it('verify fails until the sign-in lands, then passes and closes the promise', async () => {
    const a = app();
    await say(a, 'yes');
    await vi.waitFor(() => expect(start).toHaveBeenCalled());
    expect((await verify(a)).body).toEqual({ result: 'fail', absent: true, detail: 'This machine is not signed in to Tailscale yet.' });
    expect(finish).not.toHaveBeenCalled();
    status = { kind: 'ok', stdout: signedIn };
    expect((await verify(a)).body.result).toBe('pass');
    expect(finish).toHaveBeenCalledWith('CMT-1');
  });

  it('the key route refuses Tailscale, so no auth key can be stored for it', async () => {
    const a = app();
    await say(a, 'yes');
    const res = await request(a).post('/recommended-services/tailscale/key').set('X-Instar-Request', '1').set('Content-Type', 'text/plain').send('tskey-auth-example');
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('no-secret-for-this-service');
    expect(secret).toBeNull();
  });
  describe('switching Tailscale off after a confirmed no', () => {
    const sayNoOff = async (a: express.Express) => {
      const { body } = await request(a).get('/recommended-services/tailscale/confirm');
      return { page: body, res: await request(a).post('/recommended-services/tailscale/confirm').set('X-Instar-Request', '1').send({ token: body.token, pin: '1', answer: 'no', shutdown: true }) };
    };

    it('signs out only a machine its own setup signed in, confirmed from the status after', async () => {
      status = { kind: 'ok', stdout: signedOut };
      const a = app();
      await say(a, 'yes');
      await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(1));
      expect(readSetupStates(dir).tailscale?.absentBeforeSetup).toBe(true);
      status = { kind: 'ok', stdout: signedIn };
      expect((await verify(a)).body.result).toBe('pass');
      expect(readSetupStates(dir).tailscale?.signedInBySetup).toBe(true);
      const { page, res } = await sayNoOff(a);
      expect(page).toMatchObject({ workingHere: true, switchOffHere: true });
      expect(res.body).toMatchObject({ choice: 'no', shutdown: 'authorized', switchingOff: true });
      await vi.waitFor(() => expect(readSetupStates(dir).tailscale?.stopped).toBeTruthy());
      expect(logouts).toBe(1);
      expect(told.mock.calls.map((c) => c[0]).some((t: string) => /signed out of Tailscale/.test(t))).toBe(true);
    });

    it('leaves a Tailscale the person already had, and the page never offers to switch it off', async () => {
      status = { kind: 'ok', stdout: signedIn };
      const a = app();
      await say(a, 'yes');
      await vi.waitFor(() => expect(readSetupStates(dir).tailscale?.alreadyHeld).toBe(true));
      const { page } = await sayNoOff(a);
      expect(page).toMatchObject({ workingHere: true, switchOffHere: false });
      await vi.waitFor(() => expect(readSetupStates(dir).tailscale?.stopped).toBeTruthy());
      expect(logouts).toBe(0);
      expect(told.mock.calls.map((c) => c[0]).some((t: string) => /already yours before I set anything up/.test(t))).toBe(true);
    });

    it('a sign-in the person had, found switched off or offline at the yes, is never counted as setup\'s own', async () => {
      // Signed in but stopped: something is here, it just isn't working. The session brings it back; it stays theirs.
      status = { kind: 'ok', stdout: JSON.stringify({ BackendState: 'Stopped', Self: { Online: false, TailscaleIPs: [] } }) };
      const a = app();
      await say(a, 'yes');
      await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(1));
      expect(readSetupStates(dir).tailscale?.absentBeforeSetup).toBeUndefined();
      status = { kind: 'ok', stdout: signedIn };
      expect((await verify(a)).body.result).toBe('pass');
      expect(readSetupStates(dir).tailscale?.signedInBySetup).toBeUndefined();
      const { page } = await sayNoOff(a);
      expect(page).toMatchObject({ workingHere: true, switchOffHere: false });
      await vi.waitFor(() => expect(readSetupStates(dir).tailscale?.stopped).toBeTruthy());
      expect(logouts).toBe(0);
    });

    it('a switch-off from another machine, on a machine where setup never ran, touches nothing and says nothing', async () => {
      status = { kind: 'ok', stdout: signedIn };
      app();
      ledger.recordNo({ service: 'tailscale', shutdown: 'authorized', reason: 'none', origin: 'owner-surface' });
      await reconcile();
      expect(logouts).toBe(0);
      expect(told).not.toHaveBeenCalled();
      expect(readSetupStates(dir).tailscale?.stopped).toBeTruthy();
      expect(status.kind === 'ok' && status.stdout).toBe(signedIn);
    });
  });
});
