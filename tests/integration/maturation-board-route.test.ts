import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMaturationBoardRoutes, resolveReviewsDir } from '../../src/server/maturationBoardRoutes.js';
import { readMeasurementOwner } from '../../src/server/measurementCoverageRead.js';
import { measurementCoverage } from '../../src/monitoring/MeasurementCoverage.js';
import { CapabilityRegistryWriter } from '../../src/core/CapabilityRegistry.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const rm = (p: string) => SafeFsExecutor.safeRmSync(p, { recursive: true, force: true, operation: 'tests/integration/maturation-board-route.test.ts:cleanup' });

const today = () => new Date().toISOString().slice(0, 10);
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

function review(date: string, features: Array<Record<string, unknown>>) {
  return JSON.stringify({ schema: 'maturation-review/1', date, features });
}

interface Fixture { root: string; projectDir: string; stateDir: string; reviewsDir: string }

function makeFixture(): Fixture {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'mb-'));
  const projectDir = path.join(root, 'agent');
  const stateDir = path.join(projectDir, '.instar');
  const reviewsDir = path.join(projectDir, 'docs/research/feature-maturation/reviews');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(reviewsDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'config.json'), '{}');
  return { root, projectDir, stateDir, reviewsDir };
}

function ctxFor(fx: Fixture, over: Record<string, unknown> = {}) {
  return {
    config: { projectDir: fx.projectDir, stateDir: fx.stateDir, authToken: 'tok', developmentAgent: true, ...(over.config as object ?? {}) },
    meshSelfId: 'm_self',
    machinePoolRegistry: { getCapacity: (id: string) => ({ nickname: id === 'm_self' ? 'Self' : id === 'm_peer' ? 'Peer' : id }) },
    resolvePeerUrls: () => [],
    recordRopeResult: null,
    commitmentTracker: { getAll: () => [
      { id: 'CMT-1', status: 'pending', createdAt: '2026-10-01T00:00:00Z', checkInAt: '2026-10-05T00:00:00Z', nextUpdateDueAt: '2026-09-01T00:00:00Z' },
    ] },
    initiativeTracker: { list: () => [
      { id: 'feat-a', title: 'Feature A', status: 'active', updatedAt: '2026-10-20T00:00:00Z', rollout: { flagPath: 'feat.a.enabled', stage: 'dark' } },
      { id: 'bookkeeping', title: 'Standards delta', status: 'active', rollout: { lastDigestNotifiedAt: '2026-10-29T00:00:00Z' } },
    ] },
    blockerLifecycleService: { localSummary: () => ({ maturation: { features: [{ featureId: 'feat-a', status: 'ready', rung: 'dev-agent-live', passingMetrics: 1, totalMetrics: 1, evaluatedAt: '2026-10-30T00:00:00Z' }], accounting: [] } }) },
    guardRegistry: null,
    darkFlagRegistry: null,
    ...over,
  } as never;
}

// Wide timings: this suite runs beside the full suite on a loaded verifier; the
// production defaults (750 ms per peer, 2.5 s fan-out, 3 s review fetch) are unchanged.
function appFor(ctx: never) {
  return express().use(createMaturationBoardRoutes(ctx, { peerTimeoutMs: 15_000, fanOutDeadlineMs: 30_000, reviewTimeoutMs: 15_000 }));
}

