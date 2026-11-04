/**
 * Production-path proof (docs/specs/recommended-services.md, Testing): AgentServer serves the
 * ledger it is given, the route answers 200 not 503, a no reaches the ledger through the real PIN
 * check, and it survives a restart. With no ledger the route answers 503.
 */
import { describe, it, expect, afterAll } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { InitiativeTracker } from '../../src/core/InitiativeTracker.js';
import { createMockSessionManager } from '../helpers/setup.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { RecommendedServicesLedger } from '../../src/recommended/RecommendedServicesLedger.js';
import type { InstarConfig } from '../../src/core/types.js';
import type { MachineKeyLookup, MachineSigner } from '../../src/core/AppRecordSignatures.js';

const servers: AgentServer[] = [];
const dirs: string[] = [];
const { privateKey } = crypto.generateKeyPairSync('ed25519');
const signer: MachineSigner = {
  machineId: () => 'm_e2e', signerKeyHash: () => 'h',
  sign: (p: string) => ({ machineId: 'm_e2e', signerKeyHash: 'h', sig: crypto.sign(null, Buffer.from(p), privateKey).toString('base64') }) as ReturnType<MachineSigner['sign']>,
};
const AUTH = 'e2e-token';
const PIN = '123456';

function boot(withLedger: boolean) {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'rec-e2e-'));
  dirs.push(dir);
  const stateDir = path.join(dir, '.instar');
  for (const d of ['state/sessions', 'state/jobs', 'logs']) fs.mkdirSync(path.join(stateDir, d), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'config.json'), '{}');
  const config = {
    projectName: 'rec-e2e', projectDir: dir, stateDir, port: 0, host: '127.0.0.1', version: '0.0.0', authToken: AUTH, dashboardPin: PIN,
    sessions: { claudePath: '/usr/bin/echo', maxSessions: 1, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5000 },
    scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 }, messaging: [], updates: {},
  } as unknown as InstarConfig;
  const sessionManager = createMockSessionManager() as any;
  sessionManager.on = () => undefined;
  const makeLedger = () => new RecommendedServicesLedger({ stateDir, signer, keyLookup: (() => ({ status: 'unknown' })) as unknown as MachineKeyLookup });
  const server = new AgentServer({
    config, sessionManager, state: new StateManager(stateDir), initiativeTracker: new InitiativeTracker(stateDir),
    ...(withLedger ? { recommendedServicesLedger: makeLedger() } : {}),
  } as any);
  servers.push(server);
  return { server, makeLedger };
}

afterAll(async () => {
  for (const s of servers) await s.stop();
  for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/e2e/recommended-services-alive.test.ts' });
});

describe('recommended services: production wiring', () => {
  it('is alive: 200, a no through the real PIN check, and it survives a restart', async () => {
    const { server, makeLedger } = boot(true);
    const app = server.getApp();
    const list = await request(app).get('/recommended-services').set('Authorization', `Bearer ${AUTH}`);
    expect(list.status).toBe(200);
    expect(list.body.offersLive).toBe(false);
    expect(list.body).toMatchObject({ migrationComplete: false, firstResult: null });

    const noPin = await request(app).post('/recommended-services/jev/no').set('Authorization', `Bearer ${AUTH}`).set('X-Instar-Request', '1').send({});
    expect(noPin.status).toBe(403);

    const no = await request(app).post('/recommended-services/jev/no').set('Authorization', `Bearer ${AUTH}`).set('X-Instar-Request', '1').send({ pin: PIN, reason: 'cost' });
    expect(no.status).toBe(200);
    expect(no.body).toMatchObject({ choice: 'no', reason: 'cost' });
    expect(makeLedger().effective('jev').choice).toBe('no');
  });

  it('answers 503 rather than pretending when this machine has no ledger', async () => {
    const { server } = boot(false);
    const res = await request(server.getApp()).get('/recommended-services').set('Authorization', `Bearer ${AUTH}`);
    expect(res.status).toBe(503);
  });

  it('refuses to surface a retired offer', async () => {
    const { server } = boot(true);
    const res = await request(server.getApp()).post('/features/git-backup/surface').set('Authorization', `Bearer ${AUTH}`).send({ trigger: 't' });
    expect(res.status).toBe(409);
  });
});
