/**
 * Integration / e2e (Tier 2+3) for rung-2 store unification.
 *
 * Boots a real AgentServer (the production init path) with a
 * WorkingMemoryAssembler wired to a real TopicIntentStore, and verifies the
 * assembled-context HTTP route surfaces the unified "Working Set" section
 * drawing from topic-intent — the unified read path, alive end-to-end. Also
 * pins that with no topic-intent content the route is unchanged (no working-set).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { WorkingMemoryAssembler } from '../../src/memory/WorkingMemoryAssembler.js';
import { TopicIntentStore, buildEvent } from '../../src/core/TopicIntent.js';
import { createTempProject, createMockSessionManager } from '../helpers/setup.js';
import type { TempProject, MockSessionManager } from '../helpers/setup.js';
import type { InstarConfig } from '../../src/core/types.js';

const AUTH = 'cwa-unify-routes-token';

function buildConfig(project: TempProject, name: string): InstarConfig {
  return {
    projectName: name, projectDir: project.dir, stateDir: project.stateDir,
    port: 0, authToken: AUTH, requestTimeoutMs: 5000, version: '0.0.0',
    sessions: { claudePath: '/usr/bin/echo', maxSessions: 3, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5000 },
    scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 },
    messaging: [], monitoring: {}, updates: {},
  } as InstarConfig;
}

describe('GET /session/context/:topicId — unified working set (rung 2)', () => {
  let project: TempProject;
  let mockSM: MockSessionManager;
  let store: TopicIntentStore;
  let server: AgentServer;
  let app: ReturnType<AgentServer['getApp']>;

  beforeAll(() => {
    project = createTempProject();
    fs.writeFileSync(path.join(project.stateDir, 'config.json'), JSON.stringify({ port: 0, projectName: 'cwa-unify', agentName: 'CWA' }));
    mockSM = createMockSessionManager();
    store = new TopicIntentStore(project.stateDir);
    // Populate topic 42 with a decision the working set should surface.
    store.appendEvidence(42, 'r1', buildEvent('r1', 'extract-user', 'm1'), { text: 'we will deploy via blue-green', kind: 'decision' });

    const assembler = new WorkingMemoryAssembler({ topicIntentStore: store, stateDir: project.stateDir });
    server = new AgentServer({
      config: buildConfig(project, 'cwa-unify'),
      sessionManager: mockSM as any,
      state: project.state,
      workingMemory: assembler,
    });
    app = server.getApp();
  });

  afterAll(() => { project?.cleanup(); });

  const auth = () => ({ Authorization: `Bearer ${AUTH}` });

  it('the unified read path is alive: 200 with the assembled payload shape', async () => {
    const res = await request(app).get('/session/context/42').set(auth()).query({ prompt: 'how are we deploying' });
    expect(res.status).toBe(200);
    expect(typeof res.body.context).toBe('string');
    expect(Array.isArray(res.body.sources)).toBe(true);
  });

  it('surfaces the topic-intent ref in a Working Set section', async () => {
    const res = await request(app).get('/session/context/42').set(auth()).query({ prompt: 'how are we deploying' });
    expect(res.status).toBe(200);
    expect(res.body.context).toContain('Working Set');
    expect(res.body.context).toContain('blue-green');
    expect(res.body.sources.find((s: { name: string }) => s.name === 'working-set')).toBeDefined();
  });

  it('a topic with no refs yields no working-set section (additive — unchanged when empty)', async () => {
    const res = await request(app).get('/session/context/999').set(auth()).query({ prompt: 'nothing here' });
    expect(res.status).toBe(200);
    expect(res.body.sources.find((s: { name: string }) => s.name === 'working-set')).toBeUndefined();
    expect(res.body.context).not.toContain('Working Set');
  });
});
