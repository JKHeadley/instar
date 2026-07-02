/**
 * Integration test — /threadline/relay-send propagates caller-supplied
 * envelope priority through the local-delivery path.
 *
 * Audit 2026-05-23, item #1: the local-delivery envelope previously
 * hardcoded `priority: 'medium'`, so SpawnRequestManager's session-cap
 * override (which fires only on `high` or `critical`) could never be
 * triggered for local agent-to-agent traffic. Even an explicitly urgent
 * coordination message got demoted to medium at the sender.
 *
 * Contract pinned here:
 *   - When `priority: 'critical'` is sent on the body, the envelope POSTed
 *     to the target's /messages/relay-agent carries `message.priority:
 *     'critical'`.
 *   - When `priority` is omitted, the envelope defaults to `'medium'`
 *     (backward-compatible).
 *   - Invalid enum values fall through to `'medium'` (no crash, no
 *     unexpected behavior).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import { createRoutes } from '../../src/server/routes.js';
import { StateManager } from '../../src/core/StateManager.js';
import { getOrCreateAgentToken } from '../../src/server/agent-tokens.js';
import type { InstarConfig } from '../../src/core/types.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

let projectDir: string;
let stateDir: string;
let server: Server;
let baseUrl: string;
let targetServer: Server;
let targetPort: number;
let capturedEnvelopes: Array<Record<string, any>>;

describe('/threadline/relay-send priority propagation (audit #1)', () => {
  beforeAll(async () => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-relay-prio-'));
    stateDir = path.join(projectDir, '.instar');
    fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'state', 'jobs'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'threadline'), { recursive: true });

    const targetAgentName = 'peer-target';
    fs.writeFileSync(
      path.join(stateDir, 'config.json'),
      JSON.stringify({ projectName: 'echo-test' }),
    );

    // Stand up a tiny capture-server that pretends to be the target agent.
    // It accepts /threadline/health (so the sender's liveness probe passes)
    // and /messages/relay-agent (where the actual envelope lands). We mint
    // an agent token for it so the sender's Bearer check succeeds.
    const targetToken = getOrCreateAgentToken(targetAgentName, stateDir);
    capturedEnvelopes = [];

    await new Promise<void>((resolve) => {
      const tgt = express();
      tgt.use(express.json());
      tgt.get('/threadline/health', (_req, res) => res.json({ ok: true }));
      tgt.post('/messages/relay-agent', (req, res) => {
        const auth = req.headers.authorization ?? '';
        if (!auth.includes(targetToken)) {
          res.status(401).json({ error: 'unauthorized' });
          return;
        }
        capturedEnvelopes.push(req.body);
        res.json({ ok: true, threadline: { handled: true, injected: true } });
      });
      targetServer = tgt.listen(0, '127.0.0.1', () => {
        targetPort = (targetServer.address() as { port: number }).port;
        resolve();
      });
    });

    // Register the target as a known same-machine agent.
    fs.writeFileSync(
      path.join(stateDir, 'threadline', 'known-agents.json'),
      JSON.stringify({
        agents: [
          {
            name: targetAgentName,
            port: targetPort,
            fingerprint: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          },
        ],
      }),
    );

    const config = {
      projectDir,
      stateDir,
      projectName: 'echo-sender',
      port: 4042,
    } as InstarConfig;
    const state = new StateManager(stateDir);

    const app = express();
    app.use(express.json());
    const router = createRoutes({
      config,
      state,
      sessionManager: null as any,
      scheduler: null,
      telegram: null,
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
      feedbackAnomalyDetector: null,
      projectMapper: null,
      coherenceGate: null,
      contextHierarchy: null,
      canonicalState: null,
      operationGate: null,
      sentinel: null,
      adaptiveTrust: null,
      memoryMonitor: null,
      orphanReaper: null,
      coherenceMonitor: null,
      commitmentTracker: null,
      semanticMemory: null,
      activitySentinel: null,
      messageRouter: null,
      summarySentinel: null,
      spawnManager: null,
      workingMemory: null,
      quotaManager: null,
      systemReviewer: null,
      capabilityMapper: null,
      selfKnowledgeTree: null,
      coverageAuditor: null,
      topicResumeMap: null,
      autonomyManager: null,
      trustElevationTracker: null,
      autonomousEvolution: null,
      whatsapp: null,
      messageBridge: null,
      hookEventReceiver: null,
      worktreeMonitor: null,
      subagentTracker: null,
      instructionsVerifier: null,
      threadlineRouter: null,
      handshakeManager: null,
      threadlineRelayClient: null,
      listenerManager: null,
      responseReviewGate: null,
      telemetryHeartbeat: null,
      pasteManager: null,
      wsManager: null,
      soulManager: null,
      discoveryEvaluator: null,
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
    if (targetServer) await new Promise<void>((resolve) => targetServer.close(() => resolve()));
    SafeFsExecutor.safeRmSync(projectDir, {
      recursive: true,
      force: true,
      operation: 'tests/integration/threadline-relay-send-priority.test.ts:cleanup',
    });
  });

  it('propagates priority="critical" into the local-delivery envelope', async () => {
    capturedEnvelopes.length = 0;
    const res = await fetch(`${baseUrl}/threadline/relay-send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        targetAgent: 'peer-target',
        message: 'urgent coordination ping',
        priority: 'critical',
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.deliveryPath).toBe('local');

    expect(capturedEnvelopes).toHaveLength(1);
    expect(capturedEnvelopes[0].message.priority).toBe('critical');
  });

  it('defaults to "medium" when priority is omitted (back-compat)', async () => {
    capturedEnvelopes.length = 0;
    const res = await fetch(`${baseUrl}/threadline/relay-send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        targetAgent: 'peer-target',
        message: 'normal coordination ping',
      }),
    });
    expect(res.status).toBe(200);
    expect(capturedEnvelopes).toHaveLength(1);
    expect(capturedEnvelopes[0].message.priority).toBe('medium');
  });

  it('falls back to "medium" when priority is an invalid enum value', async () => {
    capturedEnvelopes.length = 0;
    const res = await fetch(`${baseUrl}/threadline/relay-send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        targetAgent: 'peer-target',
        message: 'malformed priority ping',
        priority: 'super-urgent',
      }),
    });
    expect(res.status).toBe(200);
    expect(capturedEnvelopes).toHaveLength(1);
    expect(capturedEnvelopes[0].message.priority).toBe('medium');
  });

  it('propagates priority="high" so cap-override path is reachable', async () => {
    capturedEnvelopes.length = 0;
    const res = await fetch(`${baseUrl}/threadline/relay-send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        targetAgent: 'peer-target',
        message: 'high-priority ping',
        priority: 'high',
      }),
    });
    expect(res.status).toBe(200);
    expect(capturedEnvelopes).toHaveLength(1);
    expect(capturedEnvelopes[0].message.priority).toBe('high');
  });
});
