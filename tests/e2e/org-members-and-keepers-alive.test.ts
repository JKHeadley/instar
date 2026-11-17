/**
 * Feature-is-alive proof for org-members-and-keepers (Acceptance 5): on the production boot path the
 * public check-in and propose routes answer 404 until something is published with updates on, then
 * 400 on an empty body; the members page refuses the bearer.
 */
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { InitiativeTracker } from '../../src/core/InitiativeTracker.js';
import { createMockSessionManager } from '../helpers/setup.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { InstarConfig } from '../../src/core/types.js';
import { newOrgKeyPair, sha256Hex, signRecord } from '../../src/core/OrgPack.js';

const servers: AgentServer[] = [];
const dirs: string[] = [];
afterAll(async () => {
  for (const s of servers) await s.stop();
  for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/e2e/org-members-and-keepers-alive.test.ts' });
});

describe('org-members-and-keepers is alive', () => {
  it('public routes answer on the production boot path; the page refuses the bearer', async () => {
    const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'omk-e2e-'));
    dirs.push(dir);
    const stateDir = path.join(dir, '.instar');
    for (const d of ['state/sessions', 'state/jobs', 'logs']) fs.mkdirSync(path.join(stateDir, d), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), '{}');
    const config = {
      projectName: 'e', projectDir: dir, stateDir, port: 0, authToken: 'e2e-token',
      sessions: { claudePath: '/usr/bin/echo', maxSessions: 1, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5_000 },
      scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 }, messaging: [], updates: {},
    } as unknown as InstarConfig;
    const sessionManager = createMockSessionManager() as any;
    sessionManager.on = () => undefined;
    const server = new AgentServer({ config, sessionManager, state: new StateManager(stateDir), initiativeTracker: new InitiativeTracker(stateDir) });
    servers.push(server);
    const app = server.getApp();
    expect((await request(app).post('/org/checkin').send({})).status).toBe(404);
    expect((await request(app).post('/org/pack/propose').send({})).status).toBe(404);
    const k = newOrgKeyPair();
    const policy = '## Never\n- Spend organization money\n';
    const record = signRecord({ v: 1, orgId: 'org_AAAAAAAAAAAAAAAAAAAA', orgName: 'Org', version: 1, policySha256: sha256Hex(policy), maxIndependence: 'balanced', publishedAt: 'x', publishedBy: 'A', keepers: [], updateOrigin: 'https://org.example.dev', signerPublicKey: k.publicKey }, k.privateKeyPem);
    fs.mkdirSync(path.join(stateDir, 'org', 'published'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'org', 'published', 'current.json'), JSON.stringify({ bundle: { record, policy }, shareUpdates: true }));
    // The publishing machine holds the organization key (a machine without it answers 409 org-key-elsewhere).
    fs.writeFileSync(path.join(stateDir, 'org', 'published', 'org_AAAAAAAAAAAAAAAAAAAA.signing-key'), k.privateKeyPem);
    expect((await request(app).post('/org/checkin').send({})).status).toBe(400);
    expect((await request(app).post('/org/pack/propose').send({})).status).toBe(400);
    expect((await request(app).get('/mobile/org/members').set('Authorization', 'Bearer e2e-token')).status).toBe(403);
    expect((await request(app).get('/org/members').set('Authorization', 'Bearer e2e-token')).status).toBe(200);
  });
});