describe('GET /maturation/board', () => {
  let fx: Fixture;
  const servers: http.Server[] = [];
  beforeEach(() => { fx = makeFixture(); });
  afterEach(() => {
    for (const s of servers.splice(0)) s.close();
    rm(fx.root);
  });

  it('answers 503 when the gate is off', async () => {
    const res = await request(appFor(ctxFor(fx, { config: { developmentAgent: false } }))).get('/maturation/board');
    expect(res.status).toBe(503);
  });

  it('reads independent coverage without any review file and retains inactive declarations', async () => {
    const ctx = ctxFor(fx, {
      config: { developmentAgent: true, brandNew: { enabled: true } },
      scheduler: { getJobs: () => [{ slug: 'disabled-review', name: 'Disabled review', enabled: false }] },
      featureRegistry: { getAllDefinitions: () => [] },
      blockerLifecycleService: { available: () => true, maturationOutcomeForContract: () => ({ subjectKnown: false, evidence: { state: 'missing-contract', metrics: [] } }) },
    });
    const res = await request(appFor(ctx)).get('/maturation/board?part=coverage');
    expect(res.status).toBe(200);
    expect(res.body.schema).toBe('measurement-coverage/1');
    expect(res.body.rows.find((r: { id: string }) => r.id === 'brandNew')).toMatchObject({ kind: 'feature', state: 'not-linked' });
    expect(res.body.rows.find((r: { id: string }) => r.id === 'disabled-review')).toMatchObject({ kind: 'job', posture: 'disabled', state: 'not-linked' });
    expect(res.body.counts.decision.total).toBeGreaterThan(0);
    expect(res.body.counts.effort.total).toBe(3);
    expect(res.body.rows.find((r: { id: string }) => r.id === 'commitment:["m_self","CMT-1"]')).toMatchObject({ kind: 'effort', state: 'not-linked', posture: 'pending' });
    expect(res.body.sourcesComplete).toBe(false);
  });

  it.each([
    { origin: 'm_self', truncated: false, entries: true, ok: true, count: 1 },
    { origin: 'm_self', truncated: false, entries: false, ok: true, count: 0 },
    { origin: 'm_self', truncated: true, entries: true, ok: false, count: 1 },
    { origin: 'm_foreign', truncated: false, entries: true, ok: false, count: 0 },
  ])('reads capability definitions without treating advisory availability as authority: %j', async spec => {
    const at = new Date().toISOString();
    new CapabilityRegistryWriter(path.join(fx.stateDir, 'capability-registry.json'), spec.origin).write({
      schemaVersion: 1, machineEpoch: 1, projectionSeq: 1, scanStampSecs: 1, scanState: 'observed', truncated: spec.truncated,
      entries: spec.entries ? [{ capabilityId: 'models:codex-cli/test-model', capabilityKind: 'model', doorwayId: 'codex-cli', machineId: spec.origin,
        probeOutcome: 'unknown', endpointRef: `mesh://${spec.origin}/doorways`, observedAt: at, receivedAt: at, source: 'local-doorways',
        sourceDetail: 'doorway-manifest', evidenceClass: 'manifest-only', evidence: { manifestVerifiedAt: at } }] : [],
    });
    const res = await request(appFor(ctxFor(fx, { capabilityRegistry: null }))).get('/maturation/board?part=coverage');
    expect(res.status).toBe(200);
    expect(res.body.sources).toContainEqual(expect.objectContaining({ name: 'local-model-capability-projection', ok: spec.ok }));
    expect(res.body.counts.capability.total).toBe(spec.count);
    if (spec.count) expect(res.body.rows.find((r: { kind: string }) => r.kind === 'capability')).toMatchObject({ posture: 'registered-definition', state: 'not-linked' });
  });

  it('preserves a graduated declaration and refuses ambiguous exact flag associations', async () => {
    const point = { id: 'm', observedAtMs: Date.now() - 1000, descriptorVersion: 1, value: 1, samples: 1 };
    const contract = { cadenceHours: 6, evidenceMaxAgeHours: 12, metrics: [{ id: 'm' }], outcome: {
      statement: 'Useful outcomes', owner: 'Echo', method: 'Compare recorded outcomes', version: 'v1', outcomeMetricIds: ['m'], qualityMetricIds: ['m'], baseline: { origin: 'm_self', points: [point] },
    } };
    const graduated = { id: 'graduated', title: 'Graduated', status: 'completed', rollout: { flagPath: 'brandNew.enabled', stage: 'default-on', maturationEvaluation: contract } };
    const service = { available: () => true, maturationOutcomeForContract: () => ({ subjectKnown: false, evidence: { state: 'missing-contract', metrics: [] } }) };
    const make = (items: unknown[]) => appFor(ctxFor(fx, { config: { developmentAgent: true, brandNew: { enabled: true } }, initiativeTracker: { list: () => items }, blockerLifecycleService: service }));
    const res = await request(make([graduated])).get('/maturation/board?part=coverage');
    expect(res.body.rows.find((r: { id: string }) => r.id === 'brandNew')).toMatchObject({ declaration: 'declared', state: 'inactive' });
    const multiple = await request(make([graduated, { ...graduated, id: 'other' }])).get('/maturation/board?part=coverage');
    expect(multiple.body.rows.find((r: { id: string }) => r.id === 'brandNew')).toMatchObject({ declaration: 'ambiguous', state: 'ambiguous', subjects: ['graduated', 'other'] });
  });

  it.each([{}, null, { subject: { kind: 'invalid', key: 'job' } }])('retains a malformed generic owner collision before ladder precedence: %j', measurement => {
    const entry = { id: 'collision', subject: 'collision', title: 'Collision', disposition: 'ladder', rungs: {} };
    const ladderContract = { cadenceHours: 6, evidenceMaxAgeHours: 12, metrics: [] };
    const ctx = ctxFor(fx, {
      initiativeTracker: { list: () => [{ id: 'collision', title: 'Invalid owner', status: 'active', measurement }] },
      maturationLadder: () => ({ error: null, entries: [entry], measurementContracts: () => new Map([['collision', { contract: ladderContract, overridesInitiative: true }]]) }),
    });
    expect(readMeasurementOwner(ctx, 'collision').owner).toMatchObject({ error: 'measurement-owner-collision' });
    expect(readMeasurementOwner(ctx, 'collision').owner?.contract).toBeUndefined();
  });

  it('preserves accounting ownership and ladder composition without borrowing parent evidence', async () => {
    const parent = { id: 'parent-flag', title: 'Parent feature', subject: 'parent-subject', disposition: 'ladder', flag: { path: 'parentFeature.enabled' }, rungs: {} };
    const child = { id: 'child-flag', title: 'Component', subject: 'child-subject', disposition: 'composed', composedInto: 'parent-flag', flag: { path: 'childFeature.enabled' }, rungs: {} };
    const ctx = ctxFor(fx, { initiativeTracker: { list: () => [{ id: 'child-task', title: 'Task', status: 'active', rollout: { flagPath: 'ownedFeature.enabled' }, rolloutAccounting: { ownerFeatureId: 'parent-task' } }] },
      config: { developmentAgent: true, ownedFeature: { enabled: true } },
      maturationLadder: () => ({ error: null, entries: [parent, child], measurementContracts: () => new Map(), features: () => [{ id: 'parent-flag', next: null }, { id: 'child-flag', next: null }] }),
    });
    const res = await request(appFor(ctx)).get('/maturation/board?part=coverage');
    expect(res.body.rows.find((r: { id: string }) => r.id === 'childFeature')).toMatchObject({ parents: [{ kind: 'feature', id: 'parentFeature', source: 'ladder-composition' }] });
    expect(res.body.rows.find((r: { id: string }) => r.id === 'ownedFeature')).toMatchObject({ parents: [{ kind: 'effort', id: 'parent-task', source: 'accounting-owner' }] });
    expect(res.body.counts.feature.states.corroborated).toBe(0);
  });

  it('pool coverage preserves a valid origin and discloses an old peer as unsupported', async () => {
    let old = false;
    let hasCommitmentSource = false;
    const peer = express().get('/maturation/board', (_req, res) => res.json(old ? { schema: 'maturation-board/1' } : measurementCoverage('m_peer', Date.now(), [{ kind: 'job', id: 'j', title: 'Review', sources: ['jobs'], subjects: [] }], [{ name: 'jobs', ok: true }, ...(hasCommitmentSource ? [{ name: 'commitment-tracker', ok: true }] : [])], () => null)));
    const server = http.createServer(peer); servers.push(server);
    await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const app = appFor(ctxFor(fx, { resolvePeerUrls: () => [{ machineId: 'm_peer', url, kind: 'lan' }] }));
    const res = await request(app).get('/maturation/board?scope=pool&part=coverage');
    expect(res.body.origins.map((o: { origin: string }) => o.origin)).toEqual(['m_peer', 'm_self']);
    expect(res.body.origins[0].counts.job.total).toBe(1);
    expect(res.body.poolComplete).toBe(false);
    expect(res.body.failed).toContainEqual({ machineId: 'm_peer', reason: 'commitment-inventory-unsupported' });
    expect(res.body.origins[0].sources).toEqual([{ name: 'jobs', ok: true }]);
    hasCommitmentSource = true;
    const upgraded = await request(app).get('/maturation/board?scope=pool&part=coverage');
    expect(upgraded.body.failed).toEqual([]);
    expect(upgraded.body.origins[0].counts.job.total).toBe(1);
    old = true;
    const unsupported = await request(app).get('/maturation/board?scope=pool&part=coverage');
    expect(unsupported.body.poolComplete).toBe(false);
    expect(unsupported.body.failed).toContainEqual({ machineId: 'm_peer', reason: 'unavailable-or-unsupported' });
  });

  it('measurement detail queries select one known origin and refuse foreign or unsupported replies', async () => {
    let shape='valid';let calls=0;
    const peer=express().get('/maturation/board',(_req,res)=>{calls++;res.json(shape==='old'?{schema:'maturation-board/1'}:{schema:'measurement-read/1',advisory:true,authority:'none',origin:shape==='foreign'?'another':'m_peer',subjectId:'one',generatedAt:new Date().toISOString(),windowDays:90,state:'missing-contract',detail:null,sources:[]});});
    const server=http.createServer(peer);servers.push(server);await new Promise<void>(r=>server.listen(0,'127.0.0.1',()=>r()));
    const url=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
    const app=appFor(ctxFor(fx,{resolvePeerUrls:()=>[{machineId:'m_peer',url,kind:'lan'},{machineId:'m_other',url:'http://127.0.0.1:1',kind:'lan'}]}));
    const response=await request(app).get('/maturation/board?part=measurement&subject=one&machine=m_peer');
    expect(response.status).toBe(200);expect(response.body.state).toBe('missing-contract');expect(calls).toBe(1);
    shape='old';expect((await request(app).get('/maturation/board?part=measurement&subject=one&machine=m_peer')).status).toBe(503);
    shape='foreign';expect((await request(app).get('/maturation/board?part=measurement&subject=one&machine=m_peer')).status).toBe(503);
    expect((await request(app).get('/maturation/board?part=measurement&subject=one&machine=http://evil')).status).toBe(400);
  });

  it('builds a local board from review files and live owners', async () => {
    fs.writeFileSync(path.join(fx.reviewsDir, `${daysAgo(2)}.json`), review(daysAgo(2), [
      { id: 'feat.a', verdict: 'blind', evidence: 'x', evidenceReadToday: true, commitments: [] },
    ]));
    fs.writeFileSync(path.join(fx.reviewsDir, `${today()}.json`), review(today(), [
      { id: 'feat.a', title: 'Feature A', verdict: 'stalled', evidence: 'no runs', evidenceReadToday: true, commitments: ['CMT-1'] },
      { id: 'feat.b', verdict: 'live', evidence: 'healthy', evidenceReadToday: true, commitments: [] },
    ]));
    const res = await request(appFor(ctxFor(fx))).get('/maturation/board');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ schema: 'maturation-board/1', advisory: true, authority: 'none', reviewDate: today(), reviewState: 'ok' });
    const a = res.body.features.find((f: { id: string }) => f.id === 'feat.a');
    expect(a.review.verdict).toBe('stalled');
    expect(a.history.map((h: { verdict: string }) => h.verdict)).toEqual(['blind', 'stalled']);
    // checkInAt is the deadline; the nudge marker is not.
    expect(a.deadlines).toHaveLength(1);
    expect(a.deadlines[0]).toMatchObject({ source: 'commitment', ref: 'CMT-1', open: true });
    expect(a.followUp.state).toBe('linked');
    // rollout + D7 owners attach through the flagPath alias; bookkeeping-only rollouts never appear.
    expect(a.owners.map((o: { source: string }) => o.source).sort()).toEqual(['d7', 'rollout']);
    expect(res.body.features.some((f: { id: string }) => f.id === 'bookkeeping')).toBe(false);
    // D7 ready vs review stalled is not in the closed conflict table.
    expect(a.conflicts).toEqual([]);
    // Sources the board could not read are reported, not hidden.
    expect(res.body.sources.find((s: { name: string }) => s.name === 'dark-flag')).toMatchObject({ ok: false, reason: 'registry-not-running' });
  });

  it('reports a rejected newer review instead of silently using an older one', async () => {
    fs.writeFileSync(path.join(fx.reviewsDir, `${daysAgo(2)}.json`), review(daysAgo(2), [{ id: 'a', verdict: 'live', commitments: [] }]));
    fs.writeFileSync(path.join(fx.reviewsDir, `${today()}.json`), '{ broken');
    const res = await request(appFor(ctxFor(fx))).get('/maturation/board');
    expect(res.body.reviewDate).toBe(daysAgo(2));
    expect(res.body.sources).toContainEqual(expect.objectContaining({ name: `review:${today()}.json`, ok: false, reason: 'invalid-json' }));
  });

  it('follow-up reads unknown when the commitment tracker is not running', async () => {
    fs.writeFileSync(path.join(fx.reviewsDir, `${today()}.json`), review(today(), [{ id: 'a', verdict: 'stalled', commitments: ['CMT-1'] }]));
    const res = await request(appFor(ctxFor(fx, { commitmentTracker: null }))).get('/maturation/board');
    expect(res.body.features[0].followUp.state).toBe('unknown');
  });

  it('serves the owners and review parts for peers', async () => {
    fs.writeFileSync(path.join(fx.reviewsDir, `${today()}.json`), review(today(), [{ id: 'a', verdict: 'stalled', commitments: ['CMT-1'] }]));
    const app = appFor(ctxFor(fx));
    const owners = await request(app).get('/maturation/board?scope=local&part=owners');
    expect(owners.body).toMatchObject({ schema: 'maturation-board/1', part: 'owners', reviewDigest: { date: today(), featureCount: 1 } });
    const rv = await request(app).get('/maturation/board?scope=local&part=review');
    expect(rv.body).toMatchObject({ part: 'review', date: today(), hash: owners.body.reviewDigest.hash });
    expect(rv.body.commitments[0]).toMatchObject({ id: 'CMT-1', checkInAt: '2026-10-05T00:00:00Z' });
  });

  it('pool: takes review rows from the machine with the newest review and tags peer facts', async () => {
    // Peer holds the newest review; self holds an older one.
    const peerFx = makeFixture();
    fs.writeFileSync(path.join(peerFx.reviewsDir, `${today()}.json`), review(today(), [{ id: 'feat.a', verdict: 'regressed', evidence: 'peer read', commitments: ['CMT-1'] }]));
    fs.writeFileSync(path.join(fx.reviewsDir, `${daysAgo(3)}.json`), review(daysAgo(3), [{ id: 'feat.a', verdict: 'live', commitments: [] }]));
    const peerApp = appFor(ctxFor(peerFx, { meshSelfId: 'm_peer' }));
    const server = http.createServer(peerApp);
    servers.push(server);
    await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as { port: number }).port;
    const res = await request(appFor(ctxFor(fx, { resolvePeerUrls: () => [{ machineId: 'm_peer', url: `http://127.0.0.1:${port}`, kind: 'lan' }] })))
      .get('/maturation/board?scope=pool');
    rm(peerFx.root);
    expect(res.status).toBe(200);
    expect(res.body.reviewMachine).toBe('Peer');
    expect(res.body.reviewDate).toBe(today());
    const a = res.body.features.find((f: { id: string }) => f.id === 'feat.a');
    expect(a.review.verdict).toBe('regressed');
    expect(a.followUp.items[0]).toMatchObject({ ref: 'CMT-1' });
    expect(new Set(a.owners.map((o: { machine: string }) => o.machine))).toEqual(new Set(['Self', 'Peer']));
  });

  it('pool: a peer that does not answer is named, and a future-dated peer review is refused', async () => {
    fs.writeFileSync(path.join(fx.reviewsDir, `${today()}.json`), review(today(), [{ id: 'a', verdict: 'live', commitments: [] }]));
    const liar = express().get('/maturation/board', (_req, res) => {
      res.json({ schema: 'maturation-board/1', part: 'owners', owners: [], reviewDigest: { date: '2099-01-01', hash: 'x'.repeat(64), featureCount: 1 } });
    });
    const server = http.createServer(liar);
    servers.push(server);
    await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as { port: number }).port;
    const res = await request(appFor(ctxFor(fx, { resolvePeerUrls: () => [
      { machineId: 'm_liar', url: `http://127.0.0.1:${port}`, kind: 'lan' },
      { machineId: 'm_dead', url: 'http://127.0.0.1:1', kind: 'lan' },
    ] }))).get('/maturation/board?scope=pool');
    expect(res.status).toBe(200);
    expect(res.body.reviewDate).toBe(today());
    expect(res.body.reviewMachine).toBe('Self');
    expect(res.body.sources).toContainEqual(expect.objectContaining({ name: 'may-be-superseded', machineIds: ['m_dead'], ok: false }));
    expect(res.body.sources).toContainEqual(expect.objectContaining({ name: 'peer', machineId: 'm_liar', ok: true }));
    expect(res.body.sources.some((s: { name: string; machine: string }) => s.name === 'review-candidate' && s.machine === 'm_liar')).toBe(false);
  });
});

