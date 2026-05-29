/**
 * E2E regression — Coherence Gate reports indeterminate checks honestly.
 *
 * Exercises the full AgentServer route wiring so an unbound Telegram topic
 * cannot be summarized as "all checks passed" at the HTTP boundary.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { ScopeVerifier } from '../../src/core/ScopeVerifier.js';
import {
  createTempProject,
  createMockSessionManager,
} from '../helpers/setup.js';
import type { TempProject, MockSessionManager } from '../helpers/setup.js';
import type { InstarConfig } from '../../src/core/types.js';

describe('Coherence Gate indeterminate summary lifecycle', () => {
  let project: TempProject;
  let mockSM: MockSessionManager;
  let server: AgentServer;
  let app: ReturnType<AgentServer['getApp']>;
  let originalCwd: string;
  const AUTH_TOKEN = 'test-auth-coherence-e2e';

  beforeAll(async () => {
    project = createTempProject();
    mockSM = createMockSessionManager();
    originalCwd = process.cwd();
    const projectDir = fs.realpathSync(project.dir);
    process.chdir(projectDir);
    fs.writeFileSync(path.join(project.stateDir, 'AGENT.md'), '# TestAgent\n');

    const coherenceGate = new ScopeVerifier({
      projectDir,
      stateDir: project.stateDir,
      projectName: 'test-coherence-project',
    });

    const config: InstarConfig = {
      projectName: 'test-coherence-project',
      projectDir,
      stateDir: project.stateDir,
      port: 0,
      authToken: AUTH_TOKEN,
      requestTimeoutMs: 5000,
      version: '0.9.11',
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
      users: [],
    };

    server = new AgentServer({
      config,
      sessionManager: mockSM as any,
      state: project.state,
      coherenceGate,
    });

    await server.start();
    app = server.getApp();
  });

  afterAll(async () => {
    await server.stop();
    process.chdir(originalCwd);
    project.cleanup();
  });

  it('returns warn plus indeterminate counts for an unbound topic', async () => {
    const res = await request(app)
      .post('/coherence/check')
      .set('Authorization', `Bearer ${AUTH_TOKEN}`)
      .send({
        action: 'deploy',
        context: { topicId: 919191 },
      })
      .expect(200);

    const topicCheck = res.body.checks.find((check: { name: string }) =>
      check.name === 'topic-project-alignment',
    );

    expect(topicCheck.passed).toBeNull();
    expect(res.body.passed).toBe(false);
    expect(res.body.recommendation).toBe('warn');
    expect(res.body.summary).toContain('3 of 4 coherence checks passed');
    expect(res.body.summary).toContain('1 indeterminate');
    expect(res.body.summary).not.toContain('All 4 coherence checks passed');
  });
});
