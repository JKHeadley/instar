/**
 * A second AI subscription through the routes: a yes starts setup because nothing second is switched on; the
 * session's call switches on a door already signed in; the check passes; a no with switch-off turns that door
 * off for this agent and leaves the machine's sign-in alone.
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
import { withDoor, withoutDoor, type AiDoorSurface } from '../../src/recommended/aiDoors.js';
import type { MachineKeyLookup, MachineSigner } from '../../src/core/AppRecordSignatures.js';

const { privateKey } = crypto.generateKeyPairSync('ed25519');
const signer: MachineSigner = {
  machineId: () => 'm_a', signerKeyHash: () => 'h',
  sign: (p: string) => ({ machineId: 'm_a', signerKeyHash: 'h', sig: crypto.sign(null, Buffer.from(p), privateKey).toString('base64') }) as ReturnType<MachineSigner['sign']>,
};
const PROVEN: CatalogRow = { ...RECOMMENDED_SERVICE_CATALOG.find((r) => r.id === 'second-ai-door')!, setupRecipe: 'second-door-v1' };
const BASE = '/recommended-services/second-ai-door';

describe('a second AI subscription through the routes', () => {
  let dir: string;
  let ledger: RecommendedServicesLedger;
  let enabled: string[];
  let codexSigned: boolean;
  let added: string[];
  let start: ReturnType<typeof vi.fn>;
  let told: ReturnType<typeof vi.fn>;

  const surface = (): AiDoorSurface => ({
    enabled: () => [...enabled],
    installed: () => true,
    signedIn: async (d) => (d === 'codex-cli' ? (codexSigned ? 'signed-in' : 'signed-out') : 'signed-in'),
    enable: (d) => { const next = withDoor(enabled, d); if (!next) return false; enabled = next; added.push(d); return true; },
    disable: (d) => { if (!added.includes(d)) return false; enabled = withoutDoor(enabled, d); added = added.filter((x) => x !== d); return true; },
  });
  const app = () => {
    const a = express();
    a.use(express.json());
    const router = express.Router();
    registerRecommendedServiceRoutes(router, {
      ledger: () => ledger, stateDir: dir, owner: () => '42', catalog: [PROVEN], port: 4040,
      checkPin: () => true, checkConfirmPin: () => true, recordApproval: () => undefined,
      openCommitment: () => 'CMT-1', finishCommitment: () => undefined, withdrawCommitment: () => undefined,
      startSetup: start, stopSetup: () => true, sessionForTopic: () => null, isSetupRunning: () => false,
      notifyStuck: async () => true, clearStuck: () => undefined, tellOwner: told,
      readSecret: () => null, writeSecret: () => undefined, deleteSecret: () => undefined,
      aiDoors: surface(),
    });
    a.use(router);
    return a;
  };
  const say = async (a: express.Express, what: 'yes' | 'no', shutdown = false) => {
    const { body } = await request(a).get(`${BASE}/confirm`);
    return request(a).post(`${BASE}/confirm`).set('X-Instar-Request', '1').send({ token: body.token, pin: '1', answer: what, shutdown });
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-door-'));
    ledger = new RecommendedServicesLedger({ stateDir: dir, signer, keyLookup: (() => ({ status: 'unknown' })) as unknown as MachineKeyLookup });
    enabled = ['claude-code']; codexSigned = false; added = [];
    start = vi.fn(async () => ({ sessionName: 's-door', topicId: 7 }));
    told = vi.fn();
  });
  afterEach(() => SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/integration/recommended-services-second-door.test.ts' }));

  it('yes → setup → the person signs in → check passes → the server lists it → switch-off takes back only that', async () => {
    const a = app();
    expect((await say(a, 'yes')).status).toBe(200);
    await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(1));
    expect(readSetupStates(dir)['second-ai-door']?.absentBeforeSetup).toBe(true);
    let sync = await request(a).post(`${BASE}/sync`).set('X-Instar-Request', '1').send({});
    expect(sync.body.ok).toBe(false);
    expect(enabled).toEqual(['claude-code']);
    codexSigned = true;
    const verify = await request(a).post(`${BASE}/verify`).set('X-Instar-Request', '1').send({});
    expect(verify.body.result).toBe('pass');
    expect(readSetupStates(dir)['second-ai-door']?.signedInBySetup).toBe(true);
    sync = await request(a).post(`${BASE}/sync`).set('X-Instar-Request', '1').send({});
    expect(sync.body.ok).toBe(true);
    expect(enabled).toEqual(['claude-code', 'codex-cli']);

    expect((await say(a, 'no', true)).status).toBe(200);
    await vi.waitFor(() => expect(enabled).toEqual(['claude-code']));
    expect(codexSigned).toBe(true);
    await vi.waitFor(() => expect(told).toHaveBeenCalledWith(expect.stringContaining("taken back out of this agent's settings")));
    // The switch-off forgets the last refresh, so a later yes lists the door again on the next regular check.
    await vi.waitFor(() => expect(readSetupStates(dir)['second-ai-door']?.stopped).toBeTruthy());
    expect(readSetupStates(dir)['second-ai-door']?.lastSyncAt).toBeUndefined();
  });

  it('a second provider the person had listed and signed in before the yes is left as it was by a switch-off', async () => {
    enabled = ['claude-code', 'codex-cli']; codexSigned = true;
    const a = app();
    await say(a, 'yes');
    await vi.waitFor(() => expect(told).toHaveBeenCalledWith(expect.stringContaining('already working')));
    expect(start).not.toHaveBeenCalled();
    await say(a, 'no', true);
    await vi.waitFor(() => expect(readSetupStates(dir)['second-ai-door']?.stopped).toBeTruthy());
    expect(enabled).toEqual(['claude-code', 'codex-cli']);
  });
});
