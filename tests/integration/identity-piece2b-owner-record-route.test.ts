/**
 * GET /owner-record over the real HTTP pipeline (identity-security piece 2b §8): 503 when off, auth required,
 * the Basic gate on a fresh machine, the enrolled gate after an owner key, and a lost record holding.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { createMockSessionManager } from '../helpers/setup.js';
import { StateManager } from '../../src/core/StateManager.js';
import type { InstarConfig } from '../../src/core/types.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { OwnerRecordStore } from '../../src/core/ownerRecordStore.js';
import { signOwnerRecordEntry } from '../../src/core/ownerRecord.js';
import type { OwnerRecordRouteDeps } from '../../src/server/ownerRecordRoutes.js';

const AUTH = 'test-owner-record-route';
const auth = { Authorization: `Bearer ${AUTH}` };

function keypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519', { publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
  return { pub: publicKey as string, priv: privateKey as string };
}
const signer = (priv: string) => (t: string) => crypto.sign(null, Buffer.from(t), priv).toString('base64');

function makeServer(tmp: string, deps: (() => OwnerRecordRouteDeps | null) | undefined) {
  const stateDir = path.join(tmp, '.instar');
  fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ port: 0, projectName: 'or', agentName: 'OR' }));
  const config: InstarConfig = {
    projectName: 'or', projectDir: tmp, stateDir, port: 0, authToken: AUTH, requestTimeoutMs: 10000, version: '0.10.3',
    sessions: { claudePath: '/usr/bin/echo', maxSessions: 3, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5000 },
    scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 }, messaging: [], monitoring: {}, updates: {},
  };
  return { server: new AgentServer({ config, sessionManager: createMockSessionManager() as never, state: new StateManager(stateDir), ownerRecord: deps }), stateDir };
}

describe('GET /owner-record', () => {
  let tmp: string;
  let off: AgentServer;
  let on: AgentServer;
  let store: OwnerRecordStore;
  const m = keypair();

  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'or-route-'));
    off = makeServer(path.join(tmp, 'off'), undefined).server;
    const built = makeServer(path.join(tmp, 'on'), () => ({ store, sync: null }));
    on = built.server;
    store = new OwnerRecordStore({
      instarDir: built.stateDir, agentId: 'or',
      self: () => ({ machineId: 'm_A', publicKeyPem: m.pub, sign: signer(m.priv) }),
      registeredKey: (id) => (id === 'm_A' ? m.pub : null),
      verifyFirstOwnerProof: (b) => b.proof === 'route-ok',
    });
    store.load();
  });
  afterAll(() => { SafeFsExecutor.safeRmSync(tmp, { recursive: true, force: true, operation: 'tests/integration/identity-piece2b-owner-record-route.test.ts:cleanup' }); });

  it('answers 503 when the owner record is off', async () => {
    const r = await request(off.getApp()).get('/owner-record').set(auth);
    expect(r.status).toBe(503);
  });

  it('requires the agent token', async () => {
    const r = await request(on.getApp()).get('/owner-record');
    expect(r.status).toBe(401);
  });

  it('reads Basic on a fresh machine, then after bootstrap', async () => {
    let r = await request(on.getApp()).get('/owner-record').set(auth);
    expect(r.status).toBe(200);
    expect(r.body.gate).toMatchObject({ act: 'basic', enrolment: 'never', reason: 'no-record-yet' });
    store.bootstrap();
    r = await request(on.getApp()).get('/owner-record').set(auth);
    expect(r.body).toMatchObject({ status: 'ok', level: 'basic', everEnrolled: false, machineKeys: ['m_A'], seenMarker: true });
  });

  it('reads the record after the first owner key, and never returns a private key', async () => {
    const o = keypair();
    const head = store.state()!.head[0];
    store.ingest([signOwnerRecordEntry({ kind: 'add-owner-key', agentId: 'or', parents: [head], body: { keyId: 'o_phone', publicKey: o.pub, label: 'phone', proof: 'route-ok' }, signer: { type: 'owner-key', keyId: 'o_phone' } }, signer(o.priv)).entry]);
    const r = await request(on.getApp()).get('/owner-record').set(auth);
    expect(r.body.gate).toMatchObject({ act: 'record', enrolment: 'enrolled' });
    expect(r.body.ownerKeys).toEqual(['o_phone']);
    expect(JSON.stringify(r.body)).not.toMatch(/PRIVATE KEY/);
  });

  it('holds when the enrolled record is lost', async () => {
    const recordDir = path.join(tmp, 'on', '.instar', 'state', 'owner-record');
    SafeFsExecutor.safeRmSync(recordDir, { recursive: true, force: true, operation: 'test: lose the owner record' });
    store.load();
    const r = await request(on.getApp()).get('/owner-record').set(auth);
    expect(r.body.gate).toMatchObject({ act: 'hold', enrolment: 'enrolled', reason: 'record-missing' });
  });
});
