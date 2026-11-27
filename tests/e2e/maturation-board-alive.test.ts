/** Production-path proof (docs/specs/maturation-board.md): AgentServer mounts
 * GET /maturation/board behind the development-agent gate, reads real review
 * files from the project dir, and hands the board the SAME dark-flag registry
 * instance the growth analyst owns (wiring integrity: not null, not a stub). */
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { CommitmentTracker } from '../../src/monitoring/CommitmentTracker.js';
import { BlockerLifecycleLedger } from '../../src/monitoring/BlockerLifecycleLedger.js';
import { CapabilityRegistryWriter } from '../../src/core/CapabilityRegistry.js';
import { FeatureMetricsLedger } from '../../src/monitoring/FeatureMetricsLedger.js';
import type { BlockerLifecycleService } from '../../src/monitoring/BlockerLifecycleService.js';
import { measurementSourceRef,type GenericMeasurementContract } from '../../src/monitoring/MeasurementSubject.js';
import { subjectFromId } from '../../src/monitoring/MaturationLadder.js';
import { PROVENANCE_COVERAGE } from '../../src/data/provenanceCoverage.js';
import { validMeasurementRead } from '../../src/server/measurementDetailRead.js';
import { StateManager } from '../../src/core/StateManager.js';
import { InitiativeTracker } from '../../src/core/InitiativeTracker.js';
import { createMockSessionManager } from '../helpers/setup.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { InstarConfig } from '../../src/core/types.js';

const servers: AgentServer[] = [];
const dirs: string[] = [];

async function boot(developmentAgent: boolean, measurement=false, retainedOwner?: { id: string; liveConfig: Record<string, unknown> }, authToken?: string) {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'mb-e2e-'));
  dirs.push(dir);
  const stateDir = path.join(dir, '.instar');
  for (const d of ['state/sessions', 'state/jobs', 'logs']) fs.mkdirSync(path.join(stateDir, d), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify(retainedOwner?.liveConfig ?? {}));
  if (retainedOwner) fs.writeFileSync(path.join(stateDir, 'initiatives.json'), JSON.stringify({ initiatives: [{ id: retainedOwner.id, title: 'Malformed retained owner', kind: 'task', schemaVersion: 1, status: 'active', measurement: {}, phases: [] }] }));
  const reviews = path.join(dir, 'docs/research/feature-maturation/reviews');
  fs.mkdirSync(reviews, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  fs.writeFileSync(path.join(reviews, `${date}.json`), JSON.stringify({
    schema: 'maturation-review/1', date,
    features: [{ id: 'monitoring.example', title: 'Example', verdict: 'stalled', evidence: 'no runs this week', evidenceReadToday: true, commitments: [] }],
  }));
  const config: InstarConfig = {
    projectName: 'mb-e2e', projectDir: dir, stateDir, port: 0,
    ...(authToken ? { authToken } : {}),
    developmentAgent,
    sessions: { claudePath: '/usr/bin/echo', maxSessions: 1, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5_000 },
    scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 }, messaging: [], updates: {},
    monitoring: { growthAnalyst: { enabled: true } } as InstarConfig['monitoring'],
  };
  const sessionManager = createMockSessionManager() as any;
  sessionManager.on = () => undefined;
  const initiatives=new InitiativeTracker(stateDir);
  const server = new AgentServer({ config, sessionManager, state: new StateManager(stateDir), initiativeTracker:initiatives,...(measurement?{commitmentTracker:new CommitmentTracker({stateDir})}:{}) });
  servers.push(server);
  await new Promise((resolve) => setTimeout(resolve, 30));
  return { server, date, stateDir, initiatives };
}

afterAll(async () => {
  for (const s of servers) await s.stop();
  for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/e2e/maturation-board-alive.test.ts' });
});

