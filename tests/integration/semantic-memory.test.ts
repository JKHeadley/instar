/**
 * Integration tests for SemanticMemory API routes.
 *
 * These tests spin up a REAL AgentServer with SemanticMemory wired in
 * and verify the full HTTP request path:
 *
 *   HTTP request → Express route → SemanticMemory → SQLite → response
 *
 * No mocking of SemanticMemory or SQLite. We mock only the SessionManager
 * (to avoid spawning tmux sessions).
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

describe('SemanticMemory API (integration)', () => {
  let project: TempProject;
  let mockSM: MockSessionManager;
  let memory: SemanticMemory;
  let server: AgentServer;
  let app: ReturnType<AgentServer['getApp']>;
  const AUTH_TOKEN = 'semantic-test-token';

  beforeAll(async () => {
    project = createTempProject();

    // Write minimal config
    fs.writeFileSync(
      path.join(project.stateDir, 'config.json'),
      JSON.stringify({ port: 0, projectName: 'semantic-test', agentName: 'Semantic Test Agent' })
    );

    mockSM = createMockSessionManager();

    // Create SemanticMemory with real SQLite
    const dbPath = path.join(project.stateDir, 'semantic.db');
    memory = new SemanticMemory({
      dbPath,
      decayHalfLifeDays: 30,
      lessonDecayHalfLifeDays: 90,
      staleThreshold: 0.2,
    });
    await memory.open();

    const config: InstarConfig = {
      projectName: 'semantic-test',
      agentName: 'Semantic Test Agent',
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

  // ─── Remember (POST /semantic/remember) ─────────────────────────

  describe('POST /semantic/remember', () => {
    it('creates an entity and returns its id', async () => {
      const res = await request(app)
        .post('/semantic/remember')
        .set(auth())
        .send({
          type: 'fact',
          name: 'Test fact',
          content: 'The API is running on port 3000',
          confidence: 0.9,
          source: 'test',
          tags: ['api'],
          domain: 'infrastructure',
        });

      expect(res.status).toBe(200);
      expect(res.body.id).toBeTruthy();
      expect(typeof res.body.id).toBe('string');
    });

    it('rejects invalid entity type', async () => {
      const res = await request(app)
        .post('/semantic/remember')
        .set(auth())
        .send({
          type: 'invalid-type',
          name: 'Bad entity',
          content: 'This should fail',
          confidence: 0.9,
          source: 'test',
          tags: [],
        });

      expect(res.status).toBe(400);
    });

    it('rejects missing required fields', async () => {
      const res = await request(app)
        .post('/semantic/remember')
        .set(auth())
        .send({
          type: 'fact',
          // missing name, content, etc.
        });

      expect(res.status).toBe(400);
    });
  });

  // ─── Recall (GET /semantic/recall/:id) ──────────────────────────

  describe('GET /semantic/recall/:id', () => {
    it('retrieves an entity with connections', async () => {
      // Create an entity via the API
      const createRes = await request(app)
        .post('/semantic/remember')
        .set(auth())
        .send({
          type: 'person',
          name: 'Alice',
          content: 'Alice is a developer',
          confidence: 0.95,
          source: 'test',
          tags: ['team'],
        });

      const { id } = createRes.body;

      const recallRes = await request(app)
        .get(`/semantic/recall/${id}`)
        .set(auth());

      expect(recallRes.status).toBe(200);
      expect(recallRes.body.entity.name).toBe('Alice');
      expect(recallRes.body.entity.type).toBe('person');
      expect(recallRes.body.connections).toBeInstanceOf(Array);
    });

    it('returns 404 for non-existent entity', async () => {
      const res = await request(app)
        .get('/semantic/recall/non-existent-id')
        .set(auth());

      expect(res.status).toBe(404);
    });
  });

  // ─── Connect (POST /semantic/connect) ───────────────────────────

  describe('POST /semantic/connect', () => {
    it('creates an edge between two entities', async () => {
      // Create two entities
      const person = await request(app)
        .post('/semantic/remember')
        .set(auth())
        .send({
          type: 'person',
          name: 'Bob',
          content: 'Bob is an engineer',
          confidence: 0.9,
          source: 'test',
          tags: [],
        });

      const project = await request(app)
        .post('/semantic/remember')
        .set(auth())
        .send({
          type: 'project',
          name: 'Dashboard',
          content: 'Admin dashboard',
          confidence: 0.9,
          source: 'test',
          tags: [],
        });

      const res = await request(app)
        .post('/semantic/connect')
        .set(auth())
        .send({
          fromId: person.body.id,
          toId: project.body.id,
          relation: 'built_by',
          context: 'Bob built the dashboard',
        });

      expect(res.status).toBe(200);
      expect(res.body.edgeId).toBeTruthy();

      // Verify connection exists on recall
      const recall = await request(app)
        .get(`/semantic/recall/${person.body.id}`)
        .set(auth());

      expect(recall.body.connections).toHaveLength(1);
      expect(recall.body.connections[0].entity.name).toBe('Dashboard');
    });
  });

  // ─── Search (GET /semantic/search) ─────────────────────────────

  describe('GET /semantic/search', () => {
    it('finds entities by keyword', async () => {
      // Create a searchable entity
      await request(app)
        .post('/semantic/remember')
        .set(auth())
        .send({
          type: 'fact',
          name: 'Deployment details',
          content: 'We deploy to Vercel using the main branch',
          confidence: 0.9,
          source: 'test',
          tags: ['deployment'],
        });

      const res = await request(app)
        .get('/semantic/search')
        .set(auth())
        .query({ q: 'Vercel deploy' });

      expect(res.status).toBe(200);
      expect(res.body.results.length).toBeGreaterThan(0);
      expect(res.body.results[0].name).toBe('Deployment details');
    });

    it('returns empty results for no matches', async () => {
      const res = await request(app)
        .get('/semantic/search')
        .set(auth())
        .query({ q: 'quantum mechanics entanglement' });

      expect(res.status).toBe(200);
      expect(res.body.results).toHaveLength(0);
    });

    it('respects type filter', async () => {
      const res = await request(app)
        .get('/semantic/search')
        .set(auth())
        .query({ q: 'developer engineer', types: 'person' });

      expect(res.status).toBe(200);
      for (const r of res.body.results) {
        expect(r.type).toBe('person');
      }
    });
  });

  // ─── Forget (DELETE /semantic/forget/:id) ──────────────────────

  describe('DELETE /semantic/forget/:id', () => {
    it('deletes an entity', async () => {
      const createRes = await request(app)
        .post('/semantic/remember')
        .set(auth())
        .send({
          type: 'fact',
          name: 'Ephemeral fact',
          content: 'This will be deleted',
          confidence: 0.5,
          source: 'test',
          tags: [],
        });

      const res = await request(app)
        .delete(`/semantic/forget/${createRes.body.id}`)
        .set(auth());

      expect(res.status).toBe(200);

      // Verify it's gone
      const recall = await request(app)
        .get(`/semantic/recall/${createRes.body.id}`)
        .set(auth());

      expect(recall.status).toBe(404);
    });
  });

  // ─── Verify (POST /semantic/verify/:id) ────────────────────────

  describe('POST /semantic/verify/:id', () => {
    it('refreshes verification timestamp and confidence', async () => {
      const createRes = await request(app)
        .post('/semantic/remember')
        .set(auth())
        .send({
          type: 'fact',
          name: 'Verifiable fact',
          content: 'This fact can be re-verified',
          confidence: 0.6,
          source: 'test',
          tags: [],
        });

      const res = await request(app)
        .post(`/semantic/verify/${createRes.body.id}`)
        .set(auth())
        .send({ confidence: 0.95 });

      expect(res.status).toBe(200);

      // Verify the update
      const recall = await request(app)
        .get(`/semantic/recall/${createRes.body.id}`)
        .set(auth());

      expect(recall.body.entity.confidence).toBe(0.95);
    });
  });

  // ─── Explore (GET /semantic/explore/:id) ───────────────────────

  describe('GET /semantic/explore/:id', () => {
    it('returns connected entities via graph traversal', async () => {
      // Create a small graph: Person -> Project -> Tool
      const person = await request(app)
        .post('/semantic/remember')
        .set(auth())
        .send({
          type: 'person', name: 'Carol', content: 'Carol is a dev',
          confidence: 0.9, source: 'test', tags: [],
        });

      const proj = await request(app)
        .post('/semantic/remember')
        .set(auth())
        .send({
          type: 'project', name: 'Widget', content: 'A widget project',
          confidence: 0.9, source: 'test', tags: [],
        });

      const tool = await request(app)
        .post('/semantic/remember')
        .set(auth())
        .send({
          type: 'tool', name: 'React', content: 'UI framework',
          confidence: 0.9, source: 'test', tags: [],
        });

      await request(app)
        .post('/semantic/connect')
        .set(auth())
        .send({ fromId: person.body.id, toId: proj.body.id, relation: 'built_by' });

      await request(app)
        .post('/semantic/connect')
        .set(auth())
        .send({ fromId: proj.body.id, toId: tool.body.id, relation: 'depends_on' });

      const res = await request(app)
        .get(`/semantic/explore/${person.body.id}`)
        .set(auth())
        .query({ maxDepth: 2 });

      expect(res.status).toBe(200);
      const names = res.body.results.map((e: any) => e.name);
      expect(names).toContain('Widget');
      expect(names).toContain('React');
    });
  });

  // ─── Stats (GET /semantic/stats) ──────────────────────────────

  describe('GET /semantic/stats', () => {
    it('returns accurate statistics', async () => {
      const res = await request(app)
        .get('/semantic/stats')
        .set(auth());

      expect(res.status).toBe(200);
      expect(res.body.totalEntities).toBeGreaterThan(0);
      expect(res.body.entityCountsByType).toBeTruthy();
      expect(res.body.dbSizeBytes).toBeGreaterThan(0);
    });
  });

  // ─── Export / Import (GET/POST /semantic/export, /semantic/import) ─

  describe('export and import', () => {
    it('round-trips data through export/import', async () => {
      const exportRes = await request(app)
        .get('/semantic/export')
        .set(auth());

      expect(exportRes.status).toBe(200);
      expect(exportRes.body.entities.length).toBeGreaterThan(0);

      // Import into same DB should skip all existing
      const importRes = await request(app)
        .post('/semantic/import')
        .set(auth())
        .send(exportRes.body);

      expect(importRes.status).toBe(200);
      expect(importRes.body.entitiesSkipped).toBe(exportRes.body.entities.length);
    });
  });

  // ─── Context (GET /semantic/context) ──────────────────────────

  describe('GET /semantic/context', () => {
    it('returns formatted context for a query', async () => {
      const res = await request(app)
        .get('/semantic/context')
        .set(auth())
        .query({ q: 'deploy Vercel' });

      expect(res.status).toBe(200);
      expect(res.body.context).toBeTruthy();
      expect(res.body.context).toContain('Deployment');
    });
  });

  // ─── Auth ─────────────────────────────────────────────────────

  describe('authentication', () => {
    it('rejects requests without auth token', async () => {
      const res = await request(app)
        .get('/semantic/stats');

      expect(res.status).toBe(401);
    });
  });
});
