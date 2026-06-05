/**
 * Integration test — /threadline/relay-send stores the RESOLVED full fingerprint
 * as the conversation's `remoteAgent`, not the raw "name:fpPrefix" address.
 *
 * REGRESSION (the Dawn cold-spawn incident, 2026-06-04): when a caller addressed
 * a peer with the composite "name:fpPrefix" disambiguation syntax (e.g.
 * "Dawn-Workstation:8c7928aa"), the route resolved the full fingerprint for
 * ROUTING but `captureOrigin` stored the raw composite string as the thread
 * owner. The peer's reply over the relay carries its BARE full fingerprint as
 * senderFingerprint (often with an empty senderName), so the inbound anti-hijack
 * guard (ThreadlineRouter) could not match composite-vs-fingerprint and
 * false-isolated the reply to a fresh cold-spawn thread — breaking A2A
 * continuity (the "one coherent individual" property).
 *
 * Fix: store the resolved full fingerprint (`resolvedId`) as `remoteAgent` and
 * keep the raw target only as the display name. This test sends to a composite
 * address and asserts captureOriginOnSend received the full fingerprint.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import { createRoutes } from '../../../src/server/routes.js';
import { StateManager } from '../../../src/core/StateManager.js';
import type { InstarConfig } from '../../../src/core/types.js';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';

const DAWN_FP = '8c7928aa9f04fbda947172a2f9b2d81a';

let projectDir: string;
let stateDir: string;
let server: Server;
let baseUrl: string;
let captureOriginCalls: Array<{ threadId: string; remoteAgent: string; remoteAgentDisplayName?: string; originTopicId?: number }>;

describe('/threadline/relay-send stores resolved fingerprint as remoteAgent (canonicalization)', () => {
  beforeAll(async () => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-relay-canon-'));
    stateDir = path.join(projectDir, '.instar');
    fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'threadline'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ projectName: 'echo-test' }));

    const config = { projectDir, stateDir, projectName: 'echo-test', port: 4042 } as InstarConfig;
    const state = new StateManager(stateDir);

    // Relay resolver maps the composite address to Dawn's full fingerprint.
    const stubRelayClient = {
      connectionState: 'connected',
      resolveAgent: async (_name: string) => DAWN_FP,
      sendAuto: (_recipientId: string, _message: string, _threadId?: string) => `msg-stub-${Date.now()}`,
    };

    // Capture what captureOrigin → captureOriginOnSend receives.
    captureOriginCalls = [];
    const stubTopicLinkageHandler = {
      captureOriginOnSend: vi.fn((input: { threadId: string; remoteAgent: string; remoteAgentDisplayName?: string; originTopicId?: number }) => {
        captureOriginCalls.push({
          threadId: input.threadId,
          remoteAgent: input.remoteAgent,
          remoteAgentDisplayName: input.remoteAgentDisplayName,
          originTopicId: input.originTopicId,
        });
        return null;
      }),
    };

    const app = express();
    app.use(express.json());
    const router = createRoutes({
      config, state,
      sessionManager: null as any, scheduler: null, telegram: null, relationships: null,
      feedback: null, dispatches: null, updateChecker: null, autoUpdater: null, autoDispatcher: null,
      quotaTracker: null, publisher: null, viewer: null, tunnel: null, evolution: null, watchdog: null,
      triageNurse: null, topicMemory: null, feedbackAnomalyDetector: null, projectMapper: null,
      coherenceGate: null, contextHierarchy: null, canonicalState: null, operationGate: null, sentinel: null,
      adaptiveTrust: null, memoryMonitor: null, orphanReaper: null, coherenceMonitor: null,
      commitmentTracker: null, semanticMemory: null, activitySentinel: null, messageRouter: null,
      summarySentinel: null, spawnManager: null, workingMemory: null, quotaManager: null,
      systemReviewer: null, capabilityMapper: null, selfKnowledgeTree: null, coverageAuditor: null,
      topicResumeMap: null, autonomyManager: null, trustElevationTracker: null, autonomousEvolution: null,
      whatsapp: null, messageBridge: null, hookEventReceiver: null, worktreeMonitor: null,
      subagentTracker: null, instructionsVerifier: null, threadlineRouter: null, handshakeManager: null,
      threadlineRelayClient: stubRelayClient as any, listenerManager: null, responseReviewGate: null,
      telemetryHeartbeat: null, pasteManager: null, wsManager: null, soulManager: null,
      discoveryEvaluator: null, topicLinkageHandler: stubTopicLinkageHandler as any,
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
    SafeFsExecutor.safeRmSync(projectDir, {
      recursive: true, force: true,
      operation: 'tests/integration/threadline/relay-send-canonical-remoteagent.test.ts:cleanup',
    });
  });

  it('stores the resolved full fingerprint as remoteAgent and the raw composite as the display name', async () => {
    captureOriginCalls.length = 0;
    const res = await fetch(`${baseUrl}/threadline/relay-send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        targetAgent: 'Dawn-Workstation:8c7928aa', // composite "name:fpPrefix"
        message: 'hello over the relay',
        waitForReply: false,
        originTopicId: 12476, // required so captureOrigin fires (origin capture)
      }),
    });

    expect(res.status).toBe(200);
    expect(captureOriginCalls).toHaveLength(1);
    // The canonical thread owner is the RESOLVED full fingerprint — so the
    // peer's bare-fingerprint reply matches the anti-hijack guard.
    expect(captureOriginCalls[0].remoteAgent).toBe(DAWN_FP);
    expect(captureOriginCalls[0].remoteAgent).not.toBe('Dawn-Workstation:8c7928aa');
    // The human-facing display name is preserved separately.
    expect(captureOriginCalls[0].remoteAgentDisplayName).toBe('Dawn-Workstation:8c7928aa');
    expect(captureOriginCalls[0].originTopicId).toBe(12476);
  });
});
