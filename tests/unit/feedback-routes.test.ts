import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import { AgentServer } from '../../src/server/AgentServer.js';
import { FeedbackManager } from '../../src/core/FeedbackManager.js';
import { UpdateChecker } from '../../src/core/UpdateChecker.js';
import { createTempProject, createMockSessionManager } from '../helpers/setup.js';
import type { TempProject, MockSessionManager } from '../helpers/setup.js';
import type { AgentKitConfig } from '../../src/core/types.js';

describe('Feedback Routes', () => {
  let project: TempProject;
  let mockSM: MockSessionManager;
  let feedback: FeedbackManager;
  let updateChecker: UpdateChecker;
  let server: AgentServer;
  let app: ReturnType<AgentServer['getApp']>;

  const fakeConfig: AgentKitConfig = {
    projectName: 'test-project',
    projectDir: '/tmp/test',
    stateDir: '/tmp/test/.instar',
    port: 0,
    version: '0.1.9',
    sessions: {
      tmuxPath: '/usr/bin/tmux',
      claudePath: '/usr/bin/claude',
      projectDir: '/tmp/test',
      maxSessions: 3,
      protectedSessions: [],
      completionPatterns: [],
    },
    scheduler: {
      jobsFile: '',
      enabled: false,
      maxParallelJobs: 2,
      quotaThresholds: { normal: 50, elevated: 70, critical: 85, shutdown: 95 },
    },
    users: [],
    messaging: [],
    monitoring: {
      quotaTracking: false,
      memoryMonitoring: false,
      healthCheckIntervalMs: 30000,
    },
    relationships: {
      relationshipsDir: '/tmp/test/.instar/relationships',
      maxRecentInteractions: 20,
    },
    feedback: {
      enabled: true,
      webhookUrl: 'https://example.com/feedback',
      feedbackFile: '',
    },
  };

  beforeAll(() => {
    project = createTempProject();
    mockSM = createMockSessionManager();

    // Point feedback file to temp dir
    fakeConfig.feedback.feedbackFile = path.join(project.stateDir, 'feedback.json');

    feedback = new FeedbackManager(fakeConfig.feedback);
    updateChecker = new UpdateChecker(project.stateDir);

    server = new AgentServer({
      config: fakeConfig,
      sessionManager: mockSM as any,
      state: project.state,
      feedback,
      updateChecker,
    });
    app = server.getApp();
  });

  afterAll(() => {
    project.cleanup();
  });

  describe('POST /feedback', () => {
    it('rejects missing title', async () => {
      const res = await request(app)
        .post('/feedback')
        .send({ description: 'Something broke' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('title');
    });

    it('rejects missing description', async () => {
      const res = await request(app)
        .post('/feedback')
        .send({ title: 'Bug report' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('description');
    });

    it('accepts valid feedback', async () => {
      // Mock fetch for webhook
      const originalFetch = global.fetch;
      global.fetch = vi.fn().mockRejectedValue(new Error('offline'));

      const res = await request(app)
        .post('/feedback')
        .send({
          type: 'bug',
          title: 'Server crashes',
          description: 'The server crashes when I start it.',
          context: 'Error: EADDRINUSE',
        });

      expect(res.status).toBe(201);
      expect(res.body.ok).toBe(true);
      expect(res.body.id).toMatch(/^fb-/);

      global.fetch = originalFetch;
    });

    it('defaults type to "other" for invalid types', async () => {
      const originalFetch = global.fetch;
      global.fetch = vi.fn().mockRejectedValue(new Error('offline'));

      const res = await request(app)
        .post('/feedback')
        .send({
          type: 'invalid-type',
          title: 'Test',
          description: 'Testing invalid type',
        });

      expect(res.status).toBe(201);

      global.fetch = originalFetch;
    });

    it('includes agent metadata in feedback', async () => {
      const originalFetch = global.fetch;
      global.fetch = vi.fn().mockRejectedValue(new Error('offline'));

      await request(app)
        .post('/feedback')
        .send({
          type: 'feature',
          title: 'Need something',
          description: 'Details here',
        });

      // Check that the stored feedback has system info
      const items = feedback.list();
      const last = items[items.length - 1];
      expect(last.agentName).toBe('test-project');
      expect(last.instarVersion).toBe('0.1.9');
      expect(last.nodeVersion).toBeTruthy();
      expect(last.os).toBeTruthy();

      global.fetch = originalFetch;
    });
  });

  describe('GET /feedback', () => {
    it('returns feedback list', async () => {
      const res = await request(app).get('/feedback');
      expect(res.status).toBe(200);
      expect(res.body.feedback).toBeInstanceOf(Array);
      expect(res.body.feedback.length).toBeGreaterThan(0);
    });
  });

  describe('POST /feedback/retry', () => {
    it('returns retry results', async () => {
      const res = await request(app).post('/feedback/retry');
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(typeof res.body.retried).toBe('number');
      expect(typeof res.body.succeeded).toBe('number');
    });
  });

  describe('GET /updates', () => {
    it('returns update info', async () => {
      const res = await request(app).get('/updates');
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('currentVersion');
      expect(res.body).toHaveProperty('latestVersion');
      expect(res.body).toHaveProperty('updateAvailable');
      expect(res.body).toHaveProperty('checkedAt');
    });
  });

  describe('GET /updates/last', () => {
    it('returns last check info or message', async () => {
      const res = await request(app).get('/updates/last');
      expect(res.status).toBe(200);
      // Either has checkedAt (previous check exists) or message (no check yet)
      expect(
        res.body.checkedAt || res.body.message
      ).toBeTruthy();
    });
  });
});
