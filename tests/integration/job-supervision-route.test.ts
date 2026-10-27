/** Full HTTP/auth path for the daily script-job supervision pass. */
import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { authMiddleware } from '../../src/server/middleware.js';
import { createScriptSupervisionRoutes } from '../../src/server/scriptSupervisionRoutes.js';
import { ScriptJobSupervisor } from '../../src/scheduler/ScriptJobSupervisor.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

describe('POST /jobs/script-supervision/pass', () => {
  it('requires auth, reports missing wiring, and delegates a wired pass to the real supervisor', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-supervision-route-'));
    const token = 'supervision-integration';
    const app = express();
    app.use(express.json());
    app.use(authMiddleware(() => token, 'test'));
    const deps: { supervisor: ScriptJobSupervisor | null } = { supervisor: null };
    app.use(createScriptSupervisionRoutes(deps));
    let calls = 0;
    const raised: string[] = [];
    try {
      expect((await request(app).post('/jobs/script-supervision/pass')).status).toBe(401);
      expect((await request(app).post('/jobs/script-supervision/pass').set('Authorization', `Bearer ${token}`)).status).toBe(503);
      deps.supervisor = new ScriptJobSupervisor({
        fetchPoolJobs: async () => ({ jobs: [{ slug: 'health-check', machineId: 'm-1', runner: 'script', recentOutputs: ['disk low'] }] }),
        intelligence: { evaluate: async () => { calls++; return '{"flags":[{"slug":"health-check","machineId":"m-1","reason":"disk remains low"}]}'; } },
        machineId: 'm-1', logsDir: path.join(dir, 'logs'),
        raiseAttention: item => { raised.push(item.conditionKey); },
        clearAttention: () => {}, listOpenConditionKeys: () => [],
      });
      const response = await request(app).post('/jobs/script-supervision/pass').set('Authorization', `Bearer ${token}`);
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ ok: true, reviewed: 1, raised: ['script-supervision:m-1:health-check'] });
      expect(calls).toBe(1);
      expect(raised).toEqual(['script-supervision:m-1:health-check']);
    } finally {
      SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/integration/job-supervision-route.test.ts' });
    }
  });
});
