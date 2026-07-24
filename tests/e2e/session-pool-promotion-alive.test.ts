import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { StageAdvancer } from '../../src/core/StageAdvancer.js';
import { SessionPoolRolloutDriver } from '../../src/core/SessionPoolRolloutDriver.js';
import { SessionPoolPromotionActivation } from '../../src/core/sessionPoolPromotionActivation.js';
import { SessionPoolE2EResultStore } from '../../src/core/SessionPoolE2EResultStore.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { InstarConfig } from '../../src/core/types.js';

const AUTH = 'promotion-e2e-auth';

describe('session-pool promotion feature is alive', () => {
  let dir: string;
  let server: AgentServer;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'promotion-alive-'));
    fs.mkdirSync(path.join(dir, 'state', 'sessions'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ port: 0, projectName: 'e2e' }));
    const store = new SessionPoolE2EResultStore({
      filePath: path.join(dir, 'results.json'),
      sign: (content) => `sig:${content.length}`,
      verifySig: (content, signature) => signature === `sig:${content.length}`,
    });
    store.recordResult(0, 'green', 'sha', 'feature-alive');
    let stage: 'dark' | 'shadow' | 'live-transfer' | 'rebalance' = 'dark';
    const advancer = new StageAdvancer({
      resultStore: store,
      currentCommitSha: () => 'sha',
      readStage: () => stage,
      writeStageConfig: (next) => { stage = next; },
    });
    const driver = new SessionPoolRolloutDriver({
      advancer,
      enabled: () => true,
      targetCeiling: () => 'shadow',
    });
    const activation = new SessionPoolPromotionActivation(
      { model: 'operator', ceiling: 'shadow', tickMs: 60_000 },
      driver,
    );
    const config = {
      projectName: 'e2e', projectDir: dir, stateDir: dir, port: 0,
      authToken: AUTH, dashboardPin: '000000', requestTimeoutMs: 10_000, version: '0.0.0',
      sessions: { claudePath: '/usr/bin/echo', maxSessions: 1, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5000 },
      scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 },
      messaging: [], monitoring: {}, updates: {},
    } as InstarConfig;
    server = new AgentServer({
      config,
      sessionManager: {
        listRunningSessions: () => [],
        getSession: () => null,
        on: () => undefined,
      } as never,
      state: new StateManager(dir),
      sessionPoolPromotionActivation: activation,
    });
    await server.start();
  });

  afterAll(async () => {
    await server?.stop();
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/e2e/session-pool-promotion-alive.test.ts' });
  });

  it('authenticated operator request reaches the real route, driver, gate, and stage writer', async () => {
    const response = await request(server.getApp())
      .post('/session-pool/promote')
      .set({ Authorization: `Bearer ${AUTH}` });
    expect(response.status).toBe(200);
    expect(response.body.result).toMatchObject({
      ran: true,
      reconciledTo: 'dark',
      advancedTo: 'shadow',
    });
  });

  it('requires bearer authentication', async () => {
    expect((await request(server.getApp()).post('/session-pool/promote')).status).toBe(401);
  });
});
