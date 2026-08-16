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
import { ProjectRoundRunner } from '../../src/core/ProjectRoundRunner.js';
import { MachineHeartbeat } from '../../src/core/MachineHeartbeat.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { SafeGitExecutor } from '../../src/core/SafeGitExecutor.js';
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
    // The /advance + /halt + /ack routes (Phase 1b PR 3) require the
    // target repo to be a real git repository for ProjectRoundRunner
    // preflight step 8 to pass.
    SafeGitExecutor.run(['init', '-q'], { cwd: targetRepo, operation: 'tests/integration/projects-api.test.ts:beforeAll-git-init' });
    plansDir = fs.mkdtempSync(path.join(os.tmpdir(), 'projects-api-plans-'));

    tracker = new InitiativeTracker(project.stateDir);
    const projectRoundRunner = new ProjectRoundRunner({
      tracker,
      stateDir: project.stateDir,
      machineId: 'test-machine',
    });
    const heartbeatApi = new MachineHeartbeat({
      stateDir: project.stateDir,
      machineId: 'test-machine',
      // Tests use a tiny staleness threshold so claim-ownership can be
      // exercised in both states (fresh + stale) without faking timers.
      staleThresholdMs: 50,
    });
    heartbeatApi.writeOnce(); // ensure THIS machine has a fresh record
    const machineHeartbeat = { api: heartbeatApi, config: { machineId: 'test-machine' } };
    const mockSM = createMockSessionManager();
    server = new AgentServer({
      config: makeConfig(),
      sessionManager: mockSM as never,
      state: project.state,
      initiativeTracker: tracker,
      projectRoundRunner,
      machineHeartbeat,
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

  it('GET /projects/:id/next returns a structured action payload', async () => {
    await request(app)
      .post('/projects')
      .set('Authorization', `Bearer ${AUTH_TOKEN}`)
      .send({ planDocPath: goodPlan('next-project') });
    const res = await request(app)
      .get('/projects/next-project/next')
      .set('Authorization', `Bearer ${AUTH_TOKEN}`);
    expect(res.status).toBe(200);
    // Spec § 1.5 line 268: { action, params, skillCommand? }
    expect(typeof res.body.action).toBe('string');
    expect(typeof res.body.skillCommand).toBe('string');
    expect(res.body.params.projectId).toBe('next-project');
    expect(res.body.params.roundIndex).toBe(0);
    expect(Array.isArray(res.body.params.itemIds)).toBe(true);
    expect(res.body.params.itemIds.length).toBeGreaterThan(0);
    expect(res.body.params.status).toBe('pending');
    // First round with no firstLaunchAckAt → 'await-user-approval'
    expect(res.body.action).toBe('await-user-approval');
  });

  it('GET /projects/:id/next returns "ack-required" when unacked counter at cap', async () => {
    await request(app)
      .post('/projects')
      .set('Authorization', `Bearer ${AUTH_TOKEN}`)
      .send({ planDocPath: goodPlan('ack-proj') });
    const proj = tracker.get('ack-proj');
    if (!proj) throw new Error('fixture missing');
    await tracker.update(proj.id, {
      firstLaunchAckAt: new Date().toISOString(),
      unacknowledgedAdvanceCount: 2,
      ifMatch: proj.version,
    });
    const res = await request(app)
      .get('/projects/ack-proj/next')
      .set('Authorization', `Bearer ${AUTH_TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body.action).toBe('ack-required');
  });

  it('POST /projects/:id/drift-check rejects concurrent calls with 409', async () => {
    // The test server is not wired with a checker so the route returns 503
    // before the mutex check fires. This case asserts the OPPOSITE: when no
    // checker is configured, 503 is returned (not 409 or 500). The mutex
    // behavior is exercised by unit tests in routes-projects-drift.test.ts.
    await request(app)
      .post('/projects')
      .set('Authorization', `Bearer ${AUTH_TOKEN}`)
      .send({ planDocPath: goodPlan('mutex-503-proj') });
    const res = await request(app)
      .post('/projects/mutex-503-proj/drift-check')
      .set('Authorization', `Bearer ${AUTH_TOKEN}`)
      .send({ roundIndex: 0, specPath: 'docs/specs/a.md', referencedFiles: [] });
    expect(res.status).toBe(503);
  });

  it('GET /projects/:id/next returns 204 when all rounds complete', async () => {
    await request(app)
      .post('/projects')
      .set('Authorization', `Bearer ${AUTH_TOKEN}`)
      .send({ planDocPath: goodPlan('all-done-project') });
    const proj = tracker.get('all-done-project');
    if (!proj) throw new Error('fixture project missing');
    const rounds = (proj.rounds ?? []).map((r) => ({ ...r, status: 'complete' as const }));
    await tracker.update(proj.id, { rounds, ifMatch: proj.version });
    const res = await request(app)
      .get('/projects/all-done-project/next')
      .set('Authorization', `Bearer ${AUTH_TOKEN}`);
    expect(res.status).toBe(204);
  });

  it('GET /projects/:id/next returns 404 for non-project initiative', async () => {
    const res = await request(app)
      .get('/projects/no-such-project/next')
      .set('Authorization', `Bearer ${AUTH_TOKEN}`);
    expect(res.status).toBe(404);
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

  // ── /projects/:id mutating routes (Phase 1b PR 3) ──────────────────

  /** Bootstrap a project + one child item, return the project version. */
  async function seedProject(id: string): Promise<{ projectVersion: number; itemId: string }> {
    await request(app)
      .post('/projects')
      .set('Authorization', `Bearer ${AUTH_TOKEN}`)
      .send({ planDocPath: goodPlan(id) });
    const proj = tracker.get(id)!;
    return { projectVersion: proj.version, itemId: proj.rounds![0].itemIds[0] };
  }

  it('POST /projects/:id/advance — outline → spec-drafted with a real spec file', async () => {
    const { projectVersion, itemId } = await seedProject('adv-1');
    // Materialize the spec file the validator will look for.
    fs.writeFileSync(path.join(targetRepo, 'docs/specs/a.md'), '# spec');
    const res = await request(app)
      .post('/projects/adv-1/advance')
      .set('Authorization', `Bearer ${AUTH_TOKEN}`)
      .set('If-Match', String(projectVersion))
      .send({
        itemId,
        targetStage: 'spec-drafted',
        artifact: { specPath: 'docs/specs/a.md' },
      });
    expect(res.status).toBe(200);
    expect(res.body.item.pipelineStage).toBe('spec-drafted');
    expect(tracker.get(itemId)?.pipelineStage).toBe('spec-drafted');
  });

  it('POST /projects/:id/advance — missing If-Match returns 428', async () => {
    const { itemId } = await seedProject('adv-2');
    const res = await request(app)
      .post('/projects/adv-2/advance')
      .set('Authorization', `Bearer ${AUTH_TOKEN}`)
      .send({ itemId, targetStage: 'spec-drafted', artifact: { specPath: 'docs/specs/a.md' } });
    expect(res.status).toBe(428);
  });

  it('POST /projects/:id/advance — stale If-Match returns 409', async () => {
    const { itemId } = await seedProject('adv-3');
    const res = await request(app)
      .post('/projects/adv-3/advance')
      .set('Authorization', `Bearer ${AUTH_TOKEN}`)
      .set('If-Match', '999')
      .send({ itemId, targetStage: 'spec-drafted', artifact: { specPath: 'docs/specs/a.md' } });
    expect(res.status).toBe(409);
  });

  it('POST /projects/:id/advance — artifact-fail (missing specPath file) returns 409', async () => {
    const { projectVersion, itemId } = await seedProject('adv-4');
    // Spec path the plan lists doesn't exist on disk → validator rejects.
    SafeFsExecutor.safeUnlinkSync(path.join(targetRepo, 'docs/specs/a.md'), { operation: 'tests/integration/projects-api.test.ts:advance-no-spec' });
    fs.writeFileSync(path.join(targetRepo, 'docs/specs/a.md'), ''); // re-create empty for other tests
    SafeFsExecutor.safeUnlinkSync(path.join(targetRepo, 'docs/specs/a.md'), { operation: 'tests/integration/projects-api.test.ts:advance-no-spec-2' });
    const res = await request(app)
      .post('/projects/adv-4/advance')
      .set('Authorization', `Bearer ${AUTH_TOKEN}`)
      .set('If-Match', String(projectVersion))
      .send({
        itemId,
        targetStage: 'spec-drafted',
        artifact: { specPath: 'docs/specs/a.md' },
      });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('SPEC_FILE_MISSING');
    // Restore the spec file for subsequent tests.
    fs.writeFileSync(path.join(targetRepo, 'docs/specs/a.md'), '');
  });

  it('POST /projects/:id/advance — unknown child returns 404', async () => {
    const { projectVersion } = await seedProject('adv-5');
    const res = await request(app)
      .post('/projects/adv-5/advance')
      .set('Authorization', `Bearer ${AUTH_TOKEN}`)
      .set('If-Match', String(projectVersion))
      .send({ itemId: 'no-such-child', targetStage: 'spec-drafted', artifact: {} });
    expect(res.status).toBe(404);
  });

  it('POST /projects/:id/halt — halts the active round (idempotent)', async () => {
    await seedProject('halt-1');
    const res = await request(app)
      .post('/projects/halt-1/halt')
      .set('Authorization', `Bearer ${AUTH_TOKEN}`)
      .send({ reason: 'user said stop' });
    expect(res.status).toBe(200);
    expect(res.body.roundIndex).toBe(0);
    const proj = tracker.get('halt-1')!;
    expect(proj.rounds![0].haltedAt).toBeDefined();
    expect(proj.rounds![0].haltReason).toBe('user said stop');
    // Idempotent: second call returns 200 referencing the same halted round.
    const res2 = await request(app)
      .post('/projects/halt-1/halt')
      .set('Authorization', `Bearer ${AUTH_TOKEN}`)
      .send({ reason: 'second time' });
    expect(res2.status).toBe(200);
    // Original reason preserved.
    expect(tracker.get('halt-1')!.rounds![0].haltReason).toBe('user said stop');
  });

  it('POST /projects/:id/ack — populates firstLaunchAckAt + lastAckedRoundIndex', async () => {
    await seedProject('ack-1');
    const res = await request(app)
      .post('/projects/ack-1/ack')
      .set('Authorization', `Bearer ${AUTH_TOKEN}`)
      .send({ forRoundIndex: 0 });
    expect(res.status).toBe(200);
    expect(res.body.firstLaunchAckAt).toBeDefined();
    expect(res.body.lastAckedRoundIndex).toBe(0);
    expect(res.body.unacknowledgedAdvanceCount).toBe(0);
  });

  it('POST /projects/:id/ack — rejects non-integer roundIndex', async () => {
    await seedProject('ack-2');
    const res = await request(app)
      .post('/projects/ack-2/ack')
      .set('Authorization', `Bearer ${AUTH_TOKEN}`)
      .send({ forRoundIndex: -1 });
    expect(res.status).toBe(400);
  });

  it('POST /projects/:id/accept-partial — skips remaining items + marks complete-with-skips', async () => {
    await seedProject('partial-1');
    const res = await request(app)
      .post('/projects/partial-1/accept-partial')
      .set('Authorization', `Bearer ${AUTH_TOKEN}`)
      .send({ roundIndex: 0, reason: 'time pressure', skippedBy: 'echo' });
    expect(res.status).toBe(200);
    expect(res.body.skippedItemIds.length).toBeGreaterThan(0);
    const proj = tracker.get('partial-1')!;
    expect(proj.rounds![0].status).toBe('complete-with-skips');
    expect(proj.lastAckedRoundIndex).toBe(0);
  });

  it('POST /projects/:id/accept-partial — requires reason + skippedBy', async () => {
    await seedProject('partial-2');
    const a = await request(app)
      .post('/projects/partial-2/accept-partial')
      .set('Authorization', `Bearer ${AUTH_TOKEN}`)
      .send({ roundIndex: 0, skippedBy: 'echo' });
    expect(a.status).toBe(400);
    const b = await request(app)
      .post('/projects/partial-2/accept-partial')
      .set('Authorization', `Bearer ${AUTH_TOKEN}`)
      .send({ roundIndex: 0, reason: 'time' });
    expect(b.status).toBe(400);
  });

  it('halt / ack / accept-partial require Bearer auth', async () => {
    const a = await request(app).post('/projects/foo/halt').send({ reason: 'r' });
    expect(a.status).toBe(401);
    const b = await request(app).post('/projects/foo/ack').send({ forRoundIndex: 0 });
    expect(b.status).toBe(401);
    const c = await request(app).post('/projects/foo/accept-partial').send({ roundIndex: 0, reason: 'r', skippedBy: 'e' });
    expect(c.status).toBe(401);
  });

  // ── /projects/:id/claim-ownership (Phase 1b PR 4) ─────────────────

  it('POST /projects/:id/claim-ownership — idempotent when claimer already owns', async () => {
    await seedProject('claim-1');
    // Claim from a clean slate (currentOwner is undefined) — succeeds.
    const proj = tracker.get('claim-1')!;
    const res = await request(app)
      .post('/projects/claim-1/claim-ownership')
      .set('Authorization', `Bearer ${AUTH_TOKEN}`)
      .set('If-Match', String(proj.version))
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.ownerMachineId).toBe('test-machine');

    // Claim again with the freshly bumped version — alreadyOwned.
    const after = tracker.get('claim-1')!;
    const res2 = await request(app)
      .post('/projects/claim-1/claim-ownership')
      .set('Authorization', `Bearer ${AUTH_TOKEN}`)
      .set('If-Match', String(after.version))
      .send({});
    expect(res2.status).toBe(200);
    expect(res2.body.alreadyOwned).toBe(true);
  });

  it('POST /projects/:id/claim-ownership — refuses when current owner heartbeat is fresh', async () => {
    await seedProject('claim-2');
    const proj = tracker.get('claim-2')!;
    // Pretend a peer machine "m-peer" owns this project AND has a fresh
    // heartbeat on disk.
    fs.mkdirSync(path.join(project.stateDir, 'machine-health'), { recursive: true });
    fs.writeFileSync(
      path.join(project.stateDir, 'machine-health', 'm-peer.json'),
      JSON.stringify({
        machineId: 'm-peer',
        hostname: 'peer-host',
        lastHeartbeatAt: new Date().toISOString(),
      })
    );
    await tracker.update('claim-2', { ownerMachineId: 'm-peer', ifMatch: proj.version });
    const after = tracker.get('claim-2')!;
    const res = await request(app)
      .post('/projects/claim-2/claim-ownership')
      .set('Authorization', `Bearer ${AUTH_TOKEN}`)
      .set('If-Match', String(after.version))
      .send({});
    expect(res.status).toBe(409);
    expect(res.body.currentOwner).toBe('m-peer');
  });

  it('POST /projects/:id/claim-ownership — succeeds when peer heartbeat is stale', async () => {
    await seedProject('claim-3');
    const proj = tracker.get('claim-3')!;
    fs.mkdirSync(path.join(project.stateDir, 'machine-health'), { recursive: true });
    // Stale: heartbeat is from 10 minutes ago, staleThresholdMs is 50ms in tests.
    fs.writeFileSync(
      path.join(project.stateDir, 'machine-health', 'm-peer.json'),
      JSON.stringify({
        machineId: 'm-peer',
        hostname: 'peer-host',
        lastHeartbeatAt: new Date(Date.now() - 600_000).toISOString(),
      })
    );
    await tracker.update('claim-3', { ownerMachineId: 'm-peer', ifMatch: proj.version });
    const after = tracker.get('claim-3')!;
    const res = await request(app)
      .post('/projects/claim-3/claim-ownership')
      .set('Authorization', `Bearer ${AUTH_TOKEN}`)
      .set('If-Match', String(after.version))
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.ownerMachineId).toBe('test-machine');
    expect(res.body.previousOwner).toBe('m-peer');
  });

  it('POST /projects/:id/claim-ownership — force flag overrides fresh-heartbeat refusal', async () => {
    await seedProject('claim-4');
    const proj = tracker.get('claim-4')!;
    fs.mkdirSync(path.join(project.stateDir, 'machine-health'), { recursive: true });
    fs.writeFileSync(
      path.join(project.stateDir, 'machine-health', 'm-peer.json'),
      JSON.stringify({
        machineId: 'm-peer',
        hostname: 'peer-host',
        lastHeartbeatAt: new Date().toISOString(),
      })
    );
    await tracker.update('claim-4', { ownerMachineId: 'm-peer', ifMatch: proj.version });
    const after = tracker.get('claim-4')!;
    const res = await request(app)
      .post('/projects/claim-4/claim-ownership')
      .set('Authorization', `Bearer ${AUTH_TOKEN}`)
      .set('If-Match', String(after.version))
      .send({ force: true });
    expect(res.status).toBe(200);
    expect(res.body.ownerMachineId).toBe('test-machine');
  });

  it('POST /projects/:id/claim-ownership — 428 without If-Match, 401 without auth', async () => {
    await seedProject('claim-5');
    const noIfMatch = await request(app)
      .post('/projects/claim-5/claim-ownership')
      .set('Authorization', `Bearer ${AUTH_TOKEN}`)
      .send({});
    expect(noIfMatch.status).toBe(428);
    const noAuth = await request(app).post('/projects/claim-5/claim-ownership').send({});
    expect(noAuth.status).toBe(401);
  });

  // ── /projects/:id/run-round, /resume, /abandon (Phase 1.7 surface) ──

  it('POST /projects/:id/run-round — 409 when preflight rejects (no firstLaunchAckAt)', async () => {
    await seedProject('rr-1');
    const res = await request(app)
      .post('/projects/rr-1/run-round')
      .set('Authorization', `Bearer ${AUTH_TOKEN}`)
      .send({ roundIndex: 0 });
    // First round always rejected until firstLaunchAckAt is set.
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('preflight rejected');
    expect(typeof res.body.code).toBe('string');
    expect(typeof res.body.reason).toBe('string');
  });

  it('POST /projects/:id/run-round — 200 schedules round when preflight passes', async () => {
    await seedProject('rr-2');
    const proj = tracker.get('rr-2')!;
    // Satisfy preflight steps 5+6: record first-launch ack.
    await tracker.update(proj.id, {
      firstLaunchAckAt: new Date().toISOString(),
      ifMatch: proj.version,
    });
    const res = await request(app)
      .post('/projects/rr-2/run-round')
      .set('Authorization', `Bearer ${AUTH_TOKEN}`)
      .send({ roundIndex: 0 });
    expect(res.status).toBe(200);
    expect(res.body.id).toBe('rr-2');
    expect(res.body.roundIndex).toBe(0);
    expect(typeof res.body.scheduledAt).toBe('string');
    // Verify autoAdvanceAt actually landed on the round.
    const updated = tracker.get('rr-2')!;
    expect(updated.rounds![0].autoAdvanceAt).toBe(res.body.scheduledAt);
  });

  it('POST /projects/:id/run-round — 404 on out-of-range round index', async () => {
    await seedProject('rr-3');
    const res = await request(app)
      .post('/projects/rr-3/run-round')
      .set('Authorization', `Bearer ${AUTH_TOKEN}`)
      .send({ roundIndex: 99 });
    expect(res.status).toBe(404);
  });

  it('POST /projects/:id/resume — 200 clears haltedAt and schedules round', async () => {
    await seedProject('rs-1');
    const proj = tracker.get('rs-1')!;
    const haltedRounds = (proj.rounds ?? []).map((r, i) =>
      i === 0
        ? { ...r, haltedAt: new Date().toISOString(), haltReason: 'test halt' }
        : r
    );
    await tracker.update(proj.id, {
      rounds: haltedRounds,
      status: 'halted',
      ifMatch: proj.version,
    });
    const res = await request(app)
      .post('/projects/rs-1/resume')
      .set('Authorization', `Bearer ${AUTH_TOKEN}`)
      .send({ roundIndex: 0 });
    expect(res.status).toBe(200);
    expect(typeof res.body.scheduledAt).toBe('string');
    const after = tracker.get('rs-1')!;
    expect(after.rounds![0].haltedAt).toBeUndefined();
    expect(after.rounds![0].haltReason).toBeUndefined();
    expect(after.status).toBe('active');
  });

  it('POST /projects/:id/resume — 409 when round is neither halted nor failed', async () => {
    await seedProject('rs-2');
    const res = await request(app)
      .post('/projects/rs-2/resume')
      .set('Authorization', `Bearer ${AUTH_TOKEN}`)
      .send({ roundIndex: 0 });
    expect(res.status).toBe(409);
  });

  it('POST /projects/:id/resume — 409 on failed round at cap without force', async () => {
    await seedProject('rs-3');
    const proj = tracker.get('rs-3')!;
    const failedRounds = (proj.rounds ?? []).map((r, i) =>
      i === 0 ? { ...r, status: 'failed' as const, resumeAttempts: 3 } : r
    );
    await tracker.update(proj.id, { rounds: failedRounds, ifMatch: proj.version });
    const res = await request(app)
      .post('/projects/rs-3/resume')
      .set('Authorization', `Bearer ${AUTH_TOKEN}`)
      .send({ roundIndex: 0 });
    expect(res.status).toBe(409);
    expect(res.body.resumeAttempts).toBe(3);
  });

  it('POST /projects/:id/resume — 200 force-resumes failed round and zeroes resumeAttempts', async () => {
    await seedProject('rs-4');
    const proj = tracker.get('rs-4')!;
    const failedRounds = (proj.rounds ?? []).map((r, i) =>
      i === 0 ? { ...r, status: 'failed' as const, resumeAttempts: 3 } : r
    );
    await tracker.update(proj.id, { rounds: failedRounds, ifMatch: proj.version });
    const res = await request(app)
      .post('/projects/rs-4/resume')
      .set('Authorization', `Bearer ${AUTH_TOKEN}`)
      .send({ roundIndex: 0, force: true });
    expect(res.status).toBe(200);
    expect(res.body.forced).toBe(true);
    const after = tracker.get('rs-4')!;
    expect(after.rounds![0].resumeAttempts).toBe(0);
  });

  it('POST /projects/:id/abandon — 200 sets status=abandoned and clears autoAdvanceAt', async () => {
    await seedProject('ab-1');
    const proj = tracker.get('ab-1')!;
    const withSchedule = (proj.rounds ?? []).map((r, i) =>
      i === 0 ? { ...r, autoAdvanceAt: new Date().toISOString() } : r
    );
    await tracker.update(proj.id, { rounds: withSchedule, ifMatch: proj.version });
    const res = await request(app)
      .post('/projects/ab-1/abandon')
      .set('Authorization', `Bearer ${AUTH_TOKEN}`)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('abandoned');
    const after = tracker.get('ab-1')!;
    expect(after.status).toBe('abandoned');
    expect(after.rounds![0].autoAdvanceAt).toBeUndefined();
  });

  it('POST /projects/:id/abandon — 409 when a round is in-progress', async () => {
    await seedProject('ab-2');
    const proj = tracker.get('ab-2')!;
    const running = (proj.rounds ?? []).map((r, i) =>
      i === 0 ? { ...r, status: 'in-progress' as const } : r
    );
    await tracker.update(proj.id, { rounds: running, ifMatch: proj.version });
    const res = await request(app)
      .post('/projects/ab-2/abandon')
      .set('Authorization', `Bearer ${AUTH_TOKEN}`)
      .send({});
    expect(res.status).toBe(409);
    expect(res.body.activeRound).toBeDefined();
  });

  it('POST /projects/:id/abandon — idempotent, returns alreadyAbandoned on repeat', async () => {
    await seedProject('ab-3');
    await request(app)
      .post('/projects/ab-3/abandon')
      .set('Authorization', `Bearer ${AUTH_TOKEN}`)
      .send({});
    const res = await request(app)
      .post('/projects/ab-3/abandon')
      .set('Authorization', `Bearer ${AUTH_TOKEN}`)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.alreadyAbandoned).toBe(true);
  });
});
