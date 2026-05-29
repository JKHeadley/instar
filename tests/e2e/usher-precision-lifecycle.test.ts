/**
 * E2E lifecycle test (Tier 3) for the Usher PRECISION LOOP (rung 4).
 *
 * The single most important test: is the precision loop actually ALIVE
 * end-to-end? Before this feature, the Usher fired signals but markActed had no
 * caller, so precision was pinned at 0 (the rung-5 gate could never move). This
 * boots the real createRoutes tree on a live HTTP server and proves BOTH credit
 * paths flip a fired signal to acted and the change is visible over real HTTP at
 * GET /usher/metrics:
 *
 *   path (a) — POST /telegram/reply with a reply that USES a re-surfaced context
 *              → the nudge is marked acted_by_use; precision moves null → 1.0.
 *   path (b) — an inbound human correction (the exact two-line server.ts seam:
 *              observeInboundMessage → creditUsherOnMiss) credits a prior nudge
 *              the agent ignored → acted_by_miss.
 *
 * Returns 200, not 503 — the "feature is alive" gate (CLAUDE.md Testing
 * Integrity Standard).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import type { Server } from 'node:http';
import { createRoutes } from '../../src/server/routes.js';
import type { RouteContext } from '../../src/server/routes.js';
import { createUsherRoutes } from '../../src/server/usherRoutes.js';
import { UsherSignalStore } from '../../src/core/UsherSignalStore.js';
import { HumanAsDetectorLog, observeInboundMessage } from '../../src/monitoring/HumanAsDetectorLog.js';
import { creditUsherOnMiss } from '../../src/core/UsherActedCorrelator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

describe('E2E: Usher precision loop lifecycle', () => {
  let projectDir: string;
  let stateDir: string;
  let server: Server;
  let baseUrl: string;
  let store: UsherSignalStore;
  const TOPIC_A = 12118; // path (a) topic
  const TOPIC_B = 13481; // path (b) topic

  beforeAll(async () => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-usher-prec-e2e-'));
    stateDir = path.join(projectDir, '.instar');
    fs.mkdirSync(stateDir, { recursive: true });

    store = new UsherSignalStore(stateDir);
    // Pre-fire the nudges the agent will (a) use and (b) get corrected on.
    store.recordSignal(TOPIC_A, { contextRef: 'ref-a', contextText: 'deploy the staging pipeline tonight', reason: 'the user re-raised the staging plan', turn: 4 });
    store.recordSignal(TOPIC_B, { contextRef: 'ref-b', contextText: 'we are testing the mesh over telegram', reason: 'the user re-raised the test setup', turn: 9 });

    HumanAsDetectorLog.resetForTesting();
    HumanAsDetectorLog.getInstance().configure({ stateDir, agentName: 'usher-prec-e2e' });

    let sent = 0;
    const ctx = {
      config: { projectName: 'usher-prec-e2e', projectDir, stateDir, port: 0, sessions: {} as any, scheduler: {} as any } as any,
      sessionManager: { listRunningSessions: () => [], clearInjectionTracker: () => {} } as any,
      state: { getJobState: () => null, getSession: () => null } as any,
      telegram: { sendToTopic: async () => { sent++; } } as any,
      usherSignalStore: store,
      // Null gate → checkOutboundMessage passes through (the reply isn't blocked).
      messagingToneGate: null, outboundDedupGate: null, topicIntentArcCheck: null,
      topicMemory: null, messageLedger: null, currentInboundByTopic: null,
      scheduler: null, relationships: null, feedback: null, dispatches: null,
      updateChecker: null, autoUpdater: null, autoDispatcher: null, quotaTracker: null,
      publisher: null, viewer: null, tunnel: null, evolution: null, watchdog: null,
      triageNurse: null, discoveryEvaluator: null, coordinator: null, replyMarkerTransport: null,
      startTime: new Date(),
    } as unknown as RouteContext;

    const app = express();
    app.use(express.json());
    app.use('/', createRoutes(ctx));
    app.use(createUsherRoutes({ signalStore: store }));
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        const addr = server.address();
        const port = typeof addr === 'object' && addr ? addr.port : 0;
        baseUrl = `http://127.0.0.1:${port}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    HumanAsDetectorLog.resetForTesting();
    try {
      SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: 'tests/e2e/usher-precision-lifecycle.test.ts' });
    } catch { /* best-effort */ }
  });

  it('precision starts pinned at 0 (a fired-but-unacted nudge) — the exact pre-fix state', async () => {
    // This IS the bug this feature fixes: fired>0 but acted==0 → precision 0,
    // structurally stuck (markActed had no caller). The next test moves it.
    const res = await fetch(`${baseUrl}/usher/metrics?topicId=${TOPIC_A}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.metrics.fired).toBe(1);
    expect(body.metrics.acted).toBe(0);
    expect(body.metrics.precision).toBe(0);
  });

  it('path (a): a reply that USES the re-surfaced context flips the nudge acted (precision → 1.0)', async () => {
    const reply = await fetch(`${baseUrl}/telegram/reply/${TOPIC_A}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'On it — I will deploy the staging pipeline tonight and report back when it lands.' }),
    });
    expect(reply.status).toBe(200);

    const res = await fetch(`${baseUrl}/usher/metrics?topicId=${TOPIC_A}`);
    const body = await res.json();
    expect(body.metrics.acted).toBe(1);
    expect(body.metrics.acted_by_use).toBe(1);
    expect(body.metrics.precision).toBe(1);
  });

  it('path (a) does NOT credit an unrelated reply', async () => {
    // Fire a fresh nudge on a clean topic, reply with something off-topic.
    store.recordSignal(555, { contextRef: 'ref-c', contextText: 'rotate the cloudflare tunnel token', reason: 'r', turn: 1 });
    const reply = await fetch(`${baseUrl}/telegram/reply/555`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'Sounds good, talk later!' }),
    });
    expect(reply.status).toBe(200);
    const res = await fetch(`${baseUrl}/usher/metrics?topicId=555`);
    const body = await res.json();
    expect(body.metrics.acted).toBe(0);
    expect(body.metrics.precision).toBe(0); // fired 1, acted 0
  });

  it('path (b): an inbound correction credits a prior ignored nudge (acted_by_miss)', async () => {
    // The exact two lines server.ts runs on the inbound human-detector seam.
    const missSignal = observeInboundMessage(HumanAsDetectorLog.getInstance(), {
      fromUser: true,
      text: "actually, you forgot we are testing the mesh over telegram — that's stale",
      topicId: TOPIC_B,
      messageId: 42,
    });
    expect(missSignal).not.toBeNull();
    const credited = creditUsherOnMiss(store, missSignal, { topicId: TOPIC_B, text: "actually, you forgot we are testing the mesh over telegram — that's stale" });
    expect(credited.length).toBe(1);

    const res = await fetch(`${baseUrl}/usher/metrics?topicId=${TOPIC_B}`);
    const body = await res.json();
    expect(body.metrics.acted).toBe(1);
    expect(body.metrics.acted_by_miss).toBe(1);
    expect(body.metrics.precision).toBe(1);
  });
});
