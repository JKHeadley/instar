import { describe, it, expect, vi, afterEach } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import request from 'supertest';
import { createRoutes, type RouteContext } from '../../src/server/routes.js';
import { authMiddleware } from '../../src/server/middleware.js';
import { CorrectionLedger } from '../../src/monitoring/CorrectionLedger.js';

const AUTH = 'failure-admission-http';
const context = { turns: [{ text: 'Please do setup yourself', fromUser: false, at: 1 }, { text: 'That is your task', fromUser: true, at: 2 }], instructions: ['Agent owns setup'], decisions: ['Handed task back'], sourceRefs: ['telegram:1:2'], missing: [] };
afterEach(() => vi.restoreAllMocks());
describe('failure investigation admission through authenticated HTTP', () => {
  it('persists the three-attempt brake, emits one stalled notice and keeps paused cases visible', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'failure-admission-http-'));
    const ledger = new CorrectionLedger({ dbPath: ':memory:', machineId: 'http-admission' });
    const attention = vi.fn(async () => ({}));
    const ctx = { config: { projectName: 'admission', projectDir: root, stateDir: root, port: 0, authToken: AUTH, monitoring: {}, sessions: {}, scheduler: {} },
      sessionManager: { listRunningSessions: () => [] }, state: { appendEvent: vi.fn(), getJobState: () => null },
      telegram: { createAttentionItem: attention }, correctionLedger: ledger, startTime: new Date(),
    } as unknown as RouteContext;
    const app = express(); app.use(express.json()); app.use(authMiddleware(AUTH)); app.use(createRoutes(ctx));
    const auth = { Authorization: `Bearer ${AUTH}` };
    try {
      const record = ledger.record({ kind: 'infra-gap', severity: 'failure-callout', learning: 'Do approved setup', scrubbedSummary: 'Handed setup back', failureContext: context, deterministicWeight: 3 })!;
      const claim = `/corrections/${record.id}/failure-investigation/claim`;
      expect((await request(app).post(claim).send({})).status).toBe(401);
      expect((await request(app).post(claim).set(auth).send({})).status).toBe(403);
      const start = Date.now(); let now = start; vi.spyOn(Date, 'now').mockImplementation(() => now);
      for (const offset of [0, 30 * 60_000, 90 * 60_000]) {
        now = start + offset;
        const result = await request(app).post(claim).set(auth).set('X-Instar-Request', '1').send({});
        expect(result.status).toBe(200); expect(result.body.admitted).toBe(true);
      }
      now += 365 * 86400_000;
      expect((await request(app).post(claim).set(auth).set('X-Instar-Request', '1').send({})).status).toBe(409);
      expect(attention).toHaveBeenCalledTimes(1);
      const work = await request(app).get('/corrections?severity=failure-callout&unresolved=true&investigable=true').set(auth);
      expect(work.body.records).toEqual([]);
      const backlog = await request(app).get('/corrections?severity=failure-callout&unresolved=true').set(auth);
      expect(backlog.body.records[0].investigationAdmission).toMatchObject({ paused: true, attempts: 3 });
      const endpoint = `/corrections/${record.id}/failure-investigation/resume`;
      expect((await request(app).post(endpoint).set(auth).set('X-Instar-Request', '1').send({ evidenceRef: 'invented-ref' })).status).toBe(400);
      const current = ledger.get(record.id)!;
      ledger.updateFailureCase(record.id, { context: { ...context, sourceRefs: [...context.sourceRefs, 'test-output:class-fix'] } }, current.version);
      expect((await request(app).post(endpoint).set(auth).set('X-Instar-Request', '1').send({ evidenceRef: 'test-output:class-fix' })).status).toBe(200);
      expect((await request(app).post(claim).set(auth).set('X-Instar-Request', '1').send({})).status).toBe(200);
    } finally { ledger.close(); SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'failure-admission-http-test' }); }
  });
});
