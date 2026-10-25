/**
 * Honest delivery outcomes — integration tier
 * (docs/specs/a2a-honest-delivery-outcomes.md §4/§6).
 *
 * Drives `/threadline/relay-send` with a REAL ThreadlineClient against a REAL
 * in-repo RelayServer: a live recipient (delivered), an offline recipient
 * (queued, N h), a full offline queue (502 rejected, retryLater, claim released,
 * refused reply re-drivable), the MCP client rendering of all of it, and the
 * peer-health pool scope's token check.
 *
 * Before this change every one of these sends answered
 * "submitted to relay; acceptance unconfirmed" — the 2026-10-06 Luna incident.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import { createRoutes } from '../../../src/server/routes.js';
import { StateManager } from '../../../src/core/StateManager.js';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';
import type { InstarConfig } from '../../../src/core/types.js';
import { RelayServer } from '../../../src/threadline/relay/RelayServer.js';
import { RelayClient } from '../../../src/threadline/client/RelayClient.js';
import { ThreadlineClient } from '../../../src/threadline/client/ThreadlineClient.js';
import { computeFingerprint, deriveX25519PublicKey } from '../../../src/threadline/client/MessageEncryptor.js';
import { generateIdentityKeyPair } from '../../../src/threadline/ThreadlineCrypto.js';
import { A2ADeliveryTracker } from '../../../src/threadline/A2ADeliveryTracker.js';
import { ListenerSessionManager } from '../../../src/threadline/ListenerSessionManager.js';
import { sendMessageViaHttp } from '../../../src/threadline/mcp-http-client.js';
import type { RelayVerdict } from '../../../src/threadline/relayVerdict.js';

const TOKEN = 'honest-delivery-token';

let relay: RelayServer;
let relayPort: number;
let projectDir: string;
let stateDir: string;
let sender: ThreadlineClient;
let recipient: RelayClient;
let recipientFp: string;
let tracker: A2ADeliveryTracker;
let listener: ListenerSessionManager;
let server: Server;
let port: number;

const post = async (body: Record<string, unknown>) => {
  const res = await fetch(`http://127.0.0.1:${port}/threadline/relay-send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() as Record<string, unknown> };
};

describe('/threadline/relay-send — honest delivery outcomes (real relay)', () => {
  beforeAll(async () => {
    relay = new RelayServer({
      port: 0,
      rateLimitConfig: { perAgentPerMinute: 1000, perAgentPerHour: 10000, perIPPerMinute: 10000, globalPerMinute: 50000, discoveryPerMinute: 100, authAttemptsPerMinute: 100 },
      offlineQueueConfig: { defaultTtlMs: 3_600_000, maxPerSenderPerRecipient: 2, maxPerRecipient: 10, maxPayloadBytesPerRecipient: 50_000 },
      abuseDetectorConfig: { sybilFirstHourLimit: 10000, sybilSecondHourLimit: 10000, spamUniqueRecipientsPerMinute: 10000 },
    });
    await relay.start();
    relayPort = relay.address!.port;
    const relayUrl = `ws://127.0.0.1:${relayPort}/v1/connect`;

    const rid = generateIdentityKeyPair();
    recipientFp = computeFingerprint(rid.publicKey);
    recipient = new RelayClient(
      { relayUrl, name: 'luna-peer', framework: 'test', capabilities: ['conversation'], version: '1.0.0', visibility: 'public' },
      { fingerprint: recipientFp, publicKey: rid.publicKey, privateKey: rid.privateKey, x25519PublicKey: deriveX25519PublicKey(rid.privateKey), createdAt: new Date().toISOString() },
    );
    await recipient.connect();

    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-honest-delivery-'));
    stateDir = path.join(projectDir, '.instar');
    fs.mkdirSync(path.join(stateDir, 'threadline'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ projectName: 'echo-honest' }));

    sender = new ThreadlineClient({ name: 'echo-honest', relayUrl, visibility: 'public', stateDir: path.join(stateDir, 'threadline') });
    await sender.connect();
    // Learn the recipient so name resolution is deterministic.
    expect(await sender.resolveAgent('luna-peer')).toBe(recipientFp);

    tracker = A2ADeliveryTracker.openMemory();
    // The production wiring (server.ts): one subscription, the only verdict writer.
    sender.on('relay-verdict', (v: RelayVerdict) => tracker.recordRelayStatus(v));
    listener = new ListenerSessionManager(stateDir, 'listener-token');

    const config = { projectDir, stateDir, projectName: 'echo-honest', port: 4042, authToken: TOKEN } as InstarConfig;
    const router = createRoutes({
      config,
      state: new StateManager(stateDir),
      threadlineRelayClient: sender,
      a2aDeliveryTracker: tracker,
      listenerManager: listener,
      startTime: new Date(),
    } as any);
    const app = express();
    app.use(express.json());
    app.use(router);
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => { port = (server.address() as { port: number }).port; resolve(); });
    });
  });

  afterAll(async () => {
    if (server) await new Promise<void>((r) => server.close(() => r()));
    try { sender.disconnect(); } catch { /* already closed */ }
    try { recipient.disconnect(); } catch { /* already closed */ }
    tracker?.close();
    await relay.stop();
    SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: 'tests/integration/threadline/relay-send-honest-delivery.test.ts' });
  });

  it('a live recipient answers relayStatus delivered — accepted, but never "delivered" (that needs a reply)', async () => {
    const { status, body } = await post({ targetAgent: 'luna-peer', message: 'hello' });
    expect(status).toBe(200);
    expect(body).toMatchObject({ success: true, accepted: true, delivered: false, relayStatus: 'delivered' });
    expect(String(body.deliveryOutcome)).toContain("handed to the peer's relay connection");
    expect(tracker.get(String(body.messageId))).toMatchObject({ state: 'awaiting-ack', relayStatus: 'delivered' });
  });

  it('an offline recipient answers relayStatus queued with the relay hold in hours', async () => {
    recipient.disconnect();
    await new Promise((r) => setTimeout(r, 150));
    const { status, body } = await post({ targetAgent: 'luna-peer', message: 'are you there?' });
    expect(status).toBe(200);
    expect(body).toMatchObject({ success: true, accepted: true, relayStatus: 'queued' });
    expect(String(body.deliveryOutcome)).toContain('peer offline; the relay holds it for up to 1 h');
    expect(tracker.get(String(body.messageId))).toMatchObject({ state: 'awaiting-ack', relayStatus: 'queued' });
  });

  it('a full offline queue answers 502 rejected: retryLater, claim released, refused reply re-drivable', async () => {
    await post({ targetAgent: 'luna-peer', message: 'fills the queue' }); // second queued (cap 2)
    // An authenticated inbound the refused reply answers (the route requires one).
    listener.appendCanonicalInboxEntry({ from: recipientFp, senderName: 'luna-peer', trustLevel: 'verified', threadId: 'thread-77', text: 'question?', messageId: 'inbound-77' });
    const { status, body } = await post({ targetAgent: 'luna-peer', message: 'refused', inReplyTo: 'inbound-77', threadId: 'thread-77' });
    expect(status).toBe(502);
    expect(body).toMatchObject({ success: false, accepted: false, relayStatus: 'rejected', relayReasonCode: 'queue-full', retryLater: true });
    expect(String(body.error)).toContain('do not resend now');
    expect(JSON.stringify(body)).not.toContain('Offline queue full');
    expect(tracker.get(String(body.messageId))).toMatchObject({ state: 'failed', relayStatus: 'rejected', relayRetryable: true });
    // The refused reply is recorded as such and is NOT "already sent".
    expect(listener.hasCanonicalReplyFor('thread-77', 'inbound-77')).toBe(false);
    // The claim was released: the same inbound can be claimed again for a retry.
    expect(listener.tryClaimReply('inbound-77', 'retry-owner')).toBe(true);
  });

  it('the MCP client keeps the ids and contract fields on a refusal and never invents "delivered"', async () => {
    const result = await sendMessageViaHttp({ targetAgent: 'luna-peer', message: 'refused again', waitForReply: false, timeoutSeconds: 5 }, port, TOKEN);
    expect(result).toMatchObject({ success: false, relayStatus: 'rejected', relayReasonCode: 'queue-full', retryLater: true });
    expect(result.messageId).toMatch(/^msg-/);
  });

  it('peer health: default scope is reachable, the pool scope demands the token (absent → 403)', async () => {
    const plain = await fetch(`http://127.0.0.1:${port}/threadline/peers/health`);
    expect(plain.status).toBe(200);
    const plainBody = await plain.json() as { peers: Array<{ peerFp: string; failedCount: number }>; instarVersion: string };
    expect(typeof plainBody.instarVersion).toBe('string');
    expect(plainBody.peers.find((p) => p.peerFp === recipientFp)?.failedCount).toBeGreaterThanOrEqual(1);

    const noToken = await fetch(`http://127.0.0.1:${port}/threadline/peers/health?scope=pool`);
    expect(noToken.status).toBe(403);
    const wrong = await fetch(`http://127.0.0.1:${port}/threadline/peers/health?scope=pool`, { headers: { Authorization: 'Bearer nope' } });
    expect(wrong.status).toBe(403);
    const ok = await fetch(`http://127.0.0.1:${port}/threadline/peers/health?scope=pool`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    expect(ok.status).toBe(200);
    const okBody = await ok.json() as { scope: string; mixedVersion: boolean; pool: { peersQueried: number } };
    expect(okBody.scope).toBe('pool');
    expect(okBody.mixedVersion).toBe(false);
  });

  it('rejects a malformed fingerprint on the per-peer route', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/threadline/peers/..%2Fsecrets/health`);
    expect(res.status).toBe(400);
  });
});
