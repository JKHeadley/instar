/**
 * Integration: GET /jobs/cost and POST /jobs/cost/baseline/freeze
 * (docs/specs/job-cost-reduction.md §9.3) behind the real authMiddleware, with the
 * real TokenLedger + FeatureMetricsLedger feeding a real JobCostReport, plus the
 * ?scope=pool merge with one answering peer and one failing peer.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { authMiddleware } from '../../src/server/middleware.js';
import { mountJobCostRoutes, type JobCostRoutesDeps } from '../../src/server/jobCostRoutes.js';
import { JobCostReport } from '../../src/scheduler/JobCostReport.js';
import { TokenLedger } from '../../src/monitoring/TokenLedger.js';
import { FeatureMetricsLedger } from '../../src/monitoring/FeatureMetricsLedger.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const AUTH = 'job-cost-token';
let dir: string;
let ledger: TokenLedger;
let fm: FeatureMetricsLedger;

function app(deps: Partial<JobCostRoutesDeps> & { report: JobCostReport | null }): express.Express {
  const a = express();
  a.use(express.json());
  a.use(authMiddleware(() => AUTH, 'test'));
  const router = express.Router();
  mountJobCostRoutes(router, { authToken: AUTH, ...deps });
  a.use('/', router);
  return a;
}

function report(machineId = 'm1'): JobCostReport {
  const now = Date.now();
  return new JobCostReport({
    stateDir: dir,
    machineId: () => machineId,
    runHistory: { query: () => ({ runs: [
      { runId: 'r1', slug: 'health-check', sessionId: 's', trigger: 'scheduled', startedAt: new Date(now - 3600_000).toISOString(), result: 'success', machineId, tokens: 0 } as any,
    ] }) },
    tokenLedger: ledger,
    featureMetrics: fm,
  });
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jcr-int-'));
  ledger = new TokenLedger({ dbPath: ':memory:', claudeProjectsDir: '/nonexistent', attributionBackfill: 'off' });
  fm = new FeatureMetricsLedger({ dbPath: ':memory:' });
});
afterEach(() => { ledger.close(); fm.close(); SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/integration/job-cost-routes.test.ts' }); });

const auth = { Authorization: `Bearer ${AUTH}` };

describe('GET /jobs/cost', () => {
  it('401 without a bearer token', async () => {
    const res = await request(app({ report: report() })).get('/jobs/cost');
    expect(res.status).toBe(401);
  });

  it('503 when the report is not constructed', async () => {
    const res = await request(app({ report: null })).get('/jobs/cost').set(auth);
    expect(res.status).toBe(503);
  });

  it('400 on an invalid sinceDays or scope', async () => {
    const a = app({ report: report() });
    expect((await request(a).get('/jobs/cost?sinceDays=0').set(auth)).status).toBe(400);
    expect((await request(a).get('/jobs/cost?sinceDays=abc').set(auth)).status).toBe(400);
    expect((await request(a).get('/jobs/cost?scope=world').set(auth)).status).toBe(400);
  });

  it('200 with per-slug numbers, the weights and baseline: null + reason', async () => {
    const now = Date.now();
    ledger.recordJobSession('tmux-1', 'health-check', 'm1', now - 3600_000);
    ledger.bindJobSessionTranscript('tmux-1', 'uuid-1');
    ledger.recordEvent({ requestId: 'q1', sessionId: 'uuid-1', ts: now - 3000_000, model: 'claude-opus-5-5', inputTokens: 10, outputTokens: 2 });
    fm.record({ feature: 'JobAnomalyNarrator', outcome: 'fired', tokensIn: 5, tokensOut: 1, jobSlug: 'health-check', machineId: 'm1' });
    const res = await request(app({ report: report() })).get('/jobs/cost?sinceDays=7').set(auth);
    expect(res.status).toBe(200);
    expect(res.body.weights).toEqual({ input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 });
    expect(res.body.baseline).toBeNull();
    expect(typeof res.body.baselineReason).toBe('string');
    const hc = res.body.slugs.find((s: any) => s.slug === 'health-check');
    expect(hc).toMatchObject({ runs: 1, scriptRuns: 1, modelCalls: 2, narrations: 1 });
    expect(hc.weightedTokens).toBe(10 + 10 + 5 + 5);
  });

  it('scope=pool merges a peer report and lists a failing peer in pool.failed', async () => {
    const peerBody = { schemaVersion: 1, machineId: 'm2', slugs: [{ slug: 'health-check', runs: 4, scriptRuns: 4, failures: 0, modelCalls: 0,
      tokens: { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 }, weightedTokens: 0, narrations: 0, triageSessions: 0, frameworks: {}, models: {} }] };
    const fetchPeer: JobCostRoutesDeps['fetchPeer'] = async (p, pth) => {
      expect(pth).toBe('/jobs/cost?sinceDays=7&scope=local');
      if (p.machineId === 'm3') throw new Error('ECONNREFUSED');
      return new Response(JSON.stringify(peerBody), { status: 200 });
    };
    const res = await request(app({
      report: report(),
      resolvePeerUrls: () => [
        { machineId: 'm2', url: 'http://127.0.0.1:9', kind: 'lan' },
        { machineId: 'm3', url: 'http://127.0.0.1:10', kind: 'lan' },
      ],
      fetchPeer,
    })).get('/jobs/cost?scope=pool').set(auth);
    expect(res.status).toBe(200);
    expect(res.body.scope).toBe('pool');
    expect(res.body.machines.map((m: any) => m.machineId).sort()).toEqual(['m1', 'm2']);
    expect(res.body.merged.find((s: any) => s.slug === 'health-check')).toMatchObject({ runs: 5, machines: 2 });
    expect(res.body.pool.failed).toEqual([{ machineId: 'm3', reason: 'peer-unreachable' }]);
    expect(res.body.pool.peersOk).toBe(1);
  });
});

describe('POST /jobs/cost/baseline/freeze', () => {
  it('freezes, then 409s, then refreezes with force; GET then carries the baseline', async () => {
    // Collection started two days ago (a manual freeze clips its window to the collection start).
    const r = report();
    const seeded = r.ensureCollectionStarted();
    fs.writeFileSync(r.baselinePath, JSON.stringify({ ...seeded, collectionStartedAt: new Date(Date.now() - 2 * 86_400_000).toISOString() }));
    const a = app({ report: r });
    const first = await request(a).post('/jobs/cost/baseline/freeze').set(auth).send({});
    expect(first.status).toBe(200);
    expect(first.body.baseline.method).toBe('prospective-manual');
    expect(first.body.baseline.perSlug['health-check'].runs).toBe(1);
    expect((await request(a).post('/jobs/cost/baseline/freeze').set(auth).send({})).status).toBe(409);
    expect((await request(a).post('/jobs/cost/baseline/freeze').set(auth).send({ force: true })).status).toBe(200);
    const got = await request(a).get('/jobs/cost').set(auth);
    expect(got.body.baseline).not.toBeNull();
    expect(got.body.slugs.find((s: any) => s.slug === 'health-check').baseline.runs).toBe(1);
    expect(fs.existsSync(path.join(dir, 'state', 'job-cost-baseline.json'))).toBe(true);
  });
});
