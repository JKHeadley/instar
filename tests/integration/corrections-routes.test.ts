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
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRoutes } from '../../src/server/routes.js';
import type { RouteContext } from '../../src/server/routes.js';
import { authMiddleware } from '../../src/server/middleware.js';
import { CorrectionLedger } from '../../src/monitoring/CorrectionLedger.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

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
});
