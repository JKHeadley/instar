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
import { createMaturationBoardRoutes } from '../../src/server/maturationBoardRoutes.js';
import { validMeasurementRead } from '../../src/server/measurementDetailRead.js';
import { readMeasurementCoverage } from '../../src/server/measurementCoverageRead.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const roots: string[] = []; const services: BlockerLifecycleService[] = [];
afterEach(() => { services.splice(0).forEach(s => s.close()); roots.splice(0).forEach(r => SafeFsExecutor.safeRmSync(r, { recursive: true, force: true, operation: 'maturation-outcome-route.test' })); });
const now = Date.parse('2026-11-05T12:00:00Z'); const at = now - 86_400_000;
const metric = { id: 'quality', source: 'feature-summary' as const, sourceRef: 'context-recovery.successful-recoveries', direction: 'at-least' as const, threshold: 5, minSamples: 20 };
const outcome = { statement: 'More successful recoveries with checked outcomes', owner: 'recovery-owner', method: 'Recorded recovery outcomes', version: 'v1', outcomeMetricIds: ['quality'], qualityMetricIds: ['quality'], baseline: { origin: 'local', points: [{ id: 'quality', observedAtMs: at, descriptorVersion: 1, value: 4, samples: 40 }] } };
const contract = { cadenceHours: 6, evidenceMaxAgeHours: 12, metrics: [metric], outcome };
function setup(clock = () => now) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'outcome-route-')); roots.push(root);
  const ledger = new BlockerLifecycleLedger({ dbPath: path.join(root, 'metrics.db'), now: clock });
  const tracker = Object.assign(new EventEmitter(), { getAll: () => [], getBlockerEpisodeDropBuckets: () => ({}) }) as never;
  const svc = new BlockerLifecycleService(tracker, ledger, 'local', clock); services.push(svc);
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

  it('real activity reaches the selected-origin numeric detail with baseline, quality roles and versioned history', async () => {
    const realNow=Date.now();let time=realNow-6*3600000;let value=5;
    const {root,ledger,svc}=setup(()=>time);
    ledger.recordMaturationObservation({ origin:'local',featureId:'one',metricId:metric.id,source:metric.source,sourceRef:metric.sourceRef,observedAtMs:at,value:4,samples:40 });
    svc.registerMaturationProjection(metric.sourceRef,()=>({value,samples:40}));
    const ini={id:'one',title:'Recovery',status:'active',rollout:{flagPath:'monitoring.one',stage:'live',maturationEvaluation:contract}} as Initiative;
    svc.evaluateMaturation([ini]);time=realNow;value=7;svc.evaluateMaturation([ini]);
    const ctx={config:{projectName:'test',stateDir:root,developmentAgent:true},meshSelfId:'local',initiativeTracker:{list:()=>[ini]},blockerLifecycleService:svc} as never;
    const app=express().use(authMiddleware(()=>'test','test')).use(createMaturationBoardRoutes(ctx));
    const response=await request(app).get('/maturation/board?part=measurement&subject=one&machine=local').set('Authorization','Bearer test').set('X-Instar-AgentId','test');
    expect(response.status).toBe(200);const read=response.body;
    expect(validMeasurementRead(read,'local','one',90,Date.now())).toBe(true);
    expect(read.detail.evidence).toMatchObject({state:'verified',metrics:[{delta:3,baseline:{value:4},current:{value:7,samples:40}}]});
    const m=read.detail.metrics[0];expect(m).toMatchObject({outcome:true,qualityGuard:true,total:3,omitted:0});
    expect(m.series[0].points.map((p:{value:number})=>p.value)).toEqual([4,5,7]);
    expect(m.series[0].points.map((p:{joinPrevious:boolean})=>p.joinPrevious)).toEqual([false,false,true]);
    expect((await request(app).get('/maturation/board?part=measurement&subject=bad.path').set('Authorization','Bearer test')).status).toBe(400);
  });

  it('coverage reads the edited owner baseline rather than proof from the previous D7 contract', () => {
    const { ledger, svc } = setup();
    ledger.recordMaturationObservation({ origin: 'local', featureId: 'one', metricId: metric.id, source: metric.source, sourceRef: metric.sourceRef, observedAtMs: at, value: 4, samples: 40 });
    svc.registerMaturationProjection(metric.sourceRef, () => ({ value: 6, samples: 40 }));
    const ini = { id: 'one', title: 'One', status: 'active', rollout: { flagPath: 'newFeature.enabled', stage: 'live', maturationEvaluation: contract } } as Initiative;
    svc.evaluateMaturation([ini]);
    expect(svc.maturationOutcome('one').evidence.state).toBe('verified');
    const edited = { ...contract, outcome: { ...outcome, version: 'v2', baseline: { ...outcome.baseline, points: [{ ...outcome.baseline.points[0], value: 999 }] } } };
    const current = { ...ini, rollout: { ...ini.rollout!, maturationEvaluation: edited } };
    const coverage = readMeasurementCoverage({ config: { newFeature: { enabled: true } }, meshSelfId: 'local',
      initiativeTracker: { list: () => [current] }, blockerLifecycleService: svc } as never, now);
    expect(coverage.rows.find(r => r.kind === 'feature' && r.id === 'newFeature')).toMatchObject({ declaration: 'declared', state: 'incompatible' });
    expect(svc.maturationOutcome('one').evidence.state).toBe('verified');
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
