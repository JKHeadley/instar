/**
 * Integration / e2e (Tier 2+3) for the Usher pull surface (rung 4).
 *
 * Boots a real AgentServer (production init path) with a UsherSignalStore and
 * verifies the read-only pull surface: GET /usher/signals + /usher/metrics
 * (with precision), and the 503-stub when the store is absent. Plus a
 * wiring-integrity source guard that server.ts attaches the Usher to the live
 * message callback (anti-"shipped-but-asleep").
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { UsherSignalStore } from '../../src/core/UsherSignalStore.js';
import { createTempProject, createMockSessionManager } from '../helpers/setup.js';
import type { TempProject, MockSessionManager } from '../helpers/setup.js';
import type { InstarConfig } from '../../src/core/types.js';

const AUTH = 'usher-routes-token';
function buildConfig(project: TempProject): InstarConfig {
  return {
    projectName: 'usher', projectDir: project.dir, stateDir: project.stateDir,
    port: 0, authToken: AUTH, requestTimeoutMs: 5000, version: '0.0.0',
    sessions: { claudePath: '/usr/bin/echo', maxSessions: 3, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5000 },
    scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 },
    messaging: [], monitoring: {}, updates: {},
  } as InstarConfig;
}

describe('Usher pull surface (rung 4)', () => {
  let project: TempProject;
  let mockSM: MockSessionManager;
  let store: UsherSignalStore;
  let server: AgentServer;
  let app: ReturnType<AgentServer['getApp']>;

  beforeAll(() => {
    project = createTempProject();
    fs.writeFileSync(path.join(project.stateDir, 'config.json'), JSON.stringify({ port: 0, projectName: 'usher', agentName: 'Usher' }));
    mockSM = createMockSessionManager();
    store = new UsherSignalStore(project.stateDir);
    const id = store.recordSignal(42, { contextRef: 'ref-tel', contextText: 'we are testing over Telegram', reason: 'the user just asked how we verify', turn: 5 });
    store.markActed(42, id!); // one acted → precision 1.0

    server = new AgentServer({ config: buildConfig(project), sessionManager: mockSM as any, state: project.state, usherSignalStore: store });
    app = server.getApp();
  });
  afterAll(() => { project?.cleanup(); });
  const auth = () => ({ Authorization: `Bearer ${AUTH}` });

  it('the surface is alive: GET /usher/signals returns the recorded signal', async () => {
    const res = await request(app).get('/usher/signals').query({ topicId: 42 }).set(auth());
    expect(res.status).toBe(200);
    expect(res.body.signals.length).toBe(1);
    expect(res.body.signals[0].contextRef).toBe('ref-tel');
    expect(res.body.signals[0].reason).toContain('verify');
  });

  it('GET /usher/metrics exposes fired/acted + precision', async () => {
    const res = await request(app).get('/usher/metrics').query({ topicId: 42 }).set(auth());
    expect(res.status).toBe(200);
    expect(res.body.metrics.fired).toBe(1);
    expect(res.body.metrics.acted).toBe(1);
    expect(res.body.metrics.precision).toBe(1);
  });

  it('400 without a topicId', async () => {
    const res = await request(app).get('/usher/signals').set(auth());
    expect(res.status).toBe(400);
  });

  it('a topic with no signals returns an empty list (not an error)', async () => {
    const res = await request(app).get('/usher/signals').query({ topicId: 999 }).set(auth());
    expect(res.status).toBe(200);
    expect(res.body.signals).toEqual([]);
  });
});

describe('Usher disabled', () => {
  it('503-stubs the surface when the store is absent', async () => {
    const project = createTempProject();
    fs.writeFileSync(path.join(project.stateDir, 'config.json'), JSON.stringify({ port: 0, projectName: 'u2', agentName: 'U2' }));
    const server = new AgentServer({ config: buildConfig(project), sessionManager: createMockSessionManager() as any, state: project.state, usherSignalStore: null });
    const res = await request(server.getApp()).get('/usher/signals').query({ topicId: 1 }).set({ Authorization: `Bearer ${AUTH}` });
    expect(res.status).toBe(503);
    project.cleanup();
  });
});

describe('precision split (acted_by_use / acted_by_miss)', () => {
  let project: TempProject;
  let server: AgentServer;
  let app: ReturnType<AgentServer['getApp']>;

  beforeAll(() => {
    project = createTempProject();
    fs.writeFileSync(path.join(project.stateDir, 'config.json'), JSON.stringify({ port: 0, projectName: 'usplit', agentName: 'USplit' }));
    const store = new UsherSignalStore(project.stateDir);
    const a = store.recordSignal(77, { contextRef: 'r1', contextText: 'unify the memory stores', reason: 'r', turn: 1 });
    const b = store.recordSignal(77, { contextRef: 'r2', contextText: 'we are testing over telegram', reason: 'r', turn: 2 });
    store.recordSignal(77, { contextRef: 'r3', contextText: 'unrelated', reason: 'r', turn: 3 }); // stays unacted
    store.markActed(77, a!, { via: 'use' });
    store.markActed(77, b!, { via: 'miss' });
    server = new AgentServer({ config: buildConfig(project), sessionManager: createMockSessionManager() as any, state: project.state, usherSignalStore: store });
    app = server.getApp();
  });
  afterAll(() => { project?.cleanup(); });

  it('GET /usher/metrics splits the numerator by path and computes precision', async () => {
    const res = await request(app).get('/usher/metrics').query({ topicId: 77 }).set({ Authorization: `Bearer ${AUTH}` });
    expect(res.status).toBe(200);
    expect(res.body.metrics.fired).toBe(3);
    expect(res.body.metrics.acted).toBe(2);
    expect(res.body.metrics.acted_by_use).toBe(1);
    expect(res.body.metrics.acted_by_miss).toBe(1);
    expect(res.body.metrics.precision).toBeCloseTo(2 / 3, 5);
  });

  it('a legacy topic (no acted) still reports the split fields as 0', async () => {
    const res = await request(app).get('/usher/metrics').query({ topicId: 4242 }).set({ Authorization: `Bearer ${AUTH}` });
    expect(res.status).toBe(200);
    expect(res.body.metrics.acted_by_use).toBe(0);
    expect(res.body.metrics.acted_by_miss).toBe(0);
    expect(res.body.metrics.precision).toBeNull();
  });
});

describe('wiring-integrity (anti-shipped-but-asleep)', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  it('server.ts attaches the Usher loop to the live message callback', () => {
    const src = fs.readFileSync(path.join(here, '../../src/commands/server.ts'), 'utf-8');
    expect(src).toContain('createUsherLoop(');
    expect(src).toContain('__instarUsherWired');
    expect(src).toMatch(/telegram\.onMessageLogged\s*=\s*\(entry\)\s*=>\s*\{[\s\S]*usherLoop\(/);
  });

  it('routes.ts credits the Usher (path a) on the outbound reply path', () => {
    const src = fs.readFileSync(path.join(here, '../../src/server/routes.ts'), 'utf-8');
    expect(src).toContain('creditUsherOnOutbound');
    expect(src).toMatch(/creditUsherOnOutbound\(ctx\.usherSignalStore,\s*topicId,\s*text\)/);
  });

  it('server.ts credits the Usher (path b) right after the human-as-detector observe', () => {
    const src = fs.readFileSync(path.join(here, '../../src/commands/server.ts'), 'utf-8');
    expect(src).toContain('creditUsherOnMiss');
    // the miss signal returned by observeInboundMessage feeds the correlator
    expect(src).toMatch(/const missSignal = observeInboundMessage\(humanAsDetectorLog,\s*entry\)/);
    expect(src).toMatch(/creditUsherOnMiss\(usherSignalStore,\s*missSignal,\s*entry\)/);
  });
});
