/**
 * Integration test — Deprecated /memory/* routes after MemoryIndex removal.
 *
 * Verifies that the legacy /memory/search, /memory/stats, /memory/reindex,
 * and /memory/sync endpoints correctly delegate to SemanticMemory and return
 * backwards-compatible response shapes with deprecation headers.
 *
 * Also tests the 503 path when SemanticMemory is not initialized.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { SemanticMemory } from '../../src/memory/SemanticMemory.js';
import { createMockSessionManager } from '../helpers/setup.js';
import { StateManager } from '../../src/core/StateManager.js';
import type { InstarConfig } from '../../src/core/types.js';

function buildConfig(projectDir: string, stateDir: string, authToken: string): InstarConfig {
  return {
    projectName: 'test-memory-routes',
    projectDir,
    stateDir,
    port: 0,
    authToken,
    requestTimeoutMs: 5000,
    version: '0.9.99',
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
}

describe('/memory/* deprecated routes — with SemanticMemory', () => {
  let tmpDir: string;
  let stateDir: string;
  let semanticMemory: SemanticMemory;
  let server: AgentServer;
  let app: ReturnType<AgentServer['getApp']>;
  const AUTH_TOKEN = 'test-memory-routes';

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-routes-'));
    stateDir = path.join(tmpDir, '.instar');
    fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'state', 'jobs'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });

    // Create SemanticMemory with test data
    semanticMemory = new SemanticMemory({
      dbPath: path.join(stateDir, 'semantic.db'),
      staleThreshold: 0.3,
      decayRate: 0.01,
      maxEntities: 10000,
    });
    await semanticMemory.open();

    semanticMemory.remember({
      type: 'fact',
      name: 'production-url',
      content: 'Production URL is dawn.bot-me.ai',
      confidence: 0.9,
      lastVerified: new Date().toISOString(),
      source: 'memory/MEMORY.md',
      tags: ['infrastructure'],
    });

    semanticMemory.remember({
      type: 'pattern',
      name: 'knowledge-db-rule',
      content: 'Always use prisma migrate for schema changes',
      confidence: 0.85,
      lastVerified: new Date().toISOString(),
      source: 'knowledge/patterns.md',
      tags: ['database'],
    });

    const config = buildConfig(tmpDir, stateDir, AUTH_TOKEN);
    const mockSM = createMockSessionManager();
    const state = new StateManager(stateDir);

    server = new AgentServer({
      config,
      sessionManager: mockSM as any,
      state,
      semanticMemory,
    });

    await server.start();
    app = server.getApp();
  });

  afterAll(async () => {
    await server.stop();
    semanticMemory.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── GET /memory/search ────────────────────────────────────────

  it('returns search results in backwards-compat shape', async () => {
    const res = await request(app)
      .get('/memory/search?q=production')
      .set('Authorization', `Bearer ${AUTH_TOKEN}`)
      .expect(200);

    expect(res.body).toHaveProperty('query', 'production');
    expect(res.body).toHaveProperty('results');
    expect(res.body).toHaveProperty('totalResults');
    expect(res.body).toHaveProperty('searchTimeMs');
    expect(res.body).toHaveProperty('_notice');

    // Check result shape matches old MemorySearchResult
    if (res.body.results.length > 0) {
      const result = res.body.results[0];
      expect(result).toHaveProperty('text');
      expect(result).toHaveProperty('source');
      expect(result).toHaveProperty('score');
      expect(result).toHaveProperty('highlight');
      expect(result).toHaveProperty('sourceModifiedAt');
    }
  });

  it('search respects limit parameter', async () => {
    const res = await request(app)
      .get('/memory/search?q=production&limit=1')
      .set('Authorization', `Bearer ${AUTH_TOKEN}`)
      .expect(200);

    expect(res.body.results.length).toBeLessThanOrEqual(1);
  });

  it('search filters by source prefix', async () => {
    const res = await request(app)
      .get('/memory/search?q=schema&source=knowledge/')
      .set('Authorization', `Bearer ${AUTH_TOKEN}`)
      .expect(200);

    for (const result of res.body.results) {
      expect(result.source).toMatch(/^knowledge\//);
    }
  });

  it('search sets deprecation headers', async () => {
    const res = await request(app)
      .get('/memory/search?q=test')
      .set('Authorization', `Bearer ${AUTH_TOKEN}`)
      .expect(200);

    expect(res.headers['deprecation']).toBe('true');
    expect(res.headers['sunset']).toBe('2026-06-01');
    expect(res.headers['link']).toContain('successor-version');
  });

  // ── GET /memory/stats ─────────────────────────────────────────

  it('returns stats in backwards-compat shape', async () => {
    const res = await request(app)
      .get('/memory/stats')
      .set('Authorization', `Bearer ${AUTH_TOKEN}`)
      .expect(200);

    // Old MemoryIndexStats shape
    expect(res.body).toHaveProperty('totalFiles');
    expect(res.body).toHaveProperty('totalChunks');
    expect(res.body).toHaveProperty('dbSizeBytes');
    expect(res.body).toHaveProperty('lastIndexedAt');
    expect(res.body).toHaveProperty('staleFiles');
    expect(res.body).toHaveProperty('vectorSearchAvailable');
    expect(res.body).toHaveProperty('_notice');

    expect(typeof res.body.totalFiles).toBe('number');
    expect(res.body.totalFiles).toBeGreaterThanOrEqual(2);
  });

  it('stats sets deprecation headers', async () => {
    const res = await request(app)
      .get('/memory/stats')
      .set('Authorization', `Bearer ${AUTH_TOKEN}`)
      .expect(200);

    expect(res.headers['deprecation']).toBe('true');
    expect(res.headers['sunset']).toBe('2026-06-01');
  });

  // ── POST /memory/reindex ──────────────────────────────────────

  it('reindex delegates to SemanticMemory.rebuild()', async () => {
    const res = await request(app)
      .post('/memory/reindex')
      .set('Authorization', `Bearer ${AUTH_TOKEN}`)
      .expect(200);

    expect(res.body).toHaveProperty('reindexed', true);
    expect(res.body).toHaveProperty('entities');
    expect(res.body).toHaveProperty('edges');
    expect(res.body).toHaveProperty('_notice');
  });

  it('reindex sets deprecation headers', async () => {
    const res = await request(app)
      .post('/memory/reindex')
      .set('Authorization', `Bearer ${AUTH_TOKEN}`)
      .expect(200);

    expect(res.headers['deprecation']).toBe('true');
    expect(res.headers['sunset']).toBe('2026-06-01');
  });

  // ── POST /memory/sync ─────────────────────────────────────────

  it('sync returns no-op response', async () => {
    const res = await request(app)
      .post('/memory/sync')
      .set('Authorization', `Bearer ${AUTH_TOKEN}`)
      .expect(200);

    expect(res.body).toEqual({
      synced: true,
      added: 0,
      updated: 0,
      removed: 0,
      _notice: 'This endpoint is deprecated. SemanticMemory does not require sync — writes are immediate.',
    });
  });

  it('sync sets deprecation headers', async () => {
    const res = await request(app)
      .post('/memory/sync')
      .set('Authorization', `Bearer ${AUTH_TOKEN}`)
      .expect(200);

    expect(res.headers['deprecation']).toBe('true');
  });

  // ── Data round-trip: write → search via deprecated endpoint ───

  it('data written to SemanticMemory is searchable via /memory/search', async () => {
    // The entities were added in beforeAll via semanticMemory.remember()
    const res = await request(app)
      .get('/memory/search?q=production')
      .set('Authorization', `Bearer ${AUTH_TOKEN}`)
      .expect(200);

    expect(res.body.results.length).toBeGreaterThanOrEqual(1);
    expect(res.body.results[0].text).toContain('Production');
  });
});

describe('/memory/* routes — without SemanticMemory (503 path)', () => {
  let tmpDir: string;
  let stateDir: string;
  let server: AgentServer;
  let app: ReturnType<AgentServer['getApp']>;
  const AUTH_TOKEN = 'test-memory-503';

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-routes-503-'));
    stateDir = path.join(tmpDir, '.instar');
    fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'state', 'jobs'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });

    const config = buildConfig(tmpDir, stateDir, AUTH_TOKEN);
    const mockSM = createMockSessionManager();
    const state = new StateManager(stateDir);

    // No semanticMemory passed → routes should return 503
    server = new AgentServer({
      config,
      sessionManager: mockSM as any,
      state,
    });

    await server.start();
    app = server.getApp();
  });

  afterAll(async () => {
    await server.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('GET /memory/search returns 503 when SemanticMemory is null', async () => {
    const res = await request(app)
      .get('/memory/search?q=test')
      .set('Authorization', `Bearer ${AUTH_TOKEN}`)
      .expect(503);

    expect(res.body.error).toContain('SemanticMemory not initialized');
  });

  it('GET /memory/stats returns 503 when SemanticMemory is null', async () => {
    const res = await request(app)
      .get('/memory/stats')
      .set('Authorization', `Bearer ${AUTH_TOKEN}`)
      .expect(503);

    expect(res.body.error).toContain('SemanticMemory not initialized');
  });

  it('POST /memory/reindex returns 503 when SemanticMemory is null', async () => {
    const res = await request(app)
      .post('/memory/reindex')
      .set('Authorization', `Bearer ${AUTH_TOKEN}`)
      .expect(503);

    expect(res.body.error).toContain('SemanticMemory not initialized');
  });

  it('POST /memory/sync still returns 200 (no-op, no SemanticMemory needed)', async () => {
    const res = await request(app)
      .post('/memory/sync')
      .set('Authorization', `Bearer ${AUTH_TOKEN}`)
      .expect(200);

    expect(res.body.synced).toBe(true);
  });
});
