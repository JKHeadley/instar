/**
 * Telegram through the routes: a yes starts setup; the session's call writes the bot token and chat id as this
 * agent's messaging entry and asks for a planned restart; a working entry the person had is never replaced; the
 * check passes on the Bot API's answer; a no with switch-off disables the entry when another way in works.
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
import { readSetupStates } from '../../src/recommended/setupState.js';
import { registerRecommendedServiceRoutes } from '../../src/server/recommendedServiceRoutes.js';
import type { TelegramProbe, TelegramSetupSurface } from '../../src/recommended/telegramSetup.js';
import type { MachineKeyLookup, MachineSigner } from '../../src/core/AppRecordSignatures.js';

const { privateKey } = crypto.generateKeyPairSync('ed25519');
const signer: MachineSigner = {
  machineId: () => 'm_a', signerKeyHash: () => 'h',
  sign: (p: string) => ({ machineId: 'm_a', signerKeyHash: 'h', sig: crypto.sign(null, Buffer.from(p), privateKey).toString('base64') }) as ReturnType<MachineSigner['sign']>,
};
const PROVEN: CatalogRow = { ...RECOMMENDED_SERVICE_CATALOG.find((r) => r.id === 'telegram')!, setupRecipe: 'telegram-v1' };
const BASE = '/recommended-services/telegram';
const TOKEN = '123456789:' + 'B'.repeat(35);

describe('Telegram through the routes', () => {
  let dir: string;
  let ledger: RecommendedServicesLedger;
  let entry: { token: string; chatId: string; enabled: boolean } | null;
  let probe: TelegramProbe;
  let restarts: string[];
  let start: ReturnType<typeof vi.fn>;
  let told: ReturnType<typeof vi.fn>;
  let otherRoute: boolean;

  const surface = (): TelegramSetupSurface => ({
    configured: () => entry,
    probe: async () => probe,
    write: ({ token, chatId }) => { entry = { token, chatId, enabled: true }; },
    disable: () => { if (entry) entry = { ...entry, enabled: false }; },
    requestRestart: (reason) => { restarts.push(reason); return true; },
  });
  const app = () => {
    const a = express();
    a.use(express.text({ type: 'text/plain' }));
    a.use(express.json());
    const router = express.Router();
    registerRecommendedServiceRoutes(router, {
      ledger: () => ledger, stateDir: dir, owner: () => '42', catalog: [PROVEN], port: 4040,
      checkPin: () => true, checkConfirmPin: () => true, recordApproval: () => undefined,
      openCommitment: () => 'CMT-1', finishCommitment: () => undefined, withdrawCommitment: () => undefined,
      startSetup: start, stopSetup: () => true, sessionForTopic: () => null, isSetupRunning: () => false,
      notifyStuck: async () => true, clearStuck: () => undefined, tellOwner: told,
      readSecret: () => null, writeSecret: () => undefined, deleteSecret: () => undefined,
      telegramSetup: surface(),
      otherRouteWorks: async () => otherRoute,
    });
    a.use(router);
    return a;
  };
  const say = async (a: express.Express, what: 'yes' | 'no', shutdown = false) => {
    const { body } = await request(a).get(`${BASE}/confirm`);
    return request(a).post(`${BASE}/confirm`).set('X-Instar-Request', '1').send({ token: body.token, pin: '1', answer: what, shutdown });
  };
  const storeKey = (a: express.Express, token: string, chatId: string) => request(a).post(`${BASE}/key`).set('X-Instar-Request', '1').set('X-Telegram-Chat-Id', chatId).type('text/plain').send(token);

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-tg-'));
    ledger = new RecommendedServicesLedger({ stateDir: dir, signer, keyLookup: (() => ({ status: 'unknown' })) as unknown as MachineKeyLookup });
    entry = null; probe = 'ok'; restarts = []; otherRoute = true;
    start = vi.fn(async () => ({ sessionName: 's-tg', topicId: 7 }));
    told = vi.fn();
  });
  afterEach(() => SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/integration/recommended-services-telegram.test.ts' }));

  it('yes → setup → the session writes the channel → restart requested → check passes → switch-off disables it', async () => {
    const a = app();
    expect((await say(a, 'yes')).status).toBe(200);
    await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(1));
    expect(readSetupStates(dir).telegram?.absentBeforeSetup).toBe(true);
    expect((await storeKey(a, 'not-a-token', '-1001')).status).toBe(400);
    expect((await storeKey(a, TOKEN, '12345')).body.error).toBe('invalid-chat-id');
    // The server proves the token and group before writing anything: a refused one is never stored or restarted into.
    probe = 'token-refused';
    const refused = await storeKey(a, TOKEN, '-1001234567');
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ error: 'telegram-refused', probe: 'token-refused' });
    expect(entry).toBeNull();
    expect(restarts).toHaveLength(0);
    probe = 'ok';
    const ok = await storeKey(a, TOKEN, '-1001234567');
    expect(ok.body).toEqual({ stored: true, restarting: true });
    expect(entry).toEqual({ token: TOKEN, chatId: '-1001234567', enabled: true });
    expect(restarts).toHaveLength(1);
    // Setup made it, so a switch-off may disable it even before any check ran.
    expect(readSetupStates(dir).telegram?.signedInBySetup).toBe(true);
    const verify = await request(a).post(`${BASE}/verify`).set('X-Instar-Request', '1').send({});
    expect(verify.body.result).toBe('pass');

    expect((await say(a, 'no', true)).status).toBe(200);
    await vi.waitFor(() => expect(entry?.enabled).toBe(false));
    expect(entry?.token).toBe(TOKEN);
    expect(restarts).toHaveLength(2);
  });

  it('a working Telegram the person already had is never replaced, and a switch-off leaves it alone', async () => {
    entry = { token: TOKEN, chatId: '-1001234509', enabled: true };
    const a = app();
    await say(a, 'yes');
    await vi.waitFor(() => expect(told).toHaveBeenCalledWith(expect.stringContaining('already working')));
    expect(start).not.toHaveBeenCalled();
    expect((await storeKey(a, '987654321:' + 'C'.repeat(35), '-1001234510')).body.error).toBe('already-held');
    await say(a, 'no', true);
    await vi.waitFor(() => expect(readSetupStates(dir).telegram?.stopped).toBeTruthy());
    expect(entry).toEqual({ token: TOKEN, chatId: '-1001234509', enabled: true });
  });

  it('a switch-off of the only way in waits, and says so, until another route works', async () => {
    otherRoute = false;
    const a = app();
    await say(a, 'yes');
    await vi.waitFor(() => expect(start).toHaveBeenCalled());
    await storeKey(a, TOKEN, '-1001234567');
    await request(a).post(`${BASE}/verify`).set('X-Instar-Request', '1').send({});
    await say(a, 'no', true);
    await vi.waitFor(() => expect(told).toHaveBeenCalledWith(expect.stringContaining('only way I can reach you')));
    expect(entry?.enabled).toBe(true);
  });
});
