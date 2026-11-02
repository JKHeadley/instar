import { describe, expect, it } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { MachineIdentityManager } from '../../src/core/MachineIdentity.js';
import type { InstarConfig } from '../../src/core/types.js';

/** The production boot path: the screens route is alive, and the viewer that
 * uses it is served. It opens no grant, so no real screen or input is involved. */
async function boot(enabled: boolean) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-displays-'));
  const stateDir = path.join(dir, '.instar');
  fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ projectName: 'desktop-displays', port: 0 }));
  const machineId = (await new MachineIdentityManager(stateDir).generateIdentity({ name: 'Echo Mac' })).machineId;
  const config = {
    projectName: 'desktop-displays', projectDir: dir, stateDir, port: 0,
    authToken: 'desktop-displays-token', dashboardPin: '123456', developmentAgent: true,
    remoteDesktop: { enabled, frontMachineId: machineId },
    sessions: { claudePath: '/usr/bin/echo', maxSessions: 3, defaultMaxDurationMinutes: 30,
      protectedSessions: [], monitorIntervalMs: 5000 },
    scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 }, messaging: [], monitoring: {}, updates: {},
  } as InstarConfig;
  const server = new AgentServer({
    config, state: new StateManager(stateDir), telegram: null, meshSelfId: machineId,
    listPoolMachines: () => [{ machineId, nickname: 'Echo Mac', online: true }] as never,
    sessionManager: { listRunningSessions: () => [], getSession: () => null, getRunningSessionPanePids: () => [] } as never,
  });
  await server.start();
  return { server, dir };
}

const unknownRequest = '00000000-0000-4000-8000-000000000000';

describe('desktop screens on the production boot path', () => {
  it('is dark when remote desktop is off', async () => {
    const { server, dir } = await boot(false);
    try {
      const response = await request(server.getApp()).get(`/desktop/requests/${unknownRequest}/displays`)
        .set('Authorization', 'Bearer desktop-displays-token');
      expect(response.status).toBe(503);
    } finally {
      await server.stop();
      SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'desktop-displays dark cleanup' });
    }
  });

  it.skipIf(process.platform !== 'darwin')('is alive when enabled: the route answers, the broker path exists, the viewer ships', async () => {
    const { server, dir } = await boot(true);
    try {
      const app = server.getApp();
      const unlock = await request(app).post('/dashboard/unlock').send({ pin: '123456' });
      const headers = { Authorization: 'Bearer desktop-displays-token',
        'X-Instar-Operator-Session': unlock.body.operatorSessionToken };
      // Not 404 (unrouted) and not 503 (unwired): the authority itself refused
      // a request it never granted, which is the live path.
      const unknown = await request(app).get(`/desktop/requests/${unknownRequest}/displays`).set(headers);
      expect(unknown.status).toBe(403);
      expect(unknown.body).toEqual({ error: 'Desktop displays unavailable' });
      const noSession = await request(app).get(`/desktop/requests/${unknownRequest}/displays`)
        .set('Authorization', 'Bearer desktop-displays-token');
      expect(noSession.status).toBe(403);
      expect(noSession.body).toEqual({ error: 'Dashboard operator session required' });
      const viewer = await request(app).get('/dashboard/desktop.html');
      expect(viewer.text).toContain('id="displaysButton"');
      expect(viewer.text).toContain('data-shortcut="nextSpace"');
      const script = await request(app).get('/dashboard/desktop.js');
      expect(script.text).toContain('selectDisplay');
    } finally {
      await server.stop();
      SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'desktop-displays alive cleanup' });
    }
  });
});
