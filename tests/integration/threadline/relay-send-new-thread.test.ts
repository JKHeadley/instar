/**
 * Integration test — /threadline/relay-send honours a request for a NEW thread.
 *
 * REGRESSION (Echo Bugs topic 10000000781, 2026-10-25): three sends to one
 * peer — no thread id, `fork: true`, `fork: true` + `newThread: true` — all came
 * back on the SAME existing thread, reported as success. The route minted the
 * new thread id (and the resolver kept it), but the relay leg passed the
 * caller's own threadId (none), so the relay client continued its per-peer
 * thread and the fork was lost silently.
 *
 * Fix: the route passes the thread it decided to the relay leg; a fork that
 * names a thread is refused; a fork the client did not honour is a 502, never
 * a success on the old thread.
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

const PEER_FP = '3f2a9c1b7d4e6f80a1b2c3d4e5f60718';
const EXISTING_THREAD = 'thread-1761300000000-abc123';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

let projectDir: string;
let server: Server;
let baseUrl: string;
/** The thread each relay send was asked to use (undefined = none given). */
let wireThreadArgs: Array<string | undefined>;
/** When true the stub behaves like a broken client that ignores an explicit thread. */
let ignoreExplicitThread = false;
const recordSent = vi.fn();

function post(body: Record<string, unknown>) {
  return fetch(`${baseUrl}/threadline/relay-send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ targetAgent: PEER_FP, message: 'hello', waitForReply: false, ...body }),
  });
}

describe('/threadline/relay-send newThread / fork', () => {
  beforeAll(async () => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-relay-newthread-'));
    const stateDir = path.join(projectDir, '.instar');
    fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'threadline'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ projectName: 'echo-test' }));
    const config = { projectDir, stateDir, projectName: 'echo-test', port: 4042 } as InstarConfig;

    // Mirrors ThreadlineClient's precedence: explicit thread > per-peer
    // affinity (an existing conversation with this peer) > mint.
    const stubRelayClient = {
      connectionState: 'connected',
      resolveAgent: async () => PEER_FP,
      sendAutoWithThread(_r: string, _m: string, t?: string) {
        wireThreadArgs.push(t);
        const threadId = ignoreExplicitThread ? EXISTING_THREAD : (t ?? EXISTING_THREAD);
        return { messageId: `msg-${wireThreadArgs.length}`, threadId };
      },
      awaitRelayAck: async () => null,
      banSuspected: false,
      noteUnconfirmedSettled() {},
      sendAuto: () => 'msg-stub',
    };

    const app = express();
    app.use(express.json());
    app.use(createRoutes({
      config, state: new StateManager(stateDir),
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
      a2aDeliveryTracker: { recordSent, peerHealth: () => ({ dark: false }) } as any,
      telemetryHeartbeat: null, pasteManager: null, wsManager: null, soulManager: null,
      discoveryEvaluator: null, startTime: new Date(),
    } as any));
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
      operation: 'tests/integration/threadline/relay-send-new-thread.test.ts:cleanup',
    });
  });

  it('without newThread, a send continues the existing conversation with the peer', async () => {
    wireThreadArgs = []; ignoreExplicitThread = false;
    const res = await post({});
    expect(res.status).toBe(200);
    const body = await res.json() as { threadId: string };
    expect(wireThreadArgs).toEqual([undefined]);
    expect(body.threadId).toBe(EXISTING_THREAD);
  });

  for (const flag of [{ fork: true }, { newThread: true }, { fork: true, newThread: true }]) {
    it(`${JSON.stringify(flag)} opens a new thread instead of joining the existing one`, async () => {
      wireThreadArgs = []; ignoreExplicitThread = false;
      const res = await post(flag);
      expect(res.status).toBe(200);
      const body = await res.json() as { success: boolean; threadId: string };
      expect(body.success).toBe(true);
      expect(body.threadId).not.toBe(EXISTING_THREAD);
      expect(body.threadId).toMatch(UUID_RE);
      // The decided id actually went to the relay client.
      expect(wireThreadArgs).toEqual([body.threadId]);
    });
  }

  it('two newThread sends to the same peer open two different threads', async () => {
    wireThreadArgs = []; ignoreExplicitThread = false;
    const a = await (await post({ newThread: true })).json() as { threadId: string };
    const b = await (await post({ newThread: true })).json() as { threadId: string };
    expect(a.threadId).not.toBe(b.threadId);
  });

  it('refuses newThread combined with a threadId, and sends nothing', async () => {
    wireThreadArgs = []; ignoreExplicitThread = false;
    const res = await post({ newThread: true, threadId: EXISTING_THREAD });
    expect(res.status).toBe(400);
    const body = await res.json() as { success: boolean; reason: string };
    expect(body.success).toBe(false);
    expect(body.reason).toBe('fork-conflicts-with-threadId');
    expect(wireThreadArgs).toEqual([]);
  });

  it('a fork the relay client did not honour is reported as a failure, never success on the old thread', async () => {
    wireThreadArgs = []; ignoreExplicitThread = true; recordSent.mockClear();
    try {
      const res = await post({ newThread: true });
      expect(res.status).toBe(502);
      const body = await res.json() as { success: boolean; reason: string; threadId: string; error: string };
      expect(body.success).toBe(false);
      expect(body.reason).toBe('fork-not-honoured');
      expect(body.threadId).toBe(EXISTING_THREAD);
      expect(body.error).toMatch(/Do not resend/);
      // The message DID go out, so its delivery record is still written.
      expect(recordSent).toHaveBeenCalledTimes(1);
      expect(recordSent.mock.calls[0][0]).toMatchObject({ threadId: EXISTING_THREAD });
    } finally {
      ignoreExplicitThread = false;
    }
  });
});
