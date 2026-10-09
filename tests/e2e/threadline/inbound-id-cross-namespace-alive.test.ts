/**
 * A2A inbound-id ledger — cross-namespace label, E2E "feature is alive" tier
 * (docs/specs/a2a-inbound-id-ledger.md §1 "The same id under another namespace").
 *
 * The live sequence of 2026-10-08 (ACT-061) over the production path:
 *  - the ledger controller is built with the exact `buildInboundIdLedgerController`
 *    server.ts calls (dev gate, `enabled` omitted) and opens the real on-disk file;
 *  - a real AgentServer listens on a real port with a real MessageRouter;
 *  - the relay fall-back copy (same id, `resend: true`, unknown sender) arrives
 *    FIRST through `runRelayInboundWithLedger` — the wrapper server.ts runs for
 *    every relay `gate-passed` message;
 *  - the original local copy then arrives over real HTTP on
 *    `POST /messages/relay-agent` and is DELIVERED with the resent-copy notice;
 *  - the counter is live on the authed `/health` and both rows on the read route.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  buildInboundIdLedgerController,
  resolveInboundIdLedgerPath,
  RESENT_COPY_NOTICE,
  type InboundIdLedgerController,
} from '../../../src/threadline/InboundIdLedger.js';
import { runRelayInboundWithLedger } from '../../../src/threadline/inboundIdLedgerWiring.js';
import { InboundMessageGate } from '../../../src/threadline/InboundMessageGate.js';
import { AgentServer } from '../../../src/server/AgentServer.js';
import { MessageStore } from '../../../src/messaging/MessageStore.js';
import { MessageFormatter } from '../../../src/messaging/MessageFormatter.js';
import { MessageDelivery } from '../../../src/messaging/MessageDelivery.js';
import { MessageRouter } from '../../../src/messaging/MessageRouter.js';
import { generateAgentToken, deleteAgentToken } from '../../../src/messaging/AgentTokenManager.js';
import { createTempProject, createMockSessionManager } from '../../helpers/setup.js';
import type { TempProject } from '../../helpers/setup.js';
import type { InstarConfig } from '../../../src/core/types.js';

const waitFor = async (cond: () => boolean, ms = 10_000): Promise<void> => {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 25));
  }
};

describe('inbound-id ledger — cross-namespace label is alive on the production path', () => {
  const PROJECT = `xns-alive-${process.pid}`;
  const AUTH = 'tok-xns';
  const SENDER_FP = 'c0ffee'.repeat(6).slice(0, 32);
  let project: TempProject;
  let messageStore: MessageStore;
  let controller: InboundIdLedgerController;
  let server: AgentServer;
  let url = '';
  let token = '';
  const handleInboundMessage = vi.fn(async () => ({ handled: true, accepted: true, spawned: true, threadId: 't', path: 'cold' }));

  beforeAll(async () => {
    project = createTempProject();
    const messagingDir = path.join(project.stateDir, 'messages');
    fs.mkdirSync(messagingDir, { recursive: true });
    messageStore = new MessageStore(messagingDir);
    await messageStore.initialize();
    const delivery = new MessageDelivery(new MessageFormatter(), {
      getForegroundProcess: () => 'bash', isSessionAlive: () => true, hasActiveHumanInput: () => false, sendKeys: () => true, getOutputLineCount: () => 100,
    });
    const messageRouter = new MessageRouter(messageStore, delivery, { localAgent: PROJECT, localMachine: 'this-machine', serverUrl: 'http://localhost:0' });
    token = generateAgentToken(PROJECT);
    fs.mkdirSync(path.join(project.stateDir, 'threadline'), { recursive: true });
    fs.writeFileSync(path.join(project.stateDir, 'threadline', 'known-agents.json'), JSON.stringify({ agents: [{ name: 'sender-agent', fingerprint: SENDER_FP }] }));

    const config = {
      projectName: PROJECT, projectDir: project.dir, stateDir: project.stateDir, port: 0, authToken: AUTH,
      requestTimeoutMs: 5000, version: '0.9.81', developmentAgent: true,
      sessions: { claudePath: '/usr/bin/echo', maxSessions: 3, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5000 },
      scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 },
      messaging: [], monitoring: {}, updates: {}, users: [],
      threadline: { relayEnabled: false, inboundIdLedger: { retentionDays: 14 } },
    } as InstarConfig;
    // Exactly the server.ts construction (live block read; enabled omitted ⇒ dev gate).
    controller = buildInboundIdLedgerController({
      stateDir: config.stateDir, agentId: config.projectName, developmentAgent: config.developmentAgent,
      readBlock: () => config.threadline?.inboundIdLedger,
    });
    expect(controller.current()).not.toBeNull();
    expect(fs.existsSync(resolveInboundIdLedgerPath(config.stateDir, PROJECT))).toBe(true);

    server = new AgentServer({
      config, sessionManager: createMockSessionManager() as never, state: project.state, messageRouter,
      inboundIdLedger: controller, threadlineRouter: { handleInboundMessage } as never,
    } as never);
    await server.start();
    const addr = (server as unknown as { server: { address(): { port: number } } }).server.address();
    url = `http://127.0.0.1:${addr.port}`;
  }, 30_000);

  afterAll(async () => {
    await server?.stop();
    controller?.close();
    await messageStore?.destroy();
    deleteAgentToken(PROJECT);
    project?.cleanup();
  });

  it('relay copy first, late local copy over real HTTP → delivered, labelled, counted (200, not 503)', async () => {
    const id = crypto.randomUUID();
    const threadId = crypto.randomUUID();

    // 1. The relay fall-back copy overtakes the original.
    const relayNotices: Array<string | null> = [];
    const delivered = await runRelayInboundWithLedger(
      { reason: 'relay-authenticated', message: { from: SENDER_FP, threadId, messageId: id, content: { content: 'the message', resend: true } } },
      { ledger: () => controller.current(), tracker: () => null, extractMessageId: (m) => InboundMessageGate.extractMessageId(m as never) },
      async (ticket, notice) => { relayNotices.push(notice); ticket?.recordHandoff('live'); },
    );
    expect(delivered).toBe(true);
    expect(relayNotices).toEqual([RESENT_COPY_NOTICE]);
    const relayRow = controller.current()!.getRow(`unverified:${SENDER_FP}`, id);
    expect(relayRow).toMatchObject({ disposition: 'handed-off', path: 'live' });

    // 2. The original local copy is processed afterwards.
    const now = new Date().toISOString();
    const res = await fetch(`${url}/messages/relay-agent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        schemaVersion: 1,
        message: { id, from: { agent: 'sender-agent', session: 's', machine: 'this-machine-peer', fingerprint: SENDER_FP }, to: { agent: PROJECT, session: 'best', machine: 'local' }, type: 'request', priority: 'medium', subject: 'hello', body: 'the message', threadId, createdAt: now, ttlMinutes: 30 },
        transport: { relayChain: ['sender-machine'], originServer: 'http://127.0.0.1:1', nonce: `${crypto.randomUUID()}:${now}`, timestamp: now },
        delivery: { phase: 'sent', transitions: [], attempts: 0 },
      }),
    });
    expect(res.status).toBe(200);
    const answer = await res.json() as { accepted?: boolean; deduped?: boolean };
    expect(answer.accepted).toBe(true);
    expect(answer.deduped).toBeUndefined();

    await waitFor(() => handleInboundMessage.mock.calls.length === 1);
    const opts = (handleInboundMessage.mock.calls[0] as unknown as [unknown, unknown, { resentNotice: string | null }])[2];
    expect(opts.resentNotice).toBe(RESENT_COPY_NOTICE);
    await waitFor(() => controller.current()!.getRow(`registry:${SENDER_FP}`, id)?.disposition === 'handed-off');
    expect(controller.current()!.getRow(`unverified:${SENDER_FP}`, id)).toEqual(relayRow);

    // 3. Observable: the counter on the authed /health, both rows on the read route.
    const health = await (await fetch(`${url}/health`, { headers: { Authorization: `Bearer ${AUTH}` } })).json() as { threadline?: { inboundIdLedger?: Record<string, unknown> } };
    expect(health.threadline?.inboundIdLedger).toMatchObject({ operational: true, crossNamespaceLabelled: 1, dedupById: 0 });
    const read = await fetch(`${url}/a2a/inbound-ids?id=${encodeURIComponent(id)}`, { headers: { Authorization: `Bearer ${AUTH}` } });
    expect(read.status).toBe(200);
    const rows = (await read.json() as { rows: Array<{ senderKey: string }> }).rows.map((r) => r.senderKey).sort();
    expect(rows).toEqual([`registry:${SENDER_FP}`, `unverified:${SENDER_FP}`].sort());
  });
});
