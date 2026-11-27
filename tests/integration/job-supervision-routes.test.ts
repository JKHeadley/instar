// safe-fs-allow: temporary fixture cleanup uses SafeFsExecutor.
import { describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { authMiddleware } from '../../src/server/middleware.js';
import { mountJobTriageRoutes } from '../../src/server/jobTriageRoutes.js';
import { JobRunHistory } from '../../src/scheduler/JobRunHistory.js';
import { JobSupervisionStore } from '../../src/scheduler/JobSupervisionStore.js';
import { JobSupervisionWorker } from '../../src/scheduler/JobSupervisionWorker.js';
import { parseJobReplacementVerdictStrict } from '../../src/scheduler/JobSupervisionReplacementPrompt.js';
import { JobTriageStateStore } from '../../src/scheduler/JobTriageStateStore.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

describe('authenticated script-result coverage', () => {
  it('reports a malformed outage-model reply as unchecked with a failed audited call', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'job-supervision-malformed-http-'));
    const ledger = new JobSupervisionStore(dir);
    try {
      const history = new JobRunHistory(dir);
      const runId = history.recordStart({ slug: 'health-check', sessionId: 'script-malformed',
        trigger: 'scheduled', runner: 'script' });
      history.recordCompletion({ runId, result: 'success' });
      const evidence = 'result: success\nindependent-probe: healthy';
      const attempt = ledger.register({ runId, fireId: 'fire-malformed', slug: 'health-check',
        decisionEligible: true, evidencePolicy: 'v2' });
      ledger.recordResult(attempt, { result: 'success', evidenceText: evidence,
        evidenceHash: crypto.createHash('sha256').update(evidence).digest('hex'), evidenceSufficient: true });
      const worker = new JobSupervisionWorker({ store: ledger, readJevKey: () => null,
        auditReady: () => true, replacement: () => ({ model: 'haiku', provider: 'claude-code',
          benchmarkReady: true, call: async () => {
            let formatValid = true;
            try { parseJobReplacementVerdictStrict('```json\n{"verdict":"routine"}\n```'); }
            catch { formatValid = false; }
            return { verdict: 'cannot-tell' as const, formatValid,
              actualModel: 'haiku', actualProvider: 'claude-code', tokensIn: 321 };
          } }) });
      expect(await worker.drain()).toBe(1);
      const app = express();
      app.use(authMiddleware(() => 'secret', 'test'));
      mountJobTriageRoutes(app, { state: () => new JobTriageStateStore({ file: path.join(dir, 'triage-state.json') }),
        auditPath: path.join(dir, 'triage-audit.jsonl'), machineId: 'm1', enabled: () => true,
        supervision: () => ledger, runHistory: () => history });
      const response = await request(app).get('/jobs/triage').set('Authorization', 'Bearer secret');
      expect(response.status).toBe(200);
      expect(response.body.supervision).toMatchObject({ denominator: 1, decisionCoverage: 0,
        byStatus: { unchecked: 1 } });
      expect(ledger.callRows(attempt)).toMatchObject([{ provider: 'replacement', settlement: 'failed',
        tokens_in: 321 }]);
    } finally {
      ledger.close();
      SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true,
        operation: 'tests/integration/job-supervision-routes.test.ts' });
    }
  });

  it('keeps a vanished machine in the pool coverage check until membership is revoked', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'job-supervision-roster-http-'));
    const ledger = new JobSupervisionStore(dir);
    const self = 'm_aaaaaaaaaaaaaaaa';
    const peer = 'm_bbbbbbbbbbbbbbbb';
    try {
      ledger.observeMachineMembership([{ machineId: self, status: 'active' },
        { machineId: peer, status: 'active' }]);
      const app = express();
      app.use(authMiddleware(() => 'secret', 'test'));
      mountJobTriageRoutes(app, {
        state: () => new JobTriageStateStore({ file: path.join(dir, 'triage-state.json') }),
        auditPath: path.join(dir, 'triage-audit.jsonl'), machineId: self, enabled: () => false,
        supervision: () => ledger, runHistory: () => new JobRunHistory(dir),
        expectedMachineIds: () => ledger.expectedMachineIds(),
        fetchPool: async () => ({ results: [], failed: [] }),
      });
      const missing = await request(app).get('/jobs/triage?scope=pool').set('Authorization', 'Bearer secret');
      expect(missing.status).toBe(200);
      expect(missing.body.supervision.coverageIncomplete).toBe(true);
      ledger.observeMachineMembership([{ machineId: peer, status: 'revoked' }]);
      const retired = await request(app).get('/jobs/triage?scope=pool').set('Authorization', 'Bearer secret');
      expect(retired.status).toBe(200);
      expect(retired.body.supervision.coverageIncomplete).toBe(false);
    } finally {
      ledger.close();
      SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/integration/job-supervision-routes.test.ts' });
    }
  });

  it('reports completed, missing and side-run records through the real route', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'job-supervision-http-'));
    const ledger = new JobSupervisionStore(dir);
    try {
      const history = new JobRunHistory(dir);
      const done = history.recordStart({ slug: 'health-check', sessionId: 'script-1', trigger: 'scheduled', runner: 'script' });
      history.recordCompletion({ runId: done, result: 'success' });
      const missing = history.recordStart({ slug: 'health-check', sessionId: 'script-2', trigger: 'manual', runner: 'script' });
      history.recordCompletion({ runId: missing, result: 'failure' });
      const canary = history.recordStart({ slug: 'health-check', sessionId: 'canary-1', trigger: 'script-canary', runner: 'script' });
      history.recordCompletion({ runId: canary, result: 'failure' });
      const attempt = ledger.register({ runId: done, fireId: 'fire-1', slug: 'health-check', evidencePolicy: 'v2' });
      ledger.recordResult(attempt, { result: 'success' });
      ledger.markUnchecked(attempt, 'triage-dark');
      const app = express();
      app.use(authMiddleware(() => 'secret', 'test'));
      mountJobTriageRoutes(app, {
        state: () => new JobTriageStateStore({ file: path.join(dir, 'triage-state.json') }),
        auditPath: path.join(dir, 'triage-audit.jsonl'), machineId: 'm1', enabled: () => false,
        supervision: () => ledger, runHistory: () => history,
      });
      expect((await request(app).get('/jobs/triage')).status).toBe(401);
      const response = await request(app).get('/jobs/triage').set('Authorization', 'Bearer secret');
      expect(response.status).toBe(200);
      expect(response.body.supervision).toMatchObject({ denominator: 2, decisionCoverage: 0,
        byStatus: { unchecked: 2 }, coverageIncomplete: false });
      expect(ledger.findByRunId(missing)).toMatchObject({ reason: 'missing-record', status: 'unchecked' });
      expect(ledger.findByRunId(canary)).toBeNull();
      ledger.holdSlug('health-check', 'certificate-revoked');
      const held = await request(app).get('/jobs/triage').set('Authorization', 'Bearer secret');
      expect(held.status).toBe(200);
      expect(held.body.supervision.holds).toEqual([
        expect.objectContaining({ slug: 'health-check', reason: 'certificate-revoked' }),
      ]);
    } finally {
      ledger.close();
      SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/integration/job-supervision-routes.test.ts' });
    }
  });
});
