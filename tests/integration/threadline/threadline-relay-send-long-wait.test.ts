/**
 * Long waits on `/threadline/relay-send` (docs/specs/threadline-mcp-local-http.md
 * "Bounds", Frontloaded Decision 12 — ships live, for BOTH transports;
 * acceptance criterion 8).
 *
 * The generic request timeout is shrunk to 300 ms here so the test stands in
 * for the production 30 s cut-off: before the fix, a `waitForReply` past it
 * got a 408 although the message had already left. With the override map
 * (340 s on relay-send and /mcp/threadline) the wait completes and the client
 * receives the reply — through the stdio helper's call (`sendMessageViaHttp`)
 * and through the HTTP MCP route alike. A premature close of the inner request
 * cancels the reply wait on BOTH relay-send branches (no waiter left behind).
 *
 * Real RelayServer + real ThreadlineClient for the relay branch; a fake
 * co-located agent for the local-delivery branch.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { Server } from 'node:http';
import { RelayServer } from '../../../src/threadline/relay/RelayServer.js';
import { RelayClient } from '../../../src/threadline/client/RelayClient.js';
import { ThreadlineClient } from '../../../src/threadline/client/ThreadlineClient.js';
import { computeFingerprint, deriveX25519PublicKey } from '../../../src/threadline/client/MessageEncryptor.js';
import { generateIdentityKeyPair } from '../../../src/threadline/ThreadlineCrypto.js';
import { A2ADeliveryTracker } from '../../../src/threadline/A2ADeliveryTracker.js';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';
import { sendMessageViaHttp } from '../../../src/threadline/mcp-http-client.js';
import { startHarness, connectClient, waitFor, AGENT_TOKEN, type Harness } from './_mcp-http-harness.js';

let relay: RelayServer;
let sender: ThreadlineClient;
let recipient: RelayClient;
let tracker: A2ADeliveryTracker;
let h: Harness;
let senderDir: string;
let fakeTarget: Server;
let tokenFilePath: string;
const LOCAL_TARGET = `longwait-local-${randomBytes(3).toString('hex')}`;

/** Resolve the (only) registered reply waiter after `ms`, as an inbound reply would. */
async function replyAfter(ms: number, text: string): Promise<void> {
  await waitFor(() => h.waiters.size > 0);
  await new Promise((r) => setTimeout(r, ms));
  const [entry] = [...h.waiters.values()];
  entry.resolve(text);
}

