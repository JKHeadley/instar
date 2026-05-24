/**
 * Integration test — multi-session autonomy API routes via HTTP.
 *
 * GET /autonomous/sessions, GET /autonomous/can-start (cap), POST /autonomous/stop-all,
 * POST /autonomous/sessions/:topic/stop.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTempProject } from '../helpers/setup.js';
import type { TempProject } from '../helpers/setup.js';
import { StateManager } from '../../src/core/StateManager.js';
import type { InstarConfig } from '../../src/core/types.js';
import express from 'express';
import { createRoutes } from '../../src/server/routes.js';
import type { Server } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

let project: TempProject;
let server: Server;
let baseUrl: string;

function writeJob(stateDir: string, topic: string) {
  fs.mkdirSync(path.join(stateDir, 'autonomous'), { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, 'autonomous', `${topic}.local.md`),
    `---\nactive: true\npaused: false\niteration: 1\nreport_topic: "${topic}"\ngoal: "g${topic}"\n---\n\ntask\n`,
  );
}

describe('Multi-session autonomy API (integration)', () => {
  beforeAll(async () => {
    project = createTempProject();
    const config: InstarConfig = {
      projectDir: project.dir,
      stateDir: project.stateDir,
      projectName: 'test-project',
      agentName: 'test-agent',
      autonomousSessions: { maxConcurrent: 2 },
    } as InstarConfig;
    const state = new StateManager(project.stateDir);

    const app = express();
    app.use(express.json());
    const router = createRoutes({
      config, state,
      sessionManager: null as any, scheduler: null, telegram: null, relationships: null,
      feedback: null, dispatches: null, updateChecker: null, autoUpdater: null,
      autoDispatcher: null, quotaTracker: null, publisher: null, viewer: null, tunnel: null,
      evolution: null, watchdog: null, triageNurse: null, topicMemory: null,
      feedbackAnomalyDetector: null, projectMapper: null, coherenceGate: null,
      contextHierarchy: null, canonicalState: null, operationGate: null, sentinel: null,
      adaptiveTrust: null, memoryMonitor: null, orphanReaper: null, coherenceMonitor: null,
      commitmentTracker: null, semanticMemory: null, activitySentinel: null, workingMemory: null,
      quotaManager: null, systemReviewer: null, capabilityMapper: null, topicResumeMap: null,
      autonomyManager: null as any, trustElevationTracker: null as any, autonomousEvolution: null,
      discoveryEvaluator: null, startTime: new Date(),
    } as any);
    app.use(router);
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    project.cleanup();
  });

  it('GET /autonomous/sessions lists active per-topic jobs', async () => {
    writeJob(project.stateDir, '9984');
    writeJob(project.stateDir, '12143');
    const res = await fetch(`${baseUrl}/autonomous/sessions`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.sessions.map((s: any) => s.topic).sort()).toEqual(['12143', '9984']);
  });

  it('GET /autonomous/can-start refuses at the cap (2)', async () => {
    // two jobs already written above → at the cap of 2
    const res = await fetch(`${baseUrl}/autonomous/can-start?priority=medium`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.allowed).toBe(false);
    expect(body.reason).toContain('concurrency cap');
    expect(body.maxConcurrent).toBe(2);
  });

  it('POST /autonomous/sessions/:topic/stop stops exactly one', async () => {
    const res = await fetch(`${baseUrl}/autonomous/sessions/9984/stop`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
    const list = await (await fetch(`${baseUrl}/autonomous/sessions`)).json();
    expect(list.sessions.map((s: any) => s.topic)).toEqual(['12143']);

    // now under the cap → can-start allowed
    const can = await (await fetch(`${baseUrl}/autonomous/can-start`)).json();
    expect(can.allowed).toBe(true);
  });

  it('POST /autonomous/sessions/:topic/stop returns 404 for unknown topic', async () => {
    const res = await fetch(`${baseUrl}/autonomous/sessions/nope/stop`, { method: 'POST' });
    expect(res.status).toBe(404);
  });

  it('POST /autonomous/stop-all clears everything', async () => {
    writeJob(project.stateDir, '777');
    const res = await fetch(`${baseUrl}/autonomous/stop-all`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
    const list = await (await fetch(`${baseUrl}/autonomous/sessions`)).json();
    expect(list.sessions).toEqual([]);
  });
});
