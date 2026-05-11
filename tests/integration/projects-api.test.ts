/**
 * Integration test — /projects HTTP routes (Phase 1a PR 2).
 *
 * Covers:
 *   - all endpoints require Bearer auth (global middleware)
 *   - POST /projects with a valid plan persists project + children
 *   - POST /projects/validate does not persist
 *   - POST /projects rate limit (6th call within an hour → 429)
 *   - DELETE /projects/:id refuses when a round is in-progress
 *   - DELETE /projects/:id requires If-Match
 *   - GET /projects filters to kind:project only
 *   - Path traversal in source_docs → 400
 *
 * Plan docs are generated in a temp dir and `target_repo_path` points at
 * a separate temp directory we control so the realpath jail succeeds.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { InitiativeTracker } from '../../src/core/InitiativeTracker.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { createTempProject, createMockSessionManager } from '../helpers/setup.js';
import type { TempProject } from '../helpers/setup.js';
import type { InstarConfig } from '../../src/core/types.js';

describe('/projects routes (integration)', () => {
  let project: TempProject;
  let server: AgentServer;
  let app: ReturnType<AgentServer['getApp']>;
  let tracker: InitiativeTracker;
  let targetRepo: string;
  let plansDir: string;
  const AUTH_TOKEN = 'test-projects-token';

  function makeConfig(): InstarConfig {
    return {
      projectName: 'projects-api-test',
      projectDir: project.dir,
      stateDir: project.stateDir,
      port: 0,
      authToken: AUTH_TOKEN,
      sessions: {
        tmuxPath: '/usr/bin/tmux',
        claudePath: '/usr/bin/claude',
        projectDir: project.dir,
        maxSessions: 3,
        protectedSessions: [],
        completionPatterns: [],
      },
      scheduler: {
        jobsFile: '',
        enabled: false,
        maxParallelJobs: 1,
        quotaThresholds: { normal: 50, elevated: 70, critical: 85, shutdown: 95 },
      },
      users: [],
      messaging: [],
      monitoring: {
        quotaTracking: false,
        memoryMonitoring: false,
        healthCheckIntervalMs: 30000,
      },
    } as InstarConfig;
  }

  function writePlan(name: string, body: string): string {
    const p = path.join(plansDir, name);
    fs.writeFileSync(p, body);
    return p;
  }

  function goodPlan(id = 'sample-project'): string {
    return writePlan(
      `${id}.md`,
      `---
kind: project
id: ${id}
title: Sample project
status: active
owner: Echo
target_repo_path: ${targetRepo}
source_docs:
  - docs/specs/a.md
goal: build the things
auto_advance: true
---

### Tier 1 — first batch

| # | Item    | Source | Effort |
|---|---------|--------|--------|
| 1 | Alpha   | src-a  | s      |
| 2 | Beta    | src-b  | m      |

### Tier 2 — next batch

| # | Item   | Source | Effort |
|---|--------|--------|--------|
| 3 | Gamma  | src-c  | l      |
`
    );
  }

  beforeAll(async () => {
    project = createTempProject();
    targetRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'projects-api-target-'));
    fs.mkdirSync(path.join(targetRepo, 'docs/specs'), { recursive: true });
    fs.writeFileSync(path.join(targetRepo, 'docs/specs/a.md'), '');
    plansDir = fs.mkdtempSync(path.join(os.tmpdir(), 'projects-api-plans-'));

    tracker = new InitiativeTracker(project.stateDir);
    const mockSM = createMockSessionManager();
    server = new AgentServer({
      config: makeConfig(),
      sessionManager: mockSM as never,
      state: project.state,
      initiativeTracker: tracker,
    });
    app = server.getApp();
  });

  afterAll(() => {
    project.cleanup();
    SafeFsExecutor.safeRmSync(targetRepo, { recursive: true, force: true, operation: 'tests/integration/projects-api.test.ts:afterAll-targetRepo' });
    SafeFsExecutor.safeRmSync(plansDir, { recursive: true, force: true, operation: 'tests/integration/projects-api.test.ts:afterAll-plansDir' });
  });

  beforeEach(() => {
    // Wipe initiatives + rate-limit between tests. The tracker writes to
    // `${stateDir}/initiatives.json`; we delete and reload to reset.
    const ipath = path.join(project.stateDir, 'initiatives.json');
    if (fs.existsSync(ipath)) SafeFsExecutor.safeUnlinkSync(ipath, { operation: 'tests/integration/projects-api.test.ts:beforeEach-initiatives' });
    const ratePath = path.join(project.stateDir, 'local', 'projects-rate.json');
    if (fs.existsSync(ratePath)) SafeFsExecutor.safeUnlinkSync(ratePath, { operation: 'tests/integration/projects-api.test.ts:beforeEach-rate' });
    // Force tracker to drop its in-memory map by clearing each entry.
    for (const init of tracker.list()) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (tracker as any).initiatives.delete(init.id);
    }
  });

  // ── Auth ──────────────────────────────────────────────────────────

  it('GET /projects requires Bearer auth', async () => {
    const res = await request(app).get('/projects');
    expect(res.status).toBe(401);
  });

  it('POST /projects requires Bearer auth', async () => {
    const res = await request(app).post('/projects').send({ planDocPath: 'foo' });
    expect(res.status).toBe(401);
  });

  it('DELETE /projects/:id requires Bearer auth', async () => {
    const res = await request(app).delete('/projects/foo');
    expect(res.status).toBe(401);
  });

  // ── Happy path: create + list + get ───────────────────────────────

  it('POST /projects creates a project + children from a valid plan doc', async () => {
    const planPath = goodPlan('happy-project');
    const res = await request(app)
      .post('/projects')
      .set('Authorization', `Bearer ${AUTH_TOKEN}`)
      .send({ planDocPath: planPath });
    expect(res.status).toBe(201);
    expect(res.body.project.id).toBe('happy-project');
    expect(res.body.project.kind).toBe('project');
    expect(res.body.project.rounds).toHaveLength(2);
    expect(res.body.children).toHaveLength(3);
    // Children carry parentProjectId pointing at the project.
    for (const c of res.body.children) {
      expect(c.parentProjectId).toBe('happy-project');
      expect(c.pipelineStage).toBe('outline');
    }
  });

  it('GET /projects filters to kind:project only', async () => {
    // Create one project via plan, one regular task initiative directly.
    await request(app)
      .post('/projects')
      .set('Authorization', `Bearer ${AUTH_TOKEN}`)
      .send({ planDocPath: goodPlan('filter-project') });
    await tracker.create({
      id: 'standalone-task',
      title: 'A regular task',
      description: 'should NOT appear in /projects',
      phases: [{ id: 'p1', name: 'p1', status: 'pending' }],
    });

    const res = await request(app)
      .get('/projects')
      .set('Authorization', `Bearer ${AUTH_TOKEN}`);
    expect(res.status).toBe(200);
    const ids = (res.body.items as Array<{ id: string }>).map((i) => i.id);
    expect(ids).toContain('filter-project');
    expect(ids).not.toContain('standalone-task');
  });

  it('GET /projects/:id returns project + joined children', async () => {
    await request(app)
      .post('/projects')
      .set('Authorization', `Bearer ${AUTH_TOKEN}`)
      .send({ planDocPath: goodPlan('joined-project') });
    const res = await request(app)
      .get('/projects/joined-project')
      .set('Authorization', `Bearer ${AUTH_TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body.project.id).toBe('joined-project');
    expect(res.body.children.length).toBe(3);
  });

  it('GET /projects/:id/next returns 501 placeholder', async () => {
    await request(app)
      .post('/projects')
      .set('Authorization', `Bearer ${AUTH_TOKEN}`)
      .send({ planDocPath: goodPlan('next-project') });
    const res = await request(app)
      .get('/projects/next-project/next')
      .set('Authorization', `Bearer ${AUTH_TOKEN}`);
    expect(res.status).toBe(501);
    expect(res.body.action).toBe('not-implemented');
  });

  // ── Validate (no-persist) ─────────────────────────────────────────

  it('POST /projects/validate does not persist', async () => {
    const planPath = goodPlan('dry-run-project');
    const res = await request(app)
      .post('/projects/validate')
      .set('Authorization', `Bearer ${AUTH_TOKEN}`)
      .send({ planDocPath: planPath });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.project.id).toBe('dry-run-project');
    expect(res.body.children).toHaveLength(3);
    // No initiative should have been created.
    expect(tracker.get('dry-run-project')).toBeUndefined();
  });

  // ── Path traversal → 400 ──────────────────────────────────────────

  it('POST /projects rejects plan doc with path-traversal in source_docs', async () => {
    const planPath = writePlan(
      'traversal.md',
      `---
kind: project
id: traversal-attempt
title: bad
status: active
owner: Echo
target_repo_path: ${targetRepo}
source_docs:
  - ../../etc/passwd
goal: try escape
---
`
    );
    const res = await request(app)
      .post('/projects')
      .set('Authorization', `Bearer ${AUTH_TOKEN}`)
      .send({ planDocPath: planPath });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/validation failed/);
  });

  // ── Rate limit ────────────────────────────────────────────────────

  it('POST /projects rate-limits at 5 per hour per token', async () => {
    // Each call creates a distinct project so the rate-limit (not the
    // duplicate-id check) is what trips us up.
    for (let i = 0; i < 5; i++) {
      const r = await request(app)
        .post('/projects')
        .set('Authorization', `Bearer ${AUTH_TOKEN}`)
        .send({ planDocPath: goodPlan(`rate-${i}`) });
      expect(r.status).toBe(201);
    }
    const sixth = await request(app)
      .post('/projects')
      .set('Authorization', `Bearer ${AUTH_TOKEN}`)
      .send({ planDocPath: goodPlan('rate-5') });
    expect(sixth.status).toBe(429);
    expect(sixth.body.limit).toBe(5);
    expect(sixth.body.windowEnds).toBeTruthy();
  });

  // ── Archive ───────────────────────────────────────────────────────

  it('DELETE /projects/:id archives when no in-progress round; requires If-Match', async () => {
    await request(app)
      .post('/projects')
      .set('Authorization', `Bearer ${AUTH_TOKEN}`)
      .send({ planDocPath: goodPlan('archive-test') });
    const proj = tracker.get('archive-test')!;
    expect(proj.version).toBe(1);

    // Missing If-Match → 428.
    const noMatch = await request(app)
      .delete('/projects/archive-test')
      .set('Authorization', `Bearer ${AUTH_TOKEN}`);
    expect(noMatch.status).toBe(428);

    // Wrong If-Match → 409.
    const wrongMatch = await request(app)
      .delete('/projects/archive-test')
      .set('Authorization', `Bearer ${AUTH_TOKEN}`)
      .set('If-Match', '99');
    expect(wrongMatch.status).toBe(409);
    expect(wrongMatch.body.currentVersion).toBe(1);

    // Correct If-Match → 200.
    const ok = await request(app)
      .delete('/projects/archive-test')
      .set('Authorization', `Bearer ${AUTH_TOKEN}`)
      .set('If-Match', '1');
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe('archived');
  });

  it('DELETE /projects/:id refuses when a round is in-progress', async () => {
    await request(app)
      .post('/projects')
      .set('Authorization', `Bearer ${AUTH_TOKEN}`)
      .send({ planDocPath: goodPlan('busy-project') });
    // Flip first round to in-progress.
    const proj = tracker.get('busy-project')!;
    const rounds = (proj.rounds ?? []).map((r, i) =>
      i === 0 ? { ...r, status: 'in-progress' as const } : r
    );
    await tracker.update('busy-project', { rounds, ifMatch: proj.version });
    const proj2 = tracker.get('busy-project')!;

    const res = await request(app)
      .delete('/projects/busy-project')
      .set('Authorization', `Bearer ${AUTH_TOKEN}`)
      .set('If-Match', String(proj2.version));
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/in-progress/);
  });

  // ── Bad inputs ────────────────────────────────────────────────────

  it('GET /projects/:id returns 404 for a non-project initiative', async () => {
    await tracker.create({
      id: 'just-a-task',
      title: 't',
      description: 'd',
      phases: [{ id: 'p1', name: 'p1', status: 'pending' }],
    });
    const res = await request(app)
      .get('/projects/just-a-task')
      .set('Authorization', `Bearer ${AUTH_TOKEN}`);
    expect(res.status).toBe(404);
  });

  it('POST /projects rejects when planDocPath missing', async () => {
    const res = await request(app)
      .post('/projects')
      .set('Authorization', `Bearer ${AUTH_TOKEN}`)
      .send({});
    expect(res.status).toBe(400);
  });
});