describe('relay-send long waits and close-cancellation (both transports)', () => {
  beforeAll(async () => {
    relay = new RelayServer({
      port: 0,
      rateLimitConfig: { perAgentPerMinute: 1000, perAgentPerHour: 10000, perIPPerMinute: 10000, globalPerMinute: 50000, discoveryPerMinute: 100, authAttemptsPerMinute: 100 },
      offlineQueueConfig: { defaultTtlMs: 3_600_000, maxPerSenderPerRecipient: 50, maxPerRecipient: 100, maxPayloadBytesPerRecipient: 500_000 },
      abuseDetectorConfig: { sybilFirstHourLimit: 10000, sybilSecondHourLimit: 10000, spamUniqueRecipientsPerMinute: 10000 },
    });
    await relay.start();
    const relayUrl = `ws://127.0.0.1:${relay.address!.port}/v1/connect`;
    const rid = generateIdentityKeyPair();
    const recipientFp = computeFingerprint(rid.publicKey);
    recipient = new RelayClient(
      { relayUrl, name: 'slow-peer', framework: 'test', capabilities: ['conversation'], version: '1.0.0', visibility: 'public' },
      { fingerprint: recipientFp, publicKey: rid.publicKey, privateKey: rid.privateKey, x25519PublicKey: deriveX25519PublicKey(rid.privateKey), createdAt: new Date().toISOString() },
    );
    await recipient.connect();
    const base = process.env.TMPDIR && !process.env.TMPDIR.startsWith('/tmp') ? process.env.TMPDIR : os.tmpdir();
    senderDir = fs.mkdtempSync(path.join(base, 'instar-longwait-sender-'));
    sender = new ThreadlineClient({ name: 'longwait-sender', relayUrl, visibility: 'public', stateDir: senderDir });
    await sender.connect();
    expect(await sender.resolveAgent('slow-peer')).toBe(recipientFp);
    tracker = A2ADeliveryTracker.openMemory();
    sender.on('relay-verdict', (v) => tracker.recordRelayStatus(v));

    h = await startHarness({}, { defaultTimeoutMs: 300, routeCtx: { threadlineRelayClient: sender, a2aDeliveryTracker: tracker } });

    // A fake co-located agent for the local-delivery branch.
    const targetApp = express();
    targetApp.use(express.json());
    targetApp.get('/threadline/health', (_req, res) => res.json({ ok: true }));
    targetApp.post('/messages/relay-agent', (_req, res) => res.json({ ok: true, accepted: true, delivered: false, threadline: { accepted: true, delivered: false, async: true } }));
    fakeTarget = await new Promise<Server>((resolve) => { const s = targetApp.listen(0, '127.0.0.1', () => resolve(s)); });
    fs.writeFileSync(path.join(h.stateDir, 'threadline', 'known-agents.json'), JSON.stringify({ agents: [{
      name: LOCAL_TARGET, port: (fakeTarget.address() as { port: number }).port,
      fingerprint: 'aabbccddeeff00112233445566778899', publicKey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
    }] }));
    // Same precedent as relay-send-local-roundtrip.test.ts: the route reads the target's token from ~/.instar/agent-tokens.
    const tokenDir = path.join(os.homedir(), '.instar', 'agent-tokens');
    fs.mkdirSync(tokenDir, { recursive: true });
    tokenFilePath = path.join(tokenDir, `${LOCAL_TARGET}.token`);
    fs.writeFileSync(tokenFilePath, randomBytes(32).toString('hex'));
  });

  afterAll(async () => {
    await h?.close();
    if (fakeTarget) await new Promise<void>((r) => fakeTarget.close(() => r()));
    try { sender.disconnect(); } catch { /* closed */ }
    try { recipient.disconnect(); } catch { /* closed */ }
    tracker?.close();
    await relay.stop();
    SafeFsExecutor.safeRmSync(tokenFilePath, { force: true, operation: 'tests/integration/threadline/threadline-relay-send-long-wait.test.ts:token' });
    SafeFsExecutor.safeRmSync(senderDir, { recursive: true, force: true, operation: 'tests/integration/threadline/threadline-relay-send-long-wait.test.ts' });
  });

  it('stdio path: a wait past the generic request timeout completes and returns the reply (was a 408)', async () => {
    const [result] = await Promise.all([
      sendMessageViaHttp({ targetAgent: 'slow-peer', message: 'ping', waitForReply: true, timeoutSeconds: 10 }, h.port, AGENT_TOKEN, 'stdio-session'),
      replyAfter(900, 'pong-stdio'),
    ]);
    expect(result).toMatchObject({ success: true, reply: 'pong-stdio' });
    expect(result.outcomeUnknown).toBeUndefined();
  });

  it('HTTP path: threadline_send over /mcp/threadline waits past the generic timeout and the client receives the reply', async () => {
    const client = await connectClient(h, 'http-session');
    const [r] = await Promise.all([
      client.callTool({ name: 'threadline_send', arguments: { agentId: 'slow-peer', message: 'ping', waitForReply: true, timeoutSeconds: 10 } }),
      replyAfter(900, 'pong-http'),
    ]);
    const body = JSON.parse((r as { content: Array<{ text: string }> }).content[0].text);
    expect(body).toMatchObject({ reply: 'pong-http' });
    await waitFor(() => (h.svc.health().inFlight as { total: number }).total === 0);
    await client.close();
  });

  it('relay branch: closing the inner request ends the reply wait (no waiter left behind)', async () => {
    const ac = new AbortController();
    const req = fetch(`http://127.0.0.1:${h.port}/threadline/relay-send`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: ac.signal,
      body: JSON.stringify({ targetAgent: 'slow-peer', message: 'will hang up', waitForReply: true, timeoutSeconds: 300 }),
    }).catch(() => null);
    await waitFor(() => h.waiters.size === 1);
    ac.abort();
    await req;
    await waitFor(() => h.waiters.size === 0, 2_000);
  });

  it('local-delivery branch: closing the inner request ends the reply wait too', async () => {
    const ac = new AbortController();
    const req = fetch(`http://127.0.0.1:${h.port}/threadline/relay-send`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: ac.signal,
      body: JSON.stringify({ targetAgent: LOCAL_TARGET, message: 'local hang up', waitForReply: true, timeoutSeconds: 300 }),
    }).catch(() => null);
    await waitFor(() => h.waiters.size === 1);
    ac.abort();
    await req;
    await waitFor(() => h.waiters.size === 0, 2_000);
  });

  it('a normally completed request does not cancel anything (close fires after finish)', async () => {
    const [result] = await Promise.all([
      sendMessageViaHttp({ targetAgent: LOCAL_TARGET, message: 'local ping', waitForReply: true, timeoutSeconds: 10 }, h.port, AGENT_TOKEN),
      replyAfter(50, 'local-pong'),
    ]);
    expect(result).toMatchObject({ success: true, reply: 'local-pong', deliveryPath: 'local' });
  });
});
