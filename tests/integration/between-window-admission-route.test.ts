import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { createMockSessionManager, createTempProject, type TempProject } from '../helpers/setup.js';
import type { InstarConfig } from '../../src/core/types.js';
import { validAdmissionPackage, writeAdmissionStore } from '../helpers/betweenWindowAdmissionFixture.js';

describe('POST /gate/between-window-admission', () => {
  const AUTH_TOKEN = 'between-window-route-token';
  let project: TempProject;
  let server: AgentServer;
  let app: ReturnType<AgentServer['getApp']>;

  beforeEach(async () => {
    project = createTempProject();
    writeAdmissionStore(project.stateDir);

    const config: InstarConfig = {
      projectName: 'between-window-route',
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

  afterEach(async () => {
    await server.stop();
    project.cleanup();
  });

  it('passes a complete store-facing admission package', async () => {
    const res = await request(app)
      .post('/gate/between-window-admission')
      .set('Authorization', `Bearer ${AUTH_TOKEN}`)
      .send(validAdmissionPackage())
      .expect(200);

    expect(res.body.admitted).toBe(true);
    expect(res.body.checked.fullHistoryReceipts).toBe(2);
    expect(res.body.checked.tenetReceipts).toBe(3);
    expect(res.body.corpusMismatches).toHaveLength(2);
  });

  it('refuses when a stored assessment id is claimed but absent from the store', async () => {
    const pkg = structuredClone(validAdmissionPackage());
    const receipts = pkg.fullHistoryReceipts as Array<Record<string, unknown>>;
    const receipt = receipts[1].receipt as Record<string, unknown>;
    receipt.assessment = {
      status: 'posted',
      summary: 'claimed posted',
      storedMessageIds: [777777],
    };

    const res = await request(app)
      .post('/gate/between-window-admission')
      .set('Authorization', `Bearer ${AUTH_TOKEN}`)
      .send(pkg)
      .expect(409);

    expect(res.body.admitted).toBe(false);
    expect(res.body.issues.map((issue: { code: string }) => issue.code)).toContain('POSTED_ASSESSMENT_MISSING_FROM_STORE');
  });
});
