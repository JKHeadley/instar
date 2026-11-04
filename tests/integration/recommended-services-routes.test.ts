import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import express from 'express';
import request from 'supertest';
import { RecommendedServicesLedger } from '../../src/recommended/RecommendedServicesLedger.js';
import { markNewAgent, recordDeliveredFirstResult } from '../../src/recommended/offerPrerequisites.js';
import { registerRecommendedServiceRoutes } from '../../src/server/recommendedServiceRoutes.js';
import type { MachineKeyLookup, MachineSigner } from '../../src/core/AppRecordSignatures.js';

const { privateKey } = crypto.generateKeyPairSync('ed25519');
const signer: MachineSigner = {
  machineId: () => 'm_a', signerKeyHash: () => 'h',
  sign: (p: string) => ({ machineId: 'm_a', signerKeyHash: 'h', sig: crypto.sign(null, Buffer.from(p), privateKey).toString('base64') }) as ReturnType<MachineSigner['sign']>,
};

describe('recommended services routes', () => {
  let dir: string;
  let ledger: RecommendedServicesLedger | null;
  const app = () => {
    const a = express();
    a.use(express.json());
    const router = express.Router();
    registerRecommendedServiceRoutes(router, {
      ledger: () => ledger,
      stateDir: dir,
      owner: () => '42',
      recordApproval: () => undefined,
      openCommitment: () => undefined,
      checkPin: (req, res) => {
        if ((req.body as { pin?: string }).pin === '1234') return true;
        res.status(403).json({ error: 'pin' });
        return false;
      },
    });
    a.use(router);
    return a;
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-routes-'));
    ledger = new RecommendedServicesLedger({ stateDir: dir, signer, keyLookup: (() => ({ status: 'unknown' })) as unknown as MachineKeyLookup });
  });
  afterEach(() => SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/integration/recommended-services-routes.test.ts' }));

  it('lists every service, with offers not live', async () => {
    const res = await request(app()).get('/recommended-services');
    expect(res.status).toBe(200);
    expect(res.body.offersLive).toBe(false);
    expect(res.body.services.map((s: { service: string }) => s.service)).toContain('jev');
    const jev = res.body.services.find((s: { service: string }) => s.service === 'jev');
    expect(jev).toMatchObject({ backupStatus: 'specified', available: false, choice: 'unset' });
    expect(jev.dataLeaves).toContain('TypeSafe');
    expect(jev).not.toHaveProperty('setupRecipe');
  });

  it('reports what offers still wait for', async () => {
    let res = await request(app()).get('/recommended-services');
    expect(res.body).toMatchObject({ migrationComplete: false, firstResult: null });
    markNewAgent(dir);
    recordDeliveredFirstResult(dir, 'telegram', 41);
    res = await request(app()).get('/recommended-services');
    expect(res.body.migrationComplete).toBe(true);
    expect(res.body.firstResult).toMatchObject({ carrier: 'telegram', messageId: '41' });
  });

  it('a no needs the PIN, and a bearer token alone is not enough', async () => {
    const res = await request(app()).post('/recommended-services/jev/no').set('X-Instar-Request', '1').send({});
    expect(res.status).toBe(403);
    expect(ledger!.effective('jev').choice).toBe('unset');
  });

  it('a no needs the intent header', async () => {
    const res = await request(app()).post('/recommended-services/jev/no').send({ pin: '1234' });
    expect(res.status).toBe(403);
    expect(ledger!.effective('jev').choice).toBe('unset');
  });

  it('records a no with its reason and shutdown', async () => {
    const res = await request(app()).post('/recommended-services/jev/no').set('X-Instar-Request', '1').send({ pin: '1234', reason: 'cost', shutdown: true });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ choice: 'no', reason: 'cost', shutdown: 'authorized' });
  });

  it('refuses an unknown service, a free-text reason and a bad shutdown', async () => {
    const a = app();
    expect((await request(a).post('/recommended-services/nope/no').set('X-Instar-Request', '1').send({ pin: '1234' })).status).toBe(404);
    expect((await request(a).post('/recommended-services/jev/no').set('X-Instar-Request', '1').send({ pin: '1234', reason: 'too pricey' })).status).toBe(400);
    expect((await request(a).post('/recommended-services/jev/no').set('X-Instar-Request', '1').send({ pin: '1234', shutdown: 'yes' })).status).toBe(400);
  });

  it('answers 503 with no ledger', async () => {
    ledger = null;
    expect((await request(app()).get('/recommended-services')).status).toBe(503);
  });
});