describe('peer absence vs missing data', () => {
  it('a peer that answers board-off or unsupported is not reported as possibly superseding the review', async () => {
    const fx = makeFixture();
    const servers: http.Server[] = [];
    try {
      fs.writeFileSync(path.join(fx.reviewsDir, `${today()}.json`), review(today(), [{ id: 'a', verdict: 'live', commitments: [] }]));
      const off = express().get('/maturation/board', (_req, res) => { res.status(503).json({ error: 'off' }); });
      const old = express(); // no route at all → 404
      for (const app of [off, old]) {
        const s = http.createServer(app); servers.push(s);
        await new Promise<void>(r => s.listen(0, '127.0.0.1', () => r()));
      }
      const port = (i: number) => (servers[i].address() as { port: number }).port;
      const res = await request(appFor(ctxFor(fx, { resolvePeerUrls: () => [
        { machineId: 'm_off', url: `http://127.0.0.1:${port(0)}`, kind: 'lan' },
        { machineId: 'm_old', url: `http://127.0.0.1:${port(1)}`, kind: 'lan' },
      ] }))).get('/maturation/board?scope=pool');
      expect(res.status).toBe(200);
      expect(res.body.sources).toContainEqual(expect.objectContaining({ name: 'peer', machine: 'another machine', machineId: 'm_off', reason: 'board-off' }));
      expect(res.body.sources).toContainEqual(expect.objectContaining({ name: 'peer', machine: 'another machine', machineId: 'm_old', reason: 'unsupported' }));
      expect(res.body.sources.some((s: { name: string }) => s.name === 'may-be-superseded')).toBe(false);
    } finally {
      for (const s of servers) s.close();
      rm(fx.root);
    }
  });
});

