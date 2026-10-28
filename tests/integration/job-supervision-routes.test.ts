// safe-fs-allow: temporary fixture cleanup uses SafeFsExecutor.
import { describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { authMiddleware } from '../../src/server/middleware.js';
import { mountJobTriageRoutes } from '../../src/server/jobTriageRoutes.js';
import { JobRunHistory } from '../../src/scheduler/JobRunHistory.js';
import { JobSupervisionStore } from '../../src/scheduler/JobSupervisionStore.js';
import { JobTriageStateStore } from '../../src/scheduler/JobTriageStateStore.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

describe('authenticated script-result coverage', () => {
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
    } finally {
      ledger.close();
      SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/integration/job-supervision-routes.test.ts' });
    }
  });
});
