import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { BlockerLifecycleLedger } from '../../src/monitoring/BlockerLifecycleLedger.js';
import { BlockerLifecycleService } from '../../src/monitoring/BlockerLifecycleService.js';
import { InitiativeTracker, type Initiative } from '../../src/core/InitiativeTracker.js';
import { FeatureRolloutReconciler } from '../../src/core/FeatureRolloutReconciler.js';
import { scanSpecArtifacts } from '../../src/core/featureRolloutScan.js';
import { createRoutes, type RouteContext } from '../../src/server/routes.js';
import { authMiddleware } from '../../src/server/middleware.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const roots: string[] = []; const services: BlockerLifecycleService[] = [];
afterEach(() => { services.splice(0).forEach(s => s.close()); roots.splice(0).forEach(r => SafeFsExecutor.safeRmSync(r, { recursive: true, force: true, operation: 'maturation-outcome-route.test' })); });
const now = Date.parse('2026-11-05T12:00:00Z'); const at = now - 86_400_000;
const metric = { id: 'quality', source: 'feature-summary' as const, sourceRef: 'context-recovery.successful-recoveries', direction: 'at-least' as const, threshold: 5, minSamples: 20 };
const outcome = { statement: 'More successful recoveries with checked outcomes', owner: 'recovery-owner', method: 'Recorded recovery outcomes', version: 'v1', outcomeMetricIds: ['quality'], qualityMetricIds: ['quality'], baseline: { origin: 'local', points: [{ id: 'quality', observedAtMs: at, descriptorVersion: 1, value: 4, samples: 40 }] } };
const contract = { cadenceHours: 6, evidenceMaxAgeHours: 12, metrics: [metric], outcome };
function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'outcome-route-')); roots.push(root);
  const ledger = new BlockerLifecycleLedger({ dbPath: path.join(root, 'metrics.db'), now: () => now });
  const tracker = Object.assign(new EventEmitter(), { getAll: () => [], getBlockerEpisodeDropBuckets: () => ({}) }) as never;
  const svc = new BlockerLifecycleService(tracker, ledger, 'local', () => now); services.push(svc);
  const ctx = { config: { projectName: 'test', projectDir: root, stateDir: root, port: 0, authToken: 'test', sessions: {}, scheduler: {} }, sessionManager: { listRunningSessions: () => [] }, state: { getJobState: () => null, getSession: () => null }, blockerLifecycleService: svc, resolvePeerUrls: () => [], startTime: new Date() } as unknown as RouteContext;
  const app = express(); app.use(express.json(), authMiddleware(() => 'test', 'test')); app.use('/', createRoutes(ctx));
  return { root, ledger, svc, app };
}

describe('existing maturation read carries outcome proof', () => {
  it('reads real recorded baseline/current evidence through the authenticated existing route', async () => {
    const { ledger, svc, app } = setup();
    ledger.recordMaturationObservation({ origin: 'local', featureId: 'one', metricId: metric.id, source: metric.source, sourceRef: metric.sourceRef, observedAtMs: at, value: 4, samples: 40 });
    svc.registerMaturationProjection(metric.sourceRef, () => ({ value: 6, samples: 40 }));
    svc.evaluateMaturation([{ id: 'one', rollout: { flagPath: 'monitoring.one', stage: 'live', maturationEvaluation: contract } }] as Initiative[]);
    const res = await request(app).get('/blocker-lifecycle/summary?feature=one').set('Authorization', 'Bearer test');
    expect(res.status).toBe(200);
    const m = res.body.origins[0].maturation;
    expect(m.outcomeContracts).toEqual({ scope: 'current-d7-subjects', subjects: 1, declared: 1, missing: 0, invalid: 0 });
    expect(m.outcomeDetail).toMatchObject({ featureId: 'one', subjectKnown: true, evidence: { state: 'verified', owner: 'recovery-owner', metrics: [{ delta: 2, baseline: { samples: 40 }, current: { samples: 40 } }] } });
    expect((await request(app).get('/blocker-lifecycle/summary?feature=bad.path').set('Authorization', 'Bearer test')).status).toBe(400);
  });

  it('preserves malformed scanner metadata through legacy reconciliation instead of calling it missing', async () => {
    const { root, svc, app } = setup();
    fs.mkdirSync(path.join(root, 'docs/specs'), { recursive: true }); fs.mkdirSync(path.join(root, '.instar/instar-dev-traces'), { recursive: true });
    const file = path.join(root, 'docs/specs/one.md');
    const prefix = '---\napproved: true\nships-staged: true\nrollout-flag-path: monitoring.one\n';
    fs.writeFileSync(file, prefix + 'rollout-metrics-json: ' + JSON.stringify({ ...contract, outcome: { ...outcome, owner: '' } }) + '\n---\n# One');
    fs.writeFileSync(path.join(root, '.instar/instar-dev-traces/one.json'), JSON.stringify({ phase: 'complete', specPath: 'docs/specs/one.md', prNumber: 1, createdAt: new Date(now).toISOString() }));
    const tracker = new InitiativeTracker(root);
    const reconciler = new FeatureRolloutReconciler({ tracker, listSpecArtifacts: () => scanSpecArtifacts(root, () => now), observeFlag: () => ({ flagEnabled: true, flagDryRun: false }) });
    await reconciler.reconcile(); svc.evaluateMaturation(tracker.list());
    const res = await request(app).get('/blocker-lifecycle/summary?feature=one').set('Authorization', 'Bearer test');
    expect(res.body.origins[0].maturation).toMatchObject({ outcomeContracts: { invalid: 1, missing: 0 }, outcomeDetail: { evidence: { state: 'invalid-contract' } } });
    expect(tracker.get('one')?.rollout?.maturationContractError).toBe('invalid-shape');
    fs.writeFileSync(file, prefix + '---\n# One');
    await reconciler.reconcile();
    expect(tracker.get('one')?.rollout?.maturationContractError).toBeUndefined();
    svc.evaluateMaturation(tracker.list());
    expect((svc.localSummary(24).maturation as Record<string, unknown>).outcomeContracts).toMatchObject({ missing: 1, invalid: 0 });
  });
});
