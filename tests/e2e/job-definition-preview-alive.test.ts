import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { expect, it } from 'vitest';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { StateManager } from '../../src/core/StateManager.js';
import type { InstarConfig } from '../../src/core/types.js';
import { JobDefinitionPreviewWorker } from '../../src/scheduler/JobDefinitionPreviewWorker.js';
import { AgentServer } from '../../src/server/AgentServer.js';
import { createMockSessionManager } from '../helpers/setup.js';

const PATH = '/jobs/reconcile';
const PREVIEW = PATH + '?preview=job-definitions';

it('uses the actual dashboard operator unlock and paginates the selected disposable job catalog without writing', async () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'job-preview-e2e-'));
  const stateDir = path.join(root, '.instar');
  const catalogRoot = path.join(root, 'custom');
  fs.mkdirSync(stateDir);
  fs.mkdirSync(catalogRoot);
  fs.writeFileSync(path.join(stateDir, 'config.json'), '{}');
  const jobsFile = path.join(catalogRoot, 'fixture-jobs.json');
  const jobs = Array.from({ length: 251 }, (_, number) => ({
    slug: 'demo-job-' + String(number).padStart(3, '0'), schedule: '0 * * * *',
    name: 'Private label', description: 'Private description', enabled: true,
    priority: 'low', expectedDurationMinutes: 1, execute: { type: 'prompt', value: 'Private prompt body' },
  }));
  const bytes = JSON.stringify(jobs);
  fs.writeFileSync(jobsFile, bytes);
  let server: AgentServer | undefined;
  try {
    const config = {
      projectName: 'job-preview-e2e', projectDir: root, stateDir, port: 0,
      developmentAgent: true, throwawayAgent: { createdAt: new Date().toISOString() },
      jobDefinitionPreview: { enabled: true },
      authToken: 'job-preview-fixture-master', dashboardPin: '345890',
      security: { dashboardScopedToken: { enabled: true } },
      sessions: { claudePath: '/usr/bin/echo', maxSessions: 1, protectedSessions: [], monitorIntervalMs: 5_000 },
      scheduler: { enabled: false, jobsFile, maxParallelJobs: 1 }, messaging: [], updates: {},
    } as InstarConfig;
    class ControlledWorker extends JobDefinitionPreviewWorker {
      beforeRelease?: () => void;
      override async read(input: Parameters<JobDefinitionPreviewWorker['read']>[0]) {
        const result = await super.read(input);
        this.beforeRelease?.();
        return result;
      }
    }
    const worker = new ControlledWorker(new URL('../../dist/scheduler/JobDefinitionPreviewWorker.worker.js', import.meta.url));
    server = new AgentServer({
      config, state: new StateManager(stateDir), sessionManager: createMockSessionManager() as never,
      jobDefinitionPreviewWorker: worker,
    });
    await server.start();
    const app = server.getApp();
    const raw = 'Bearer job-preview-fixture-master';
    await request(app).get(PREVIEW).set('Authorization', raw).expect(403).expect('Cache-Control', 'no-store');
    const unlock = await request(app).post('/dashboard/unlock').send({ pin: '345890' }).expect(200);
    expect(unlock.body.token).toMatch(/^dst_/);
    expect(unlock.body.operatorSessionToken).toEqual(expect.any(String));
    const read = (url: string) => request(app).get(url).set('Authorization', 'Bearer ' + unlock.body.token)
      .set('X-Instar-Operator-Session', unlock.body.operatorSessionToken);
    const ordinary = await read(PATH).expect(200);
    expect(ordinary.body).toMatchObject({ findings: [], previewAvailable: true });
    const first = await read(PREVIEW).expect(200).expect('Cache-Control', 'no-store');
    expect(first.body).toMatchObject({ schemaVersion: 1, complete: true, truncated: true, scheduler: 'unknown', pool: 'unchecked' });
    expect(first.body.rows).toHaveLength(250);
    expect(first.body.cursor).toEqual(expect.any(String));
    expect(first.text).not.toMatch(/Private prompt body|Private description|fixture-jobs\.json/);
    const nextUrl = PREVIEW + '&cursor=' + encodeURIComponent(first.body.cursor);
    const second = await read(nextUrl).expect(200);
    expect(second.body.rows.map((row: { slug: string }) => row.slug)).toEqual(['demo-job-250']);
    expect(second.body.cursor).toBeUndefined();
    expect(fs.readFileSync(jobsFile, 'utf8')).toBe(bytes);
    expect(fs.readdirSync(catalogRoot)).toEqual(['fixture-jobs.json']);

    jobs[250].schedule = '30 * * * *';
    fs.writeFileSync(jobsFile, JSON.stringify(jobs)); // A native fixture change, not a preview side effect.
    await read(nextUrl).expect(409);
    worker.beforeRelease = () => { config.security!.dashboardScopedToken!.enabled = false; };
    await read(PREVIEW).expect(403);
    worker.beforeRelease = undefined;
    config.security!.dashboardScopedToken!.enabled = true;
    config.dashboardPin = '987650';
    await read(PREVIEW).expect(403);
  } finally {
    if (server) await server.stop();
    SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'job-definition-preview-e2e' });
  }
}, 25_000);
