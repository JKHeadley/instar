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

/** Production boot path with desktop OFF: guided setup must be alive, because it
 * is the only way a machine that is off comes on. */
async function boot(remoteDesktop: InstarConfig['remoteDesktop'], developmentAgent = true) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-setup-boot-'));
  const stateDir = path.join(dir, '.instar');
  fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ projectName: 'desktop-setup', port: 0, keep: 'me' }));
  const machineId = (await new MachineIdentityManager(stateDir).generateIdentity({ name: 'Echo Mac' })).machineId;
  const config = {
    projectName: 'desktop-setup', projectDir: dir, stateDir, port: 0,
    authToken: 'setup-e2e-token', dashboardPin: '123456', developmentAgent, remoteDesktop,
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
  const app = server.getApp();
  const unlock = await request(app).post('/dashboard/unlock').send({ pin: '123456' });
  expect(unlock.status).toBe(200);
  const session = { Authorization: `Bearer ${unlock.body.token}`, 'X-Instar-Operator-Session': unlock.body.operatorSessionToken };
  return { server, app, dir, stateDir, machineId, session };
}

describe('guided setup production boot', () => {
  it('is alive with desktop off, turns this machine on, and asks for a real restart', async () => {
    const { server, app, dir, stateDir, machineId, session } = await boot({ enabled: false } as never);
    try {
      expect((await request(app).get('/desktop/targets').set(session)).status).toBe(503);
      const list = await request(app).get('/desktop/setup').set(session);
      expect(list.status).toBe(200);
      expect(list.body.machines).toHaveLength(1);
      expect(list.body.machines[0]).toMatchObject({ machineId, label: 'Echo Mac', state: 'off', ready: false });
      expect(list.body.machines[0].actions[0].id).toBe('turn-on');

      const on = await request(app).post(`/desktop/setup/${machineId}`).set(session).set('X-Instar-Request', '1').send({ action: 'turn-on' });
      expect(on.status).toBe(200);
      expect(on.body.step.state).toBe('restarting');
      const file = JSON.parse(fs.readFileSync(path.join(stateDir, 'config.json'), 'utf8'));
      expect(file).toMatchObject({ keep: 'me', remoteDesktop: { enabled: true, frontMachineId: machineId } });
      const flag = JSON.parse(fs.readFileSync(path.join(stateDir, 'state', 'restart-requested.json'), 'utf8'));
      expect(flag.requestedBy).toBe('remote-desktop-setup');
      expect(fs.readFileSync(path.join(stateDir, 'logs', 'desktop-setup.jsonl'), 'utf8')).toContain('"sender":"local"');
    } finally {
      await server.stop();
      SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'desktop-setup-boot cleanup' });
    }
  });

  it('serves the setup script under the page’s policy', async () => {
    const { server, app, dir } = await boot({ enabled: false } as never);
    try {
      const page = await request(app).get('/dashboard/desktop.html');
      expect(page.status).toBe(200);
      expect(page.text).toContain('id="setupRows"');
      const script = await request(app).get('/dashboard/desktop-setup.js');
      expect(script.status).toBe(200);
      expect(script.headers['content-type']).toContain('javascript');
      expect(script.text).toContain('createDesktopSetup');
    } finally {
      await server.stop();
      SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'desktop-setup-boot cleanup' });
    }
  });

  it('stays dark on a fleet agent', async () => {
    const { server, app, dir, session } = await boot({ enabled: false } as never, false);
    try {
      expect((await request(app).get('/desktop/setup').set(session)).status).toBe(503);
    } finally {
      await server.stop();
      SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'desktop-setup-boot cleanup' });
    }
  });

  it('refuses an operator route with a Bearer token and no PIN session', async () => {
    const { server, app, dir } = await boot({ enabled: false } as never);
    try {
      const response = await request(app).get('/desktop/setup').set('Authorization', 'Bearer setup-e2e-token');
      expect(response.status).toBe(403);
    } finally {
      await server.stop();
      SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'desktop-setup-boot cleanup' });
    }
  });
});
