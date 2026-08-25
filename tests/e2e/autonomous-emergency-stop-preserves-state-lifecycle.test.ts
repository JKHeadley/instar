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
  let killOutcome: boolean;
  let sent: string[]; // what the PERSON in the topic is told

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
    killOutcome = true;
    sent = [];

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
        killSession: (name: string) => { killed.push(name); return killOutcome; },
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
        onSentinelKillSession: (name: string) => { killed.push(name); return killOutcome; },
        sendToTopic: async (_topic: number, text: string) => { sent.push(text); },
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
    // The person in the topic is told the truth: it was terminated.
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatch(/^Session terminated\./);
  });

  // Both sides of the decision boundary on the production init path: a kill that
  // FAILS must report failure (killed:false) — never the original false
  // killed:true — while the record is still preserved.
  it('reports killed:false when the kill fails, and STILL leaves the record intact', async () => {
    killOutcome = false; // the emergency-stop kill does not land
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
        messageId: 2,
      }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, sentinel: 'emergency-stop', killed: false });
    expect(killed).toContain(SESSION); // the kill was attempted against the bound session
    // The record-preservation half still holds even when the kill fails.
    expect(fs.existsSync(stateFile)).toBe(true);
    const content = fs.readFileSync(stateFile, 'utf8');
    expect(content).toMatch(/^active: false$/m);
    expect(content).toContain('release evidence in progress');
    // The message a PERSON reads must not claim termination when the kill
    // failed: it says the session is still running AND that the stop was
    // recorded, in plain English with no internal identifiers.
    expect(sent).toHaveLength(1);
    expect(sent[0]).not.toMatch(/terminated/i);
    expect(sent[0]).toMatch(/still running/i);
    expect(sent[0]).toMatch(/recorded/i);
    expect(sent[0]).not.toContain(SESSION);
  });
});
