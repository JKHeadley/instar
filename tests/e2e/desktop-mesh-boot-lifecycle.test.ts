/** Production boot proof for the PIN front and authenticated target route. */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { MultiMachineCoordinator } from '../../src/core/MultiMachineCoordinator.js';
import { MachineIdentityManager } from '../../src/core/MachineIdentity.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { signRequest } from '../../src/server/machineAuth.js';
import type { InstarConfig } from '../../src/core/types.js';
import { boundAgentServerBase } from '../helpers/boundAgentServerBase.js';

function machine(root: string, name: string) {
  const stateDir = path.join(root, name, '.instar');
  fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
  const identityManager = new MachineIdentityManager(stateDir);
  return { stateDir, identityManager, name };
}

describe('desktop mesh production boot', () => {
  it.skipIf(process.platform !== 'darwin')('serves a signed peer availability probe and refuses an unsigned admission', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-mesh-boot-'));
    const front = machine(root, 'front');
    const target = machine(root, 'target');
    let frontServer: AgentServer | undefined;
    let targetServer: AgentServer | undefined;
    let frontCoordinator: MultiMachineCoordinator | undefined;
    let targetCoordinator: MultiMachineCoordinator | undefined;
    try {
      const frontIdentity = await front.identityManager.generateIdentity({ name: 'Echo Front' });
      const targetIdentity = await target.identityManager.generateIdentity({ name: 'Echo Target' });
      front.identityManager.registerMachine(targetIdentity, 'standby');
      front.identityManager.storeRemoteIdentity(targetIdentity);
      target.identityManager.registerMachine(frontIdentity, 'awake');
      target.identityManager.storeRemoteIdentity(frontIdentity);
      const frontSigningKey = front.identityManager.loadSigningKey();
      const targetSigningKey = target.identityManager.loadSigningKey();
      const pool = [
        { machineId: frontIdentity.machineId, nickname: 'Echo Front', online: true },
        { machineId: targetIdentity.machineId, nickname: 'Echo Target', online: true },
      ];
      const config = (m: typeof front): InstarConfig => ({
        projectName: 'echo', projectDir: path.dirname(m.stateDir), stateDir: m.stateDir,
        port: 0, host: '127.0.0.1', authToken: `desktop-mesh-${m.name}`,
        dashboardPin: '123456', developmentAgent: true,
        remoteDesktop: { enabled: true, frontMachineId: frontIdentity.machineId },
        sessions: { claudePath: '/usr/bin/echo', maxSessions: 3, defaultMaxDurationMinutes: 30,
          protectedSessions: [], monitorIntervalMs: 5000 },
        scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 },
        messaging: [], monitoring: {}, updates: {},
      } as InstarConfig);
      const frontState = new StateManager(front.stateDir);
      const targetState = new StateManager(target.stateDir);
      frontCoordinator = new MultiMachineCoordinator(frontState, { stateDir: front.stateDir });
      targetCoordinator = new MultiMachineCoordinator(targetState, { stateDir: target.stateDir });
      frontCoordinator.start();
      targetCoordinator.start();
      let targetUrl = '';
      const sessions = { listRunningSessions: () => [], getSession: () => null,
        getRunningSessionPanePids: () => [] } as never;
      targetServer = new AgentServer({ config: config(target), state: targetState,
        sessionManager: sessions, telegram: null, coordinator: targetCoordinator,
        meshSelfId: targetIdentity.machineId, localSigningKeyPem: targetSigningKey,
        listPoolMachines: () => pool as never,
        resolvePeerUrls: () => [],
      });
      await targetServer.start();
      targetUrl = boundAgentServerBase(targetServer);
      frontServer = new AgentServer({ config: config(front), state: frontState,
        sessionManager: sessions, telegram: null, coordinator: frontCoordinator,
        meshSelfId: frontIdentity.machineId, localSigningKeyPem: frontSigningKey,
        listPoolMachines: () => pool as never,
        resolvePeerUrls: () => [{ machineId: targetIdentity.machineId, url: targetUrl, kind: 'lan' }],
      });
      await frontServer.start();
      const frontApp = frontServer.getApp();
      const unlock = await request(frontApp).post('/dashboard/unlock').send({ pin: '123456' });
      expect(unlock.status).toBe(200);
      const listed = await request(frontApp).get('/desktop/targets')
        .set('Authorization', 'Bearer desktop-mesh-front')
        .set('X-Instar-Operator-Session', unlock.body.operatorSessionToken);
      expect(listed.status).toBe(200);
      expect(listed.body.machines).toEqual(expect.arrayContaining([
        expect.objectContaining({ machineId: targetIdentity.machineId, label: 'Echo Target', ready: expect.any(Boolean),
          targetSigningPublicKey: targetIdentity.signingPublicKey }),
      ]));
      const targetUnlock = await request(targetServer.getApp()).post('/dashboard/unlock').send({ pin: '123456' });
      const targetLocalList = await request(targetServer.getApp()).get('/desktop/targets')
        .set('Authorization', 'Bearer desktop-mesh-target')
        .set('X-Instar-Operator-Session', targetUnlock.body.operatorSessionToken);
      expect(targetLocalList.status).toBe(503);
      const activation = await request(targetServer.getApp()).post('/desktop/activate-config')
        .set('Authorization', 'Bearer desktop-mesh-target')
        .set('X-Instar-Request', '1').send({});
      expect(activation.status).toBe(202);
      expect(activation.body).toEqual({ restartRequested: true });
      expect(JSON.parse(fs.readFileSync(path.join(target.stateDir, 'state', 'restart-requested.json'), 'utf8')))
        .toMatchObject({ requestedBy: 'remote-desktop-config', plannedRestart: true });
      const signed = await request(targetServer.getApp()).post('/api/desktop/availability')
        .set(signRequest(frontIdentity.machineId, frontSigningKey, {})).send({});
      expect(signed.status).toBe(200);
      expect(signed.body.machineId).toBe(targetIdentity.machineId);
      const unsigned = await request(targetServer.getApp()).post('/api/desktop/operator-begin').send({});
      expect(unsigned.status).toBe(401);
      // A valid transport identity alone never creates a desktop grant.
      const noAssertion = await request(targetServer.getApp()).post('/api/desktop/operator-begin')
        .set(signRequest(frontIdentity.machineId, frontSigningKey, {})).send({});
      expect(noAssertion.status).toBeGreaterThanOrEqual(400);
      expect(noAssertion.status).toBeLessThan(500);
    } finally {
      await frontServer?.stop();
      await targetServer?.stop();
      frontCoordinator?.stop();
      targetCoordinator?.stop();
      SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'desktop mesh boot cleanup' });
    }
  });
});
