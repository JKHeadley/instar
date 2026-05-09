/**
 * Integration test — /threadline/relay-send respects the nickname store.
 *
 * REGRESSION: prior to this fix, the route only consulted the relay's
 * discovery cache via relayClient.resolveAgent(). When the relay returned
 * a stale or imposter agent named "Dawn" with a wrong fingerprint, the
 * route silently sent to the wrong recipient — Dawn's real instance never
 * received the message. The user-curated mapping in nicknames.json was
 * ignored.
 *
 * Fix: nickname store is consulted first; user-curated names are authority
 * over relay discovery. This test reproduces the original failure
 * conditions and verifies the route now routes to the nickname's
 * fingerprint, NOT the relay's.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import { createRoutes } from '../../src/server/routes.js';
import { StateManager } from '../../src/core/StateManager.js';
import type { InstarConfig } from '../../src/core/types.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const CORRECT_DAWN_FP = '8c7928aa9f04fbda947172a2f9b2d81a';
const WRONG_DAWN_FP   = '5c338c63cd2ecebc8f52483d5bba6486';

let projectDir: string;
let stateDir: string;
let server: Server;
let baseUrl: string;
let relaySendCalls: Array<{ recipientId: string; message: string; threadId?: string }>;

describe('/threadline/relay-send nickname authority (regression)', () => {
  beforeAll(async () => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-relay-nick-'));
    stateDir = path.join(projectDir, '.instar');

    fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'state', 'jobs'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'threadline'), { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, 'config.json'),
      JSON.stringify({ projectName: 'echo-test' }),
    );

    // User-curated nickname mapping. Source-of-truth: "Dawn" is fingerprint
    // 8c7928aa…, NOT 5c338c63… (the imposter the relay returns below).
    fs.writeFileSync(
      path.join(stateDir, 'threadline', 'nicknames.json'),
      JSON.stringify({
        version: 1,
        nicknames: {
          [CORRECT_DAWN_FP]: {
            nickname: 'Dawn',
            source: 'user',
            updatedAt: '2026-05-07T00:44:34.234Z',
          },
        },
      }),
      'utf-8',
    );

    const config = {
      projectDir,
      stateDir,
      projectName: 'echo-test',
      port: 4042,
    } as InstarConfig;

    const state = new StateManager(stateDir);

    // Stub relay client that simulates the production bug:
    // the relay's discovery resolver returns the WRONG fingerprint for "Dawn".
    relaySendCalls = [];
    const stubRelayClient = {
      connectionState: 'connected',
      resolveAgent: async (name: string) => {
        // Reproduce the original failure: relay says "Dawn" is the wrong fp.
        if (name === 'Dawn') return WRONG_DAWN_FP;
        return null;
      },
      sendAuto: (recipientId: string, message: string, threadId?: string) => {
        relaySendCalls.push({ recipientId, message, threadId });
        return `msg-stub-${Date.now()}`;
      },
    };

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
      threadlineRelayClient: stubRelayClient as any,
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
        const addr = server.address() as { port: number };
        baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    SafeFsExecutor.safeRmSync(projectDir, {
      recursive: true,
      force: true,
      operation: 'tests/integration/threadline-relay-send-nickname.test.ts:cleanup',
    });
  });

  it('routes to the nickname fingerprint, NOT the (wrong) relay-resolved one', async () => {
    relaySendCalls.length = 0;
    const res = await fetch(`${baseUrl}/threadline/relay-send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        targetAgent: 'Dawn',
        message: 'where does feedback clustering live?',
        waitForReply: false,
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.deliveryPath).toBe('relay');

    // The bug-shape: prior code would have called sendAuto with WRONG_DAWN_FP
    // because resolveAgent returned it. Now nickname authority overrides:
    expect(relaySendCalls).toHaveLength(1);
    expect(relaySendCalls[0].recipientId).toBe(CORRECT_DAWN_FP);
    expect(relaySendCalls[0].recipientId).not.toBe(WRONG_DAWN_FP);
    expect(body.resolvedAgent).toBe(CORRECT_DAWN_FP);
  });

  it('falls back to relay discovery when no nickname matches', async () => {
    relaySendCalls.length = 0;
    // "Stranger" has no nickname mapping; resolver returns null and the
    // route should 404 (per existing behavior).
    const res = await fetch(`${baseUrl}/threadline/relay-send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        targetAgent: 'Stranger',
        message: 'hello',
        waitForReply: false,
      }),
    });
    expect(res.status).toBe(404);
    expect(relaySendCalls).toHaveLength(0);
  });

  it('passes through unchanged when the input is a raw fingerprint', async () => {
    relaySendCalls.length = 0;
    // A raw hex fingerprint that isn't in nicknames.json should bypass the
    // nickname check entirely (no risk of false-positive matching).
    const someOtherFp = 'aabbccddeeff00112233445566778899';
    const res = await fetch(`${baseUrl}/threadline/relay-send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        targetAgent: someOtherFp,
        message: 'direct',
        waitForReply: false,
      }),
    });
    // resolveAgent returns null for non-"Dawn" inputs in our stub, so 404.
    // The important part: nickname store wasn't consulted (would have been
    // null anyway, but the fingerprint-shape short-circuits the check).
    expect(res.status).toBe(404);
  });
});