describe('reviews directory containment', () => {
  it('refuses a directory outside the project, under .instar, or a symlink escape', () => {
    const fx = makeFixture();
    try {
      expect(resolveReviewsDir(fx.projectDir, '../').error).toBe('reviews-dir-outside-project');
      expect(resolveReviewsDir(fx.projectDir, '.instar').error).toBe('reviews-dir-forbidden');
      const outside = fs.mkdtempSync(path.join(fx.root, 'out-'));
      fs.symlinkSync(outside, path.join(fx.projectDir, 'escape'));
      expect(resolveReviewsDir(fx.projectDir, 'escape').error).toBe('reviews-dir-outside-project');
      expect(resolveReviewsDir(fx.projectDir, undefined).dir).toBe(fs.realpathSync(fx.reviewsDir));
    } finally {
      rm(fx.root);
    }
  });

  it('refuses a symlinked review file', async () => {
    const fx = makeFixture();
    try {
      const target = path.join(fx.root, 'secret.json');
      fs.writeFileSync(target, review(today(), [{ id: 'a', verdict: 'live', commitments: [] }]));
      fs.symlinkSync(target, path.join(fx.reviewsDir, `${today()}.json`));
      const res = await request(appFor(ctxFor(fx))).get('/maturation/board');
      expect(res.body.reviewState).toBe('none');
      expect(res.body.sources).toContainEqual(expect.objectContaining({ reason: 'not-a-regular-file' }));
    } finally {
      rm(fx.root);
    }
  });
});
