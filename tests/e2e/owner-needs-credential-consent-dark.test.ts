import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { expect, it } from 'vitest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { InstarConfig } from '../../src/core/types.js';
import { createMockSessionManager } from '../helpers/setup.js';

it('does not mount the disposable credential consent routes in AgentServer', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'needs-credential-dark-'));
  const stateDir = path.join(dir, '.instar');
  let server: AgentServer | undefined;
  try {
    for (const sub of ['state/sessions', 'state/jobs', 'logs']) fs.mkdirSync(path.join(stateDir, sub), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), '{}');
    const config = {
      projectName: 'needs-credential-dark', projectDir: dir, stateDir, port: 0, authToken: 'fixture-agent', developmentAgent: true,
      sessions: { claudePath: '/usr/bin/echo', maxSessions: 1, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5_000 },
      scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 }, messaging: [], updates: {},
    } as unknown as InstarConfig;
    const sessionManager = createMockSessionManager() as ConstructorParameters<typeof AgentServer>[0]['sessionManager'];
    sessionManager.on = () => sessionManager;
    server = new AgentServer({ config, sessionManager, state: new StateManager(stateDir) });
    const app = server.getApp();
    const auth = (call: request.Test) => call.set('Authorization', 'Bearer fixture-agent').set('X-Instar-AgentId', 'needs-credential-dark');
    const fixture = '/fixture/credential/ask-1';
    expect((await auth(request(app).get(fixture + '/card'))).status).toBe(404);
    expect((await auth(request(app).get(fixture))).status).toBe(404);
    expect((await auth(request(app).post(fixture)).send({ disclosureId: 'fixture', value: 'sample' })).status).toBe(404);
  } finally {
    if (server) await server.stop();
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'owner-needs-credential-consent-dark fixture' });
  }
});
