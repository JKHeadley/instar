/** Authenticated route-to-route proxy; no agent, session or external service. */
import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import type { Server } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRoutes, type RouteContext } from '../../src/server/routes.js';
import { authMiddleware } from '../../src/server/middleware.js';
import { CorrectionLedger } from '../../src/monitoring/CorrectionLedger.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const AUTH = 'failure-pool-test-token';
const headers = { Authorization: `Bearer ${AUTH}` };
const roots: string[] = [], ledgers: CorrectionLedger[] = [], servers: Server[] = [];
function fixture(machineId: string, ledgerEnabled = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'failure-pool-')); roots.push(root);
  const ledger = ledgerEnabled ? new CorrectionLedger({ dbPath: ':memory:', machineId }) : null;
  if (ledger) ledgers.push(ledger);
  const ctx = {
    config: { projectName: 'failure-pool', projectDir: root, stateDir: root, port: 0, authToken: AUTH,
      monitoring: { failureCallouts: { enabled: true }, correctionLearning: { enabled: false } }, sessions: {}, scheduler: {} },
    meshSelfId: machineId, correctionLedger: ledger,
    sessionManager: { listRunningSessions: () => [] }, state: { getJobState: () => null, getSession: () => null },
    scheduler: null, telegram: null, relationships: null, feedback: null, dispatches: null,
    updateChecker: null, autoUpdater: null, autoDispatcher: null, quotaTracker: null, publisher: null,
    viewer: null, tunnel: null, evolution: null, watchdog: null, triageNurse: null, topicMemory: null,
    feedbackAnomalyDetector: null, discoveryEvaluator: null, startTime: new Date(),
  } as unknown as RouteContext;
  const app = express(); app.use(express.json()); app.use(authMiddleware(AUTH)); app.use(createRoutes(ctx));
  return { ctx, app, ledger };
}
const context = {
  turns: [{ text: 'Agent handed the setup back', fromUser: false, at: 1 }, { text: 'That was your job', fromUser: true, at: 2 }],
  instructions: ['Agent owns approved work'], decisions: ['Approval ignored'], sourceRefs: ['message:2'], missing: [],
};
function record(ledger: CorrectionLedger, label = 'setup') {
  return ledger.record({ kind: 'infra-gap', severity: 'failure-callout', learning: `Agent owns ${label}`, scrubbedSummary: label,
    deterministicWeight: 3, failureContext: context })!;
}
async function serve(app: express.Express) {
  const server = app.listen(0, '127.0.0.1'); servers.push(server);
  await new Promise<void>(resolve => server.once('listening', resolve));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
afterEach(async () => {
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  for (const ledger of ledgers.splice(0)) ledger.close();
  for (const root of roots.splice(0)) SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'failure-pool-test' });
});

