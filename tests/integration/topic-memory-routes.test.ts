/**
 * Integration test — TopicMemory API routes.
 *
 * Tests the full HTTP API for topic search, context retrieval,
 * summary management, and rebuild — with a real SQLite database
 * and real HTTP server.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { TopicMemory } from '../../src/memory/TopicMemory.js';
import {
  createTempProject,
  createMockSessionManager,
} from '../helpers/setup.js';
import type { TempProject, MockSessionManager } from '../helpers/setup.js';
import type { InstarConfig } from '../../src/core/types.js';

describe('TopicMemory API routes', () => {
  let project: TempProject;
  let mockSM: MockSessionManager;
  let server: AgentServer;
  let topicMemory: TopicMemory;
  let app: ReturnType<AgentServer['getApp']>;
  const AUTH_TOKEN = 'test-auth-topic-memory';

  beforeAll(async () => {
    project = createTempProject();
    mockSM = createMockSessionManager();

    // Initialize TopicMemory with test data
    topicMemory = new TopicMemory(project.stateDir);
    await topicMemory.open();

    // Seed test messages
    for (let i = 0; i < 30; i++) {
      topicMemory.insertMessage({
        messageId: i,
        topicId: 100,
        text: i % 2 === 0
          ? `User message ${i}: we need to fix the deployment pipeline${i === 0 ? ' at instar.sh under SEC-123.' : ''}`
          : `Agent response ${i}: I'll look into the CI/CD configuration`,
        fromUser: i % 2 === 0,
        timestamp: new Date(2026, 1, 24, 12, i).toISOString(),
        sessionName: i % 2 === 0 ? null : 'test-session',
      });
    }

    // Different topic
    for (let i = 0; i < 10; i++) {
      topicMemory.insertMessage({
        messageId: 100 + i,
        topicId: 200,
        text: `Database migration discussion message ${i}`,
        fromUser: i % 2 === 0,
        timestamp: new Date(2026, 1, 24, 14, i).toISOString(),
        sessionName: null,
      });
    }

    topicMemory.setTopicName(100, 'Deployment');
    topicMemory.setTopicName(200, 'Database');
    topicMemory.saveTopicSummary(100, 'Discussion about fixing the deployment pipeline and CI/CD.', 20, 19);

    const config: InstarConfig = {
      projectName: 'test-topic-memory',
      projectDir: project.dir,
      stateDir: project.stateDir,
      port: 0, // Ephemeral port
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
      sessionManager: mockSM as any,
      state: project.state,
      topicMemory,
    });

    await server.start();
    app = server.getApp();
  });

  afterAll(async () => {
    await server.stop();
    topicMemory.close();
    project.cleanup();
  });

  // ── Search ──────────────────────────────────────────────────

  describe('GET /topic/search', () => {
    it('searches across all topics', async () => {
      const res = await request(app)
        .get('/topic/search?q=deployment')
        .set('Authorization', `Bearer ${AUTH_TOKEN}`)
        .expect(200);

      expect(res.body.query).toBe('deployment');
      expect(res.body.results.length).toBeGreaterThan(0);
      expect(res.body.results[0].text).toBeDefined();
      expect(res.body.results[0].topicId).toBeDefined();
      expect(res.body.results[0].highlight).toBeDefined();
    });

    it('accepts dotted names and hyphenated IDs as literal queries', async () => {
      for (const [q, totalResults] of [['instar.sh', 1], ['SEC-123', 1], ['instarsh', 0], ['SEC-124', 0]] as const) {
        const response = await request(app).get('/topic/search').query({ q, topic: 100 })
          .set('Authorization', `Bearer ${AUTH_TOKEN}`).expect(200);
        expect(response.body.totalResults).toBe(totalResults);
      }
    });

    it('searches scoped to a topic', async () => {
      const res = await request(app)
        .get('/topic/search?q=message&topic=200')
        .set('Authorization', `Bearer ${AUTH_TOKEN}`)
        .expect(200);

      expect(res.body.topicId).toBe(200);
      expect(res.body.results.every((r: any) => r.topicId === 200)).toBe(true);
    });

    it('respects limit parameter', async () => {
      const res = await request(app)
        .get('/topic/search?q=message&limit=3')
        .set('Authorization', `Bearer ${AUTH_TOKEN}`)
        .expect(200);

      expect(res.body.results.length).toBeLessThanOrEqual(3);
    });

    it('returns 400 for missing query', async () => {
      await request(app)
        .get('/topic/search')
        .set('Authorization', `Bearer ${AUTH_TOKEN}`)
        .expect(400);
    });

    it('returns empty results for no matches', async () => {
      const res = await request(app)
        .get('/topic/search?q=xyznonexistent')
        .set('Authorization', `Bearer ${AUTH_TOKEN}`)
        .expect(200);

      expect(res.body.results).toHaveLength(0);
    });

    it('requires authentication', async () => {
      await request(app)
        .get('/topic/search?q=test')
        .expect(401);
    });
  });

  // ── Context ─────────────────────────────────────────────────

  describe('GET /topic/context/:topicId', () => {
    it('returns context with summary and recent messages', async () => {
      const res = await request(app)
        .get('/topic/context/100')
        .set('Authorization', `Bearer ${AUTH_TOKEN}`)
        .expect(200);

      expect(res.body.summary).toContain('deployment pipeline');
      expect(res.body.recentMessages.length).toBeGreaterThan(0);
      expect(res.body.totalMessages).toBe(30);
      expect(res.body.topicName).toBe('Deployment');
    });

    it('returns null summary for topic without one', async () => {
      const res = await request(app)
        .get('/topic/context/200')
        .set('Authorization', `Bearer ${AUTH_TOKEN}`)
        .expect(200);

      expect(res.body.summary).toBeNull();
      expect(res.body.recentMessages.length).toBeGreaterThan(0);
    });

    it('respects recent limit parameter', async () => {
      const res = await request(app)
        .get('/topic/context/100?recent=5')
        .set('Authorization', `Bearer ${AUTH_TOKEN}`)
        .expect(200);

      expect(res.body.recentMessages).toHaveLength(5);
    });

    it('returns 400 for invalid topicId', async () => {
      await request(app)
        .get('/topic/context/abc')
        .set('Authorization', `Bearer ${AUTH_TOKEN}`)
        .expect(400);
    });
  });

  // ── List ────────────────────────────────────────────────────

  describe('GET /topic/list', () => {
    it('lists all topics with metadata', async () => {
      const res = await request(app)
        .get('/topic/list')
        .set('Authorization', `Bearer ${AUTH_TOKEN}`)
        .expect(200);

      expect(res.body.topics.length).toBeGreaterThanOrEqual(2);
      expect(res.body.total).toBeGreaterThanOrEqual(2);

      const topic100 = res.body.topics.find((t: any) => t.topicId === 100);
      expect(topic100).toBeDefined();
      expect(topic100.topicName).toBe('Deployment');
      expect(topic100.messageCount).toBe(30);
      expect(topic100.hasSummary).toBe(true);

      const topic200 = res.body.topics.find((t: any) => t.topicId === 200);
      expect(topic200).toBeDefined();
      expect(topic200.hasSummary).toBe(false);
    });
  });

  // ── Stats ───────────────────────────────────────────────────

  describe('GET /topic/stats', () => {
    it('returns database statistics', async () => {
      const res = await request(app)
        .get('/topic/stats')
        .set('Authorization', `Bearer ${AUTH_TOKEN}`)
        .expect(200);

      expect(res.body.totalMessages).toBe(40); // 30 + 10
      expect(res.body.totalTopics).toBe(2);
      expect(res.body.topicsWithSummaries).toBe(1);
      expect(res.body.dbSizeBytes).toBeGreaterThan(0);
    });
  });

  // ── Summary Management ──────────────────────────────────────

  describe('POST /topic/summarize', () => {
    it('returns data for summary generation', async () => {
      const res = await request(app)
        .post('/topic/summarize')
        .set('Authorization', `Bearer ${AUTH_TOKEN}`)
        .send({ topicId: 100 })
        .expect(200);

      expect(res.body.topicId).toBe(100);
      expect(res.body.currentSummary).toBeDefined();
      expect(res.body.messagesSinceSummary).toBeGreaterThanOrEqual(0);
      expect(res.body.messages).toBeDefined();
      expect(Array.isArray(res.body.messages)).toBe(true);
    });

    it('returns 400 for missing topicId', async () => {
      await request(app)
        .post('/topic/summarize')
        .set('Authorization', `Bearer ${AUTH_TOKEN}`)
        .send({})
        .expect(400);
    });
  });

  describe('POST /topic/summary', () => {
    it('saves a generated summary', async () => {
      const res = await request(app)
        .post('/topic/summary')
        .set('Authorization', `Bearer ${AUTH_TOKEN}`)
        .send({
          topicId: 200,
          summary: 'New summary for topic 200.',
          messageCount: 10,
          lastMessageId: 109,
        })
        .expect(200);

      expect(res.body.saved).toBe(true);

      // Verify it's actually saved
      const context = await request(app)
        .get('/topic/context/200')
        .set('Authorization', `Bearer ${AUTH_TOKEN}`)
        .expect(200);

      expect(context.body.summary).toBe('New summary for topic 200.');
    });

    it('returns 400 for missing required fields', async () => {
      await request(app)
        .post('/topic/summary')
        .set('Authorization', `Bearer ${AUTH_TOKEN}`)
        .send({ topicId: 100 })
        .expect(400);
    });
  });

  // ── Rebuild ─────────────────────────────────────────────────

  describe('POST /topic/rebuild', () => {
    it('rebuilds from JSONL', async () => {
      // Create a JSONL file with known data
      const jsonlPath = path.join(project.stateDir, 'telegram-messages.jsonl');
      const lines = [];
      for (let i = 0; i < 5; i++) {
        lines.push(JSON.stringify({
          messageId: 1000 + i,
          topicId: 300,
          text: `Rebuild test message ${i}`,
          fromUser: true,
          timestamp: new Date(2026, 1, 24, 16, i).toISOString(),
        }));
      }
      fs.writeFileSync(jsonlPath, lines.join('\n'));

      const res = await request(app)
        .post('/topic/rebuild')
        .set('Authorization', `Bearer ${AUTH_TOKEN}`)
        .expect(200);

      expect(res.body.rebuilt).toBe(true);
      expect(res.body.messagesImported).toBe(5);
      expect(res.body.stats.totalMessages).toBe(5);
      // PROP-1289: rows the store absorbed without keeping are counted, and the
      // count reaches the only API consumer of the import stats. A counter the
      // route does not carry is a counter nobody can read.
      expect(res.body.parseErrors).toMatchObject({ notLanded: 0 });
    });
  });
});

// ── TopicMemory NOT initialized (server has no TopicMemory) ──────
//
// Tests the EXACT scenario that caused the DeepSignal bug:
// TopicMemory init fails → ctx.topicMemory is null → all topic
// routes return 503. This ensures the failure is clear and
// the server doesn't silently return empty data.

describe('TopicMemory API routes — not initialized', () => {
  let project: TempProject;
  let mockSM: MockSessionManager;
  let server: AgentServer;
  let app: ReturnType<AgentServer['getApp']>;
  const AUTH_TOKEN = 'test-auth-no-topic-memory';

  beforeAll(async () => {
    project = createTempProject();
    mockSM = createMockSessionManager();

    const config: InstarConfig = {
      projectName: 'test-no-topic-memory',
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

    // Deliberately NOT passing topicMemory — simulates init failure
    server = new AgentServer({
      config,
      sessionManager: mockSM as any,
      state: project.state,
      // topicMemory: undefined — not passed
    });

    await server.start();
    app = server.getApp();
  });

  afterAll(async () => {
    await server.stop();
    project.cleanup();
  });

  it('GET /topic/search returns 503', async () => {
    const res = await request(app)
      .get('/topic/search?q=test')
      .set('Authorization', `Bearer ${AUTH_TOKEN}`)
      .expect(503);

    expect(res.body.error).toContain('not initialized');
  });

  it('GET /topic/context/:topicId returns 503', async () => {
    const res = await request(app)
      .get('/topic/context/100')
      .set('Authorization', `Bearer ${AUTH_TOKEN}`)
      .expect(503);

    expect(res.body.error).toContain('not initialized');
  });

  it('GET /topic/list returns 503', async () => {
    const res = await request(app)
      .get('/topic/list')
      .set('Authorization', `Bearer ${AUTH_TOKEN}`)
      .expect(503);

    expect(res.body.error).toContain('not initialized');
  });

  it('GET /topic/stats returns 503', async () => {
    const res = await request(app)
      .get('/topic/stats')
      .set('Authorization', `Bearer ${AUTH_TOKEN}`)
      .expect(503);

    expect(res.body.error).toContain('not initialized');
  });

  it('POST /topic/summarize returns 503', async () => {
    const res = await request(app)
      .post('/topic/summarize')
      .set('Authorization', `Bearer ${AUTH_TOKEN}`)
      .send({ topicId: 100 })
      .expect(503);

    expect(res.body.error).toContain('not initialized');
  });

  it('POST /topic/summary returns 503', async () => {
    const res = await request(app)
      .post('/topic/summary')
      .set('Authorization', `Bearer ${AUTH_TOKEN}`)
      .send({ topicId: 100, summary: 'test', messageCount: 1, lastMessageId: 1 })
      .expect(503);

    expect(res.body.error).toContain('not initialized');
  });

  it('POST /topic/rebuild returns 503', async () => {
    const res = await request(app)
      .post('/topic/rebuild')
      .set('Authorization', `Bearer ${AUTH_TOKEN}`)
      .expect(503);

    expect(res.body.error).toContain('not initialized');
  });
});
