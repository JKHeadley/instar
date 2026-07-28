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
import { CompletionEvaluator } from '../../src/core/CompletionEvaluator.js';
import type { Server } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

let project: TempProject;
let server: Server;
let baseUrl: string;
const sentInputs: Array<{ tmux: string; input: string }> = [];

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
      autonomousSessions: {
        maxConcurrent: 2,
        codexTaskContinuation: { enabled: true, maxDurationSeconds: 3600, maxContinuations: 3 },
      },
    } as InstarConfig;
    const state = new StateManager(project.stateDir);

    const app = express();
    app.use(express.json());
    const router = createRoutes({
      config, state,
      sessionManager: { sendInput: (tmux: string, input: string) => { sentInputs.push({ tmux, input }); return true; } } as any,
      scheduler: null, telegram: null, relationships: null,
      feedback: null, dispatches: null, updateChecker: null, autoUpdater: null,
      autoDispatcher: null, quotaTracker: null, publisher: null, viewer: null, tunnel: null,
      evolution: null, watchdog: null, triageNurse: null, topicMemory: null,
      feedbackAnomalyDetector: null, projectMapper: null, coherenceGate: null,
      contextHierarchy: null, canonicalState: null, operationGate: null, sentinel: null,
      adaptiveTrust: null, memoryMonitor: null, orphanReaper: null, coherenceMonitor: null,
      commitmentTracker: null, semanticMemory: null, activitySentinel: null, workingMemory: null,
      quotaManager: null, systemReviewer: null, capabilityMapper: null, topicResumeMap: null,
      autonomyManager: null as any, trustElevationTracker: null as any, autonomousEvolution: null,
      discoveryEvaluator: null,
      // Stub IntelligenceProvider: "MET" only when the transcript mentions "passed".
      completionEvaluator: new CompletionEvaluator({
        intelligence: {
          async evaluate(prompt: string) {
            return /passed/i.test(prompt) ? 'MET\nthe transcript shows tests passed' : 'NOT_MET\nno passing evidence yet';
          },
        },
      }),
      startTime: new Date(),
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

  it('POST /autonomous/evaluate-completion returns met:true when the transcript shows success', async () => {
    const res = await fetch(`${baseUrl}/autonomous/evaluate-completion`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ condition: 'all tests pass', transcriptTail: 'npm test → 42 passed' }),
    });
    expect(res.status).toBe(200);
    const v = await res.json();
    expect(v.met).toBe(true);
    expect(v.reason).toBeTruthy();
  });

  it('POST /autonomous/evaluate-completion returns met:false when there is no success evidence', async () => {
    const res = await fetch(`${baseUrl}/autonomous/evaluate-completion`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ condition: 'all tests pass', transcriptTail: 'still writing code' }),
    });
    const v = await res.json();
    expect(v.met).toBe(false);
  });

  it('POST /autonomous/evaluate-completion 400s without a condition', async () => {
    const res = await fetch(`${baseUrl}/autonomous/evaluate-completion`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it('drives the task-continuation lifecycle through the real HTTP routes', async () => {
    const started = await fetch(`${baseUrl}/continuation/start`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topicId: '458', tasks: ['first', 'second'] }),
    });
    expect(started.status).toBe(201);

    const first = await fetch(`${baseUrl}/continuation/decide`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topicId: '458', sessionId: 'codex-session' }),
    });
    expect(await first.json()).toMatchObject({ decision: 'continue', openTaskCount: 2 });

    await fetch(`${baseUrl}/continuation/458/complete`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ordinal: 1 }),
    });
    const status = await (await fetch(`${baseUrl}/continuation/458/status`)).json();
    expect(status).toMatchObject({ active: true, taskCount: 2, openTaskCount: 1 });

    await fetch(`${baseUrl}/continuation/458/stop`, { method: 'POST' });
    const stopped = await fetch(`${baseUrl}/continuation/decide`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topicId: '458', sessionId: 'codex-session' }),
    });
    expect(await stopped.json()).toMatchObject({ decision: 'deactivate', reason: 'operator-stop' });

    const renewed = await fetch(`${baseUrl}/continuation/458/renew`, { method: 'POST' });
    expect(renewed.status).toBe(201);
    const renewedStatus = await (await fetch(`${baseUrl}/continuation/458/status`)).json();
    expect(renewedStatus).toMatchObject({ active: true, taskCount: 2, openTaskCount: 1 });
    expect(renewedStatus.startedAt).toBeTypeOf('string');
    expect(renewedStatus.expiresAt).toBeTypeOf('string');

    const ledgerPath = path.join(project.stateDir, 'continuation', '458.local.json');
    const corruptTimestamp = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
    corruptTimestamp.startedAt = 'not-a-date';
    fs.writeFileSync(ledgerPath, JSON.stringify(corruptTimestamp));
    const corruptStatus = await (await fetch(`${baseUrl}/continuation/458/status`)).json();
    expect(corruptStatus.expiresAt).toBeNull();
  });

  it('POST /autonomous/native-goal/set injects /goal <condition> and flips goal_mode', async () => {
    // registry maps topic 9984 -> tmux 'sess-x'; a per-topic job file exists.
    fs.writeFileSync(path.join(project.stateDir, 'topic-session-registry.json'),
      JSON.stringify({ topicToSession: { '9984': 'sess-x' }, topicToName: {} }));
    writeJob(project.stateDir, '9984');
    sentInputs.length = 0;

    const res = await fetch(`${baseUrl}/autonomous/native-goal/set`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topicId: '9984', condition: 'all tests pass' }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).mode).toBe('native');
    // injected the native /goal command into the topic's session
    expect(sentInputs).toContainEqual({ tmux: 'sess-x', input: '/goal all tests pass' });
    // goal_mode flipped in the per-topic state file
    const stateFile = path.join(project.stateDir, 'autonomous', '9984.local.md');
    expect(fs.readFileSync(stateFile, 'utf8')).toMatch(/goal_mode:\s*"native"/);
  });

  it('POST /autonomous/native-goal/clear injects /goal clear', async () => {
    sentInputs.length = 0;
    const res = await fetch(`${baseUrl}/autonomous/native-goal/clear`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ topicId: '9984' }),
    });
    expect(res.status).toBe(200);
    expect(sentInputs).toContainEqual({ tmux: 'sess-x', input: '/goal clear' });
  });

  it('POST /autonomous/native-goal/set 404s for an unknown topic', async () => {
    const res = await fetch(`${baseUrl}/autonomous/native-goal/set`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topicId: 'nope', condition: 'x' }),
    });
    expect(res.status).toBe(404);
  });
});