describe('failure callout pool queue and origin proxies', () => {
  it('merges summaries, exposes dark origins, and routes detail and CAS writes to the origin', async () => {
    const origin = fixture('origin'), reader = fixture('reader');
    const first = record(origin.ledger!); record(reader.ledger!, 'local');
    const url = await serve(origin.app);
    reader.ctx.resolvePeerUrls = () => [{ machineId: 'origin', url, kind: 'lan' }];
    reader.ctx.listPoolMachines = () => [{ machineId: 'origin' }, { machineId: 'dark' }];
    const queue = await request(reader.app).get('/corrections?scope=pool&severity=failure-callout&unresolved=true').set(headers);
    expect(queue.status).toBe(200);
    expect(queue.body.records).toHaveLength(2);
    expect(queue.body.records.find((r: any) => r.id === first.id).machineId).toBe('origin');
    expect(JSON.stringify(queue.body)).not.toContain('That was your job');
    expect(queue.body.pool.failed).toContainEqual({ machineId: 'dark', error: 'no-known-url', state: 'unknown' });
    const endpoint = `/corrections/${first.id}`;
    expect((await request(reader.app).get(endpoint).set(headers)).status).toBe(404);
    const detail = await request(reader.app).get(`${endpoint}?machineId=origin`).set(headers);
    expect(detail.status).toBe(200); expect(detail.body.failureCase.context).toEqual(context);
    expect((await request(reader.app).patch(`${endpoint}/failure-case?machineId=origin`).set(headers).send({ version: first.version, context })).status).toBe(403);
    const updated = await request(reader.app).patch(`${endpoint}/failure-case?machineId=origin`).set(headers).set('X-Instar-Request', '1').send({ version: first.version, context });
    expect(updated.status).toBe(200); expect(updated.body.version).toBe(first.version + 1);
    const stale = await request(reader.app).patch(`${endpoint}/failure-case?machineId=origin`).set(headers).set('X-Instar-Request', '1').send({ version: first.version, context });
    expect(stale.status).toBe(409); expect(stale.body.current.learning).toBeUndefined();
    expect(origin.ledger!.get(first.id)!.version).toBe(first.version + 1);
    expect(reader.ledger!.get(first.id)).toBeNull();
  });

  it('does not leak detail even when a peer sends it in a list and ignores filters', async () => {
    const reader = fixture('reader');
    const peer = express(); peer.get('/corrections', (req, res) => {
      expect(req.query.scope).toBeUndefined(); expect(req.headers.authorization).toBe(`Bearer ${AUTH}`);
      res.json({ failureCalloutVersion: 1, records: [{ id: 'failure', severity: 'failure-callout', failureState: 'captured', updatedAt: '2026-01-01',
        scrubbedSummary: 'failure summary', failureCase: { context }, learning: 'private learning', sessionId: 'private session' },
        { id: 'ordinary', severity: 'correction' }, { id: 'verified', severity: 'failure-callout', failureState: 'verified' }] });
    });
    const url = await serve(peer);
    reader.ctx.resolvePeerUrls = () => [{ machineId: 'origin', url, kind: 'lan' }];
    const result = await request(reader.app).get('/corrections?scope=pool&severity=failure-callout&unresolved=true').set(headers);
    expect(result.body.records.map((r: any) => r.id)).toEqual(['failure']);
    expect(JSON.stringify(result.body)).not.toMatch(/That was your job|private learning|private session|failureCase/);
  });

  it('proxies the complete bounded forensic history beyond the generic pool summary limit', async () => {
    const reader = fixture('reader');
    const largeContext = { ...context, instructions: Array(20).fill('界'.repeat(4000)), decisions: Array(20).fill('界'.repeat(4000)) };
    const episode = { state: 'captured', context: largeContext, updatedAt: new Date().toISOString() };
    const failureCase = { ...episode, history: Array(5).fill(episode) };
    expect(Buffer.byteLength(JSON.stringify(failureCase))).toBeGreaterThan(2 * 1024 * 1024);
    const peer = express(); peer.get('/corrections/large', (_req, res) => res.json({ id: 'large', failureCase }));
    const url = await serve(peer); reader.ctx.resolvePeerUrls = () => [{ machineId: 'origin', url, kind: 'lan' }];
    const result = await request(reader.app).get('/corrections/large?machineId=origin').set(headers);
    expect(result.status).toBe(200); expect(result.body.failureCase).toEqual(failureCase);
  });

  it('keeps complete replicated evidence readable while the origin is offline and refuses replica writes', async () => {
    const origin = fixture('origin'), reader = fixture('reader');
    const recordAtOrigin = record(origin.ledger!);
    reader.ledger!.setFailureReplicaReader({ all: () => [{ machineId: 'origin', record: recordAtOrigin }],
      episodes: () => origin.ledger!.listFailureEpisodes(recordAtOrigin.id) });
    reader.ctx.listPoolMachines = () => [{ machineId: 'origin' }];
    const queue = await request(reader.app).get('/corrections?scope=pool&severity=failure-callout&unresolved=true').set(headers);
    expect(queue.body.records[0]).toMatchObject({ id: recordAtOrigin.id, machineId: 'origin', replication: { state: 'stale', readOnly: true } });
    const detail = await request(reader.app).get(`/corrections/${recordAtOrigin.id}?machineId=origin`).set(headers);
    expect(detail.status).toBe(200); expect(detail.body.failureCase.context).toEqual(context);
    expect(detail.body.replication).toMatchObject({ state: 'stale', readOnly: true, originMachineId: 'origin' });
    const episodes = await request(reader.app).get(`/corrections/${recordAtOrigin.id}/failure-episodes?machineId=origin&limit=1`).set(headers);
    expect(episodes.status).toBe(200); expect(episodes.body.episodes).toHaveLength(1);
    expect(episodes.body.replication.readOnly).toBe(true);
    const mutation = await request(reader.app).patch(`/corrections/${recordAtOrigin.id}/failure-case?machineId=origin`).set(headers).set('X-Instar-Request', '1').send({ version: recordAtOrigin.version, context });
    expect(mutation.status).toBe(503); expect(reader.ledger!.get(recordAtOrigin.id)).toBeNull();
  });

  it('marks an older peer without failure protocol support unknown even if its list is empty', async () => {
    const reader = fixture('reader'), peer = express();
    peer.get('/corrections', (_req, res) => res.json({ records: [] }));
    const url = await serve(peer); reader.ctx.resolvePeerUrls = () => [{ machineId: 'old', url, kind: 'lan' }];
    const result = await request(reader.app).get('/corrections?scope=pool&severity=failure-callout&unresolved=true').set(headers);
    expect(result.body.pool.failed).toContainEqual({ machineId: 'old', error: 'failure-callouts-unsupported', state: 'unknown' });
  });

  it('accounts offline/unsafe origins and never forwards their credentials or accepts arbitrary targets', async () => {
    const reader = fixture('reader');
    reader.ctx.resolvePeerUrls = () => [{ machineId: 'unsafe', url: 'http://example.com', kind: 'last-known-url' }, { machineId: 'offline', url: 'http://127.0.0.1:1', kind: 'lan' }];
    reader.ctx.machinePoolRegistry = { getCapacity: (id: string) => id === 'offline' ? { online: false } : null } as any;
    const queue = await request(reader.app).get('/corrections?scope=pool&severity=failure-callout&unresolved=true').set(headers);
    expect(queue.body.pool.failed).toEqual(expect.arrayContaining([
      { machineId: 'unsafe', error: 'url-rejected', state: 'unknown' }, { machineId: 'offline', error: 'offline', state: 'unknown' },
    ]));
    expect((await request(reader.app).get('/corrections/anything?machineId=arbitrary').set(headers)).body).toMatchObject({ state: 'unknown', error: 'peer-unknown' });
    expect((await request(reader.app).get('/corrections/anything?machineId=unsafe').set(headers)).status).toBe(503);
    expect((await request(reader.app).get('/corrections?scope=pool')).status).toBe(401);
  });

  it('serves remote queues from a dark local holder and keeps forensic opt-out independent of preferences', async () => {
    const origin = fixture('origin'), reader = fixture('reader', false); record(origin.ledger!);
    const url = await serve(origin.app); reader.ctx.resolvePeerUrls = () => [{ machineId: 'origin', url, kind: 'lan' }];
    const queue = await request(reader.app).get('/corrections?scope=pool&severity=failure-callout&unresolved=true').set(headers);
    expect(queue.status).toBe(200); expect(queue.body.records).toHaveLength(1);
    expect(queue.body.pool.failed).toContainEqual({ machineId: 'reader', error: 'correction-learning disabled', state: 'unknown' });
    origin.ctx.config.monitoring!.failureCallouts!.enabled = false;
    expect((await request(origin.app).get('/corrections?severity=failure-callout&unresolved=true').set(headers)).status).toBe(503);
    expect((await request(origin.app).post('/corrections/analyze').set(headers)).status).toBe(503);
    expect((await request(origin.app).post('/corrections').set(headers).set('X-Instar-Request', '1')
      .send({ learning: 'new failure', kind: 'infra-gap', severity: 'failure-callout' })).status).toBe(503);
    const existing = origin.ledger!.list()[0];
    expect((await request(origin.app).get(`/corrections/${existing.id}`).set(headers)).status).toBe(200);
    expect((await request(origin.app).patch(`/corrections/${existing.id}/failure-case`).set(headers).set('X-Instar-Request', '1')
      .send({ version: existing.version, context })).status).toBe(503);
    const disabled = await request(reader.app).get('/corrections?scope=pool&severity=failure-callout&unresolved=true').set(headers);
    expect(disabled.body.records).toHaveLength(0);
    expect(disabled.body.pool.failed).toContainEqual({ machineId: 'origin', error: 'HTTP 503', state: 'unknown' });
  });
});
