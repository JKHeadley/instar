/**
 * API route tests for Commitment Tracking endpoints.
 *
 * Tests cover:
 * - GET /commitments — list all or active
 * - GET /commitments/:id — single lookup
 * - POST /commitments — record new commitment
 * - POST /commitments/:id/deliver — mark commitment delivered
 * - POST /commitments/:id/withdraw — withdraw commitment
 * - POST /commitments/verify — trigger verification
 * - GET /commitments/context — behavioral context for sessions
 * - Disabled state (null tracker)
 * - Input validation
 * - Error handling
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { CommitmentTracker } from '../../src/monitoring/CommitmentTracker.js';
import { LiveConfig } from '../../src/config/LiveConfig.js';
import { createTempProject, createMockSessionManager } from '../helpers/setup.js';
import type { TempProject } from '../helpers/setup.js';
import type { InstarConfig } from '../../src/core/types.js';

const fakeConfig: InstarConfig = {
  projectName: 'test-project',
  projectDir: '/tmp/test',
  stateDir: '/tmp/test/.instar',
  port: 0,
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

// ── Tests with CommitmentTracker enabled ──────────────────────────

describe('Commitment API routes (enabled)', () => {
  let project: TempProject;
  let tracker: CommitmentTracker;
  let server: AgentServer;
  let app: ReturnType<AgentServer['getApp']>;
  let liveConfig: LiveConfig;

  beforeAll(() => {
    project = createTempProject();
    // Write config for LiveConfig
    fs.writeFileSync(
      path.join(project.stateDir, 'config.json'),
      JSON.stringify({ updates: { autoApply: true }, sessions: { maxSessions: 3 } }, null, 2)
    );
    liveConfig = new LiveConfig(project.stateDir);
    tracker = new CommitmentTracker({ stateDir: project.stateDir, liveConfig });

    const mockSM = createMockSessionManager();
    server = new AgentServer({
      config: { ...fakeConfig, stateDir: project.stateDir },
      sessionManager: mockSM as any,
      state: project.state,
      commitmentTracker: tracker,
    });
    app = server.getApp();
  });

  afterAll(() => {
    tracker.stop();
    project.cleanup();
  });

  // ── GET /commitments ───────────────────────────────────

  describe('GET /commitments', () => {
    it('returns empty list initially', async () => {
      const res = await request(app).get('/commitments');
      expect(res.status).toBe(200);
      expect(res.body.enabled).toBe(true);
      expect(res.body.commitments).toEqual([]);
    });

    it('returns all commitments', async () => {
      tracker.record({
        type: 'behavioral',
        userRequest: 'Always ask first',
        agentResponse: 'Will do',
        behavioralRule: 'Always ask the user',
      });

      const res = await request(app).get('/commitments');
      expect(res.status).toBe(200);
      expect(res.body.commitments.length).toBeGreaterThanOrEqual(1);
    });

    it('filters by status=active', async () => {
      const c = tracker.record({
        type: 'behavioral',
        userRequest: 'temp rule',
        agentResponse: 'ok',
        behavioralRule: 'temp',
      });
      tracker.withdraw(c.id, 'done');

      const res = await request(app).get('/commitments?status=active');
      expect(res.status).toBe(200);
      // Withdrawn commitment should not appear in active list
      const ids = res.body.commitments.map((c: any) => c.id);
      expect(ids).not.toContain(c.id);
    });
  });

  // ── GET /commitments/:id ───────────────────────────────

  describe('GET /commitments/:id', () => {
    it('returns a commitment by ID', async () => {
      const c = tracker.record({
        type: 'one-time-action',
        userRequest: 'Deploy to staging',
        agentResponse: 'Deploying now',
        verificationMethod: 'manual',
      });

      const res = await request(app).get(`/commitments/${c.id}`);
      expect(res.status).toBe(200);
      expect(res.body.id).toBe(c.id);
      expect(res.body.userRequest).toBe('Deploy to staging');
    });

    it('returns 404 for non-existent ID', async () => {
      const res = await request(app).get('/commitments/CMT-999');
      expect(res.status).toBe(404);
      expect(res.body.error).toContain('not found');
    });
  });

  // ── POST /commitments ──────────────────────────────────

  describe('POST /commitments', () => {
    it('records a config-change commitment', async () => {
      const res = await request(app)
        .post('/commitments')
        .send({
          type: 'config-change',
          userRequest: 'Set max sessions to 5',
          agentResponse: 'Done, setting max sessions to 5',
          configPath: 'sessions.maxSessions',
          configExpectedValue: 5,
          topicId: 100,
        });

      expect(res.status).toBe(201);
      expect(res.body.id).toMatch(/^CMT-\d{3}$/);
      expect(res.body.type).toBe('config-change');
      expect(res.body.source).toBe('agent');
    });

    it('records a behavioral commitment', async () => {
      const res = await request(app)
        .post('/commitments')
        .send({
          type: 'behavioral',
          userRequest: 'Never auto-commit code',
          agentResponse: 'Understood, I will never auto-commit',
          behavioralRule: 'Never automatically commit code changes',
        });

      expect(res.status).toBe(201);
      expect(res.body.type).toBe('behavioral');
    });

    it('records the agent-facing one-time follow-up commitment shape', async () => {
      const res = await request(app)
        .post('/commitments')
        .send({
          type: 'one-time-action',
          userRequest: 'Report back when CI is green',
          agentResponse: 'I will report back when CI is green',
          topicId: 458,
        });

      expect(res.status).toBe(201);
      expect(res.body.id).toMatch(/^CMT-\d{3}$/);
      expect(res.body.type).toBe('one-time-action');
      expect(res.body.status).toBe('pending');
      expect(res.body.userRequest).toBe('Report back when CI is green');
      expect(res.body.agentResponse).toBe('I will report back when CI is green');
      expect(res.body.topicId).toBe(458);
      expect(res.body.verificationCount).toBe(0);
      expect(res.body.violationCount).toBe(0);
      expect(res.body.source).toBe('agent');
    });

    it('rejects missing required fields', async () => {
      const res = await request(app)
        .post('/commitments')
        .send({ type: 'behavioral' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('required');
    });

    it('rejects invalid commitment type', async () => {
      const res = await request(app)
        .post('/commitments')
        .send({
          type: 'invalid-type',
          userRequest: 'req',
          agentResponse: 'resp',
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('type must be');
    });

    it('rejects the stale follow-up type alias', async () => {
      const res = await request(app)
        .post('/commitments')
        .send({
          type: 'follow-up',
          userRequest: 'Report back',
          agentResponse: 'I will report back',
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('one-time-action');
    });
  });

  // ── POST /commitments/:id/deliver ──────────────────────

  describe('POST /commitments/:id/deliver', () => {
    it('transitions a pending commitment to delivered and removes it from active results', async () => {
      const created = await request(app)
        .post('/commitments')
        .send({
          type: 'one-time-action',
          userRequest: 'Send the summary',
          agentResponse: 'I will send the summary',
          topicId: 458,
        });

      expect(created.status).toBe(201);
      const id = created.body.id;

      const delivered = await request(app)
        .post(`/commitments/${id}/deliver`)
        .send({ deliveryMessageId: 'telegram-123' });

      expect(delivered.status).toBe(200);
      expect(delivered.body.delivered).toBe(true);
      expect(delivered.body.id).toBe(id);
      expect(delivered.body.commitment.status).toBe('delivered');
      expect(delivered.body.commitment.deliveryMessageId).toBe('telegram-123');
      expect(delivered.body.commitment.resolvedAt).toBeTruthy();
      expect(delivered.body.commitment.version).toBe(1);

      const byId = await request(app).get(`/commitments/${id}`);
      expect(byId.status).toBe(200);
      expect(byId.body.status).toBe('delivered');

      const active = await request(app).get('/commitments?status=active');
      expect(active.status).toBe(200);
      expect(active.body.commitments.map((c: any) => c.id)).not.toContain(id);
    });

    it('rejects deliver for unknown commitments', async () => {
      const res = await request(app).post('/commitments/CMT-999/deliver').send({});
      expect(res.status).toBe(404);
    });
  });

  // ── POST /commitments/:id/withdraw ─────────────────────

  describe('POST /commitments/:id/withdraw', () => {
    it('withdraws a commitment', async () => {
      const c = tracker.record({
        type: 'behavioral',
        userRequest: 'withdrawable',
        agentResponse: 'ok',
        behavioralRule: 'some rule',
      });

      const res = await request(app)
        .post(`/commitments/${c.id}/withdraw`)
        .send({ reason: 'Changed my mind' });

      expect(res.status).toBe(200);
      expect(res.body.withdrawn).toBe(true);

      // Verify it's actually withdrawn
      const check = tracker.get(c.id)!;
      expect(check.status).toBe('withdrawn');
    });

    it('rejects missing reason', async () => {
      const c = tracker.record({
        type: 'behavioral',
        userRequest: 'no-reason-test',
        agentResponse: 'ok',
        behavioralRule: 'rule',
      });

      const res = await request(app)
        .post(`/commitments/${c.id}/withdraw`)
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('reason');
    });

    it('returns 404 for non-existent commitment', async () => {
      const res = await request(app)
        .post('/commitments/CMT-999/withdraw')
        .send({ reason: 'gone' });

      expect(res.status).toBe(404);
    });
  });

  // ── POST /commitments/verify ───────────────────────────

  describe('POST /commitments/verify', () => {
    it('triggers verification and returns report', async () => {
      const res = await request(app)
        .post('/commitments/verify')
        .send();

      expect(res.status).toBe(200);
      expect(res.body.timestamp).toBeTruthy();
      expect(typeof res.body.active).toBe('number');
      expect(typeof res.body.verified).toBe('number');
      expect(typeof res.body.violated).toBe('number');
      expect(Array.isArray(res.body.violations)).toBe(true);
    });
  });

  // ── GET /commitments/context ───────────────────────────

  describe('GET /commitments/context', () => {
    it('returns behavioral context and health', async () => {
      const res = await request(app).get('/commitments/context');
      expect(res.status).toBe(200);
      expect(res.body.enabled).toBe(true);
      expect(typeof res.body.context).toBe('string');
      expect(res.body.health).toBeTruthy();
      expect(res.body.health.status).toBeTruthy();
    });
  });
});

// ── Tests with CommitmentTracker disabled ─────────────────────────

describe('Commitment API routes (disabled)', () => {
  let project: TempProject;
  let server: AgentServer;
  let app: ReturnType<AgentServer['getApp']>;

  beforeAll(() => {
    project = createTempProject();
    const mockSM = createMockSessionManager();
    server = new AgentServer({
      config: { ...fakeConfig, stateDir: project.stateDir },
      sessionManager: mockSM as any,
      state: project.state,
      // NO commitmentTracker — disabled state
    });
    app = server.getApp();
  });

  afterAll(() => {
    project.cleanup();
  });

  it('GET /commitments returns enabled: false', async () => {
    const res = await request(app).get('/commitments');
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(false);
    expect(res.body.commitments).toEqual([]);
  });

  it('POST /commitments returns 404', async () => {
    const res = await request(app)
      .post('/commitments')
      .send({
        type: 'behavioral',
        userRequest: 'req',
        agentResponse: 'resp',
      });
    expect(res.status).toBe(404);
  });

  it('GET /commitments/:id returns 404', async () => {
    const res = await request(app).get('/commitments/CMT-001');
    expect(res.status).toBe(404);
  });

  it('POST /commitments/:id/withdraw returns 404', async () => {
    const res = await request(app)
      .post('/commitments/CMT-001/withdraw')
      .send({ reason: 'test' });
    expect(res.status).toBe(404);
  });

  it('POST /commitments/verify returns 404', async () => {
    const res = await request(app)
      .post('/commitments/verify')
      .send();
    expect(res.status).toBe(404);
  });

  it('GET /commitments/context returns enabled: false', async () => {
    const res = await request(app).get('/commitments/context');
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(false);
    expect(res.body.context).toBe('');
  });
});
