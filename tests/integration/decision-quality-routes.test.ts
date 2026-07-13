import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { createRoutes, type RouteContext } from '../../src/server/routes.js';
import { authMiddleware } from '../../src/server/middleware.js';
import { FeatureMetricsLedger } from '../../src/monitoring/FeatureMetricsLedger.js';
import {
  ExternalHogDecisionStore,
  HOG_SUSTAINED_RIGHT_RULE_ID,
  type HogEvidenceScanView,
} from '../../src/monitoring/ExternalHogDecisionStore.js';
import type { HogDecisionSeed } from '../../src/monitoring/ExternalHogScanTick.js';
import { DP_EXTERNAL_HOG_KILL_LEAVE } from '../../src/data/provenanceCoverage.js';
import {
  DecisionQualityRecorderImpl,
  installDecisionQualityRecorder,
} from '../../src/core/DecisionQualityRecorderImpl.js';
import { _resetDecisionQualityForTest } from '../../src/core/decisionQualityTypes.js';

/**
 * Integration tests for GET /decision-quality + POST /decision-quality/grade-pass
 * (llm-decision-quality-meter §5.5) behind the REAL Express routes + authMiddleware.
 * Covers: 200-with-data, 503-when-dark, Bearer required, ?scope=pool field
 * allowlist (a hostile peer row's extras — incl. contextFull — are stripped),
 * and grade-pass idempotency (re-run converges, never multiplies).
 */

const AUTH = 'test-decision-quality';
const HOUR = 60 * 60 * 1000;
let ledger: FeatureMetricsLedger | null = null;
let tmpDir: string | null = null;

function ctxWith(opts: {
  ledger: FeatureMetricsLedger | null;
  developmentAgent?: boolean;
  peers?: Array<{ machineId: string; url: string }>;
  hogStore?: ExternalHogDecisionStore | null;
}): RouteContext {
  return {
    config: {
      projectName: 'test', projectDir: '/tmp', stateDir: tmpDir ?? '/tmp/.instar', port: 0, authToken: AUTH,
      developmentAgent: opts.developmentAgent ?? false,
      provenance: { uniformSeam: { dryRun: false } },
      sessions: {} as any, scheduler: {} as any,
    } as any,
    sessionManager: { listRunningSessions: () => [] } as any,
    state: { getJobState: () => null, getSession: () => null } as any,
    featureMetricsLedger: opts.ledger,
    externalHogSentinel: opts.hogStore ? ({ decisionStoreRef: () => opts.hogStore } as any) : undefined,
    resolvePeerUrls: opts.peers ? () => opts.peers! : undefined,
    startTime: new Date(),
  } as unknown as RouteContext;
}

function appWith(ctx: RouteContext): express.Express {
  const app = express();
  app.use(express.json());
  app.use(authMiddleware(() => AUTH, 'test'));
  app.use('/', createRoutes(ctx));
  return app;
}

function killSeed(over: Partial<HogDecisionSeed> = {}): HogDecisionSeed {
  return {
    ledgerKey: 'vscode-exthost:hashA', classId: 'vscode-exthost', commandHash: 'hashA',
    verdict: 'kill', enacted: 'killed', correlationId: 'd-kill-1',
    targetTuple: { pid: 900, startTimeMs: Date.now() - 10 * HOUR }, ownerTuple: { parentPid: 400 },
    floorPermitted: true, ...over,
  };
}
const emptyView = (): HogEvidenceScanView => ({ candidates: [], aliveStartTimeMs: () => undefined });

