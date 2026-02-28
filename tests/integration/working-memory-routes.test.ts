/**
 * Integration tests for Working Memory Assembly API route.
 *
 * Tests the full HTTP pipeline:
 *   HTTP request → Express route → WorkingMemoryAssembler → SemanticMemory + EpisodicMemory → response
 *
 * Uses real SemanticMemory (SQLite) and real EpisodicMemory (filesystem)
 * to verify the assembler works through the API layer.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { SemanticMemory } from '../../src/memory/SemanticMemory.js';
import { EpisodicMemory } from '../../src/memory/EpisodicMemory.js';
import { WorkingMemoryAssembler } from '../../src/memory/WorkingMemoryAssembler.js';
import {
  createTempProject,
  createMockSessionManager,
} from '../helpers/setup.js';
import type { TempProject, MockSessionManager } from '../helpers/setup.js';
import type { InstarConfig } from '../../src/core/types.js';

describe('Working Memory API (integration)', () => {
  let project: TempProject;
  let mockSM: MockSessionManager;
  let semanticMemory: SemanticMemory;
  let episodicMemory: EpisodicMemory;
  let assembler: WorkingMemoryAssembler;
  let server: AgentServer;
  let app: ReturnType<AgentServer['getApp']>;
  const AUTH_TOKEN = 'working-memory-test-token';

  beforeAll(async () => {
    project = createTempProject();

    fs.writeFileSync(
      path.join(project.stateDir, 'config.json'),
      JSON.stringify({ port: 0, projectName: 'wm-test', agentName: 'WM Test Agent' }),
    );

    mockSM = createMockSessionManager();

    // Create real SemanticMemory with SQLite
    const dbPath = path.join(project.stateDir, 'semantic.db');
    semanticMemory = new SemanticMemory({
      dbPath,
      decayHalfLifeDays: 30,
      lessonDecayHalfLifeDays: 90,
      staleThreshold: 0.2,
    });
    await semanticMemory.open();

    // Seed entities
    const now = new Date().toISOString();
    semanticMemory.remember({
      name: 'Token Budgeting',
      type: 'concept',
      content: 'Token budgeting ensures context assembly stays within model limits. Each source gets an allocated budget.',
      confidence: 0.9,
      lastVerified: now,
      source: 'test',
      tags: ['memory', 'architecture'],
    });
    semanticMemory.remember({
      name: 'Memory Architecture',
      type: 'concept',
      content: 'Three-layer memory architecture: semantic (knowledge), episodic (activity), working (assembly).',
      confidence: 0.85,
      lastVerified: now,
      source: 'test',
      tags: ['architecture'],
    });
    semanticMemory.remember({
      name: 'Justin',
      type: 'person',
      content: 'Justin is the project collaborator and primary human partner.',
      confidence: 0.95,
      lastVerified: now,
      source: 'test',
      tags: ['person', 'collaborator'],
    });

    // Create real EpisodicMemory
    episodicMemory = new EpisodicMemory({ stateDir: project.stateDir });

    // Seed a digest
    episodicMemory.saveDigest({
      sessionId: 'test-session-001',
      sessionName: 'memory-build',
      summary: 'Built the working memory assembler with token budgets and tiered rendering.',
      actions: ['implemented assembler', 'wrote unit tests'],
      learnings: ['Stop words need filtering from query extraction'],
      significance: 8,
      themes: ['memory-architecture', 'testing'],
      startedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
      endedAt: new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString(),
    });

    // Create the assembler with real dependencies
    assembler = new WorkingMemoryAssembler({
      semanticMemory,
      episodicMemory,
    });

    const config: InstarConfig = {
      projectName: 'wm-test',
      agentName: 'WM Test Agent',
      projectDir: project.dir,
      stateDir: project.stateDir,
      port: 0,
      authToken: AUTH_TOKEN,
    };

    server = new AgentServer({
      config,
      sessionManager: mockSM as any,
      state: project.state,
      semanticMemory,
      workingMemory: assembler,
    });

    app = server.getApp();
  });

  afterAll(() => {
    semanticMemory?.close();
    project?.cleanup();
  });

  const auth = () => ({ Authorization: `Bearer ${AUTH_TOKEN}` });

  // ── Route availability ───────────────────────────────────────────

  it('GET /context/working-memory returns 200', async () => {
    const res = await request(app)
      .get('/context/working-memory')
      .set(auth())
      .query({ prompt: 'memory architecture' });

    expect(res.status).toBe(200);
    expect(res.body.context).toBeDefined();
    expect(res.body.estimatedTokens).toBeGreaterThan(0);
    expect(res.body.sources).toBeInstanceOf(Array);
    expect(res.body.queryTerms).toBeInstanceOf(Array);
    expect(res.body.assembledAt).toBeTruthy();
  });

  // ── Assembly with knowledge ──────────────────────────────────────

  it('returns knowledge entities for relevant queries', async () => {
    const res = await request(app)
      .get('/context/working-memory')
      .set(auth())
      .query({ prompt: 'token budgeting architecture' });

    expect(res.status).toBe(200);
    expect(res.body.context).toContain('Token Budgeting');
    expect(res.body.sources.some((s: any) => s.name === 'knowledge')).toBe(true);
  });

  // ── Assembly with episodes ───────────────────────────────────────

  it('returns episode digests for recent activity', async () => {
    const res = await request(app)
      .get('/context/working-memory')
      .set(auth())
      .query({ prompt: 'memory architecture' });

    expect(res.status).toBe(200);
    expect(res.body.context).toContain('Recent Activity');
    expect(res.body.sources.some((s: any) => s.name === 'episodes')).toBe(true);
  });

  // ── Assembly with relationships ──────────────────────────────────

  it('returns people context for person-related queries', async () => {
    const res = await request(app)
      .get('/context/working-memory')
      .set(auth())
      .query({ prompt: 'Justin collaboration partner' });

    expect(res.status).toBe(200);
    // The person entity should appear in knowledge or relationships section
    expect(res.body.context).toContain('Justin');
  });

  // ── Empty/no-query behavior ──────────────────────────────────────

  it('returns empty context for stop-word-only query', async () => {
    const res = await request(app)
      .get('/context/working-memory')
      .set(auth())
      .query({ prompt: 'just test this please' });

    expect(res.status).toBe(200);
    // All words are stop words — no meaningful search terms
    // Should still return valid structure even if empty
    expect(res.body.queryTerms).toBeDefined();
    expect(res.body.sources).toBeInstanceOf(Array);
  });

  it('returns valid structure with no query params', async () => {
    const res = await request(app)
      .get('/context/working-memory')
      .set(auth());

    expect(res.status).toBe(200);
    expect(res.body.context).toBeDefined();
    expect(res.body.queryTerms).toEqual([]);
  });

  // ── Job slug support ─────────────────────────────────────────────

  it('uses jobSlug for query terms', async () => {
    const res = await request(app)
      .get('/context/working-memory')
      .set(auth())
      .query({ jobSlug: 'memory-build' });

    expect(res.status).toBe(200);
    expect(res.body.queryTerms).toContain('memory');
  });

  // ── Response shape ───────────────────────────────────────────────

  it('response includes all expected fields', async () => {
    const res = await request(app)
      .get('/context/working-memory')
      .set(auth())
      .query({ prompt: 'architecture' });

    expect(res.status).toBe(200);

    const body = res.body;
    expect(typeof body.context).toBe('string');
    expect(typeof body.estimatedTokens).toBe('number');
    expect(Array.isArray(body.sources)).toBe(true);
    expect(Array.isArray(body.queryTerms)).toBe(true);
    expect(typeof body.assembledAt).toBe('string');

    // Each source has required fields
    for (const source of body.sources) {
      expect(typeof source.name).toBe('string');
      expect(typeof source.tokens).toBe('number');
      expect(typeof source.count).toBe('number');
    }
  });
});

// ── 503 when not wired ─────────────────────────────────────────────

describe('Working Memory API (not wired)', () => {
  let project: TempProject;
  let server: AgentServer;
  let app: ReturnType<AgentServer['getApp']>;
  const AUTH_TOKEN = 'no-wm-test-token';

  beforeAll(() => {
    project = createTempProject();

    fs.writeFileSync(
      path.join(project.stateDir, 'config.json'),
      JSON.stringify({ port: 0, projectName: 'no-wm-test', agentName: 'No WM Test' }),
    );

    const mockSM = createMockSessionManager();

    server = new AgentServer({
      config: {
        projectName: 'no-wm-test',
        agentName: 'No WM Test',
        projectDir: project.dir,
        stateDir: project.stateDir,
        port: 0,
        authToken: AUTH_TOKEN,
      } as InstarConfig,
      sessionManager: mockSM as any,
      state: project.state,
      // No workingMemory — tests 503 path
    });

    app = server.getApp();
  });

  afterAll(() => {
    project?.cleanup();
  });

  it('returns 503 when working memory assembler is not wired', async () => {
    const res = await request(app)
      .get('/context/working-memory')
      .set({ Authorization: `Bearer ${AUTH_TOKEN}` });

    expect(res.status).toBe(503);
    expect(res.body.error).toContain('not enabled');
  });
});
