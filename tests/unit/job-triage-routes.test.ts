// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/** GET /jobs/triage (job-cost-reduction §5.6.2, §13): self view, pool merge, pool cooldown helper. */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { createJobTriagePoolFetcher, mountJobTriageRoutes, poolHasRecentTriageSession, type JobTriageRoutesDeps } from '../../src/server/jobTriageRoutes.js';
import { JobTriageStateStore } from '../../src/scheduler/JobTriageStateStore.js';
import { JobRunHistory } from '../../src/scheduler/JobRunHistory.js';
import { JobSupervisionStore } from '../../src/scheduler/JobSupervisionStore.js';

describe('GET /jobs/triage', () => {
  let dir: string;
  let audit: string;
  const now = Date.parse('2026-10-26T12:00:00Z');
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-triage-routes-'));
    audit = path.join(dir, 'logs', 'job-triage.jsonl');
    fs.mkdirSync(path.dirname(audit), { recursive: true });
    const rows = [
      { kind: 'decision', ts: '2026-10-26T11:00:00.000Z', slug: 'health-check', runId: 'r1', decider: 'floor', decision: 'needs_session', floor: true, action: 'spawned' },
      { kind: 'decision', ts: '2026-10-26T11:05:00.000Z', slug: 'health-check', runId: 'r2', decider: 'floor', decision: 'needs_session', floor: true, action: 'suppressed-cap' },
      { kind: 'decision', ts: '2026-10-26T11:10:00.000Z', slug: 'health-check', runId: 'r3', decider: 'jev', decision: 'routine', action: 'none' },
      { kind: 'decision', ts: '2026-10-20T11:10:00.000Z', slug: 'old', runId: 'r0', decider: 'jev', decision: 'routine', action: 'none' },
    ];
    fs.writeFileSync(audit, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  });
  afterEach(() => { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/job-triage-routes.test.ts' }); });

  function app(deps: Partial<JobTriageRoutesDeps> = {}) {
    const store = new JobTriageStateStore({ file: path.join(dir, 'state.json') });
    store.update((s) => { s.cooldowns['health-check:disk-critical'] = '2026-10-26T11:00:00.000Z'; s.sessions.push({ sessionName: 'triage-health-check-1', slug: 'health-check', runId: 'r1', startedAt: '2026-10-26T11:00:00.000Z', output: 'fixed', origin: 'floor' }); });
    const a = express();
    const router = express.Router();
    mountJobTriageRoutes(router, { state: () => store, auditPath: audit, machineId: 'm-1', enabled: () => true, now: () => now, ...deps });
    a.use(router);
    return a;
  }

  it('returns this machine\'s last-24h counts, sessions and floor-required refusals', async () => {
    const res = await request(app()).get('/jobs/triage');
    expect(res.status).toBe(200);
    expect(res.body.counts.byDecider).toEqual({ floor: 2, jev: 1 });
    expect(res.body.counts.sessionsSpawned).toBe(1);
    expect(res.body.counts.floorRequiredRefused).toBe(1);
    expect(res.body.perSlug.old).toBeUndefined();
    expect(res.body.sessions[0]).toMatchObject({ sessionName: 'triage-health-check-1', output: 'fixed' });
  });

  it('503 when triage is not constructed; 400 for an unknown scope', async () => {
    expect((await request(app({ state: () => null })).get('/jobs/triage')).status).toBe(503);
    expect((await request(app()).get('/jobs/triage?scope=bogus')).status).toBe(400);
  });

  it('?scope=pool merges peers and lists failed peers', async () => {
    const res = await request(app({
      fetchPool: async () => ({ results: [{ machineId: 'm-2', machineNickname: 'mini', body: { counts: { sessionsSpawned: 2 }, cooldowns: {} } }], failed: [{ machineId: 'm-3', reason: 'timeout' }] }),
    })).get('/jobs/triage?scope=pool');
    expect(res.status).toBe(200);
    expect(res.body.machines).toHaveLength(2);
    expect(res.body.machines[1]).toMatchObject({ machineId: 'm-2', remote: true });
    expect(res.body.pool.failed).toEqual([{ machineId: 'm-3', reason: 'timeout' }]);
  });

  it('never claims complete pool coverage without a verified expected roster', async () => {
    const history = new JobRunHistory(dir);
    const supervision = new JobSupervisionStore(dir);
    try {
      const missingRoster = await request(app({ supervision: () => supervision, runHistory: () => history,
        fetchPool: async () => ({ results: [], failed: [] }) })).get('/jobs/triage?scope=pool');
      expect(missingRoster.body.supervision).toMatchObject({ coverageIncomplete: true, accuracy: null });
      const vanishedPeer = await request(app({ supervision: () => supervision, runHistory: () => history,
        expectedMachineIds: () => ['m-1', 'm-2'],
        fetchPool: async () => ({ results: [], failed: [] }) })).get('/jobs/triage?scope=pool');
      expect(vanishedPeer.body.supervision).toMatchObject({ coverageIncomplete: true, accuracy: null });
    } finally { supervision.close(); }
  });

  it('keeps local and pool quality unavailable after the supervision journal is recreated', async () => {
    const history = new JobRunHistory(dir);
    const original = new JobSupervisionStore(dir);
    original.close();
    SafeFsExecutor.safeUnlinkSync(path.join(dir, 'ledger', 'job-supervision.db'),
      { operation: 'tests/unit/job-triage-routes.test.ts' });
    let restored = new JobSupervisionStore(dir);
    restored.close();
    restored = new JobSupervisionStore(dir); // The lost-journal embargo must survive another restart.
    try {
      const local = await request(app({ supervision: () => restored, runHistory: () => history })).get('/jobs/triage');
      expect(local.body.supervision).toMatchObject({ coverageIncomplete: true, accuracy: null });
      const pool = await request(app({ supervision: () => restored, runHistory: () => history,
        expectedMachineIds: () => restored.expectedMachineIds(),
        fetchPool: async () => ({ results: [], failed: [] }) })).get('/jobs/triage?scope=pool');
      expect(pool.body.supervision).toMatchObject({ coverageIncomplete: true, accuracy: null });
    } finally { restored.close(); }
  });

  it('poolHasRecentTriageSession: true on a peer cooldown since the window, null when the pool cannot be read', async () => {
    const fetchPool = async () => ({ results: [{ machineId: 'm-2', body: { cooldowns: { 'health-check:disk-low': '2026-10-26T10:00:00.000Z' } } }], failed: [] });
    expect(await poolHasRecentTriageSession(fetchPool, 'health-check:disk-low', Date.parse('2026-10-26T06:00:00Z'))).toBe(true);
    expect(await poolHasRecentTriageSession(fetchPool, 'health-check:disk-low', Date.parse('2026-10-26T11:00:00Z'))).toBe(false);
    expect(await poolHasRecentTriageSession(async () => ({ results: [], failed: [{ machineId: 'm-2', reason: 'timeout' }] }), 'k', 0)).toBeNull();
    expect(await poolHasRecentTriageSession(async () => { throw new Error('x'); }, 'k', 0)).toBeNull();
    expect(await poolHasRecentTriageSession(undefined, 'k', 0)).toBeNull();
  });

  it('pool fetch bounds peer replies and reports rejected or unavailable peers', async () => {
    const fetchPool = createJobTriagePoolFetcher({
      resolvePeerUrls: () => [
        { machineId: 'm-2', url: 'https://peer.dawn-tunnel.dev' },
        { machineId: 'm-3', url: 'http://169.254.169.254' },
      ],
      authToken: 'test-token',
      fetchPeer: async (peer, route, init) => {
        expect(peer.machineId).toBe('m-2');
        expect(route).toBe('/jobs/triage');
        expect(init?.headers).toMatchObject({ Authorization: 'Bearer test-token' });
        expect(init?.redirect).toBe('manual');
        return Response.json({ cooldowns: {}, sessions: [] });
      },
    });
    const result = await fetchPool('/jobs/triage');
    expect(result.results).toHaveLength(1);
    expect(result.failed).toContainEqual({ machineId: 'm-3', reason: 'url-rejected' });
  });

  it('counts missing supervision rows from the independent script-run census', async () => {
    const history = new JobRunHistory(dir);
    const supervision = new JobSupervisionStore(dir);
    try {
      const first = history.recordStart({ slug: 'health-check', sessionId: 'script-1', trigger: 'scheduled', runner: 'script' });
      history.recordCompletion({ runId: first, result: 'success' });
      const second = history.recordStart({ slug: 'health-check', sessionId: 'script-2', trigger: 'manual', runner: 'script' });
      history.recordCompletion({ runId: second, result: 'failure' });
      const id = supervision.register({ runId: first, fireId: 'fire-1', slug: 'health-check', evidencePolicy: 'v2' });
      supervision.recordResult(id, { result: 'success', evidenceHash: 'abc' });
      supervision.markUnchecked(id, 'triage-dark');
      const res = await request(app({ supervision: () => supervision, runHistory: () => history, now: Date.now })).get('/jobs/triage');
      expect(res.status).toBe(200);
      expect(res.body.supervision).toMatchObject({ denominator: 2, decisionCoverage: 0, coverageIncomplete: false,
        byStatus: { unchecked: 2 }, reconciliation: { inserted: 1 } });
      expect(supervision.findByRunId(second)).toMatchObject({ status: 'unchecked', reason: 'missing-record' });
    } finally {
      supervision.close();
    }
  });

  it('marks the report incomplete if the independent completion append is missing', async () => {
    const history = new JobRunHistory(dir);
    const supervision = new JobSupervisionStore(dir);
    try {
      const runId = history.recordStart({ slug: 'health-check', sessionId: 'script-1', trigger: 'scheduled', runner: 'script' });
      const id = supervision.register({ runId, fireId: 'fire-1', slug: 'health-check', decisionEligible: true, evidencePolicy: 'v2' });
      supervision.recordResult(id, { result: 'success', evidenceHash: 'evidence-v1', evidenceSufficient: true });
      const call = supervision.beginCall({ attemptId: id, provider: 'jev', decisionPoint: 'job-result-supervision-v2',
        promptHash: 'prompt-v1', evidencePolicyHash: 'policy-v1', evidenceHash: 'evidence-v1',
        intendedModel: 'jev-1.13.0', leaseMs: 1000 });
      expect(call).not.toBeNull();
      supervision.settleCall({ attemptId: id, epoch: call!.epoch, actualProvider: 'typesafe-api',
        actualModel: 'jev-1.13.0', verdict: 'routine', latencyMs: 1 });
      const res = await request(app({ supervision: () => supervision, runHistory: () => history, now: Date.now })).get('/jobs/triage');
      expect(res.status).toBe(200);
      expect(res.body.supervision).toMatchObject({ denominator: 1, decisionCoverage: 1,
        coverageIncomplete: true, accuracy: null });
    } finally { supervision.close(); }
  });

  it('counts a surviving attempt when its independent history file has lost the run', async () => {
    const history = new JobRunHistory(dir);
    const supervision = new JobSupervisionStore(dir);
    try {
      const id = supervision.register({ runId: 'lost-history-run', fireId: 'fire-1',
        slug: 'health-check', evidencePolicy: 'v2' });
      supervision.recordResult(id, { result: 'failure' });
      supervision.markUnchecked(id, 'history-missing');
      const res = await request(app({ supervision: () => supervision, runHistory: () => history,
        now: Date.now })).get('/jobs/triage');
      expect(res.status).toBe(200);
      expect(res.body.supervision).toMatchObject({ denominator: 1, coverageIncomplete: true,
        accuracy: null, gradableFraction: null, byStatus: { unchecked: 1 } });
    } finally { supervision.close(); }
  });
});
