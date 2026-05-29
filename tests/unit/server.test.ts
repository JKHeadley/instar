import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { createTempProject, createMockSessionManager } from '../helpers/setup.js';
import type { TempProject, MockSessionManager } from '../helpers/setup.js';
import type { InstarConfig } from '../../src/core/types.js';

describe('AgentServer', () => {
  let project: TempProject;
  let mockSM: MockSessionManager;
  let server: AgentServer;
  let app: ReturnType<AgentServer['getApp']>;

  const fakeConfig: InstarConfig = {
    projectName: 'test-project',
    projectDir: '/tmp/test',
    stateDir: '/tmp/test/.instar',
    port: 0, // not actually listening in tests
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
  };

  beforeAll(() => {
    project = createTempProject();
    mockSM = createMockSessionManager();

    server = new AgentServer({
      config: fakeConfig,
      sessionManager: mockSM as any,
      state: project.state,
    });
    app = server.getApp();
  });

  afterAll(() => {
    project.cleanup();
  });

  describe('GET /health', () => {
    it('returns ok status', async () => {
      const res = await request(app).get('/health');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
      expect(res.body.project).toBe('test-project');
      expect(res.body).toHaveProperty('uptime');
      expect(res.body).toHaveProperty('uptimeHuman');
      expect(res.body).toHaveProperty('version');
    });

    it('includes memory usage in health response', async () => {
      const res = await request(app).get('/health');
      expect(res.status).toBe(200);
      expect(res.body.memory).toBeDefined();
      expect(typeof res.body.memory.rss).toBe('number');
      expect(typeof res.body.memory.heapUsed).toBe('number');
      expect(typeof res.body.memory.heapTotal).toBe('number');
      // Memory values should be in MB (positive integers)
      expect(res.body.memory.rss).toBeGreaterThan(0);
      expect(res.body.memory.heapUsed).toBeGreaterThan(0);
    });

    it('includes node version in health response', async () => {
      const res = await request(app).get('/health');
      expect(res.status).toBe(200);
      expect(res.body.node).toBe(process.version);
    });

    it('includes auto-updater restart deferral details when configured', async () => {
      const localProject = createTempProject();
      const localServer = new AgentServer({
        config: fakeConfig,
        sessionManager: createMockSessionManager() as any,
        state: localProject.state,
        autoUpdater: {
          getStatus: () => ({
            running: true,
            lastCheck: '2026-05-29T08:00:00.000Z',
            lastApply: '2026-05-29T08:01:00.000Z',
            lastAppliedVersion: '1.3.78',
            config: {},
            pendingUpdate: null,
            lastError: null,
            coalescingUntil: null,
            pendingUpdateDetectedAt: null,
            deferralReason: '1 active session(s): topic-458',
            deferralElapsedMinutes: 7,
            maxDeferralHours: 4,
            restartDeferral: {
              active: true,
              targetVersion: '1.3.78',
              firstDeferredAt: '2026-05-29T08:01:00.000Z',
              reason: '1 active session(s): topic-458',
              currentBlockers: ['topic-458'],
              nextRetryAt: '2026-05-29T08:06:00.000Z',
              updatedAt: '2026-05-29T08:01:00.000Z',
            },
          }),
        } as any,
      });

      const res = await request(localServer.getApp()).get('/health');
      localProject.cleanup();

      expect(res.status).toBe(200);
      expect(res.body.autoUpdater.restartDeferral).toMatchObject({
        targetVersion: '1.3.78',
        currentBlockers: ['topic-458'],
      });
    });
  });

  describe('GET /status', () => {
    it('returns session and scheduler info', async () => {
      const res = await request(app).get('/status');
      expect(res.status).toBe(200);
      expect(res.body.sessions).toHaveProperty('running');
      expect(res.body.sessions).toHaveProperty('max');
      expect(res.body.scheduler).toBeNull(); // No scheduler provided
    });
  });

  describe('GET /sessions', () => {
    it('returns empty array when no sessions', async () => {
      const res = await request(app).get('/sessions');
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });
  });

  describe('GET /sessions/:name/output', () => {
    it('returns output for valid session', async () => {
      // captureOutput returns 'mock output' for any session
      const res = await request(app).get('/sessions/test-session/output');
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('output');
    });
  });

  describe('POST /sessions/:name/input', () => {
    it('rejects missing text', async () => {
      const res = await request(app)
        .post('/sessions/test-session/input')
        .send({});
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('text');
    });

    it('returns 404 for non-running session', async () => {
      // sendInput returns false when session not in aliveSet
      const res = await request(app)
        .post('/sessions/nonexistent/input')
        .send({ text: 'hello' });
      expect(res.status).toBe(404);
    });
  });

  describe('POST /sessions/spawn', () => {
    it('rejects missing required fields', async () => {
      const res = await request(app)
        .post('/sessions/spawn')
        .send({ name: 'test' });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('required');
    });
  });

  describe('GET /jobs', () => {
    it('returns empty when no scheduler', async () => {
      const res = await request(app).get('/jobs');
      expect(res.status).toBe(200);
      expect(res.body.jobs).toEqual([]);
      expect(res.body.scheduler).toBeNull();
    });
  });

  describe('POST /jobs/:slug/trigger', () => {
    it('returns 503 when no scheduler', async () => {
      const res = await request(app)
        .post('/jobs/test-job/trigger')
        .send({});
      expect(res.status).toBe(503);
    });
  });

  describe('GET /events', () => {
    it('returns events', async () => {
      project.state.appendEvent({
        type: 'test',
        summary: 'Test event',
        timestamp: new Date().toISOString(),
      });

      const res = await request(app).get('/events');
      expect(res.status).toBe(200);
      expect(res.body.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('GET /telegram/topics', () => {
    it('returns empty array when telegram not configured', async () => {
      const res = await request(app).get('/telegram/topics');
      expect(res.status).toBe(200);
      expect(res.body.topics).toEqual([]);
    });
  });

  describe('GET /telegram/topics/:topicId/messages', () => {
    it('returns 503 when telegram not configured', async () => {
      const res = await request(app).get('/telegram/topics/123/messages');
      expect(res.status).toBe(503);
      expect(res.body.error).toContain('Telegram');
    });
  });

  describe('POST /telegram/reply/:topicId', () => {
    it('returns 503 when telegram not configured', async () => {
      const res = await request(app)
        .post('/telegram/reply/123')
        .send({ text: 'hello' });
      expect(res.status).toBe(503);
    });
  });

  describe('error handling', () => {
    it('DELETE /sessions/:id returns 404 for unknown session', async () => {
      const res = await request(app).delete('/sessions/nonexistent');
      expect(res.status).toBe(404);
    });
  });
});