describe('maturation board — production wiring', () => {
  it('includes real commitment owner records in the census without sharing their conversation text', async () => {
    const { server } = await boot(true, true, undefined, 'commitment-census-test');
    const privateRequest = 'Private commitment census fixture';
    const privateResponse = 'Private response retained only by its existing owner';
    expect((await request(server.getApp()).get('/maturation/board?part=coverage')).status).toBe(401);
    const created = await request(server.getApp()).post('/commitments').set('Authorization', 'Bearer commitment-census-test').send({
      type: 'one-time-action', userRequest: privateRequest, agentResponse: privateResponse,
      owner: 'user', blockedOn: 'none', verificationMethod: 'manual',
      followThroughOptOutReason: 'Isolated test fixture; no user delivery required',
    });
    expect(created.status).toBe(201);
    const coverage = await request(server.getApp()).get('/maturation/board?part=coverage').set('Authorization', 'Bearer commitment-census-test');
    expect(coverage.status).toBe(200);
    expect(coverage.body.sources).toContainEqual({ name: 'commitment-tracker', ok: true });
    const id = `commitment:${JSON.stringify([created.body.originMachineId ?? coverage.body.origin, created.body.id])}`;
    expect(coverage.body.rows.find((r: { id: string }) => r.id === id)).toMatchObject({
      kind: 'effort', title: `Commitment ${created.body.id}`, posture: 'pending',
      sources: ['commitment-tracker'], subjects: [], state: 'not-linked',
    });
    expect(JSON.stringify(coverage.body)).not.toContain(privateRequest);
    expect(JSON.stringify(coverage.body)).not.toContain(privateResponse);
    const ownerRead = await request(server.getApp()).get('/commitments').set('Authorization', 'Bearer commitment-census-test');
    expect(ownerRead.body.commitments.find((r: { id: string }) => r.id === created.body.id)).toMatchObject({ userRequest: privateRequest, agentResponse: privateResponse });
  });

  it('is alive on a development agent: 200, real review rows, advisory, registry wired', async () => {
    const { server, date } = await boot(true);
    const res = await request(server.getApp()).get('/maturation/board');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ schema: 'maturation-board/1', advisory: true, authority: 'none', reviewDate: date, reviewState: 'ok' });
    expect(res.body.features[0]).toMatchObject({ id: 'monitoring.example', review: { verdict: 'stalled' } });
    // Wiring integrity: the hoisted registry reached the route. "registry-not-running"
    // would mean the route got null instead of the analyst's instance.
    const df = res.body.sources.find((s: { name: string }) => s.name === 'dark-flag');
    expect(df).toBeDefined();
    expect(df.reason).not.toBe('registry-not-running');
    // The console tile probe answers.
    const probe = await request(server.getApp()).get('/maturation/board?part=probe');
    expect(probe.status).toBe(200);
    const coverage = await request(server.getApp()).get('/maturation/board?part=coverage');
    expect(coverage.status).toBe(200);
    expect(coverage.body.schema).toBe('measurement-coverage/1');
    expect(coverage.body.counts.feature.total).toBeGreaterThan(0);
    expect(coverage.body.counts.decision.total).toBeGreaterThan(0);
    expect(coverage.body.sources).toContainEqual(expect.objectContaining({ name: 'loaded-scheduler-jobs', ok: false }));
    const script=await request(server.getApp()).get('/dashboard/console/measurement-trend.js');
    expect(script.status).toBe(200);expect(script.text).toContain('export function measurementDetail');
  });

  it('real winning grades reach generic evaluation and the selected-origin visual data through production readers',async()=>{
    const {server,stateDir,initiatives}=await boot(true,true);const now=Date.now(),at=now-6*3600000,point=PROVENANCE_COVERAGE[0].decisionPoint;
    const c:GenericMeasurementContract={subject:{kind:'effort',key:'whole-quality'},adapter:{kind:'decision-quality',decisionPoint:point,ruleId:'test-grade-v1',rung:'deterministic-ground-truth',evidenceStrength:'deterministic-proof',windowHours:24,rightRateMetricId:'right-rate',unmatchedShareMetricId:'unmatched'},cadenceHours:6,evidenceMaxAgeHours:12,metrics:[{id:'right-rate',source:'feature-summary',sourceRef:'',direction:'at-least',threshold:.8,minSamples:10},{id:'unmatched',source:'feature-summary',sourceRef:'',direction:'at-most',threshold:.1,minSamples:10}],outcome:{statement:'Better checked decisions',owner:'Echo',method:'Canonical local winning grades',version:'v1',outcomeMetricIds:['right-rate'],qualityMetricIds:['unmatched'],baseline:{origin:'mb-e2e',points:[{id:'right-rate',observedAtMs:at,descriptorVersion:1,value:.8,samples:90},{id:'unmatched',observedAtMs:at,descriptorVersion:1,value:.1,samples:100}]}}};for(const m of c.metrics)m.sourceRef=measurementSourceRef(c,m.id);
    const created=await request(server.getApp()).post('/initiatives').send({id:'whole-quality',title:'Whole quality effort',description:'Measured whole effort',phases:[{id:'p1',name:'Measure',summary:'Check outcomes'}],measurement:c});expect(created.status).toBe(201);
    const observations=new BlockerLifecycleLedger({dbPath:path.join(stateDir,'server-data','blocker-lifecycle.db')});const grades=new FeatureMetricsLedger({dbPath:path.join(stateDir,'server-data','feature-metrics.db')});
    try{
      for(let n=0;n<100;n++){const id=`baseline-${n}`;grades.recordDecision({correlationId:id,decisionPoint:point,ts:at});if(n<90)grades.upsertOutcome({correlationId:id,gradedBy:'test-owner',ruleId:'test-grade-v1',rung:'deterministic-ground-truth',evidenceStrength:'deterministic-proof',grade:n<72?'right':'wrong',ts:at});}
      const baseline=grades.decisionMeasurementCohort({decisionPoint:point,ruleId:'test-grade-v1',rung:'deterministic-ground-truth',evidenceStrength:'deterministic-proof',sinceMs:at-24*3600000,untilMs:at,machineSegment:null})!;
      expect(baseline).toEqual({total:100,right:72,wrong:18,unknownOrUnmatched:10});
      for(const m of c.metrics){const settled=baseline.right+baseline.wrong;observations.recordMaturationObservation({origin:'mb-e2e',featureId:'whole-quality',metricId:m.id,source:m.source,sourceRef:m.sourceRef,observedAtMs:at,value:m.id==='right-rate'?baseline.right/settled:baseline.unknownOrUnmatched/baseline.total,samples:m.id==='right-rate'?settled:baseline.total});}
      for(let n=0;n<10;n++){const id=`grade-${n}`;grades.recordDecision({correlationId:id,decisionPoint:point,ts:now});grades.upsertOutcome({correlationId:id,gradedBy:'test-owner',ruleId:'test-grade-v1',rung:'deterministic-ground-truth',evidenceStrength:'deterministic-proof',grade:n===0?'wrong':'right',ts:now});}
      const d7=(server as unknown as {blockerLifecycleService:BlockerLifecycleService}).blockerLifecycleService;expect(d7).not.toBeNull();expect(d7.evaluateMaturation(initiatives.list())).toMatchObject({measurementEligible:1});
      expect((d7.localSummary(24).maturation as {measurements:{subjects:Array<{id:string;status:string}>}}).measurements.subjects.find(i=>i.id==='whole-quality')!.status).toBe('ready');
      const response=await request(server.getApp()).get('/maturation/board?part=measurement&subject=whole-quality&machine=mb-e2e');expect(response.status).toBe(200);expect(validMeasurementRead(response.body,'mb-e2e','whole-quality',90,Date.now())).toBe(true);expect(response.body.detail.evidence).toMatchObject({state:'verified',metrics:[{id:'right-rate',current:{value:.81,samples:100}},{id:'unmatched',current:{value:10/110,samples:110}}]});
      // Quality history at a glance: the same owner's series through the production route, baseline proof intact.
      const glance=await request(server.getApp()).get('/maturation/board?part=quality');expect(glance.status).toBe(200);
      expect(glance.body).toMatchObject({schema:'measurement-quality-glance/1',advisory:true,authority:'none',origin:'mb-e2e'});
      expect(typeof glance.body.noMeasurement).toBe('number');expect(glance.body.notReadable['missing-contract']).toBeUndefined();expect(glance.body.subjectsOmitted).toBe(0);
      const right=glance.body.items.find((i:{subjectId:string;metric:{id:string}})=>i.subjectId==='whole-quality'&&i.metric.id==='right-rate');
      expect(right).toMatchObject({proof:{comparisonAvailable:true,baseline:{state:'verified',value:.8}},metric:{threshold:.8,direction:'at-least'}});expect(right.series.points.length).toBeGreaterThan(0);
      const invalid=await request(server.getApp()).patch('/initiatives/whole-quality').send({rollout:{flagPath:'one.enabled',stage:'live'}});expect(invalid.status).toBe(400);expect(initiatives.get('whole-quality')!.measurement).toBeDefined();
      const cleared=await request(server.getApp()).patch('/initiatives/whole-quality').send({measurement:null});expect(cleared.status).toBe(200);expect(initiatives.get('whole-quality')!.measurement).toBeUndefined();
    }finally{observations.close();grades.close();}
  });

  it('keeps a malformed retained generic owner invalid through the real ladder and measurement route', async () => {
    const id = subjectFromId('apprenticeship.stallCoverageGate');
    const { server } = await boot(true, true, { id, liveConfig: { apprenticeship: { stallCoverageGate: true } } });
    const response = await request(server.getApp()).get(`/maturation/board?part=measurement&subject=${id}&machine=mb-e2e`);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ state: 'invalid-contract', subjectId: id, detail: null });
    expect(response.body.sources).toContainEqual(expect.objectContaining({ name: 'ladder-owner', ok: true }));
  });

  it('counts a real local capability definition without availability or routing permission', async () => {
    const { server, stateDir } = await boot(true);
    const at = new Date().toISOString();
    new CapabilityRegistryWriter(path.join(stateDir, 'capability-registry.json'), 'local').write({
      schemaVersion: 1, machineEpoch: 1, projectionSeq: 1, scanStampSecs: 1, scanState: 'observed', truncated: false,
      entries: [{ capabilityId: 'models:codex-cli/test-model', capabilityKind: 'model', doorwayId: 'codex-cli', machineId: 'local',
        probeOutcome: 'unknown', endpointRef: 'mesh://local/doorways', observedAt: at, receivedAt: at, source: 'local-doorways',
        sourceDetail: 'doorway-manifest', evidenceClass: 'manifest-only', evidence: { manifestVerifiedAt: at } }],
    });
    const response = await request(server.getApp()).get('/maturation/board?part=coverage');
    expect(response.status).toBe(200);
    expect(response.body.counts.capability.total).toBe(1);
    expect(response.body.rows.find((r: { kind: string }) => r.kind === 'capability')).toMatchObject({ posture: 'registered-definition', state: 'not-linked' });
    expect(response.body.sources).toContainEqual(expect.objectContaining({ name: 'local-model-capability-projection', ok: true }));
  });

  it('is off on a fleet agent: 503', async () => {
    const { server } = await boot(false);
    const res = await request(server.getApp()).get('/maturation/board');
    expect(res.status).toBe(503);
    expect((await request(server.getApp()).get('/maturation/board?part=quality')).status).toBe(503);
  });

  it('serves the standalone page shell', async () => {
    const { server } = await boot(true);
    const res = await request(server.getApp()).get('/dashboard/maturation/');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Feature maturation');
  });
});