afterEach(() => {
  ledger?.close();
  ledger = null;
  installDecisionQualityRecorder(null);
  _resetDecisionQualityForTest();
  vi.unstubAllGlobals();
  if (tmpDir) { SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/integration/decision-quality-routes.test.ts' }); tmpDir = null; }
});

describe('GET /decision-quality (integration)', () => {
  it('returns 401 without a bearer token', async () => {
    ledger = new FeatureMetricsLedger({ dbPath: ':memory:' });
    const res = await request(appWith(ctxWith({ ledger, developmentAgent: true }))).get('/decision-quality');
    expect(res.status).toBe(401);
  });

  it('returns 503 when the seam is dark (not a development agent, no explicit enable)', async () => {
    ledger = new FeatureMetricsLedger({ dbPath: ':memory:' });
    const res = await request(appWith(ctxWith({ ledger, developmentAgent: false })))
      .get('/decision-quality').set('Authorization', `Bearer ${AUTH}`);
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/seam is off/i);
  });

  it('returns 200 with per-point grade distribution + census debt + rejection counters', async () => {
    ledger = new FeatureMetricsLedger({ dbPath: ':memory:' });
    const now = Date.now();
    ledger.recordDecision({ correlationId: 'd-1', decisionPoint: DP_EXTERNAL_HOG_KILL_LEAVE, feature: 'ExternalHogClassifier', ts: now - 1000, model: 'gpt-5.5', framework: 'codex-cli', promptId: 'hog-v1' });
    ledger.upsertOutcome({
      correlationId: 'd-1', gradedBy: 'DecisionGrading', ruleId: HOG_SUSTAINED_RIGHT_RULE_ID,
      rung: 'deterministic-ground-truth', evidenceStrength: 'negative-evidence', grade: 'right', ts: now,
    });

    const res = await request(appWith(ctxWith({ ledger, developmentAgent: true })))
      .get('/decision-quality?sinceHours=24').set('Authorization', `Bearer ${AUTH}`);

    expect(res.status).toBe(200);
    expect(res.body.gate.enabled).toBe(true);
    const point = (res.body.points as Array<any>).find((p) => p.decisionPoint === DP_EXTERNAL_HOG_KILL_LEAVE);
    expect(point).toBeTruthy();
    expect(point.decisions).toBe(1);
    expect(point.gradeDistribution.right).toBe(1);
    // Strength-first aggregate is present and segments proof-like vs heuristic.
    expect(point.byStrength['negative-evidence'].right).toBe(1);
    expect(point.byRule[HOG_SUSTAINED_RIGHT_RULE_ID].right).toBe(1);
    expect(point.attribution.models).toContain('gpt-5.5');
    expect(point.insufficientEvidence).toBe(true); // 1 < minSampleForRates(20)
    expect(res.body.censusDebt.wired).toBeGreaterThanOrEqual(3);
    expect(res.body.rejections).toEqual({ enumInvalid: 0, rungMismatch: 0, ownerMismatch: 0, unknownDecisionPoint: 0 });
    // evidence_note is NEVER served by this route.
    expect(JSON.stringify(res.body)).not.toMatch(/evidence_note|evidenceNote/);
  });

  it('?scope=pool strips a hostile peer row down to the FIELD ALLOWLIST (contextFull + extras removed)', async () => {
    ledger = new FeatureMetricsLedger({ dbPath: ':memory:' });
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      json: async () => ({
        points: [{
          decisionPoint: 'external-hog-kill-leave',
          decisions: 3,
          gradeDistribution: { right: 2, wrong: 0, unknown: 1, expired: 0 },
          // hostile extras a peer must NOT be able to smuggle back through the merge:
          contextFull: 'SECRET-TRANSCRIPT-BODY',
          evilField: 'should-be-stripped',
          __proto__pollution: true,
        }],
      }),
    }));
    const res = await request(appWith(ctxWith({
      ledger, developmentAgent: true,
      peers: [{ machineId: 'peer-1', url: 'http://127.0.0.1:9099' }],
    }))).get('/decision-quality?scope=pool').set('Authorization', `Bearer ${AUTH}`);

    expect(res.status).toBe(200);
    expect(res.body.scope).toBe('pool');
    expect(res.body.pool.peersQueried).toBe(1);
    const remote = res.body.remotePoints as Array<any>;
    expect(remote).toHaveLength(1);
    expect(remote[0].decisionPoint).toBe('external-hog-kill-leave');
    expect(remote[0].decisions).toBe(3);
    expect(remote[0].machineId).toBe('peer-1');
    expect(remote[0].remote).toBe(true);
    // The allowlist stripped every non-allowlisted field.
    expect(remote[0].contextFull).toBeUndefined();
    expect(remote[0].evilField).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toMatch(/SECRET-TRANSCRIPT-BODY|should-be-stripped/);
  });

  it('?scope=pool records a non-allowlisted peer URL as pool.failed (Bearer never travels there)', async () => {
    ledger = new FeatureMetricsLedger({ dbPath: ':memory:' });
    const fetchSpy = vi.fn(async () => ({ ok: true, json: async () => ({ points: [] }) }));
    vi.stubGlobal('fetch', fetchSpy);
    const res = await request(appWith(ctxWith({
      ledger, developmentAgent: true,
      peers: [{ machineId: 'peer-evil', url: 'http://evil.example.com/x' }], // public host over http → rejected
    }))).get('/decision-quality?scope=pool').set('Authorization', `Bearer ${AUTH}`);
    expect(res.status).toBe(200);
    expect(res.body.pool.failed).toEqual([{ machineId: 'peer-evil', error: 'url-rejected' }]);
    expect(fetchSpy).not.toHaveBeenCalled(); // no outbound request to a non-allowlisted URL
  });
});

