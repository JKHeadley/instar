import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { createMockSessionManager, createTempProject, type TempProject } from '../helpers/setup.js';
import type { InstarConfig } from '../../src/core/types.js';
import { validAdmissionPackage, writeAdmissionStore } from '../helpers/betweenWindowAdmissionFixture.js';

describe('between-window charter admission lifecycle', () => {
  const AUTH_TOKEN = 'between-window-e2e-token';
  let project: TempProject;
  let server: AgentServer;
  let app: ReturnType<AgentServer['getApp']>;

  beforeAll(async () => {
    project = createTempProject();
    writeAdmissionStore(project.stateDir);

    const config: InstarConfig = {
      projectName: 'between-window-e2e',
      projectDir: project.dir,
      stateDir: project.stateDir,
      port: 0,
      authToken: AUTH_TOKEN,
      requestTimeoutMs: 5000,
      version: '0.9.1',
      sessions: {
        claudePath: '/usr/bin/echo',
        maxSessions: 3,
        defaultMaxDurationMinutes: 30,
        protectedSessions: [],
        monitorIntervalMs: 5000,
      },
      scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 },
      messaging: [],
      monitoring: {},
      updates: {},
    };

    server = new AgentServer({
      config,
      sessionManager: createMockSessionManager() as any,
      state: project.state,
    });
    await server.start();
    app = server.getApp();
  });

  afterAll(async () => {
    await server.stop();
    project.cleanup();
  });

  it('refuses then passes charter activation through the live admission endpoint', async () => {
    const incomplete = structuredClone(validAdmissionPackage());
    incomplete.fullHistoryReceipts = [((incomplete.fullHistoryReceipts as unknown[])[0])];

    const refused = await request(app)
      .post('/gate/between-window-admission')
      .set('Authorization', `Bearer ${AUTH_TOKEN}`)
      .send(incomplete)
      .expect(409);

    expect(refused.body.admitted).toBe(false);
    expect(refused.body.issues.map((issue: { code: string }) => issue.code)).toContain('RECEIPT_FIELD_MISSING');

    const passed = await request(app)
      .post('/gate/between-window-admission')
      .set('Authorization', `Bearer ${AUTH_TOKEN}`)
      .send(validAdmissionPackage())
      .expect(200);

    expect(passed.body.admitted).toBe(true);
    expect(passed.body.corpusMismatches.map((m: { scope: string }) => m.scope)).toEqual([
      'pathway',
      'observer-1-topic-36966',
    ]);
  });
});
