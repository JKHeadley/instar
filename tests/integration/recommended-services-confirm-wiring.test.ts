/**
 * The real routes hand a yes to the real owner check, approval ledger and commitment tracker
 * (docs/specs/recommended-services.md, Yes).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRoutes, type RouteContext } from '../../src/server/routes.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { RecommendedServicesLedger } from '../../src/recommended/RecommendedServicesLedger.js';
import { RECOMMENDED_SERVICE_CATALOG } from '../../src/recommended/catalog.js';
import { GLOBAL_PIN_KEY } from '../../src/core/PinAttemptStore.js';
import type { MachineKeyLookup, MachineSigner } from '../../src/core/AppRecordSignatures.js';

const { privateKey } = crypto.generateKeyPairSync('ed25519');
const signer: MachineSigner = {
  machineId: () => 'm_w', signerKeyHash: () => 'h',
  sign: (p: string) => ({ machineId: 'm_w', signerKeyHash: 'h', sig: crypto.sign(null, Buffer.from(p), privateKey).toString('base64') }) as ReturnType<MachineSigner['sign']>,
};
const PATH = '/recommended-services/jev/confirm';

let dir = '';
afterEach(() => {
  if (dir) SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'recommended-services-confirm-wiring test cleanup' });
  dir = '';
});

function fixture(ownerUid: number | undefined) {
  dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'rec-wiring-'));
  const recordApproval = vi.fn();
  const record = vi.fn();
  const ledger = new RecommendedServicesLedger({ stateDir: dir, signer, keyLookup: (() => ({ status: 'unknown' })) as unknown as MachineKeyLookup });
  const ctx = {
    config: { projectName: 'test', projectDir: dir, stateDir: dir, port: 0, users: [], sessions: {}, scheduler: {}, messaging: [], dashboardPin: '654321' },
    sessionManager: { listRunningSessions: () => [], clearInjectionTracker: () => undefined },
    state: { getJobState: () => null, getSession: () => null },
    telegram: { getLifelineTopicId: () => 55, getOwnerUserId: () => ownerUid, setCallbackApproverResolver: () => undefined, getTopicHistory: () => [] },
    recommendedServicesLedger: ledger,
    recommendedServicesCatalog: RECOMMENDED_SERVICE_CATALOG.map((r) => (r.id === 'jev' ? { ...r, setupRecipe: 'jev-v1' } : r)),
    approvalLedger: { recordApproval },
    commitmentTracker: { record },
    scheduler: null, relationships: null, feedback: null, dispatches: null,
    updateChecker: null, autoUpdater: null, autoDispatcher: null, quotaTracker: null,
    publisher: null, viewer: null, tunnel: null, evolution: null, watchdog: null,
    triageNurse: null, topicMemory: null, discoveryEvaluator: null,
    tokenLedger: null, featureMetricsLedger: null, resourceLedger: null, messagingToneGate: null,
    startTime: new Date(),
  } as unknown as RouteContext;
  const app = express();
  app.use(express.json());
  app.use('/', createRoutes(ctx));
  return { app, ctx, ledger, recordApproval, record };
}

describe('recommended services confirm wiring', () => {
  it('the real PIN check, owner, approval ledger and commitment tracker all receive a yes', async () => {
    const { app, ledger, recordApproval, record } = fixture(777);
    const { body: page } = await request(app).get(PATH);
    expect(page.token).toBeTruthy();

    const wrong = await request(app).post(PATH).set('X-Instar-Request', '1').send({ token: page.token, pin: '000000', answer: 'yes' });
    expect(wrong.status).toBe(403);
    expect(ledger.effective('jev').choice).toBe('unset');

    const yes = await request(app).post(PATH).set('X-Instar-Request', '1').send({ token: page.token, pin: '654321', answer: 'yes' });
    expect(yes.status).toBe(200);
    const grant = ledger.activeGrant('jev', 'm_w')!;
    expect(grant.principal).toBe('777');
    expect(recordApproval).toHaveBeenCalledWith(expect.objectContaining({ subject: 'recommended-service:jev', mode: 'approved-as-is', evidenceRef: grant.eventId }));
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ type: 'one-time-action', beaconEnabled: true, topicId: 55, userRequest: expect.stringContaining('Jev') }));
  });

  it('the confirm route holds the unlock limits: insecure connection and the global cap', async () => {
    const f = fixture(777);
    const { body: page } = await request(f.app).get(PATH);
    (f.ctx as { pinEntryRefusedHere?: () => boolean }).pinEntryRefusedHere = () => true;
    const insecure = await request(f.app).post(PATH).set('X-Instar-Request', '1').send({ token: page.token, pin: '654321', answer: 'yes' });
    expect(insecure.status).toBe(403);
    expect(insecure.body.error).toBe('insecure-connection');
    (f.ctx as { pinEntryRefusedHere?: () => boolean }).pinEntryRefusedHere = () => false;
    const failures: string[] = [];
    (f.ctx as { pinAttemptStore?: unknown }).pinAttemptStore = { blocked: (key: string) => key === GLOBAL_PIN_KEY, recordFailure: (k: string) => failures.push(k), recordSuccess: () => undefined };
    const capped = await request(f.app).post(PATH).set('X-Instar-Request', '1').send({ token: page.token, pin: '654321', answer: 'yes' });
    expect(capped.status).toBe(429);
    (f.ctx as { pinAttemptStore?: unknown }).pinAttemptStore = { blocked: () => false, recordFailure: (k: string) => failures.push(k), recordSuccess: () => undefined };
    await request(f.app).post(PATH).set('X-Instar-Request', '1').send({ token: page.token, pin: '000000', answer: 'yes' });
    expect(failures).toContain(GLOBAL_PIN_KEY);
  });

  it('an empty PIN never charges the cap every address shares', async () => {
    const f = fixture(777);
    const { body: page } = await request(f.app).get(PATH);
    const failures: string[] = [];
    (f.ctx as { pinAttemptStore?: unknown }).pinAttemptStore = { blocked: () => false, recordFailure: (k: string) => failures.push(k), recordSuccess: () => undefined };
    expect((await request(f.app).post(PATH).set('X-Instar-Request', '1').send({ token: page.token, answer: 'yes' })).status).toBe(403);
    expect(failures).toEqual([]);
  });

  it('an insecure connection gets no PIN box at all', async () => {
    const f = fixture(777);
    (f.ctx as { pinEntryRefusedHere?: () => boolean }).pinEntryRefusedHere = () => true;
    const page = await request(f.app).get(PATH);
    expect(page.status).toBe(403);
    expect(page.body.error).toBe('insecure-connection');
    expect(page.body.token).toBeUndefined();
  });

  it('with no owner the page gives no token', async () => {
    const { app } = fixture(undefined);
    const res = await request(app).get(PATH);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('no-owner');
  });
});
