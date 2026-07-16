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
import DatabaseCtor from 'better-sqlite3';
import { createRoutes } from '../../src/server/routes.js';
import type { RouteContext } from '../../src/server/routes.js';
import { authMiddleware } from '../../src/server/middleware.js';
import { ApprenticeshipProgram, type GateDeps } from '../../src/core/ApprenticeshipProgram.js';
import { validateRetroHarvest } from '../../src/core/retroHarvestValidator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { ApprenticeshipCycleStore } from '../../src/monitoring/ApprenticeshipCycleStore.js';
import { ApprenticeshipCycleSlaMonitor } from '../../src/monitoring/ApprenticeshipCycleSlaMonitor.js';
import { FrameworkIssueLedger } from '../../src/monitoring/FrameworkIssueLedger.js';
import { generateAgentToken, deleteAgentToken } from '../../src/messaging/AgentTokenManager.js';

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
  peerCycleReader: RouteContext['apprenticeshipPeerCycleReader'] = null,
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
    apprenticeshipPeerCycleReader: peerCycleReader,
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

const UXOK = {
  dupNotices: 0, infraNoiseMsgs: 0, asksOfUser: 0, contentFreeUpdates: 0,
  modalitiesExercised: ['text'], duringRestartChurn: false,
};

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
    deleteAgentToken('apprenticeship-routes');
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/integration/apprenticeship-routes.test.ts:afterEach' });
  });

  function makeProgram(deps?: Partial<GateDeps>): ApprenticeshipProgram {
    return new ApprenticeshipProgram({ stateDir, projectDir, deps });
  }

  function makeActiveProgram(): ApprenticeshipProgram {
    const p = makeProgram({ readHarvest: () => buildHarvest(), validate: validateRetroHarvest });
    for (const id of ['echo-to-codey', 'other-instance', 'tuned', 'dorm']) {
      p.createInstance({ id, instanceType: 'mentorship', mentor: 'echo', mentee: 'codey', framework: 'codex-cli' });
      expect(p.transition(id, 'active').ok).toBe(true);
    }
    return p;
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
    const app = appWith(ctxFor(stateDir, makeActiveProgram(), store));

    const bad = await request(app)
      .post('/apprenticeship/cycles')
      .set(auth())
      .send({ instanceId: 'echo-to-codey' });
    expect(bad.status).toBe(400);

    const badChannel = await request(app)
      .post('/apprenticeship/cycles')
      .set(auth())
      .send({
        instanceId: 'echo-to-codey',
        cycleNumber: 1,
        task: 'Manual review',
        menteeOutput: 'raw output',
        channel: 'email',
      });
    expect(badChannel.status).toBe(400);
    expect(badChannel.body.error).toContain('channel must be one of');

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
        channel: 'telegram-playwright',
        operatorSeatUx: {
          dupNotices: 0, infraNoiseMsgs: 0, asksOfUser: 0, contentFreeUpdates: 0,
          modalitiesExercised: ['text'], duringRestartChurn: false,
        },
        // telegram-playwright cycles require the objective audit artifact (#864 gate).
        transcriptAudit: {
          topicIds: [1052],
          window: { start: '2026-06-03T07:00:00.000Z', end: '2026-06-03T08:00:00.000Z' },
          summary: { total: 0 },
          findingDedupKeys: [],
          generatedAt: '2026-06-03T08:01:00.000Z',
          ledger: 'dry-run',
        },
      });
    expect(created.status).toBe(201);
    expect(created.body.kind).toBe('mentor-mentee-differential');
    expect(created.body.channel).toBe('telegram-playwright');
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
        operatorSeatUx: {
          dupNotices: 0, infraNoiseMsgs: 0, asksOfUser: 0, contentFreeUpdates: 0,
          modalitiesExercised: ['text'], duringRestartChurn: false,
        },
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

  it('refuses unknown and non-active instance ids at cycle-record time', async () => {
    const store = makeCycleStore();
    const p = makeProgram();
    p.createInstance({ id: 'pending-one', instanceType: 'mentorship', mentor: 'echo', mentee: 'codey', framework: 'codex-cli' });
    p.createInstance({ id: 'abandoned-one', instanceType: 'mentorship', mentor: 'echo', mentee: 'wrong', framework: 'codex-cli' });
    expect(p.transition('abandoned-one', 'abandoned').ok).toBe(true);
    const app = appWith(ctxFor(stateDir, p, store));
    const base = { cycleNumber: 1, task: 't', menteeOutput: 'o', operatorSeatUx: UXOK };

    for (const [instanceId, expected] of [
      ['ghost', 'does not exist'],
      ['pending-one', 'only while the instance is active'],
      ['abandoned-one', 'only while the instance is active'],
    ] as const) {
      const res = await request(app).post('/apprenticeship/cycles').set(auth()).send({ ...base, instanceId });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain(expected);
    }
    expect(store.list()).toEqual([]);
    store.close();
  });

  it('reports legacy dangling cycles without mutating them', async () => {
    const store = makeCycleStore();
    store.record({ instanceId: 'phantom', cycleNumber: 1, task: 'legacy', menteeOutput: 'kept', operatorSeatUx: UXOK });
    const app = appWith(ctxFor(stateDir, makeActiveProgram(), store));

    const report = await request(app).get('/apprenticeship/cycles/integrity').set(auth());
    expect(report.status).toBe(200);
    expect(report.body).toMatchObject({ scanned: 1, danglingCount: 1, truncated: false });
    expect(report.body.dangling[0]).toMatchObject({ instanceId: 'phantom' });
    expect(store.list()).toHaveLength(1);
    store.close();
  });

  it('reports a dangling legacy bad-kind cycle instead of failing the integrity read', async () => {
    const dbPath = path.join(stateDir, 'legacy-bad-kind.db');
    let store = new ApprenticeshipCycleStore({ dbPath });
    store.record({ id: 'legacy-bad-kind', instanceId: 'phantom', cycleNumber: 1, task: 'legacy', menteeOutput: 'kept', operatorSeatUx: UXOK });
    store.close();
    const db = new DatabaseCtor(dbPath);
    db.prepare(`UPDATE apprenticeship_cycles SET kind = 'mentorship' WHERE id = ?`).run('legacy-bad-kind');
    db.close();
    store = new ApprenticeshipCycleStore({ dbPath });
    const app = appWith(ctxFor(stateDir, makeActiveProgram(), store));

    const report = await request(app).get('/apprenticeship/cycles/integrity').set(auth());
    expect(report.status).toBe(200);
    expect(report.body).toMatchObject({ scanned: 1, danglingCount: 1 });
    expect(report.body.dangling[0]).toMatchObject({ cycleId: 'legacy-bad-kind', instanceId: 'phantom' });
    expect(store.list()).toMatchObject([{ id: 'legacy-bad-kind', kind: 'unknown' }]);
    store.close();
  });

  it('REFUSES a cycle without operatorSeatUx over HTTP with the self-describing shape (UX-blindspot gate)', async () => {
    const store = makeCycleStore();
    const app = appWith(ctxFor(stateDir, makeActiveProgram(), store));

    const refused = await request(app)
      .post('/apprenticeship/cycles')
      .set(auth())
      .send({
        instanceId: 'echo-to-codey',
        cycleNumber: 1,
        task: 'drive without observing',
        menteeOutput: 'no verdict supplied',
      });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toContain('operatorSeatUx is required');
    expect(refused.body.error).toContain('modalitiesExercised'); // caller can self-serve the fix
    store.close();
  });

  it('records manual overseer cycle rows with their execution channel', async () => {
    const store = makeCycleStore();
    const app = appWith(ctxFor(stateDir, makeActiveProgram(), store));

    const created = await request(app)
      .post('/apprenticeship/cycles')
      .set(auth())
      .send({
        id: 'cycle-overseer-manual',
        instanceId: 'echo-to-codey',
        cycleNumber: 1,
        task: 'Manual overseer review of Codey output',
        menteeOutput: 'Codey shipped the route.',
        overseerDifferential: ['route existed but was not surfaced in capabilities'],
        coaching: 'Check live main before assuming the missing layer.',
        infraItems: ['add capability awareness for cycle writes'],
        kind: 'overseer-apprentice-devreview',
        channel: 'direct-shortcut',
        operatorSeatUx: {
          dupNotices: 0, infraNoiseMsgs: 0, asksOfUser: 0, contentFreeUpdates: 0,
          modalitiesExercised: ['text'], duringRestartChurn: false,
        },
      });

    expect(created.status).toBe(201);
    expect(created.body.kind).toBe('overseer-apprentice-devreview');
    expect(created.body.channel).toBe('direct-shortcut');

    const fetched = await request(app).get('/apprenticeship/cycles/cycle-overseer-manual').set(auth());
    expect(fetched.status).toBe(200);
    expect(fetched.body.overseerDifferential).toEqual(['route existed but was not surfaced in capabilities']);

    const coverage = await request(app).get('/apprenticeship/instances/echo-to-codey/role-coverage').set(auth());
    expect(coverage.status).toBe(200);
    expect(coverage.body.axes['overseer-apprentice-devreview'].fired).toBe(true);
    expect(coverage.body.axes['mentor-mentee-differential'].fired).toBe(false);
    // keystoneBalance (the 2026-06-06 mentor/mentee balance signal) is surfaced
    // through the route: this instance reviewed without ever driving the mentee.
    expect(coverage.body.keystoneBalance.keystoneAxis).toBe('mentor-mentee-differential');
    expect(coverage.body.keystoneBalance.starved).toBe(true);
    expect(coverage.body.keystoneBalance.reason).toMatch(/never fired/i);
    store.close();
  });

  it('role-coverage honors the ?oversightStarvationThreshold tuning query', async () => {
    const store = makeCycleStore();
    const app = appWith(ctxFor(stateDir, makeActiveProgram(), store));
    const base = (id: string, n: number, kind: string, at: string) => ({
      id, instanceId: 'tuned', cycleNumber: n, task: 't', menteeOutput: 'm', kind, createdAt: at, operatorSeatUx: UXOK,
    });
    for (const c of [
      base('k', 1, 'mentor-mentee-differential', '2026-06-03T08:00:00.000Z'),
      base('o1', 2, 'overseer-apprentice-devreview', '2026-06-03T09:00:00.000Z'),
      base('o2', 3, 'overseer-apprentice-devreview', '2026-06-03T10:00:00.000Z'),
    ]) {
      await request(app).post('/apprenticeship/cycles').set(auth()).send(c).expect(201);
    }
    // default threshold 3 → 2 oversight-since → not starved
    const dflt = await request(app).get('/apprenticeship/instances/tuned/role-coverage').set(auth());
    expect(dflt.body.keystoneBalance.starved).toBe(false);
    // ?oversightStarvationThreshold=2 → exactly at → starved
    const tuned = await request(app).get('/apprenticeship/instances/tuned/role-coverage?oversightStarvationThreshold=2').set(auth());
    expect(tuned.body.keystoneBalance.starved).toBe(true);
    expect(tuned.body.keystoneBalance.starvationThreshold).toBe(2);
    store.close();
  });

  it('role-coverage merges remote agent cycles and names incomplete peer reads', async () => {
    const store = makeCycleStore();
    const peerCycle = {
      id: 'peer-keystone', instanceId: 'echo-to-codey', cycleNumber: 7,
      createdAt: '2026-06-03T07:30:00.000Z', task: 'Echo drove Codey', menteeOutput: 'output',
      mentorFlagged: [], overseerDifferential: [], coaching: '', infraItems: [],
      kind: 'mentor-mentee-differential' as const, status: 'open', channel: 'threadline-backup' as const,
      operatorSeatUx: null, transcriptAudit: null,
    };
    const app = appWith(ctxFor(stateDir, makeActiveProgram(), store, null, async () => ({
      cycles: [peerCycle],
      sources: [
        { agent: 'echo', port: 4042, cycleCount: 1, truncated: false },
        { agent: 'gemini', port: 4048, cycleCount: 0, truncated: false, error: 'HTTP 503' },
      ],
      complete: false,
      omittedPeerCount: 0,
    })));

    const response = await request(app).get('/apprenticeship/instances/echo-to-codey/role-coverage').set(auth());
    expect(response.status).toBe(200);
    expect(response.body.axes['mentor-mentee-differential']).toMatchObject({ fired: true, cycleCount: 1 });
    expect(response.body.keystoneBalance.starved).toBe(false);
    expect(response.body.aggregation).toMatchObject({ scope: 'registered-agents', complete: false });
    expect(response.body.aggregation.peerSources).toContainEqual(expect.objectContaining({ agent: 'gemini', error: 'HTTP 503' }));
    store.close();
  });

  it('serves the bounded peer-cycle read only to the target agent token', async () => {
    const store = makeCycleStore();
    store.record({
      id: 'peer-readable-cycle', instanceId: 'echo-to-codey', cycleNumber: 1,
      task: 'drive', menteeOutput: 'output', operatorSeatUx: UXOK,
    });
    const app = appWith(ctxFor(stateDir, makeActiveProgram(), store));

    await request(app)
      .get('/a2a/apprenticeship/cycles?instanceId=echo-to-codey')
      .set({ Authorization: 'Bearer wrong-token' })
      .expect(401);
    const token = generateAgentToken('apprenticeship-routes');
    const response = await request(app)
      .get('/a2a/apprenticeship/cycles?instanceId=echo-to-codey')
      .set({ Authorization: `Bearer ${token}` });
    expect(response.status).toBe(200);
    expect(response.body.cycles).toContainEqual(expect.objectContaining({ id: 'peer-readable-cycle' }));
    store.close();
  });

  it('role-coverage surfaces dormancy and honors the ?keystoneDormancyMs tuning query', async () => {
    const store = makeCycleStore(); // fixed now() = 2026-06-03T08:00:00Z
    const app = appWith(ctxFor(stateDir, makeActiveProgram(), store));
    // one keystone drive 8h before now, nothing since — the masked-as-healthy shape
    await request(app).post('/apprenticeship/cycles').set(auth()).send({
      id: 'k', instanceId: 'dorm', cycleNumber: 1, task: 't', menteeOutput: 'm',
      kind: 'mentor-mentee-differential', createdAt: '2026-06-03T00:00:00.000Z', operatorSeatUx: UXOK,
    }).expect(201);
    // default dormancy 6h → an 8h-old keystone reads DORMANT (but not starved: no oversight piled up)
    const dflt = await request(app).get('/apprenticeship/instances/dorm/role-coverage').set(auth());
    expect(dflt.status).toBe(200);
    expect(dflt.body.keystoneBalance.starved).toBe(false);
    expect(dflt.body.keystoneBalance.dormant).toBe(true);
    expect(dflt.body.keystoneBalance.lastKeystoneAgeMs).toBe(8 * 60 * 60 * 1000);
    expect(dflt.body.keystoneBalance.dormancyThresholdMs).toBe(6 * 60 * 60 * 1000);
    expect(dflt.body.keystoneBalance.reason).toMatch(/dormant/i);
    // ?keystoneDormancyMs raised past the age → no longer dormant, reads healthy
    const relaxed = await request(app)
      .get(`/apprenticeship/instances/dorm/role-coverage?keystoneDormancyMs=${9 * 60 * 60 * 1000}`)
      .set(auth());
    expect(relaxed.body.keystoneBalance.dormant).toBe(false);
    expect(relaxed.body.keystoneBalance.dormancyThresholdMs).toBe(9 * 60 * 60 * 1000);
    expect(relaxed.body.keystoneBalance.reason).toMatch(/healthy/i);
    store.close();
  });

  // ── transcript-audit artifact gate (#864 follow-through) ───────────────
  describe('transcript-audit gate over HTTP', () => {
    const AUDIT_OK = {
      topicIds: [1052],
      window: { start: '2026-06-03T07:00:00.000Z', end: '2026-06-03T08:00:00.000Z' },
      summary: { 'asks-of-user': 0, total: 0 },
      findingDedupKeys: [],
      generatedAt: '2026-06-03T08:01:00.000Z',
      ledger: 'dry-run',
    };
    const tpCycle = (over: Record<string, unknown> = {}) => ({
      instanceId: 'echo-to-codey',
      cycleNumber: 1,
      task: 'playwright drive',
      menteeOutput: 'mentee did the thing',
      channel: 'telegram-playwright',
      operatorSeatUx: UXOK,
      ...over,
    });

    function makeLedger(): FrameworkIssueLedger {
      return new FrameworkIssueLedger({ dbPath: path.join(stateDir, 'server-data', 'framework-issues.db') });
    }

    it('REFUSES a telegram-playwright cycle without the audit, teaching the producing CLI', async () => {
      const store = makeCycleStore();
      const app = appWith(ctxFor(stateDir, makeActiveProgram(), store));
      const refused = await request(app).post('/apprenticeship/cycles').set(auth()).send(tpCycle());
      expect(refused.status).toBe(400);
      expect(refused.body.error).toContain('transcriptAudit is required for telegram-playwright cycles');
      expect(refused.body.error).toContain('dev:post-drive-transcript-audit');
      store.close();
    });

    it('ACCEPTS a dry-run audit block and round-trips it on GET', async () => {
      const store = makeCycleStore();
      const app = appWith(ctxFor(stateDir, makeActiveProgram(), store));
      const created = await request(app).post('/apprenticeship/cycles').set(auth())
        .send(tpCycle({ id: 'cycle-audited', transcriptAudit: AUDIT_OK }));
      expect(created.status).toBe(201);
      expect(created.body.transcriptAudit.ledger).toBe('dry-run');

      const fetched = await request(app).get('/apprenticeship/cycles/cycle-audited').set(auth());
      expect(fetched.status).toBe(200);
      expect(fetched.body.transcriptAudit.topicIds).toEqual([1052]);
      expect(fetched.body.transcriptAudit.window.start).toBe('2026-06-03T07:00:00.000Z');
      store.close();
    });

    it("REFUSES a ledger:'local' claim whose dedup keys do NOT resolve in the real ledger (anti-fabrication)", async () => {
      const store = makeCycleStore();
      const ledger = makeLedger();
      const ctx = ctxFor(stateDir, makeActiveProgram(), store);
      (ctx as unknown as Record<string, unknown>).frameworkIssueLedger = ledger;
      const app = appWith(ctx);

      const refused = await request(app).post('/apprenticeship/cycles').set(auth()).send(tpCycle({
        transcriptAudit: {
          ...AUDIT_OK,
          ledger: 'local',
          summary: { 'asks-of-user': 1, total: 1 },
          findingDedupKeys: ['post-drive-transcript-audit::asks-of-user::topic-1052::fabricated00'],
        },
      }));
      expect(refused.status).toBe(400);
      expect(refused.body.error).toContain('none of the claimed');
      ledger.close();
      store.close();
    });

    it("ACCEPTS a ledger:'local' claim whose dedup key actually resolves", async () => {
      const store = makeCycleStore();
      const ledger = makeLedger();
      const dedupKey = 'post-drive-transcript-audit::asks-of-user::topic-1052::real0001';
      ledger.recordObservation({
        framework: 'codex-cli',
        bucket: 'instar-integration-gap',
        title: 'Post-drive transcript asked the operator to resend',
        dedupKey,
      });
      const ctx = ctxFor(stateDir, makeActiveProgram(), store);
      (ctx as unknown as Record<string, unknown>).frameworkIssueLedger = ledger;
      const app = appWith(ctx);

      const created = await request(app).post('/apprenticeship/cycles').set(auth()).send(tpCycle({
        id: 'cycle-local-verified',
        transcriptAudit: {
          ...AUDIT_OK,
          ledger: 'local',
          summary: { 'asks-of-user': 1, total: 1 },
          findingDedupKeys: [dedupKey],
        },
      }));
      expect(created.status).toBe(201);
      expect(created.body.transcriptAudit.findingDedupKeys).toEqual([dedupKey]);
      ledger.close();
      store.close();
    });

    it('skips the ledger cross-check gracefully when no ledger is wired (declaration still recorded)', async () => {
      const store = makeCycleStore();
      const app = appWith(ctxFor(stateDir, makeActiveProgram(), store)); // no frameworkIssueLedger on ctx
      const created = await request(app).post('/apprenticeship/cycles').set(auth()).send(tpCycle({
        transcriptAudit: {
          ...AUDIT_OK,
          ledger: 'local',
          findingDedupKeys: ['post-drive-transcript-audit::infra-noise::topic-1052::unverified'],
        },
      }));
      expect(created.status).toBe(201);
      store.close();
    });
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
      operatorSeatUx: UXOK,
      kind: 'overseer-apprentice-devreview',
    });
    store.record({
      id: 'review-2',
      instanceId: 'echo-to-codey',
      cycleNumber: 2,
      createdAt: '2026-06-03T09:00:00.000Z',
      task: 'review 2',
      menteeOutput: 'output',
      operatorSeatUx: UXOK,
      kind: 'overseer-apprentice-devreview',
    });
    store.record({
      id: 'healthy-mentor',
      instanceId: 'healthy',
      cycleNumber: 1,
      createdAt: '2026-06-03T10:00:00.000Z',
      task: 'mentor loop',
      menteeOutput: 'output',
      operatorSeatUx: UXOK,
      kind: 'mentor-mentee-differential',
    });
    store.record({
      id: 'healthy-review',
      instanceId: 'healthy',
      cycleNumber: 2,
      createdAt: '2026-06-03T11:00:00.000Z',
      task: 'review loop',
      menteeOutput: 'output',
      operatorSeatUx: UXOK,
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
      operatorSeatUx: UXOK,
    });
    store.record({
      id: 'young-open',
      instanceId: 'echo-to-codey',
      cycleNumber: 2,
      createdAt: '2026-06-03T11:30:00.000Z',
      task: 'young open',
      menteeOutput: 'output',
      operatorSeatUx: UXOK,
    });
    store.record({
      id: 'old-closed',
      instanceId: 'echo-to-codey',
      cycleNumber: 3,
      createdAt: '2026-06-03T08:00:00.000Z',
      task: 'old closed',
      menteeOutput: 'output',
      operatorSeatUx: UXOK,
      status: 'closed',
    });
    store.record({
      id: 'other-old-open',
      instanceId: 'other-instance',
      cycleNumber: 1,
      createdAt: '2026-06-03T08:00:00.000Z',
      task: 'other old',
      menteeOutput: 'output',
      operatorSeatUx: UXOK,
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
    expect(created.body.ladderRung).toBe(0);

    const fetched = await request(app).get('/apprenticeship/instances/echo-to-codey').set(auth());
    expect(fetched.status).toBe(200);
    expect(fetched.body.id).toBe('echo-to-codey');

    const missing = await request(app).get('/apprenticeship/instances/no-such').set(auth());
    expect(missing.status).toBe(404);
  });

  it('transitions ladder rung only with adjacent evidence-backed changes', async () => {
    const app = appWith(ctxFor(stateDir, makeProgram()));
    await request(app).post('/apprenticeship/instances').set(auth()).send({
      id: 'ladder-route', instanceType: 'mentorship', mentor: 'echo', mentee: 'codey', framework: 'codex-cli',
    }).expect(201);

    const noEvidence = await request(app)
      .post('/apprenticeship/instances/ladder-route/rung-transition').set(auth()).send({ to: 1 });
    expect(noEvidence.status).toBe(409);

    const promoted = await request(app)
      .post('/apprenticeship/instances/ladder-route/rung-transition').set(auth())
      .send({ to: 1, evidenceRef: 'cycle:5faea978; prs:1479,1480,1481' });
    expect(promoted.status).toBe(200);
    expect(promoted.body.instance.ladderRung).toBe(1);
    expect(promoted.body.instance.rungHistory).toHaveLength(2);

    const missing = await request(app)
      .post('/apprenticeship/instances/no-such/rung-transition').set(auth())
      .send({ to: 1, evidenceRef: 'pr:1' });
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

  it('disposes a mistaken pending instance as retained terminal abandoned', async () => {
    const app = appWith(ctxFor(stateDir, makeProgram()));
    await request(app).post('/apprenticeship/instances').set(auth()).send({
      id: 'wrong-type', instanceType: 'apprenticeship', mentor: 'echo', mentee: 'codey', framework: 'codex-cli',
    }).expect(201);
    const disposed = await request(app)
      .post('/apprenticeship/instances/wrong-type/transition').set(auth()).send({ to: 'abandoned' });
    expect(disposed.status).toBe(200);
    expect(disposed.body.instance.status).toBe('abandoned');
    const retained = await request(app).get('/apprenticeship/instances/wrong-type').set(auth());
    expect(retained.body.status).toBe('abandoned');
    const restart = await request(app)
      .post('/apprenticeship/instances/wrong-type/transition').set(auth()).send({ to: 'active' });
    expect(restart.status).toBe(409);
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
