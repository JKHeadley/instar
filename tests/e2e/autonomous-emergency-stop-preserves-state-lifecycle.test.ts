/**
 * E2E lifecycle: an emergency stop on a live-shaped autonomous run halts the
 * session and preserves the run record for release evidence.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import { createRoutes } from '../../src/server/routes.js';
import { StateManager } from '../../src/core/StateManager.js';
import { ProcessIntegrity } from '../../src/core/ProcessIntegrity.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { InstarConfig } from '../../src/core/types.js';

const AUTH_TOKEN = 'test-auth-token-deadbeef';
const TOPIC = 29723;
const SESSION = 'echo-lifecycle-worker';

describe('E2E: autonomous emergency-stop preserves state record', () => {
  let projectDir: string;
  let stateDir: string;
  let server: Server;
  let baseUrl: string;
  let killed: string[];

  beforeEach(async () => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-emergency-stop-e2e-'));
    stateDir = path.join(projectDir, '.instar');
    fs.mkdirSync(path.join(stateDir, 'autonomous'), { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, 'topic-session-registry.json'),
      JSON.stringify({ topicToSession: { [String(TOPIC)]: SESSION } }),
    );
    fs.writeFileSync(
      path.join(stateDir, 'autonomous', `${TOPIC}.local.md`),
      `---\nactive: true\npaused: false\niteration: 7\nreport_topic: "${TOPIC}"\nstarted_at: "2026-08-23T21:00:00Z"\nduration_seconds: 86400\n---\n\nrelease evidence in progress\n`,
    );
    ProcessIntegrity.reset();
    ProcessIntegrity.initialize('1.2.36', null);
    killed = [];

    const config = {
      projectName: 'emergency-stop-e2e',
      projectDir,
      stateDir,
      port: 0,
      authToken: AUTH_TOKEN,
      sessions: {},
      scheduler: {},
    } as InstarConfig;
    const state = new StateManager(stateDir);
    const app = express();
    app.use(express.json());
    app.use(createRoutes({
      config,
      state,
      sessionManager: {
        listRunningSessions: () => [],
        killSession: (name: string) => { killed.push(name); return true; },
      } as never,
      sentinel: {
        decideInboundDisposition: async () => ({
          disposition: 'kill',
          category: 'emergency-stop',
          reason: 'test emergency stop',
        }),
      } as never,
      telegram: {
        logInboundMessage: () => {},
        getSessionForTopic: () => SESSION,
        onSentinelKillSession: (name: string) => { killed.push(name); return true; },
        sendToTopic: async () => {},
        onTopicMessage: () => { throw new Error('emergency stop routed to session'); },
      } as never,
      scheduler: null,
      relationships: null,
      feedback: null,
      dispatches: null,
      updateChecker: null,
      autoUpdater: null,
      autoDispatcher: null,
      quotaTracker: null,
      publisher: null,
      viewer: null,
      tunnel: null,
      evolution: null,
      watchdog: null,
      triageNurse: null,
      topicMemory: null,
      discoveryEvaluator: null,
      startTime: new Date(),
    } as never));

    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
        resolve();
      });
    });
  });

  afterEach(async () => {
    ProcessIntegrity.reset();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: 'autonomous-emergency-stop-preserves-state-lifecycle:cleanup' });
  });

  it('halts the live-shaped run and leaves its state file intact', async () => {
    const stateFile = path.join(stateDir, 'autonomous', `${TOPIC}.local.md`);
    const res = await fetch(`${baseUrl}/internal/telegram-forward`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${AUTH_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        topicId: TOPIC,
        text: 'stop everything',
        fromUserId: 1,
        fromUsername: 'operator',
        fromFirstName: 'Operator',
        messageId: 1,
      }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, sentinel: 'emergency-stop', killed: true });
    expect(killed).toContain(SESSION);
    expect(fs.existsSync(stateFile)).toBe(true);
    const content = fs.readFileSync(stateFile, 'utf8');
    expect(content).toMatch(/^active: false$/m);
    expect(content).toContain('release evidence in progress');
  });
});
