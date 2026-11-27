/** CI-owned AgentServer composition test. Never run a test agent on the operator laptop. */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { JobScheduler } from '../../src/scheduler/JobScheduler.js';
import { TelegramAdapter } from '../../src/messaging/TelegramAdapter.js';
import { NotificationSelectivityGate } from '../../src/messaging/NotificationSelectivityGate.js';
import { NotificationPreferences } from '../../src/messaging/NotificationPreferences.js';
import { createMockSessionManager } from '../helpers/setup.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { InstarConfig } from '../../src/core/types.js';

describe('notification preferences — production registration', () => {
  it('uses the sole writer through the real read-only route context and protects fixed reply floors', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'quiet-preferences-alive-'));
    const stateDir = path.join(root, '.instar');
    for (const dir of ['state/sessions', 'state/jobs', 'logs']) fs.mkdirSync(path.join(stateDir, dir), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), '{}');
    const values = new Map<string, unknown>();
    const liveConfig = { get: <T>(key: string, fallback: T): T => (values.get(key) ?? fallback) as T, set: (key: string, value: unknown) => { values.set(key, value); } };
    const gate = new NotificationSelectivityGate(stateDir, 'ci-machine', () => ({ enabled: true, dryRun: false, push: { categories: { 'job-status': liveConfig.get('notifications.selectivity.push.categories.job-status', false), 'spend-alert': liveConfig.get('notifications.selectivity.push.categories.spend-alert', false) }, jobs: { 'instar2-checkin': liveConfig.get('notifications.selectivity.push.jobs.instar2-checkin', undefined as unknown as boolean) } } }));
    gate.preferences = new NotificationPreferences({ root: stateDir, self: () => 'ci-machine', peers: () => [],
      apply: (category, enabled) => liveConfig.set(`notifications.selectivity.push.categories.${category}`, enabled),
      applyJob: (slug, enabled) => liveConfig.set(`notifications.selectivity.push.jobs.${slug}`, enabled), send: async () => false });
    const telegram = new TelegramAdapter({ token: '123:test', chatId: '-1001' }, stateDir); telegram.selectivity = gate;
    const config = { projectName: 'quiet-preferences-alive', projectDir: root, stateDir, port: 0, authToken: 'ci-token', dashboardPin: '123456',
      developmentAgent: true, sessions: { claudePath: '/usr/bin/echo', maxSessions: 1, defaultMaxDurationMinutes: 1, protectedSessions: [], monitorIntervalMs: 5000 },
      scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 }, messaging: [], updates: {} } as unknown as InstarConfig;
    const sessionManager = createMockSessionManager() as any; sessionManager.on = () => undefined;
    // A real scheduler that has never loaded this file: the route must see a job written seconds ago.
    const jobsFile = path.join(stateDir, 'jobs.json');
    fs.writeFileSync(jobsFile, JSON.stringify([{ slug: 'instar2-checkin', name: 'Check-in', description: 'Reports status', schedule: '0 * * * *', priority: 'medium', model: 'sonnet', enabled: true, execute: { type: 'prompt', value: 'Report status' } }]));
    const state = new StateManager(stateDir);
    const scheduler = new JobScheduler({ jobsFile, enabled: false, maxParallelJobs: 1, quotaThresholds: { normal: 50, elevated: 70, critical: 85, shutdown: 95 } }, sessionManager, state, stateDir);
    const server = new AgentServer({ config, sessionManager, state, telegram, liveConfig, scheduler });
    try {
      const app = server.getApp(); // No CLI agent or native session is started.
      const unlock = await request(app).post('/dashboard/unlock').send({ pin: '123456' });
      expect(unlock.status).toBe(200);
      const auth = (q: request.Test) => q.set('Authorization', 'Bearer ci-token').set('X-Instar-AgentId', config.projectName);
      const changed = await auth(request(app).post('/notifications/categories/job-status/push')).set('X-Instar-Operator-Session', unlock.body.operatorSessionToken).send({ enabled: true, confirmedBy: 'dashboard-pin' });
      expect(changed.status).toBe(200);
      expect(liveConfig.get('notifications.selectivity.push.categories.job-status', false)).toBe(true);
      const spend = await auth(request(app).post('/notifications/categories/spend-alert/push')).set('X-Instar-Operator-Session', unlock.body.operatorSessionToken).send({ enabled: true, confirmedBy: 'dashboard-pin' });
      expect(spend.status).toBe(200);
      const status = await auth(request(app).get('/notifications/selectivity'));
      expect(status.status).toBe(200);
      expect(status.body.categories.find((row: { id: string }) => row.id === 'spend-alert').push).toBe(true);
      expect(status.body.categories.find((row: { id: string }) => row.id === 'job-status').push).toBe(true);
      expect(status.body.categories.find((row: { id: string }) => row.id === 'command-response').configurable).toBe(false);
      // Per-job opt-in is alive on the same production route context.
      const job = await auth(request(app).post('/notifications/jobs/instar2-checkin/push')).set('X-Instar-Operator-Session', unlock.body.operatorSessionToken).send({ enabled: true, confirmedBy: 'dashboard-pin' });
      expect(job.status).toBe(200);
      expect(liveConfig.get('notifications.selectivity.push.jobs.instar2-checkin', false)).toBe(true);
      expect(job.body.message).toContain('Attention topic');
      expect((await auth(request(app).post('/notifications/jobs/instar2-checkin/push')).send({ enabled: true, confirmedBy: 'dashboard-pin' })).status).toBe(400);
      expect((await auth(request(app).post('/notifications/jobs/missing/push')).set('X-Instar-Operator-Session', unlock.body.operatorSessionToken).send({ enabled: true, confirmedBy: 'dashboard-pin' })).status).toBe(404);
      expect((await auth(request(app).get('/notifications/selectivity'))).body.jobs[0]).toMatchObject({ slug: 'instar2-checkin', decided: true });
      const floor = await auth(request(app).post('/notifications/categories/command-response/push')).set('X-Instar-Operator-Session', unlock.body.operatorSessionToken).send({ enabled: false, confirmedBy: 'dashboard-pin' });
      expect(floor.status).toBe(400);
    } finally {
      await server.stop(); await gate.close(); await telegram.stop();
      SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'notification preferences alive fixture' });
    }
  });
});
