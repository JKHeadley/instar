import { describe, expect, it } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { InstarConfig } from '../../src/core/types.js';
import { MachineIdentityManager } from '../../src/core/MachineIdentity.js';
import { PROVEN_MACOS_VERSIONS } from '../../src/core/DesktopProvenVersions.js';

async function boot(remoteEnabled: boolean) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-locked-boot-'));
  const stateDir = path.join(dir, '.instar');
  fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ projectName: 'desktop-locked', port: 0 }));
  const machineId = (await new MachineIdentityManager(stateDir).generateIdentity({ name: 'Echo Mac' })).machineId;
  const config = {
    projectName: 'desktop-locked', projectDir: dir, stateDir, port: 0,
    authToken: 'desktop-locked-e2e', dashboardPin: '123456', developmentAgent: true,
    remoteDesktop: { enabled: remoteEnabled, frontMachineId: machineId },
    sessions: { claudePath: '/usr/bin/echo', maxSessions: 3, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5000 },
    scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 }, messaging: [], monitoring: {}, updates: {},
  } as InstarConfig;
  const server = new AgentServer({ config, state: new StateManager(stateDir), telegram: null, meshSelfId: machineId,
    listPoolMachines: () => [{ machineId, nickname: 'Echo Mac', online: true }] as never,
    sessionManager: { listRunningSessions: () => [], getSession: () => null, getRunningSessionPanePids: () => [] } as never });
  await server.start();
  return { server, dir };
}
const auth = { Authorization: 'Bearer desktop-locked-e2e' };

describe('locked-screen access on the production boot path', () => {
  it('ships with no proven macOS', () => {
    expect(PROVEN_MACOS_VERSIONS).toHaveLength(0);
  });

  it('stays dark when remote desktop is off', async () => {
    const { server, dir } = await boot(false);
    try {
      expect((await request(server.getApp()).get('/desktop/locked/status').set(auth)).status).toBe(503);
    } finally { await server.stop(); SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'test cleanup' }); }
  });

  it.skipIf(process.platform !== 'darwin')('is alive on a Mac and refuses to turn on', async () => {
    const { server, dir } = await boot(true);
    try {
      const status = await request(server.getApp()).get('/desktop/locked/status').set(auth);
      expect(status.status).toBe(200);
      expect(status.body).toMatchObject({ enabled: false, active: false, refusal: 'unsupported-macos' });
      const pin = await request(server.getApp()).post('/dashboard/unlock').send({ pin: '123456' });
      const session = pin.body.operatorSessionToken as string | undefined;
      const reply = await request(server.getApp()).post('/desktop/locked/settings')
        .set({ ...auth, 'X-Instar-Request': '1', 'X-Instar-Operator-Session': session ?? '' }).send({ enabled: true });
      expect([403, 409]).toContain(reply.status);
      if (session) expect(reply.body.error).toBe('unsupported-macos');
      const after = await request(server.getApp()).get('/desktop/locked/status').set(auth);
      expect(after.body.enabled).toBe(false);
    } finally { await server.stop(); SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'test cleanup' }); }
  });
});