describe('POST /decision-quality/grade-pass (integration)', () => {
  it('returns 503 when the seam is dark', async () => {
    ledger = new FeatureMetricsLedger({ dbPath: ':memory:' });
    const res = await request(appWith(ctxWith({ ledger, developmentAgent: false })))
      .post('/decision-quality/grade-pass').set('Authorization', `Bearer ${AUTH}`).send({});
    expect(res.status).toBe(503);
  });

  it('grades a matured kill and CONVERGES on re-run (idempotent — never multiplies)', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dq-grade-pass-int-'));
    ledger = new FeatureMetricsLedger({ dbPath: ':memory:' });
    // Live recorder wired to the SAME ledger so the route's annotate chokepoint writes durably.
    installDecisionQualityRecorder(new DecisionQualityRecorderImpl({
      ledger, config: { developmentAgent: true, provenance: { uniformSeam: { enabled: true, dryRun: false } } },
    }));
    // A hog kill whose window has already closed relative to real Date.now().
    const past = Date.now() - 8 * HOUR;
    const store = new ExternalHogDecisionStore({
      stateDir: tmpDir,
      config: { provenance: { quality: { evidenceWindowHours: 6, gradingSlackHours: 2 } } },
      killLedgerBreakerWindowMs: HOUR,
      nowMs: () => past,
    });
    store.record(killSeed({ correlationId: 'd-kill-int', ledgerKey: 'k1', commandHash: 'h1' }), emptyView());
    ledger.recordDecision({ correlationId: 'd-kill-int', decisionPoint: DP_EXTERNAL_HOG_KILL_LEAVE, ts: past });

    const ctx = ctxWith({ ledger, developmentAgent: true, hogStore: store });
    const app = appWith(ctx);

    const r1 = await request(app).post('/decision-quality/grade-pass').set('Authorization', `Bearer ${AUTH}`).send({});
    expect(r1.status).toBe(200);
    expect(r1.body.graded).toBe(1);
    expect(r1.body.byRule[HOG_SUSTAINED_RIGHT_RULE_ID]).toBe(1);
    expect(r1.body.cursors[DP_EXTERNAL_HOG_KILL_LEAVE]).toBeTruthy();

    const r2 = await request(app).post('/decision-quality/grade-pass').set('Authorization', `Bearer ${AUTH}`).send({});
    expect(r2.status).toBe(200);
    expect(r2.body.graded).toBe(0); // converged — the cursor advanced past the graded row

    // The decision reads as exactly one `right` grade — never multiplied.
    expect(ledger.getWinningGrades(['d-kill-int'])[0]?.grade).toBe('right');
  });
});
