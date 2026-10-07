/**
 * Integration tier — A2A backup routes (docs/specs/a2a-backup-routes.md).
 *
 * A REAL in-repo RelayServer; a REAL ThreadlineClient behind the REAL
 * /threadline/relay-send route (gate on via developmentAgent); a receiver
 * agent booted with the REAL `bootstrapThreadline` relay client whose
 * `gate-passed` consumer runs the same `runRelayInboundWithLedger` server.ts
 * uses, over a REAL on-disk inbound-id ledger. The receiver's same-machine
 * loopback (`/threadline/health` + `/messages/relay-agent`) is a local server
 * whose answers each test sets.
 *
 *  - a local POST that times out falls through, and the relay copy arrives on
 *    the local attempt's thread with the resent-copy notice;
 *  - an ECONNREFUSED fall-through arrives unmarked;
 *  - an in-flight 409 is marked;
 *  - a fingerprint-addressed send to a connected co-located agent goes local;
 *    to a standby or a stale port it goes to the relay;
 *  - a sender whose own relay is down still delivers a fingerprint-addressed
 *    message locally.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { Server } from 'node:http';
import { createRoutes } from '../../../src/server/routes.js';
import { StateManager } from '../../../src/core/StateManager.js';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';
import type { InstarConfig } from '../../../src/core/types.js';
import { RelayServer } from '../../../src/threadline/relay/RelayServer.js';
import { ThreadlineClient } from '../../../src/threadline/client/ThreadlineClient.js';
import { bootstrapThreadline } from '../../../src/threadline/ThreadlineBootstrap.js';
import { InboundMessageGate } from '../../../src/threadline/InboundMessageGate.js';
import { buildInboundIdLedgerController, RESENT_COPY_NOTICE, type InboundIdLedgerController } from '../../../src/threadline/InboundIdLedger.js';
import { runRelayInboundWithLedger } from '../../../src/threadline/inboundIdLedgerWiring.js';

const TOKEN = 'backup-routes-int-token';

const waitFor = async (cond: () => boolean, ms = 10_000): Promise<void> => {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 50));
  }
};

type PostMode = 'ok' | 'hang' | 'refuse' | 'inflight';

describe('A2A backup routes — real relay, ledger on the receiver', () => {
  let relay: RelayServer;
  let relayUrl: string;
  let tmp: string;
  let recvState: string;
  let recvBoot: Awaited<ReturnType<typeof bootstrapThreadline>>;
  let recvFp: string;
  let controller: InboundIdLedgerController;
  const received: Array<{ messageId: string | null; threadId?: string; notice: string | null }> = [];

  // The receiver's same-machine loopback.
  let loop: Server;
  let loopApp: express.Express;
  let loopPort: number;
  let postMode: PostMode = 'ok';
  let health: Record<string, unknown> = {};
  const localEnvelopes: Array<{ message: { id: string; threadId: string } }> = [];

  // The sender.
  let senderState: string;
  let sender: ThreadlineClient;
  let server: Server;
  let port: number;
  let tokenPath: string;
  const RECV_NAME = `backup-recv-${randomBytes(3).toString('hex')}`;

  const send = async (body: Record<string, unknown>) => {
    const r = await fetch(`http://127.0.0.1:${port}/threadline/relay-send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify(body),
    });
    return { status: r.status, body: await r.json() as Record<string, unknown> };
  };

  const listenLoop = () => new Promise<void>((resolve) => {
    loop = loopApp.listen(loopPort ?? 0, '127.0.0.1', () => { loopPort = (loop.address() as { port: number }).port; resolve(); });
  });

  beforeAll(async () => {
    relay = new RelayServer({
      port: 0,
      rateLimitConfig: { perAgentPerMinute: 1000, perAgentPerHour: 10000, perIPPerMinute: 10000, globalPerMinute: 50000, discoveryPerMinute: 100, authAttemptsPerMinute: 100 },
      abuseDetectorConfig: { sybilFirstHourLimit: 10000, sybilSecondHourLimit: 10000, spamUniqueRecipientsPerMinute: 10000 },
    });
    await relay.start();
    relayUrl = `ws://127.0.0.1:${relay.address!.port}/v1/connect`;
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-routes-int-'));

    // ── receiver: real relay client + real ledger ──
    recvState = path.join(tmp, 'recv');
    fs.mkdirSync(recvState, { recursive: true });
    controller = buildInboundIdLedgerController({
      stateDir: recvState, agentId: RECV_NAME, developmentAgent: true, readBlock: () => ({ retentionDays: 14 }),
    });
    expect(controller.current()).not.toBeNull();
    recvBoot = await bootstrapThreadline({ agentName: RECV_NAME, stateDir: recvState, projectDir: path.join(tmp, 'recv-project'), port: 4040, relayEnabled: true, relayUrl });
    expect(recvBoot.relayClient?.connectionState).toBe('connected');
    recvFp = recvBoot.relayClient!.fingerprint!.toLowerCase();
    recvBoot.relayClient!.on('gate-passed', (decision) => {
      void runRelayInboundWithLedger(
        decision,
        { ledger: () => controller.current(), tracker: () => null, extractMessageId: (m) => InboundMessageGate.extractMessageId(m as never) },
        async (ticket, notice) => {
          received.push({ messageId: InboundMessageGate.extractMessageId(decision.message as never), threadId: decision.message?.threadId, notice });
          ticket?.recordHandoff('listener');
        },
      );
    });

    // ── receiver's loopback ──
    loopApp = express();
    loopApp.use(express.json({ limit: '128kb' }));
    loopApp.get('/threadline/health', (_req, res) => {
      if (postMode === 'refuse') { loop.close(); res.set('Connection', 'close'); }
      res.json(health);
    });
    loopApp.post('/messages/relay-agent', (req, res) => {
      localEnvelopes.push(req.body);
      if (postMode === 'hang') return; // never answers → the sender's 10 s POST timeout
      if (postMode === 'inflight') { res.status(409).json({ deduped: true, disposition: 'admitted', retryable: true }); return; }
      res.json({ ok: true, accepted: true, delivered: false, threadline: { accepted: true, delivered: false, async: true } });
    });
    await listenLoop();

    // ── sender ──
    senderState = path.join(tmp, 'send', '.instar');
    fs.mkdirSync(path.join(senderState, 'threadline'), { recursive: true });
    fs.mkdirSync(path.join(senderState, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(senderState, 'config.json'), JSON.stringify({ projectName: 'backup-sender' }));
    fs.writeFileSync(path.join(senderState, 'threadline', 'known-agents.json'), JSON.stringify({
      agents: [{ name: RECV_NAME, port: loopPort, fingerprint: recvFp }],
    }));
    const tokenDir = path.join(os.homedir(), '.instar', 'agent-tokens');
    fs.mkdirSync(tokenDir, { recursive: true });
    tokenPath = path.join(tokenDir, `${RECV_NAME}.token`);
    fs.writeFileSync(tokenPath, randomBytes(32).toString('hex'));

    sender = new ThreadlineClient({ name: 'backup-sender', relayUrl, visibility: 'public', stateDir: path.join(senderState, 'threadline') });
    await sender.connect();
    expect((await sender.resolveAgent(RECV_NAME))?.toLowerCase()).toBe(recvFp);

    const config = { projectDir: path.join(tmp, 'send'), stateDir: senderState, projectName: 'backup-sender', port: 4042, authToken: TOKEN, developmentAgent: true } as InstarConfig;
    const router = createRoutes({ config, state: new StateManager(senderState), threadlineRelayClient: sender, startTime: new Date() } as never);
    const app = express();
    app.use(express.json());
    app.use(router);
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => { port = (server.address() as { port: number }).port; resolve(); });
    });
  }, 30_000);

  afterAll(async () => {
    if (server) await new Promise<void>((r) => server.close(() => r()));
    if (loop?.listening) await new Promise<void>((r) => { loop.close(() => r()); loop.closeAllConnections(); });
    try { sender.disconnect(); } catch { /* already closed */ }
    await recvBoot?.shutdown();
    controller?.close();
    await relay.stop();
    SafeFsExecutor.safeRmSync(tokenPath, { force: true, operation: 'tests/integration/threadline/a2a-backup-routes.test.ts:token' });
    SafeFsExecutor.safeRmSync(tmp, { recursive: true, force: true, operation: 'tests/integration/threadline/a2a-backup-routes.test.ts' });
  });

  beforeEach(() => {
    postMode = 'ok';
    health = { fingerprint: recvFp, relay: { state: 'connected' } };
    localEnvelopes.length = 0;
  });

  const relayCopyOf = async (messageId: string) => {
    await waitFor(() => received.some((r) => r.messageId === messageId));
    return received.find((r) => r.messageId === messageId)!;
  };

  it('a local POST that times out falls through; the relay copy arrives on the same thread with the resent-copy notice', async () => {
    postMode = 'hang';
    const r = await send({ targetAgent: RECV_NAME, message: 'timeout then relay' });
    expect(r.body).toMatchObject({ deliveryPath: 'relay' });
    const local = localEnvelopes[0].message;
    expect(r.body.messageId).toBe(local.id);
    expect(r.body.threadId).toBe(local.threadId);
    const copy = await relayCopyOf(local.id);
    expect(copy.threadId).toBe(local.threadId);
    expect(copy.notice).toBe(RESENT_COPY_NOTICE);
  }, 30_000);

  it('an ECONNREFUSED fall-through arrives unmarked (still on the local attempt\'s thread)', async () => {
    postMode = 'refuse';
    try {
      const r = await send({ targetAgent: RECV_NAME, message: 'refused then relay' });
      expect(r.body).toMatchObject({ deliveryPath: 'relay' });
      expect(localEnvelopes).toHaveLength(0);
      const copy = await relayCopyOf(String(r.body.messageId));
      expect(copy.notice).toBeNull();
      expect(copy.threadId).toBe(r.body.threadId);
    } finally {
      await listenLoop();
    }
  });

  it('an in-flight 409 is marked', async () => {
    postMode = 'inflight';
    const r = await send({ targetAgent: RECV_NAME, message: 'in-flight then relay' });
    const local = localEnvelopes[0].message;
    const copy = await relayCopyOf(local.id);
    expect(r.body.threadId).toBe(local.threadId);
    expect(copy.threadId).toBe(local.threadId);
    expect(copy.notice).toBe(RESENT_COPY_NOTICE);
  });

  it('a fingerprint-addressed send to a connected co-located agent takes the local route', async () => {
    const before = received.length;
    const r = await send({ targetAgent: recvFp, message: 'by fingerprint' });
    expect(r.body).toMatchObject({ success: true, deliveryPath: 'local', resolvedAgent: RECV_NAME });
    expect(localEnvelopes).toHaveLength(1);
    await new Promise((res) => setTimeout(res, 300));
    expect(received.length).toBe(before);
  });

  it('a fingerprint-addressed send to a standby (relay not-configured) goes to the relay, unmarked', async () => {
    health = { fingerprint: recvFp, relay: { state: 'not-configured' } };
    const r = await send({ targetAgent: recvFp, message: 'standby → relay' });
    expect(r.body).toMatchObject({ deliveryPath: 'relay' });
    expect(localEnvelopes).toHaveLength(0);
    const copy = await relayCopyOf(String(r.body.messageId));
    expect(copy.notice).toBeNull();
  });

  it('a fingerprint-addressed send to a stale port (another agent answers) goes to the relay', async () => {
    health = { fingerprint: 'f0'.repeat(16), relay: { state: 'connected' } };
    const r = await send({ targetAgent: recvFp, message: 'stale port → relay' });
    expect(r.body).toMatchObject({ deliveryPath: 'relay' });
    expect(localEnvelopes).toHaveLength(0);
    await relayCopyOf(String(r.body.messageId));
  });

  it('a sender whose own relay is down still delivers a fingerprint-addressed message locally (last: disconnects the sender)', async () => {
    sender.disconnect();
    await waitFor(() => sender.connectionState !== 'connected', 5000);
    const r = await send({ targetAgent: recvFp, message: 'my relay is down' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ success: true, deliveryPath: 'local' });
    // The same send by name with a failing local POST has no relay to fall back to.
    postMode = 'inflight';
    const r2 = await send({ targetAgent: RECV_NAME, message: 'no relay, local refused' });
    expect(r2.status).toBe(503);
  });
});
