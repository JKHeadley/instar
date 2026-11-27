/**
 * Feature-is-alive proof for the multi-machine organization routes (CMT-1873): on the production boot
 * path, a machine that has the published-elsewhere marker forwards the public pack through the wired
 * forward hook; without the hook (single machine) it answers as before.
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
import { markPublishedElsewhere, setOrgForward } from '../../src/server/orgPackRoutes.js';

const servers: AgentServer[] = [];
const dirs: string[] = [];
afterAll(async () => {
  setOrgForward(null);
  for (const s of servers) await s.stop();
  for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/e2e/org-multimachine-alive.test.ts' });
});

describe('org multi-machine forwarding is alive', () => {
  it('forwards only with the marker and a wired hook', async () => {
    const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'omm-e2e-'));
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
    expect((await request(app).get('/org/pack/current')).status).toBe(404);
    setOrgForward(async () => ({ status: 200, body: { forwarded: true } }));
    expect((await request(app).get('/org/pack/current')).status).toBe(404);
    markPublishedElsewhere(stateDir, 'org_AAAAAAAAAAAAAAAAAAAA', 'peer');
    const draft = await request(app).post('/org/draft').set('Authorization', 'Bearer e2e-token')
      .send({ orgName: 'Office', policyMarkdown: '## Never\n- Share a donor list\n' });
    expect(draft.status).toBe(409);
    expect(draft.body).toMatchObject({ error: 'org-key-elsewhere', machineId: 'peer' });
    const fw = await request(app).get('/org/pack/current');
    expect(fw.status).toBe(200);
    expect(fw.body).toEqual({ forwarded: true });
    setOrgForward(async () => null);
    expect((await request(app).get('/org/pack/current')).body.error).toBe('org-key-machine-asleep');
  });
});
