/**
 * Integration tests — /corrections routes (Correction & Preference Learning
 * Sentinel, Slice 1b). Tier 2: the REAL inline routes in createRoutes(), behind
 * the real authMiddleware, backed by a real CorrectionLedger.
 *
 * Covers (spec §6 Integration):
 *   - GET /corrections requires bearer (401 without)
 *   - 503 when the feature is disabled (null ledger)
 *   - toApiView strips raw `learning` (raw text never leaks over HTTP)
 *   - POST /corrections requires X-Instar-Request: 1
 *   - pagination shape (?limit, nextBefore)
 *   - /health does NOT serialize the ephemeral capture ring
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRoutes } from '../../src/server/routes.js';
import type { RouteContext } from '../../src/server/routes.js';
import { authMiddleware } from '../../src/server/middleware.js';
import { CorrectionLedger } from '../../src/monitoring/CorrectionLedger.js';
import { CorrectionCaptureBacklog } from '../../src/monitoring/CorrectionCaptureBacklog.js';
import { drainBacklog } from '../../src/monitoring/CorrectionCaptureLoop.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { ClassReviewStore } from '../../src/monitoring/ClassReviewStore.js';
import { CorrectionClassReview } from '../../src/monitoring/CorrectionClassReview.js';
import { CompletionClaimVerifier } from '../../src/monitoring/CompletionClaimVerifier.js';

const AUTH = 'corr-routes-token';
const auth = () => ({ Authorization: `Bearer ${AUTH}` });

function ctxFor(stateDir: string, ledger: CorrectionLedger | null): RouteContext {
  return {
    config: {
      projectName: 'corr-routes', projectDir: path.dirname(stateDir), stateDir, port: 0,
      authToken: AUTH,
      monitoring: { correctionLearning: { enabled: !!ledger } },
      sessions: {} as any, scheduler: {} as any,
    } as any,
    sessionManager: { listRunningSessions: () => [] } as any,
    state: { getJobState: () => null, getSession: () => null } as any,
    scheduler: null, telegram: null, relationships: null, feedback: null,
    dispatches: null, updateChecker: null, autoUpdater: null, autoDispatcher: null,
    quotaTracker: null, publisher: null, viewer: null, tunnel: null, evolution: null,
    watchdog: null, triageNurse: null, topicMemory: null, feedbackAnomalyDetector: null,
    discoveryEvaluator: null, correctionLedger: ledger, startTime: new Date(),
  } as unknown as RouteContext;
}

function appWith(ctx: RouteContext): express.Express {
  const app = express();
  app.use(express.json());
  app.use(authMiddleware(AUTH));
  app.use('/', createRoutes(ctx));
  return app;
}

describe('/corrections routes (integration)', () => {
  let tmpDir: string;
  let stateDir: string;
  let ledger: CorrectionLedger | null = null;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'corr-routes-'));
    stateDir = path.join(tmpDir, '.instar');
    fs.mkdirSync(stateDir, { recursive: true });
  });

  afterEach(() => {
    ledger?.close();
    ledger = null;
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/integration/corrections-routes.test.ts:afterEach' });
  });

  it('401 without a bearer token', async () => {
    ledger = new CorrectionLedger({ dbPath: ':memory:', machineId: 't' });
    const res = await request(appWith(ctxFor(stateDir, ledger))).get('/corrections');
    expect(res.status).toBe(401);
  });

  it('503 when the feature is disabled (null ledger)', async () => {
    const res = await request(appWith(ctxFor(stateDir, null))).get('/corrections').set(auth());
    expect(res.status).toBe(503);
    expect(res.body.error).toContain('correction-learning disabled');
  });

  it('200 with an empty list when enabled but no records', async () => {
    ledger = new CorrectionLedger({ dbPath: ':memory:', machineId: 't' });
    const res = await request(appWith(ctxFor(stateDir, ledger))).get('/corrections').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.records).toEqual([]);
    expect(res.body.totalRecords).toBe(0);
  });

  it('toApiView strips the raw learning + sessionId (raw text never leaks)', async () => {
    ledger = new CorrectionLedger({ dbPath: ':memory:', machineId: 't' });
    ledger.record({
      kind: 'user-preference',
      learning: 'RAW-SECRET-LEARNING-TEXT-DO-NOT-LEAK',
      scrubbedSummary: 'prefers plain language',
      deterministicWeight: 3,
      sessionId: 'SECRET-SESSION-ID',
      topicId: 9,
    });
    const res = await request(appWith(ctxFor(stateDir, ledger))).get('/corrections').set(auth());
    expect(res.status).toBe(200);
    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toContain('RAW-SECRET-LEARNING-TEXT-DO-NOT-LEAK');
    expect(serialized).not.toContain('SECRET-SESSION-ID');
    expect(serialized).toContain('prefers plain language');
    expect(res.body.records[0].learning).toBeUndefined();
  });

  it('GET /corrections/:id returns the scrubbed view (404 when missing)', async () => {
    ledger = new CorrectionLedger({ dbPath: ':memory:', machineId: 't' });
    const rec = ledger.record({ kind: 'infra-gap', learning: 'x', scrubbedSummary: 'force push nag', deterministicWeight: 3 })!;
    const app = appWith(ctxFor(stateDir, ledger));
    const found = await request(app).get(`/corrections/${rec.id}`).set(auth());
    expect(found.status).toBe(200);
    expect(found.body.scrubbedSummary).toBe('force push nag');
    const missing = await request(app).get('/corrections/CORR-nope-999').set(auth());
    expect(missing.status).toBe(404);
  });

  it('POST /corrections requires X-Instar-Request: 1', async () => {
    ledger = new CorrectionLedger({ dbPath: ':memory:', machineId: 't' });
    const app = appWith(ctxFor(stateDir, ledger));
    const noHeader = await request(app).post('/corrections').set(auth()).send({ learning: 'x', kind: 'infra-gap' });
    expect(noHeader.status).toBe(403);
    const withHeader = await request(app).post('/corrections').set(auth()).set('X-Instar-Request', '1').send({ learning: 'force push nag', kind: 'infra-gap' });
    expect(withHeader.status).toBe(201);
    expect(withHeader.body.learning).toBeUndefined(); // view strips raw
  });

  it('POST /corrections rejects an invalid kind', async () => {
    ledger = new CorrectionLedger({ dbPath: ':memory:', machineId: 't' });
    const app = appWith(ctxFor(stateDir, ledger));
    const res = await request(app).post('/corrections').set(auth()).set('X-Instar-Request', '1').send({ learning: 'x', kind: 'admin-override' });
    expect(res.status).toBe(400);
  });

  it('records an exact-key class-review shell before returning a correction and exposes scrubbed lifecycle state', async () => {
    ledger = new CorrectionLedger({ dbPath: ':memory:', machineId: 't' });
    const store = new ClassReviewStore({ dbPath: ':memory:', machineId: 't' });
    const engine = new CorrectionClassReview({ store, dryRun: false,
      intelligence: { evaluate: async () => {
        expect(store.list({ limit: 10 })).toEqual([expect.objectContaining({ fillState: 'pending' })]);
        return JSON.stringify({ standardReview: { verdict: 'covered', standardRef: 'Existing Standard', isPolicyRelaxation: false },
          processReview: { verdict: 'not-applicable' }, rationale: 'safe', confidence: 'high' });
      } } as any });
    const ctx = ctxFor(stateDir, ledger);
    ctx.classReviewStore = store; ctx.correctionClassReview = engine;
    const app = appWith(ctx);
    const created = await request(app).post('/corrections').set(auth()).set('X-Instar-Request', '1')
      .send({ learning: 'token=abcdefghijklmnop should not cross', kind: 'infra-gap' });
    expect(created.status).toBe(201);
    const rec = ledger.get(created.body.id)!;
    await vi.waitFor(() => expect(store.get(rec.dedupeKey)?.fillState).toBe('filled'));
    const listed = await request(app).get('/class-reviews').set(auth());
    expect(listed.status).toBe(200);
    expect(listed.body.records[0]).toMatchObject({ dedupeKey: rec.dedupeKey, reviewLifecycle: 'resolved' });
    expect(JSON.stringify(listed.body)).not.toContain('abcdefghijklmnop');
  });

  it('keeps outcome mutation operator-PIN bound and completion observation signal-only', async () => {
    ledger = new CorrectionLedger({ dbPath: ':memory:', machineId: 't' });
    const store = new ClassReviewStore({ dbPath: ':memory:', machineId: 't' });
    const rec = ledger.record({ kind: 'infra-gap', learning: 'x', scrubbedSummary: 'x', deterministicWeight: 3 })!;
    store.ensureShell({ dedupeKey: rec.dedupeKey, correctionId: rec.id, origin: 'operator-attributed' });
    store.fill(rec.dedupeKey, { standardReview: { verdict: 'needs-upgrade', standardRef: 'S', isPolicyRelaxation: false },
      processReview: { verdict: 'not-applicable' }, rationale: 'r', confidence: 'high' });
    const ctx = ctxFor(stateDir, ledger);
    (ctx.config as any).dashboardPin = '123456'; ctx.classReviewStore = store;
    const verifier = new CompletionClaimVerifier({ enabled: true, dryRun: true, stateDir,
      intelligence: { evaluate: async () => JSON.stringify({ clauses: [{ clauseId: 0,
        label: 'completed-or-in-progress-assertion', completionScope: 'this-turn',
        actionKind: 'pushed', target: 'feature', corroborated: false, rationale: 'missing evidence' }] }) } as any });
    ctx.completionClaimVerifier = verifier;
    const app = appWith(ctx);
    expect((await request(app).patch(`/class-reviews/${rec.dedupeKey}/outcome`).set(auth())
      .send({ arm: 'standard', outcome: 'ratified', pin: '000000' })).status).toBe(403);
    expect((await request(app).patch(`/class-reviews/${rec.dedupeKey}/outcome`).set(auth())
      .send({ arm: 'standard', outcome: 'ratified', pin: '123456' })).status).toBe(200);
    const observed = await request(app).post('/completion-claim/observe').set(auth()).set('X-Instar-Request', '1')
      .send({ message: 'I pushed feature', evidence: { hadToolCalls: false, toolCalls: [], truncated: false, unavailable: false, canaryOk: true } });
    expect(observed.status).toBe(202);
    expect(observed.body).toMatchObject({ observed: true, queued: true, blocked: false });
    await vi.waitFor(() => expect(verifier.readAudit()).toEqual([expect.objectContaining({ flagged: true })]));
  });

  it('pool completion audit proxies allowed peers and strips content and unknown fields', async () => {
    ledger = new CorrectionLedger({ dbPath: ':memory:', machineId: 't' });
    const ctx = ctxFor(stateDir, ledger);
    ctx.completionClaimVerifier = new CompletionClaimVerifier({ enabled: true, dryRun: true, stateDir });
    ctx.resolvePeerUrls = () => [{ machineId: 'peer-b', url: 'http://127.0.0.1:4044' }];
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ records: [{
      ts: '2026-07-19T00:00:00.000Z', evaluated: true, flagged: true, dryRun: true,
      verdict: 'uncorroborated', actionKind: 'pushed', hadToolCalls: false,
      message: 'SECRET COMPLETION PROSE', target: 'private-repository', injected: 'must-not-cross',
    }] }) }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      const response = await request(appWith(ctx)).get('/completion-claim/audit?scope=pool').set(auth());
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ scope: 'pool', pool: { peersQueried: 1, failed: [] } });
      expect(response.body.records).toContainEqual(expect.objectContaining({
        machineId: 'peer-b', remote: true, evaluated: true, flagged: true, actionKind: 'pushed',
      }));
      expect(JSON.stringify(response.body)).not.toContain('SECRET COMPLETION PROSE');
      expect(JSON.stringify(response.body)).not.toContain('private-repository');
      expect(JSON.stringify(response.body)).not.toContain('must-not-cross');
      expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/completion-claim/audit?limit='),
        expect.objectContaining({ headers: { Authorization: `Bearer ${AUTH}` } }));
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('applies the same exact correspondence predicate to correction-derived commitments', async () => {
    ledger = new CorrectionLedger({ dbPath: ':memory:', machineId: 't' });
    const store = new ClassReviewStore({ dbPath: ':memory:', machineId: 't' });
    const rec = ledger.record({ kind: 'infra-gap', learning: 'x', scrubbedSummary: 'x', deterministicWeight: 3 })!;
    const record = vi.fn((input: any) => ({ id: 'CMT-1', status: 'pending', ...input }));
    const ctx = ctxFor(stateDir, ledger); ctx.classReviewStore = store;
    ctx.commitmentTracker = { record } as any;
    (ctx.config.monitoring as any).correctionClassReview = { dryRun: false };
    const app = appWith(ctx);
    const body = { type: 'one-time-action', userRequest: 'fix it', agentResponse: 'I will fix it',
      topicId: 7, origin: 'correction', correctionId: rec.id, classReviewRef: rec.dedupeKey };
    const absent = await request(app).post('/commitments').set(auth()).send(body);
    expect(absent.status).toBe(409); expect(record).not.toHaveBeenCalled();
    store.ensureShell({ dedupeKey: rec.dedupeKey, correctionId: rec.id, origin: 'agent-self' });
    store.fill(rec.dedupeKey, { standardReview: { verdict: 'covered', standardRef: 'S', isPolicyRelaxation: false },
      processReview: { verdict: 'covered' }, rationale: 'r', confidence: 'high' });
    const admitted = await request(app).post('/commitments').set(auth()).send(body);
    expect(admitted.status).toBe(201);
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ correctionId: rec.id, classReviewRef: rec.dedupeKey }));
  });

  it('routes mixed clauses through one live arbiter and suppresses the parallel legacy sentinel only after admission', async () => {
    ledger = new CorrectionLedger({ dbPath: ':memory:', machineId: 't' });
    const record = vi.fn((input: any) => ({ id: 'CMT-mixed', status: 'pending', ...input }));
    const ctx = ctxFor(stateDir, ledger);
    (ctx.config.monitoring as any).completionClaimVerification = { enabled: true, dryRun: false };
    ctx.liveConfig = { get: (key: string, fallback: unknown) => key === 'actionClaim.enabled' ? true : fallback } as any;
    ctx.commitmentTracker = { record, getActive: () => [] } as any;
    const verifier = new CompletionClaimVerifier({ enabled: true, dryRun: false, stateDir,
      intelligence: { evaluate: async () => JSON.stringify({ clauses: [
        { clauseId: 0, label: 'completed-or-in-progress-assertion', completionScope: 'this-turn', actionKind: 'pushed', target: 'X', corroborated: false, rationale: 'no push' },
        { clauseId: 1, label: 'future-commitment', completionScope: 'none', actionKind: 'deployed', target: 'Y', corroborated: false, rationale: 'future' },
      ] }) } as any });
    ctx.completionClaimVerifier = verifier;
    const app = appWith(ctx);
    const message = 'I pushed X and I will deploy Y';
    const completion = await request(app).post('/completion-claim/observe').set(auth()).set('X-Instar-Request', '1')
      .send({ message, topicId: 7, evidence: { hadToolCalls: false, toolCalls: [], truncated: false, unavailable: false, canaryOk: true } });
    expect(completion.status).toBe(202);
    await vi.waitFor(() => expect(verifier.getRecentAuthoritativeArbitration(message)?.authoritative).toBe(true));
    const legacy = await request(app).post('/action-claim/observe').set(auth()).send({ message, topicId: 7 });
    expect(legacy.body).toMatchObject({ registered: false, reason: 'shared-arbiter-authoritative' });
    await vi.waitFor(() => expect(record).toHaveBeenCalledTimes(1));
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ userRequest: expect.stringContaining('deploy') }));
  });

  it('never suppresses legacy Action-Claim while arbitration is pending or failed', async () => {
    ledger = new CorrectionLedger({ dbPath: ':memory:', machineId: 't' });
    const record = vi.fn((input: any) => ({ id: `CMT-${record.mock.calls.length}`, status: 'pending', ...input }));
    const ctx = ctxFor(stateDir, ledger);
    (ctx.config.monitoring as any).completionClaimVerification = { enabled: true, dryRun: false };
    ctx.liveConfig = { get: (key: string, fallback: unknown) => key === 'actionClaim.enabled' ? true : fallback } as any;
    ctx.commitmentTracker = { record, getActive: () => [] } as any;
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    ctx.completionClaimVerifier = new CompletionClaimVerifier({ enabled: true, dryRun: false, stateDir,
      intelligence: { evaluate: async () => { await pending; throw new Error('provider failed'); } } as any });
    const app = appWith(ctx);
    const message = "I'm deploying it now; the branch is pushed";
    expect((await request(app).post('/completion-claim/observe').set(auth()).set('X-Instar-Request', '1')
      .send({ message, topicId: 7, evidence: { hadToolCalls: false, toolCalls: [], truncated: false, unavailable: false, canaryOk: true } })).status).toBe(202);

    const raced = await request(app).post('/action-claim/observe').set(auth()).send({ message, topicId: 7 });
    expect(raced.body.reason).not.toBe('shared-arbiter-authoritative');
    expect(record).toHaveBeenCalledTimes(1);
    release();
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(ctx.completionClaimVerifier.getRecentAuthoritativeArbitration(message)).toBeNull();
  });

  it('keeps deferred reviews parked with tracking and supports PIN-audited reopen/supersede', async () => {
    ledger = new CorrectionLedger({ dbPath: ':memory:', machineId: 't' });
    const store = new ClassReviewStore({ dbPath: ':memory:', machineId: 't' });
    const first = ledger.record({ kind: 'infra-gap', learning: 'one', scrubbedSummary: 'one', deterministicWeight: 3 })!;
    const second = ledger.record({ kind: 'infra-gap', learning: 'two', scrubbedSummary: 'two', deterministicWeight: 3 })!;
    for (const rec of [first, second]) {
      store.ensureShell({ dedupeKey: rec.dedupeKey, correctionId: rec.id, origin: 'operator-attributed' });
      store.fill(rec.dedupeKey, { semanticClassId: 'shared-class', standardReview: { verdict: 'needs-upgrade', standardRef: 'S', isPolicyRelaxation: false },
        processReview: { verdict: 'covered' }, rationale: 'r', confidence: 'high' });
    }
    const ctx = ctxFor(stateDir, ledger); ctx.classReviewStore = store;
    (ctx.config as any).dashboardPin = '123456';
    ctx.commitmentTracker = { record: vi.fn(() => ({ id: 'CMT-revisit' })) } as any;
    const app = appWith(ctx);
    const deferred = await request(app).patch(`/class-reviews/${first.dedupeKey}/outcome`).set(auth())
      .send({ arm: 'standard', outcome: 'deferred', pin: '123456' });
    expect(deferred.body).toMatchObject({ reviewLifecycle: 'parked', standardOutcome: 'deferred', deferredTrackingId: 'CMT-revisit' });
    const reopened = await request(app).patch(`/class-reviews/${first.dedupeKey}/lifecycle`).set(auth())
      .send({ action: 'reopen', reason: 'correction recurred', pin: '123456' });
    expect(reopened.body).toMatchObject({ reviewLifecycle: 'reopened', standardOutcome: 'proposed' });
    const superseded = await request(app).patch(`/class-reviews/${first.dedupeKey}/lifecycle`).set(auth())
      .send({ action: 'supersede', supersededBy: second.dedupeKey, reason: 'operator merged duplicate classes', pin: '123456' });
    expect(superseded.body).toMatchObject({ reviewLifecycle: 'superseded', supersededBy: second.dedupeKey,
      supersessionAudit: { actor: 'operator-pin', reason: 'operator merged duplicate classes' } });
  });

  it('pagination: limit caps the list and nextBefore is set when full', async () => {
    ledger = new CorrectionLedger({ dbPath: ':memory:', machineId: 't' });
    for (let i = 0; i < 5; i++) {
      ledger.record({ kind: 'user-preference', learning: `pref ${i}`, scrubbedSummary: `s${i}`, deterministicWeight: 3, detectedAt: `2026-05-0${i + 1}T10:00:00Z` });
    }
    const res = await request(appWith(ctxFor(stateDir, ledger))).get('/corrections?limit=2').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.records).toHaveLength(2);
    expect(res.body.nextBefore).toBeTruthy();
  });

  it('pagination: ?before is the keyset cursor — paging walks the full set without overlap', async () => {
    ledger = new CorrectionLedger({ dbPath: ':memory:', machineId: 't' });
    for (let i = 0; i < 5; i++) {
      ledger.record({ kind: 'user-preference', learning: `pref ${i}`, scrubbedSummary: `s${i}`, deterministicWeight: 3, detectedAt: `2026-05-0${i + 1}T10:00:00Z` });
    }
    const app = appWith(ctxFor(stateDir, ledger));
    const page1 = await request(app).get('/corrections?limit=2').set(auth());
    expect(page1.body.records).toHaveLength(2);
    const cursor = page1.body.nextBefore;
    const page2 = await request(app).get(`/corrections?limit=2&before=${encodeURIComponent(cursor)}`).set(auth());
    expect(page2.status).toBe(200);
    expect(page2.body.records).toHaveLength(2);
    // No overlap between pages.
    const ids1 = page1.body.records.map((r: any) => r.id);
    const ids2 = page2.body.records.map((r: any) => r.id);
    expect(ids1.some((id: string) => ids2.includes(id))).toBe(false);
  });

  it('pagination: ?since lower-bounds detected_at (records older than since excluded)', async () => {
    ledger = new CorrectionLedger({ dbPath: ':memory:', machineId: 't' });
    for (let i = 0; i < 5; i++) {
      ledger.record({ kind: 'user-preference', learning: `pref ${i}`, scrubbedSummary: `s${i}`, deterministicWeight: 3, detectedAt: `2026-05-0${i + 1}T10:00:00Z` });
    }
    // since = 2026-05-03 → only 05-03, 05-04, 05-05 remain (3 records).
    const res = await request(appWith(ctxFor(stateDir, ledger))).get('/corrections?since=2026-05-03T00:00:00Z').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.records).toHaveLength(3);
    for (const r of res.body.records) {
      expect(Date.parse(r.detectedAt)).toBeGreaterThanOrEqual(Date.parse('2026-05-03T00:00:00Z'));
    }
  });

  it('pagination: a malformed ?since / ?before is tolerated (ignored, never a 500)', async () => {
    ledger = new CorrectionLedger({ dbPath: ':memory:', machineId: 't' });
    ledger.record({ kind: 'user-preference', learning: 'p', scrubbedSummary: 's', deterministicWeight: 3 });
    const res = await request(appWith(ctxFor(stateDir, ledger))).get('/corrections?since=not-a-date&before=garbage').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.records).toHaveLength(1); // both params ignored → full set
  });

  describe('/health does NOT serialize the ephemeral capture ring', () => {
    it('the /health response shape contains no captured turn text', async () => {
      ledger = new CorrectionLedger({ dbPath: ':memory:', machineId: 't' });
      // Even with a record present, /health must not embed any raw learning OR
      // any capture-ring contents. The ring is in-process only; it is never on
      // the RouteContext, so it cannot reach /health by construction.
      ledger.record({ kind: 'user-preference', learning: 'RING-SECRET-SHOULD-NEVER-APPEAR', scrubbedSummary: 's', deterministicWeight: 3 });
      const res = await request(appWith(ctxFor(stateDir, ledger))).get('/health').set(auth());
      const serialized = JSON.stringify(res.body);
      expect(serialized).not.toContain('RING-SECRET-SHOULD-NEVER-APPEAR');
      expect(serialized).not.toContain('captureRing');
      expect(serialized).not.toContain('capture_ring');
    });
  });

  describe('capture-backlog drain surfaces a throttled capture on /corrections (full pipeline)', () => {
    it('a drained backlog entry becomes a record served over the real /corrections route', async () => {
      // The SAME ledger handle the route reads from, fed by a sibling backlog.
      ledger = new CorrectionLedger({ dbPath: ':memory:', machineId: 't' });
      const backlog = new CorrectionCaptureBacklog({ dbPath: ':memory:' });
      try {
        // A capture that was throttled at distill time sits in the backlog.
        backlog.enqueue({
          topicId: 11,
          turns: [{ fromUser: true, text: 'lead with the action, skip the preamble', at: 0 }],
          deterministicWeight: 4,
        });
        // Headroom: drainBacklog distills it into the ledger the route serves.
        const distill = async () =>
          JSON.stringify({
            learning: 'lead with the action; skip the preamble',
            kind: 'user-preference',
            llm_confidence: 0.9,
            scrubbed_summary: 'Prefers the action first, no preamble.',
          });
        const result = await drainBacklog({ backlog, ledger, distill, llmAvailable: () => true }, 5);
        expect(result.recorded).toBe(1);
        expect(backlog.count()).toBe(0);

        // Observable through the full HTTP pipeline (auth + real route).
        const res = await request(appWith(ctxFor(stateDir, ledger))).get('/corrections').set(auth());
        expect(res.status).toBe(200);
        expect(res.body.records.length).toBe(1);
        expect(res.body.records[0].kind).toBe('user-preference');
        expect(res.body.records[0].scrubbedSummary).toContain('action first');
        // Raw distilled learning never crosses HTTP.
        expect(JSON.stringify(res.body)).not.toContain('skip the preamble');
        expect(res.body.records[0].learning).toBeUndefined();
      } finally {
        backlog.close();
      }
    });
  });
});
