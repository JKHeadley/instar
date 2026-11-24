import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { expect, it } from 'vitest';
import { InitiativeTracker } from '../../src/core/InitiativeTracker.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { StateManager } from '../../src/core/StateManager.js';
import type { InstarConfig } from '../../src/core/types.js';
import { AgentServer } from '../../src/server/AgentServer.js';
import { TaskFlowStore } from '../../src/tasks/task-flow-registry.store.sqlite.js';
import { TaskFlowRegistry } from '../../src/tasks/TaskFlowRegistry.js';
import { createTaskFlowProjectsComparisonSource } from '../../src/tasks/taskFlowProjectsComparison.js';
import { createMockSessionManager } from '../helpers/setup.js';

it('shows current native Projects evidence to a private Work owner and leaves the other source unchecked', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'project-list-comparison-e2e-'));
  const stateDir = path.join(root, '.instar');
  fs.mkdirSync(stateDir);
  fs.writeFileSync(path.join(stateDir, 'config.json'), '{}');
  const databasePath = path.join(stateDir, 'task-flows.db');
  const store = new TaskFlowStore({ dbPath: databasePath });
  let server: AgentServer | undefined;
  try {
    await store.open();
    const tracker = new InitiativeTracker(stateDir);
    tracker.setTaskFlowRegistry(new TaskFlowRegistry({ store }), 'comparison-fixture-owner');
    await tracker.create({
      id: 'hidden-id-not-in-response', kind: 'project', title: 'Current fixture project',
      description: 'Internal description', phases: [{ id: 'start', name: 'Start' }],
    });
    // The disposable isolated database and every flow in this test have one owner and
    // no external writers. Raw database revisions are valid only under this fixture scope.
    let wholeFixtureAccess = true;
    const source = createTaskFlowProjectsComparisonSource({
      workerUrl: new URL('../../dist/tasks/taskFlowProjectsComparison.worker.js', import.meta.url),
      proveAuthority: () => tracker.proveWholeTaskFlowProjectsComparison(() => wholeFixtureAccess),
    });
    const cfg = {
      projectName: 'comparison-e2e', projectDir: root, stateDir, port: 0,
      developmentAgent: true, throwawayAgent: { createdAt: new Date().toISOString() },
      projectListComparison: { enabled: true },
      authToken: 'comparison-fixture-master', dashboardPin: '456789',
      security: { dashboardScopedToken: { enabled: true } },
      sessions: { claudePath: '/usr/bin/echo', maxSessions: 1, protectedSessions: [], monitorIntervalMs: 5_000 },
      scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 }, messaging: [], updates: {},
    } as InstarConfig;
    server = new AgentServer({
      config: cfg, state: new StateManager(stateDir), sessionManager: createMockSessionManager() as never,
      initiativeTracker: tracker, projectComparisonSources: { projects: source },
    });
    await server.start();
    const app = server.getApp();
    const plainBearer = 'Bearer comparison-fixture-master';
    await request(app).get('/work/projects/compare').set('Authorization', plainBearer)
      .expect(403).expect('Cache-Control', 'no-store');
    const rawProjects = await request(app).get('/work/projects').set('Authorization', plainBearer).expect(200);
    expect(rawProjects.body.comparisonAvailable).toBeUndefined();
    const unlocked = await request(app).post('/dashboard/unlock').send({ pin: '456789' }).expect(200);
    expect(unlocked.body.token).toMatch(/^dst_/);
    const owner = 'Bearer ' + unlocked.body.token;
    await request(app).get('/work/projects').set('Authorization', owner).expect(403);
    await request(app).head('/work/projects/compare').set('Authorization', plainBearer).expect(403);
    await request(app).head('/work/projects/compare').set('Authorization', owner)
      .expect(204).expect('Cache-Control', 'no-store');

    const result = await request(app).get('/work/projects/compare').set('Authorization', owner)
      .expect(200).expect('Cache-Control', 'no-store');
    expect(result.body).toMatchObject({
      schemaVersion: 1, status: 'partial', truncated: false,
      coverage: { projects: { status: 'complete' }, chiefOfStaff: { status: 'unavailable' } },
      rows: [{ state: 'counterpart-unchecked', projects: [{ title: 'Current fixture project' }], chiefOfStaff: [] }],
    });
    expect(result.text).not.toMatch(/hidden-id-not-in-response|Internal description/);
    const matches = await request(app).get('/work/projects/compare?view=matches').set('Authorization', owner).expect(200);
    expect(matches.body).toMatchObject({ status: 'partial', rows: [] });
    wholeFixtureAccess = false;
    await request(app).get('/work/projects/compare').set('Authorization', owner)
      .expect(503).expect('Cache-Control', 'no-store');
    fs.mkdirSync(path.join(stateDir, 'conversation-graph'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'conversation-graph', 'owner-intent-policy.json'), '{}');
    await request(app).head('/work/projects/compare').set('Authorization', owner).expect(403);
  } finally {
    if (server) await server.stop();
    store.close();
    SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'project-list-comparison-e2e' });
  }
}, 25_000);
