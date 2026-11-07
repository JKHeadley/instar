import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { createMockSessionManager } from '../helpers/setup.js';
import type { InstarConfig } from '../../src/core/types.js';
import { installBuiltinJobs } from '../../src/scheduler/InstallBuiltinJobs.js';

const AUTH = 'failure-default-lifecycle';
describe('default failure-callout production lifecycle', () => {
  it('is available without preference opt-in and refuses preference promotion', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'failure-default-e2e-'));
    const stateDir = path.join(root, '.instar');
    fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
    const config = { projectName: 'failure-default', projectDir: root, stateDir, port: 0, authToken: AUTH } as InstarConfig;
    const server = new AgentServer({ config, state: new StateManager(stateDir), sessionManager: createMockSessionManager() as any });
    const auth = { Authorization: `Bearer ${AUTH}` };
    const app = server.getApp();
    try {
      expect((await request(app).get('/corrections?scope=pool&severity=failure-callout&unresolved=true').set(auth)).status).toBe(200);
      expect((await request(app).post('/corrections/analyze').set(auth)).status).toBe(503);
      for (const slug of ['telegram-group-handoff', 'locked-screen-false-blocker', 'false-review-wait-without-link']) {
        const fixture = JSON.parse(fs.readFileSync(new URL(`../fixtures/failure-callouts/${slug}.json`, import.meta.url), 'utf8'));
        const created = await request(app).post('/corrections').set(auth).set('X-Instar-Request', '1')
          .send({ kind: 'infra-gap', severity: 'failure-callout', learning: fixture.learning, topicId: fixture.topicId, failureContext: fixture.context });
        expect(created.status).toBe(201);
        const endpoint = `/corrections/${created.body.id}/failure-case`;
        const diagnosis = { classification: 'enforcement-gap', standardRefs: ['Operator approves, agent does work'], rootCause: fixture.context.decisions.join(' '), classFix: 'Repair the responsible decision boundary', fixRefs: [] };
        const investigated = await request(app).patch(endpoint).set(auth).set('X-Instar-Request', '1').send({ version: created.body.version, investigation: diagnosis });
        expect(investigated.status).toBe(200);
        const premature = await request(app).patch(endpoint).set(auth).set('X-Instar-Request', '1').send({ version: investigated.body.version, verification: { scenario: slug, baselineRef: 'source-message', replayRef: 'not-yet-run', allowedCaseRef: 'not-yet-run', replayPassed: true, allowedCasePassed: true } });
        expect(premature.status).toBe(400);
        const repeat = await request(app).post('/corrections').set(auth).set('X-Instar-Request', '1')
          .send({ kind: 'infra-gap', severity: 'failure-callout', learning: fixture.learning, topicId: fixture.topicId, failureContext: fixture.context });
        expect(repeat.body.failureCase.state).toBe('reopened');
        const stale = await request(app).patch(endpoint).set(auth).set('X-Instar-Request', '1').send({ version: investigated.body.version, investigation: diagnosis });
        expect(stale.status).toBe(409);
      }
      const queue = await request(app).get('/corrections?scope=pool&severity=failure-callout&unresolved=true').set(auth);
      expect(queue.body.records).toHaveLength(3);
      expect(queue.body.records.every((r: any) => r.failureCase === undefined)).toBe(true);
      expect(fs.existsSync(path.join(stateDir, 'preferences.json'))).toBe(false);
    } finally { SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'failure-default-lifecycle' }); }
  });

  it('installs and refreshes the bounded investigator through the production job installer', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'failure-job-e2e-'));
    const packageRoot = path.resolve(new URL('../..', import.meta.url).pathname);
    try {
      const report = installBuiltinJobs({ agentStateDir: root, packageRoot, port: 4199 });
      expect(report.errors).toEqual([]);
      const job = path.join(root, 'jobs', 'instar', 'failure-callout-investigator.md');
      expect(fs.readFileSync(job, 'utf8')).toContain('scope=pool');
      expect(fs.readFileSync(job, 'utf8')).toContain('4199');
      const manifest = JSON.parse(fs.readFileSync(path.join(root, 'jobs', 'schedule', 'failure-callout-investigator.json'), 'utf8'));
      expect(manifest.enabled).toBe(true);
      fs.writeFileSync(job, 'stale built-in');
      installBuiltinJobs({ agentStateDir: root, packageRoot, port: 4199 });
      expect(fs.readFileSync(job, 'utf8')).toContain('constitution-gap');
    } finally { SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'failure-job-install-lifecycle' }); }
  });
});
