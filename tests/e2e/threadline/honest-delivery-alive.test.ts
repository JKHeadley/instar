/**
 * Honest delivery outcomes — E2E "feature is alive" tier
 * (docs/specs/a2a-honest-delivery-outcomes.md).
 *
 * Production initialization path: the relay client comes from the real
 * `bootstrapThreadline`, the tracker is the real on-disk `A2ADeliveryTracker`,
 * and the verdict subscription + silence sweep are the exact
 * `honestDeliveryWiring` functions `commands/server.ts` calls. A real in-repo
 * `RelayServer` (the hosted relay is deployed from this codebase) supplies the
 * verdicts. Proves: an offline peer's message is recorded `queued`; when the
 * relay expires it the row becomes `failed` (corroborated), the peer reads
 * stale, and the counters are served on the AUTHENTICATED /health only; the
 * relay never forwards a peer's ack frame to the sender; acks on one socket
 * arrive in send order (the ordering the ban handling relies on).
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import { RelayServer } from '../../../src/threadline/relay/RelayServer.js';
import { RelayClient } from '../../../src/threadline/client/RelayClient.js';
import { computeFingerprint, deriveX25519PublicKey } from '../../../src/threadline/client/MessageEncryptor.js';
import { generateIdentityKeyPair } from '../../../src/threadline/ThreadlineCrypto.js';
import { bootstrapThreadline } from '../../../src/threadline/ThreadlineBootstrap.js';
import { A2ADeliveryTracker } from '../../../src/threadline/A2ADeliveryTracker.js';
import { wireRelayVerdicts, startDeliverySweep } from '../../../src/threadline/honestDeliveryWiring.js';
import { createRoutes } from '../../../src/server/routes.js';
import { StateManager } from '../../../src/core/StateManager.js';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';
import type { InstarConfig } from '../../../src/core/types.js';

const TOKEN = 'alive-token';
// Unique per run: agent discovery can remember names across runs on one machine.
const PEER_NAME = `luna-alive-${process.pid}-${Date.now().toString(36)}`;
const waitFor = async (cond: () => boolean, ms = 10_000): Promise<void> => {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 50));
  }
};

describe('honest delivery — production path is alive', () => {
  let relay: RelayServer;
  let relayUrl: string;
  let tmp: string;
  let stateDir: string;
  let boot: Awaited<ReturnType<typeof bootstrapThreadline>>;
  let tracker: A2ADeliveryTracker;
  let peerFp: string;
  let peerIdentity: ReturnType<typeof generateIdentityKeyPair>;
  let server: Server;
  let port: number;
  const reports: Array<{ feature: string }> = [];

  const peerClient = (name: string) => new RelayClient(
    { relayUrl, name, framework: 'test', capabilities: ['conversation'], version: '1.0.0', visibility: 'public' },
    { fingerprint: peerFp, publicKey: peerIdentity.publicKey, privateKey: peerIdentity.privateKey, x25519PublicKey: deriveX25519PublicKey(peerIdentity.privateKey), createdAt: new Date().toISOString() },
  );

  beforeAll(async () => {
    relay = new RelayServer({
      port: 0,
      rateLimitConfig: { perAgentPerMinute: 1000, perAgentPerHour: 10000, perIPPerMinute: 10000, globalPerMinute: 50000, discoveryPerMinute: 100, authAttemptsPerMinute: 100 },
      offlineQueueConfig: { defaultTtlMs: 200, maxPerSenderPerRecipient: 50, maxPerRecipient: 100, maxPayloadBytesPerRecipient: 500_000 },
      abuseDetectorConfig: { sybilFirstHourLimit: 10000, sybilSecondHourLimit: 10000, spamUniqueRecipientsPerMinute: 10000 },
    });
    await relay.start();
    relayUrl = `ws://127.0.0.1:${relay.address!.port}/v1/connect`;

    peerIdentity = generateIdentityKeyPair();
    peerFp = computeFingerprint(peerIdentity.publicKey);

    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'honest-alive-'));
    stateDir = path.join(tmp, 'state');
    const projectDir = path.join(tmp, 'project');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.mkdirSync(projectDir, { recursive: true });
    const kp = generateIdentityKeyPair();
    fs.writeFileSync(path.join(stateDir, 'identity.json'), JSON.stringify({
      publicKey: kp.publicKey.toString('base64'), privateKey: kp.privateKey.toString('base64'),
      privateKeyEncryption: 'none', createdAt: new Date().toISOString(),
    }));

    boot = await bootstrapThreadline({ agentName: 'alive-agent', stateDir, projectDir, port: 4040, relayEnabled: true, relayUrl });
    expect(boot.relayClient?.connectionState).toBe('connected');

    tracker = A2ADeliveryTracker.open('alive-agent', stateDir);
    wireRelayVerdicts(boot.relayClient!, () => tracker, { report: (e) => reports.push(e) });

    const config = { projectDir, stateDir, projectName: 'alive-agent', port: 4042, authToken: TOKEN } as InstarConfig;
    const router = createRoutes({
      config, state: new StateManager(stateDir), threadlineRelayClient: boot.relayClient, a2aDeliveryTracker: tracker,
      // /health reads the cached session count; a minimal real-shaped stand-in.
      sessionManager: { getCachedRunningSessions: () => ({ count: 0, sessions: [] }) },
      scheduler: null,
      relayVerdictCounters: () => ({ ...boot.relayClient!.relayVerdictCounters, expiredMismatchIgnored: tracker.expiredMismatchIgnored }),
      startTime: new Date(),
    } as any);
    const app = express();
    app.use(express.json());
    app.use(router);
    await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', () => { port = (server.address() as { port: number }).port; resolve(); }); });

    // Make the peer known to the sender, then take it offline.
    const peer = peerClient(PEER_NAME);
    await peer.connect();
    expect(await boot.relayClient!.resolveAgent(PEER_NAME)).toBe(peerFp);
    peer.disconnect();
    await new Promise((r) => setTimeout(r, 150));
  });

  afterAll(async () => {
    if (server) await new Promise<void>((r) => server.close(() => r()));
    await boot?.shutdown();
    tracker?.close();
    await relay.stop();
    SafeFsExecutor.safeRmSync(tmp, { recursive: true, force: true, operation: 'tests/e2e/threadline/honest-delivery-alive.test.ts' });
  });

  it('offline peer → queued → relay expiry → failed (corroborated), peer stale; counters only on authed /health', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/threadline/relay-send`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ targetAgent: PEER_NAME, message: 'still there?' }),
    });
    const body = await res.json() as { relayStatus: string; messageId: string };
    expect(res.status).toBe(200);
    expect(body.relayStatus).toBe('queued');
    expect(tracker.get(body.messageId)).toMatchObject({ state: 'awaiting-ack', relayStatus: 'queued' });

    // Drive the relay's own expiry pass (its timer is 30 s) after the 200 ms TTL.
    await new Promise((r) => setTimeout(r, 300));
    const q = (relay as unknown as { offlineQueue: { expireMessages(): unknown[]; expiryCallbacks: Array<(e: unknown[]) => void> } }).offlineQueue;
    const expired = q.expireMessages();
    expect(expired.length).toBeGreaterThan(0);
    for (const cb of q.expiryCallbacks) cb(expired);

    // The real delivery_expired frame carries the canonical recipient fingerprint.
    await waitFor(() => tracker.get(body.messageId)?.state === 'failed');
    expect(tracker.get(body.messageId)).toMatchObject({ state: 'failed', relayStatus: 'expired' });
    const health = tracker.peerHealth(peerFp);
    expect(health.failedCount).toBe(1);
    expect(health.stale).toBe(true);
    expect(tracker.expiredMismatchIgnored).toBe(0);

    const anon = await (await fetch(`http://127.0.0.1:${port}/health`)).json() as Record<string, unknown>;
    expect(anon.threadline).toBeUndefined();
    const authed = await (await fetch(`http://127.0.0.1:${port}/health`, { headers: { Authorization: `Bearer ${TOKEN}` } })).json() as { threadline?: { relayVerdicts?: Record<string, number> } };
    expect(authed.threadline?.relayVerdicts).toMatchObject({ cacheEvictions: 0, unmappedReason: 0, expiredMismatchIgnored: 0 });
  });

  it('the silence sweep (production function) relabels a verdict-less relay row to unconfirmed, never failed', () => {
    const since = Date.parse(tracker.relayTrackingSince());
    tracker.recordSent({ messageId: 'msg-silent', peerFp, threadId: 'thread-silent', transport: 'relay', sentAt: new Date(since + 1000).toISOString() });
    const audit = path.join(tmp, 'logs', 'a2a-delivery-verdicts.jsonl');
    const sweep = startDeliverySweep({ tracker, auditPath: audit, degradations: { report: (e) => reports.push(e) }, schedule: false });
    expect(sweep.tick(since + 1000 + 25 * 60 * 60 * 1000)).toBe(1);
    expect(tracker.get('msg-silent')!.state).toBe('unconfirmed');
    const line = JSON.parse(fs.readFileSync(audit, 'utf-8').trim());
    expect(line).toMatchObject({ kind: 'sweep', messageId: 'msg-silent', to: 'unconfirmed', cause: 'no-verdict-timeout' });
    expect(JSON.stringify(line)).not.toContain('text');
    sweep.stop();
  });

  it('a sustained-failure sweep tick reports ONCE and backs off (skips ticks, never re-creates the timer)', () => {
    const broken = { sweepSilence: () => { throw new Error('db gone'); }, relayTrackingSince: () => new Date().toISOString() } as unknown as A2ADeliveryTracker;
    const before = reports.length;
    const sweep = startDeliverySweep({ tracker: broken, auditPath: path.join(tmp, 'x.jsonl'), degradations: { report: (e) => reports.push(e) }, schedule: false });
    const t0 = Date.now();
    sweep.tick(t0);
    sweep.tick(t0 + 60 * 60 * 1000 + 1);
    sweep.tick(t0 + 60 * 60 * 1000 + 2 * 60 * 60 * 1000 + 2);
    expect(reports.length - before).toBe(1);
    expect(reports[reports.length - 1].feature).toBe('A2ADeliverySweep');
    expect(sweep.state().backoffMs).toBe(8 * 60 * 60 * 1000);
    sweep.stop();
  });

  it('the relay never forwards a peer\'s ack frame to the sender (ack-origin invariant)', async () => {
    const peer = peerClient(PEER_NAME);
    await peer.connect();
    const seen: unknown[] = [];
    const onVerdict = (v: unknown) => seen.push(v);
    boot.relayClient!.on('relay-verdict', onVerdict);
    peer.sendAck('msg-forged', 'delivered');
    await new Promise((r) => setTimeout(r, 300));
    expect(seen.find((v) => (v as { messageId: string }).messageId === 'msg-forged')).toBeUndefined();
    boot.relayClient!.off('relay-verdict', onVerdict);
    peer.disconnect();
  });

  it('acks for back-to-back sends on one socket arrive in send order (the ordering the ban handling relies on)', async () => {
    const peer = peerClient(PEER_NAME);
    await peer.connect();
    const order: string[] = [];
    const onVerdict = (v: { messageId: string }) => order.push(v.messageId);
    boot.relayClient!.on('relay-verdict', onVerdict);
    const ids = [1, 2, 3, 4, 5].map((i) => boot.relayClient!.sendAuto(peerFp, `burst ${i}`));
    await waitFor(() => ids.every((id) => order.includes(id)));
    expect(order.filter((id) => ids.includes(id))).toEqual(ids);
    boot.relayClient!.off('relay-verdict', onVerdict);
    peer.disconnect();
    void vi;
  });
});
