/**
 * Integration tests for MemoryExporter API route.
 *
 * Tests the full HTTP request path:
 *   HTTP POST /semantic/export-memory → MemoryExporter → SemanticMemory → response
 *
 * Plus deprecation headers on legacy /memory/* routes.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { SemanticMemory } from '../../src/memory/SemanticMemory.js';
import {
  createTempProject,
  createMockSessionManager,
} from '../helpers/setup.js';
import type { TempProject, MockSessionManager } from '../helpers/setup.js';
import type { InstarConfig } from '../../src/core/types.js';

describe('MemoryExporter API (integration)', () => {
  let project: TempProject;
  let mockSM: MockSessionManager;
  let memory: SemanticMemory;
  let server: AgentServer;
  let app: ReturnType<AgentServer['getApp']>;
  const AUTH_TOKEN = 'exporter-test-token';

  beforeAll(async () => {
    project = createTempProject();

    fs.writeFileSync(
      path.join(project.stateDir, 'config.json'),
      JSON.stringify({ port: 0, projectName: 'exporter-test', agentName: 'Test Agent' })
    );

    mockSM = createMockSessionManager();

    const dbPath = path.join(project.stateDir, 'semantic.db');
    memory = new SemanticMemory({
      dbPath,
      decayHalfLifeDays: 30,
      lessonDecayHalfLifeDays: 90,
      staleThreshold: 0.2,
    });
    await memory.open();

    // Seed some entities
    const now = new Date().toISOString();
    memory.remember({
      name: 'Docker Setup', type: 'tool', content: 'Docker compose for dev.',
      confidence: 0.9, domain: 'infrastructure', tags: ['docker'],
      lastVerified: now, source: 'test',
    });
    memory.remember({
      name: 'Portal Project', type: 'project', content: 'AI chatbot platform.',
      confidence: 0.95, domain: 'development', tags: ['portal'],
      lastVerified: now, source: 'test',
    });
    memory.remember({
      name: 'TypeScript Tip', type: 'fact', content: 'Strict null checks.',
      confidence: 0.6, tags: ['typescript'],
      lastVerified: now, source: 'test',
    });

    const config: InstarConfig = {
      projectName: 'exporter-test',
      agentName: 'Test Agent',
      projectDir: project.dir,
      stateDir: project.stateDir,
      port: 0,
      authToken: AUTH_TOKEN,
    };

    server = new AgentServer({
      config,
      sessionManager: mockSM as any,
      state: project.state,
      semanticMemory: memory,
    });

    app = server.getApp();
  });

  afterAll(() => {
    memory?.close();
    project?.cleanup();
  });

  const auth = () => ({ Authorization: `Bearer ${AUTH_TOKEN}` });

  // ── POST /semantic/export-memory ────────────────────────────────

  describe('POST /semantic/export-memory', () => {
    it('returns generated markdown and metadata', async () => {
      const res = await request(app)
        .post('/semantic/export-memory')
        .set(auth())
        .send({});

      expect(res.status).toBe(200);
      expect(res.body.markdown).toContain('# Agent Memory');
      expect(res.body.entityCount).toBe(3);
      expect(res.body.excludedByCap).toBe(0);
      expect(res.body.excludedByBudget).toBe(0);
      expect(res.body.wordBudget).toBe(5000);
      expect(res.body.selectedEntityWords).toBeGreaterThan(0);
      expect(res.body.actualWords).toBeGreaterThan(0);
      expect(res.body.domainCount).toBeGreaterThanOrEqual(2);
      expect(res.body.estimatedTokens).toBeGreaterThan(0);
    });

    it('respects custom agentName', async () => {
      const res = await request(app)
        .post('/semantic/export-memory')
        .set(auth())
        .send({ agentName: 'Dawn' });

      expect(res.status).toBe(200);
      expect(res.body.markdown).toContain('# Dawn Memory');
    });

    it('respects minConfidence filter', async () => {
      const res = await request(app)
        .post('/semantic/export-memory')
        .set(auth())
        .send({ minConfidence: 0.8 });

      expect(res.status).toBe(200);
      expect(res.body.entityCount).toBe(2); // Docker (0.9) and Portal (0.95)
      expect(res.body.markdown).not.toContain('TypeScript Tip'); // 0.6 excluded
    });

    it('writes to file when filePath provided', async () => {
      const outPath = path.join(project.dir, 'test-export.md');

      const res = await request(app)
        .post('/semantic/export-memory')
        .set(auth())
        .send({ filePath: outPath });

      expect(res.status).toBe(200);
      expect(res.body.filePath).toBe(outPath);
      expect(res.body.fileSizeBytes).toBeGreaterThan(0);
      expect(fs.existsSync(outPath)).toBe(true);

      const content = fs.readFileSync(outPath, 'utf-8');
      expect(content).toContain('# Agent Memory');
    });

    it('respects maxEntities', async () => {
      const res = await request(app)
        .post('/semantic/export-memory')
        .set(auth())
        .send({ maxEntities: 1 });

      expect(res.status).toBe(200);
      expect(res.body.entityCount).toBe(1);
      expect(res.body.excludedCount).toBe(2);
      expect(res.body.excludedByCap).toBe(2);
      expect(res.body.excludedByBudget).toBe(0);
    });

    it('respects wordBudget independently from maxEntities', async () => {
      const res = await request(app)
        .post('/semantic/export-memory')
        .set(auth())
        .send({ maxEntities: 10, wordBudget: 8 });

      expect(res.status).toBe(200);
      expect(res.body.wordBudget).toBe(8);
      expect(res.body.entityCount).toBeLessThan(3);
      expect(res.body.selectedEntityWords).toBeLessThanOrEqual(8);
      expect(res.body.excludedByCap).toBe(0);
      expect(res.body.excludedByBudget).toBeGreaterThan(0);
      expect(res.body.markdown).toContain('Selection health:');
    });

    it('returns 503 when semantic memory not available', async () => {
      // Create a server without semantic memory
      const bareServer = new AgentServer({
        config: {
          projectName: 'bare-test',
          agentName: 'Bare Agent',
          projectDir: project.dir,
          stateDir: project.stateDir,
          port: 0,
          authToken: AUTH_TOKEN,
        },
        sessionManager: mockSM as any,
        state: project.state,
      });

      const bareApp = bareServer.getApp();
      const res = await request(bareApp)
        .post('/semantic/export-memory')
        .set(auth())
        .send({});

      expect(res.status).toBe(503);
    });
  });

  // ── Legacy route deprecation headers ────────────────────────────

  describe('Legacy /memory/* deprecation headers', () => {
    it('GET /memory/search returns Deprecation header', async () => {
      const res = await request(app)
        .get('/memory/search?q=test')
        .set(auth());

      // Route may 500 (no MemoryIndex files to index) but should still have deprecation header
      expect(res.headers['deprecation']).toBe('true');
      expect(res.headers['sunset']).toBe('2026-06-01');
      expect(res.headers['link']).toContain('/semantic/search');
    });

    it('GET /memory/stats returns Deprecation header', async () => {
      const res = await request(app)
        .get('/memory/stats')
        .set(auth());

      expect(res.headers['deprecation']).toBe('true');
      expect(res.headers['sunset']).toBe('2026-06-01');
    });
  });
});
