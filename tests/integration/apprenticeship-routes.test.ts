// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.

/**
 * Integration tests — /apprenticeship/* routes (Apprenticeship Step 1). Tier 2:
 * the REAL inline routes in createRoutes(), behind the real authMiddleware,
 * backed by a real ApprenticeshipProgram.
 *
 * Covers (spec §5 Integration):
 *   - GET /apprenticeship/instances requires bearer (401 without; wrong token 401)
 *   - 503 when the program is unavailable (null)
 *   - create → transition gating end to end (gate refuses, then allows)
 *   - the decision-audit line is written
 *   - read-only gate previews (can-start / can-complete)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRoutes } from '../../src/server/routes.js';
import type { RouteContext } from '../../src/server/routes.js';
import { authMiddleware } from '../../src/server/middleware.js';
import { ApprenticeshipProgram, type GateDeps } from '../../src/core/ApprenticeshipProgram.js';
import { validateRetroHarvest } from '../../src/core/retroHarvestValidator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { ApprenticeshipCycleStore } from '../../src/monitoring/ApprenticeshipCycleStore.js';
import { ApprenticeshipCycleSlaMonitor } from '../../src/monitoring/ApprenticeshipCycleSlaMonitor.js';

const AUTH = 'apprenticeship-routes-token';
const auth = () => ({ Authorization: `Bearer ${AUTH}` });

const SCHEMA_ID = 'apprenticeship-retro-harvest/v1';
function buildHarvest(): string {
  const fm: Record<string, unknown> = {
    schema: SCHEMA_ID,
    instanceType: 'mentorship',
    from: 'echo',
    to: 'codey',
    framework: 'codex-cli',
    harvestedAt: '2026-06-02T03:00:00Z',
    scopeMode: 'full',
    completeness: 'complete',
    sourcesCovered: {
      ledger: { read: true, issueCount: 12 },
      playbook: { read: true, entryCount: 3 },
      memory: { read: true, files: 40 },
      threads: [{ id: 13435, messagesRead: 500, truncated: false }],
      prs: [666],
    },
    counts: { lessons: 1, metaLessons: 1, processInsights: 1 },
    seededToPlaybook: [],
    redaction: { scrubber: 'correction-scrub@v1', findingsRemoved: 2, scrubbedAt: '2026-06-02T03:00:00Z' },
    fidelityReview: { reviewer: 'indep', verdict: 'faithful', at: '2026-06-02T03:05:00Z' },
    programNeeds: 1,
  };
  const yamlLines = Object.entries(fm).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join('\n');
  const body = ['## Lessons', '- l. ledger:4c4a8ded', '## Meta-lessons', '- m. thread:13435#m1', '## Process-insights', '- p.', '## What the program needs', '- need-001 x.'].join('\n');
  return `---\n${yamlLines}\n---\n\n${body}\n`;
}

function ctxFor(
  stateDir: string,
  program: ApprenticeshipProgram | null,
  cycleStore: ApprenticeshipCycleStore | null = null,
  cycleSlaMonitor: ApprenticeshipCycleSlaMonitor | null = null,
): RouteContext {
  return {
    config: {
      projectName: 'apprenticeship-routes', projectDir: path.dirname(stateDir), stateDir, port: 0,
      authToken: AUTH, monitoring: {}, sessions: {} as any, scheduler: {} as any,
    } as any,
    sessionManager: { listRunningSessions: () => [] } as any,
    state: { getJobState: () => null, getSession: () => null } as any,
    scheduler: null, telegram: null, relationships: null, feedback: null,
    dispatches: null, updateChecker: null, autoUpdater: null, autoDispatcher: null,
    quotaTracker: null, publisher: null, viewer: null, tunnel: null, evolution: null,
    watchdog: null, triageNurse: null, topicMemory: null, feedbackAnomalyDetector: null,
    discoveryEvaluator: null, correctionLedger: null, apprenticeshipProgram: program,
    apprenticeshipCycleStore: cycleStore, apprenticeshipCycleSlaMonitor: cycleSlaMonitor,
    startTime: new Date(),
  } as unknown as RouteContext;
}

function appWith(ctx: RouteContext): express.Express {
  const app = express();
  app.use(express.json());
  app.use(authMiddleware(AUTH));
  app.use('/', createRoutes(ctx));
  return app;
}

describe('/apprenticeship routes (integration)', () => {
  let tmpDir: string;
  let stateDir: string;
  let projectDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apprenticeship-routes-'));
    projectDir = path.join(tmpDir, 'project');
    stateDir = path.join(projectDir, '.instar');
    fs.mkdirSync(stateDir, { recursive: true });
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/integration/apprenticeship-routes.test.ts:afterEach' });
  });

  function makeProgram(deps?: Partial<GateDeps>): ApprenticeshipProgram {
    return new ApprenticeshipProgram({ stateDir, projectDir, deps });
  }

  function makeCycleStore(): ApprenticeshipCycleStore {
    return new ApprenticeshipCycleStore({
      dbPath: path.join(stateDir, 'server-data', 'apprenticeship-cycles.db'),
      now: () => new Date('2026-06-03T08:00:00.000Z'),
    });
  }

  function makeCycleSlaMonitor(store: ApprenticeshipCycleStore): ApprenticeshipCycleSlaMonitor {
    return new ApprenticeshipCycleSlaMonitor({
      store,
      config: { enabled: true, overdueAfterMinutes: 120 },
      now: () => new Date('2026-06-03T12:00:00.000Z'),
    });
  }

  // ── auth-negative ─────────────────────────────────────────────────────
  it('401 without a bearer token', async () => {
    const res = await request(appWith(ctxFor(stateDir, makeProgram()))).get('/apprenticeship/instances');
    expect(res.status).toBe(401);
  });

  it('403 with a WRONG bearer token', async () => {
    const res = await request(appWith(ctxFor(stateDir, makeProgram())))
      .get('/apprenticeship/instances')
      .set({ Authorization: 'Bearer wrong-token' });
    expect(res.status).toBe(403);
  });

  it('503 when the program is unavailable (null)', async () => {
    const res = await request(appWith(ctxFor(stateDir, null))).get('/apprenticeship/instances').set(auth());
    expect(res.status).toBe(503);
    expect(res.body.error).toContain('apprenticeship program disabled');
  });

  // ── cycle capture ───────────────────────────────────────────────────
  it('cycle routes require bearer auth and 503 when the store is unavailable', async () => {
    const app = appWith(ctxFor(stateDir, makeProgram(), null));
    const unauth = await request(app).get('/apprenticeship/cycles');
    expect(unauth.status).toBe(401);

    const unavailable = await request(app).get('/apprenticeship/cycles').set(auth());
    expect(unavailable.status).toBe(503);
    expect(unavailable.body.error).toContain('cycle store disabled');
  });

  it('records, lists, gets, filters, and closes cycle rows over HTTP', async () => {
    const store = makeCycleStore();
    const app = appWith(ctxFor(stateDir, makeProgram(), store));

    const bad = await request(app)
      .post('/apprenticeship/cycles')
      .set(auth())
      .send({ instanceId: 'echo-to-codey' });
    expect(bad.status).toBe(400);

    const created = await request(app)
      .post('/apprenticeship/cycles')
      .set(auth())
      .send({
        id: 'cycle-http-1',
        instanceId: 'echo-to-codey',
        cycleNumber: 1,
        task: 'Run Gemini identity review',
        menteeOutput: 'raw output',
        mentorFlagged: ['compressed principles'],
        overseerDifferential: ['surface env issue'],
        coaching: 'Keep reasoning and infra findings separate.',
        infraItems: ['ripgrep missing'],
        kind: 'mentor-mentee-differential',
      });
    expect(created.status).toBe(201);
    expect(created.body.kind).toBe('mentor-mentee-differential');
    expect(created.body.mentorFlagged).toEqual(['compressed principles']);
    expect(created.body.infraItems).toEqual(['ripgrep missing']);

    await request(app)
      .post('/apprenticeship/cycles')
      .set(auth())
      .send({
        id: 'cycle-other',
        instanceId: 'other-instance',
        cycleNumber: 1,
        task: 'Other task',
        menteeOutput: 'other output',
      })
      .expect(201);

    const list = await request(app).get('/apprenticeship/cycles?instanceId=echo-to-codey&limit=10').set(auth());
    expect(list.status).toBe(200);
    expect(list.body.cycles.map((c: { id: string }) => c.id)).toEqual(['cycle-http-1']);

    const fetched = await request(app).get('/apprenticeship/cycles/cycle-http-1').set(auth());
    expect(fetched.status).toBe(200);
    expect(fetched.body.overseerDifferential).toEqual(['surface env issue']);

    const missing = await request(app).get('/apprenticeship/cycles/no-such').set(auth());
    expect(missing.status).toBe(404);

    const closed = await request(app).post('/apprenticeship/cycles/cycle-http-1/close').set(auth());
    expect(closed.status).toBe(200);
    expect(closed.body.status).toBe('closed');

    const closeMissing = await request(app).post('/apprenticeship/cycles/no-such/close').set(auth());
    expect(closeMissing.status).toBe(404);
    store.close();
  });

  it('role-coverage route requires bearer, 503s without the store, and detects role drift', async () => {
    const unavailable = appWith(ctxFor(stateDir, makeProgram(), null, null));
    const unauth = await request(unavailable).get('/apprenticeship/instances/echo-to-codey/role-coverage');
    expect(unauth.status).toBe(401);

    const disabled = await request(unavailable).get('/apprenticeship/instances/echo-to-codey/role-coverage').set(auth());
    expect(disabled.status).toBe(503);
    expect(disabled.body.error).toContain('cycle store disabled');

    const store = makeCycleStore();
    store.record({
      id: 'review-1',
      instanceId: 'echo-to-codey',
      cycleNumber: 1,
      createdAt: '2026-06-03T08:00:00.000Z',
      task: 'review 1',
      menteeOutput: 'output',
      kind: 'overseer-apprentice-devreview',
    });
    store.record({
      id: 'review-2',
      instanceId: 'echo-to-codey',
      cycleNumber: 2,
      createdAt: '2026-06-03T09:00:00.000Z',
      task: 'review 2',
      menteeOutput: 'output',
      kind: 'overseer-apprentice-devreview',
    });
    store.record({
      id: 'healthy-mentor',
      instanceId: 'healthy',
      cycleNumber: 1,
      createdAt: '2026-06-03T10:00:00.000Z',
      task: 'mentor loop',
      menteeOutput: 'output',
      kind: 'mentor-mentee-differential',
    });
    store.record({
      id: 'healthy-review',
      instanceId: 'healthy',
      cycleNumber: 2,
      createdAt: '2026-06-03T11:00:00.000Z',
      task: 'review loop',
      menteeOutput: 'output',
      kind: 'overseer-apprentice-devreview',
    });

    const app = appWith(ctxFor(stateDir, makeProgram(), store, null));
    const drift = await request(app).get('/apprenticeship/instances/echo-to-codey/role-coverage').set(auth());
    expect(drift.status).toBe(200);
    expect(drift.body.driftWarning).toBe(true);
    expect(drift.body.axes['overseer-apprentice-devreview'].cycleCount).toBe(2);
    expect(drift.body.dormantAxes).toContain('mentor-mentee-differential');

    const healthy = await request(app).get('/apprenticeship/instances/healthy/role-coverage').set(auth());
    expect(healthy.status).toBe(200);
    expect(healthy.body.driftWarning).toBe(false);
    expect(healthy.body.axes['mentor-mentee-differential'].cycleCount).toBe(1);

    const empty = await request(app).get('/apprenticeship/instances/empty/role-coverage').set(auth());
    expect(empty.status).toBe(200);
    expect(empty.body.driftWarning).toBe(false);
    expect(empty.body.axes['mentor-mentee-differential'].cycleCount).toBe(0);
    store.close();
  });

  it('overdue route requires bearer, 503s when SLA monitor is disabled, and returns the overdue set', async () => {
    const unavailable = appWith(ctxFor(stateDir, makeProgram(), null, null));
    const unauth = await request(unavailable).get('/apprenticeship/cycles/overdue');
    expect(unauth.status).toBe(401);

    const disabled = await request(unavailable).get('/apprenticeship/cycles/overdue').set(auth());
    expect(disabled.status).toBe(503);
    expect(disabled.body.error).toContain('SLA monitor disabled');

    const store = makeCycleStore();
    store.record({
      id: 'old-open',
      instanceId: 'echo-to-codey',
      cycleNumber: 1,
      createdAt: '2026-06-03T09:00:00.000Z',
      task: 'old open',
      menteeOutput: 'output',
    });
    store.record({
      id: 'young-open',
      instanceId: 'echo-to-codey',
      cycleNumber: 2,
      createdAt: '2026-06-03T11:30:00.000Z',
      task: 'young open',
      menteeOutput: 'output',
    });
    store.record({
      id: 'old-closed',
      instanceId: 'echo-to-codey',
      cycleNumber: 3,
      createdAt: '2026-06-03T08:00:00.000Z',
      task: 'old closed',
      menteeOutput: 'output',
      status: 'closed',
    });
    store.record({
      id: 'other-old-open',
      instanceId: 'other-instance',
      cycleNumber: 1,
      createdAt: '2026-06-03T08:00:00.000Z',
      task: 'other old',
      menteeOutput: 'output',
    });

    const app = appWith(ctxFor(stateDir, makeProgram(), store, makeCycleSlaMonitor(store)));
    const res = await request(app).get('/apprenticeship/cycles/overdue?instanceId=echo-to-codey').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.overdue).toEqual([
      {
        id: 'old-open',
        instanceId: 'echo-to-codey',
        cycleNumber: 1,
        ageMinutes: 180,
        createdAt: '2026-06-03T09:00:00.000Z',
      },
    ]);
    store.close();
  });

  // ── create ────────────────────────────────────────────────────────────
  it('200 with an empty list, then 201 create, then GET :id', async () => {
    const app = appWith(ctxFor(stateDir, makeProgram()));
    const empty = await request(app).get('/apprenticeship/instances').set(auth());
    expect(empty.status).toBe(200);
    expect(empty.body.instances).toEqual([]);

    const created = await request(app)
      .post('/apprenticeship/instances')
      .set(auth())
      .send({ id: 'echo-to-codey', instanceType: 'mentorship', overseer: 'echo', mentor: 'echo', mentee: 'codey', framework: 'codex-cli', priorInstanceId: null });
    expect(created.status).toBe(201);
    expect(created.body.harvestFrom).toBe('echo');
    expect(created.body.status).toBe('pending');

    const fetched = await request(app).get('/apprenticeship/instances/echo-to-codey').set(auth());
    expect(fetched.status).toBe(200);
    expect(fetched.body.id).toBe('echo-to-codey');

    const missing = await request(app).get('/apprenticeship/instances/no-such').set(auth());
    expect(missing.status).toBe(404);
  });

  it('400 on a charset-invalid create', async () => {
    const app = appWith(ctxFor(stateDir, makeProgram()));
    const res = await request(app)
      .post('/apprenticeship/instances')
      .set(auth())
      .send({ id: 'Bad/Id', instanceType: 'mentorship', mentor: 'echo', mentee: 'codey', framework: 'codex-cli' });
    expect(res.status).toBe(400);
  });

  // ── create → transition gating end to end ─────────────────────────────
  it('transition pending→active is REFUSED (409) when the start gate fails, then ALLOWED when it passes', async () => {
    // First: no harvest on disk → start gate refuses.
    const program = makeProgram({ readHarvest: () => null, validate: validateRetroHarvest });
    const app = appWith(ctxFor(stateDir, program));
    await request(app)
      .post('/apprenticeship/instances')
      .set(auth())
      .send({ id: 'gated', instanceType: 'mentorship', overseer: 'echo', mentor: 'echo', mentee: 'codey', framework: 'codex-cli', priorInstanceId: null });

    const refused = await request(app).post('/apprenticeship/instances/gated/transition').set(auth()).send({ to: 'active' });
    expect(refused.status).toBe(409);
    expect(refused.body.ok).toBe(false);
    expect(refused.body.reason).toMatch(/start gate refused/);

    // Now: a program whose readHarvest returns a valid harvest → allowed.
    const program2 = makeProgram({ readHarvest: () => buildHarvest(), validate: validateRetroHarvest });
    const app2 = appWith(ctxFor(stateDir, program2)); // same store on disk (the instance persists)
    const allowed = await request(app2).post('/apprenticeship/instances/gated/transition').set(auth()).send({ to: 'active' });
    expect(allowed.status).toBe(200);
    expect(allowed.body.ok).toBe(true);
    expect(allowed.body.instance.status).toBe('active');
  });

  it('400 on an invalid transition target', async () => {
    const program = makeProgram();
    const app = appWith(ctxFor(stateDir, program));
    await request(app).post('/apprenticeship/instances').set(auth()).send({ id: 'i', instanceType: 'mentorship', mentor: 'echo', mentee: 'codey', framework: 'codex-cli' });
    const res = await request(app).post('/apprenticeship/instances/i/transition').set(auth()).send({ to: 'bogus' });
    expect(res.status).toBe(400);
  });

  it('404 transition on a missing instance', async () => {
    const app = appWith(ctxFor(stateDir, makeProgram()));
    const res = await request(app).post('/apprenticeship/instances/ghost/transition').set(auth()).send({ to: 'active' });
    expect(res.status).toBe(404);
  });

  // ── read-only gate previews ───────────────────────────────────────────
  it('can-start / can-complete are read-only previews (no mutation)', async () => {
    const program = makeProgram({ readHarvest: () => buildHarvest(), validate: validateRetroHarvest, countInstanceLedgerEntries: () => 0, detectorAuditExists: () => false });
    const app = appWith(ctxFor(stateDir, program));
    await request(app).post('/apprenticeship/instances').set(auth()).send({ id: 'preview', instanceType: 'mentorship', overseer: 'echo', mentor: 'echo', mentee: 'codey', framework: 'codex-cli', priorInstanceId: null });

    const canStart = await request(app).post('/apprenticeship/instances/preview/can-start').set(auth());
    expect(canStart.status).toBe(200);
    expect(canStart.body.allow).toBe(true);

    const canComplete = await request(app).post('/apprenticeship/instances/preview/can-complete').set(auth());
    expect(canComplete.status).toBe(200);
    expect(canComplete.body.allow).toBe(false);
    expect(canComplete.body.missing).toContain('ledgerEntries:none');

    // Previews did not mutate — still pending.
    const after = await request(app).get('/apprenticeship/instances/preview').set(auth());
    expect(after.body.status).toBe('pending');
  });

  // ── decision-audit line ───────────────────────────────────────────────
  it('writes a decision-audit line on a gated transition', async () => {
    const program = makeProgram({ readHarvest: () => null, validate: validateRetroHarvest });
    const app = appWith(ctxFor(stateDir, program));
    await request(app).post('/apprenticeship/instances').set(auth()).send({ id: 'aud', instanceType: 'mentorship', overseer: 'echo', mentor: 'echo', mentee: 'codey', framework: 'codex-cli', priorInstanceId: null });
    await request(app).post('/apprenticeship/instances/aud/transition').set(auth()).send({ to: 'active' });

    const logPath = path.join(stateDir, 'logs', 'apprenticeship-decisions.jsonl');
    expect(fs.existsSync(logPath)).toBe(true);
    const entry = JSON.parse(fs.readFileSync(logPath, 'utf-8').trim().split('\n')[0]);
    expect(entry.gate).toBe('start');
    expect(entry.instanceId).toBe('aud');
    expect(entry.allow).toBe(false);
  });
});
