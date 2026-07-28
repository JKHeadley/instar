/**
 * Integration test — the negotiator lease/voice send gate over the REAL
 * /threadline/relay-send route (Robustness Phase 1, D-B/G1), plus the
 * GET /threadline/negotiator read route.
 *
 * Spec test plan (Integration tier):
 *  - enforce + foreign live lease → content WITHHELD (holding); only the fixed
 *    holding notice reaches the peer; NO awaiting-ack record is created for it
 *  - the owner session's send is delivered normally (content reaches the peer)
 *  - dry-run observes a foreign lease but still sends the content
 *  - GET /threadline/negotiator → 200, bearer-gated, paginated, own-data-only
 *  - commitment-class advisory surfaces on the send response (signal only)
 *
 * We POST directly to /threadline/relay-send so we control `originSessionName`
 * (the server-authoritative owning session, normally INSTAR_SESSION_NAME).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import { createRoutes } from '../../../src/server/routes.js';
import { StateManager } from '../../../src/core/StateManager.js';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';
import { ConversationStore } from '../../../src/threadline/ConversationStore.js';
import { A2ADeliveryTracker } from '../../../src/threadline/A2ADeliveryTracker.js';
import type { InstarConfig } from '../../../src/core/types.js';

const AUTH = 'test-negotiator-gate';
const OWNER_SESSION = 'echo-topic-12476';
const WARM_SESSION = 'echo-warm-99';

describe('Threadline negotiator send-gate (integration)', () => {
  let projectDir: string;
  let stateDir: string;
  let server: Server;
  let port: number;
  let conversationStore: ConversationStore;
  let a2aDeliveryTracker: A2ADeliveryTracker;
  let sentAuto: Array<{ rid: string; text: string; threadId?: string }>;
  let liveSessions: string[];

  function buildApp(singleNegotiator: Record<string, unknown>): express.Express {
    const config = {
      projectDir, stateDir, projectName: 'echo', port: 4042, authToken: AUTH,
      threadline: { singleNegotiator },
    } as unknown as InstarConfig;

    const ctx = {
      config,
      state: new StateManager(stateDir),
      conversationStore,
      a2aDeliveryTracker,
      meshSelfId: 'machine-a',
      sessionManager: {
        getCachedRunningSessions: () => ({ count: liveSessions.length, sessions: liveSessions.map((s) => ({ tmuxSession: s })) }),
        listRunningSessions: () => liveSessions.map((s) => ({ tmuxSession: s })),
      },
      threadlineRelayClient: {
        connectionState: 'connected',
        resolveAgent: async () => 'targetfp00112233445566778899aabbcc',
        sendAuto: (rid: string, text: string, threadId?: string) => { sentAuto.push({ rid, text, threadId }); return `msg-${sentAuto.length}`; },
      },
      startTime: new Date(),
    };
    const router = createRoutes(ctx as never);
    const app = express();
    app.use(express.json());
    app.use(router);
    return app;
  }

  async function listen(app: express.Express): Promise<void> {
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => { port = (server.address() as { port: number }).port; resolve(); });
    });
  }

  async function relaySend(body: Record<string, unknown>): Promise<{ status: number; json: Record<string, unknown> }> {
    const res = await fetch(`http://127.0.0.1:${port}/threadline/relay-send`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: res.status, json: await res.json() as Record<string, unknown> };
  }

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'negotiator-gate-'));
    stateDir = path.join(projectDir, '.instar');
    fs.mkdirSync(path.join(stateDir, 'threadline'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ projectName: 'echo' }));
    conversationStore = new ConversationStore(stateDir);
    a2aDeliveryTracker = A2ADeliveryTracker.openMemory();
    sentAuto = [];
    liveSessions = [OWNER_SESSION, WARM_SESSION];
  });

  afterEach(async () => {
    if (server) await new Promise<void>((r) => server.close(() => r()));
    a2aDeliveryTracker.close();
    SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: 'negotiator-send-gate:cleanup' });
  });

  it('ENFORCE: a warm (non-owner) session is HELD — content withheld, only the holding notice reaches the peer', async () => {
    await listen(buildApp({ enabled: true, dryRun: false }));
    // The owner session already holds the lease on this thread.
    await conversationStore.acquireOrRenewLease('thread-1', { ownerSessionName: OWNER_SESSION, ownerMachineId: 'machine-a' }, { ttlMs: 90000 });

    // The WARM session tries to "lock W1 for Fri 10:00, see you at the gate".
    const { json } = await relaySend({
      targetAgent: 'Dawn', threadId: 'thread-1', originSessionName: WARM_SESSION,
      message: 'locked W1 for Fri 10:00, see you at the gate',
    });

    // Content was WITHHELD.
    expect(json.success).toBe(true);
    expect(json.held).toBe(true);
    expect(json.delivered).toBe(false);
    expect(json.deliveryOutcome).toBe('holding');
    // Only the fixed holding notice reached the peer — NOT the warm session's content.
    expect(sentAuto.length).toBe(1);
    expect(sentAuto[0].text).toContain('holding notice');
    expect(sentAuto[0].text).not.toContain('locked W1');
    // FD-11: the holding notice created NO awaiting-ack record on the sender side.
    expect(a2aDeliveryTracker.pending().length).toBe(0);
  });

  it('OWNER: the lease-holding session is the voice — content is delivered', async () => {
    await listen(buildApp({ enabled: true, dryRun: false }));
    await conversationStore.acquireOrRenewLease('thread-1', { ownerSessionName: OWNER_SESSION, ownerMachineId: 'machine-a' }, { ttlMs: 90000 });

    const { json } = await relaySend({
      targetAgent: 'Dawn', threadId: 'thread-1', originSessionName: OWNER_SESSION,
      message: 'real owner content',
    });

    expect(json.success).toBe(true);
    expect(json.deliveryPath).toBe('relay');
    expect(sentAuto.length).toBe(1);
    expect(sentAuto[0].text).toBe('real owner content'); // the real content, not a notice
  });

  it('DRY-RUN: a foreign lease is observed but the content still sends', async () => {
    await listen(buildApp({ enabled: true, dryRun: true }));
    await conversationStore.acquireOrRenewLease('thread-1', { ownerSessionName: OWNER_SESSION, ownerMachineId: 'machine-a' }, { ttlMs: 90000 });

    const { json } = await relaySend({
      targetAgent: 'Dawn', threadId: 'thread-1', originSessionName: WARM_SESSION,
      message: 'warm content under dry-run',
    });

    expect(json.success).toBe(true);
    expect(json.held).toBeUndefined(); // not withheld in dry-run
    expect(sentAuto.length).toBe(1);
    expect(sentAuto[0].text).toBe('warm content under dry-run'); // real content sent
  });

  it('commitment-class prose surfaces an advisory nudge (signal only — still sends)', async () => {
    await listen(buildApp({ enabled: false }));
    const { json } = await relaySend({
      targetAgent: 'Dawn', threadId: 'thread-2', originSessionName: OWNER_SESSION,
      message: "yep, go ahead — let's schedule the cutover",
    });
    expect(json.success).toBe(true);
    expect(typeof json.advisory).toBe('string');
    expect(json.advisory as string).toMatch(/mandate|reviewexchange/i);
  });

  it('GET /threadline/negotiator is bearer-gated, 200, paginated, own-data-only', async () => {
    await listen(buildApp({ enabled: true, dryRun: true }));
    await conversationStore.acquireOrRenewLease('thread-1', { ownerSessionName: OWNER_SESSION, ownerMachineId: 'machine-a' }, { ttlMs: 90000 });

    const noAuth = await fetch(`http://127.0.0.1:${port}/threadline/negotiator`);
    expect(noAuth.status).toBe(401);

    const ok = await fetch(`http://127.0.0.1:${port}/threadline/negotiator`, { headers: { Authorization: `Bearer ${AUTH}` } });
    expect(ok.status).toBe(200);
    const body = await ok.json() as { enabled: boolean; dryRun: boolean; leases: Array<Record<string, unknown>>; total: number };
    expect(body.enabled).toBe(true);
    expect(body.dryRun).toBe(true);
    expect(body.total).toBe(1);
    expect(body.leases[0]).toMatchObject({ threadId: 'thread-1', owner: OWNER_SESSION, epoch: 1 });
  });
});
