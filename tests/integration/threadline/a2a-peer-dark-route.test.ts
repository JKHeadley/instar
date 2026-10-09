// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * Tier-2 integration for a2a-single-agent-identity §3 (AC5): the send route and
 * the health reads over the real HTTP pipeline with a REAL ThreadlineClient
 * against a REAL in-repo RelayServer.
 *
 *  - A send to a peer whose rows have been queued past the threshold carries
 *    `peerDark` {since, queuedCount, expiresAt, connectedNow}; with the notice
 *    LIVE the deliveryOutcome is the worded sentence; in dry-run the legacy
 *    sentence stands and a would-sentence row lands in logs/a2a-peer-dark.jsonl.
 *  - `connectedNow` is read from the presence map (false after a refresh that
 *    saw the recipient offline) — no inline discover on the send path.
 *  - GET /threadline/peers/health and the per-peer route carry `dark`,
 *    `darkSince`, `queuedCount`, `connectedNow`, `darkCount`.
 *  - The MCP HTTP client passes `peerDark` through additively.
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

const TOKEN = 'peer-dark-token';
const H = 3_600_000;

let relay: RelayServer;
let relayDataDir: string;
let projectDir: string;
let stateDir: string;
let sender: ThreadlineClient;
let recipient: RelayClient;
let recipientFp: string;
let tracker: A2ADeliveryTracker;
let listener: ListenerSessionManager;
let server: Server;
let port: number;
let config: InstarConfig & { threadline: { peerDarkNotice: { enabled: boolean; dryRun: boolean; queuedDarkAfterMs: number } } };

const post = async (body: Record<string, unknown>) => {
  const res = await fetch(`http://127.0.0.1:${port}/threadline/relay-send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() as Record<string, unknown> };
};
const get = async (p: string) => {
  const res = await fetch(`http://127.0.0.1:${port}${p}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  return { status: res.status, body: await res.json() as Record<string, unknown> };
};
const auditPath = () => path.join(stateDir, 'logs', 'a2a-peer-dark.jsonl');
const auditRows = (): Array<Record<string, unknown>> =>
  fs.existsSync(auditPath()) ? fs.readFileSync(auditPath(), 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];

describe('§3 dark peer — /threadline/relay-send + peers/health (real relay)', () => {
  beforeAll(async () => {
    // The relay persists registrations under `registryDataDir` (default ./data) — a
    // per-run temp dir keeps earlier runs' `luna-dark` keys from making the name ambiguous.
    relayDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-peer-dark-relay-'));
    relay = new RelayServer({
      port: 0,
      registryDataDir: relayDataDir,
      rateLimitConfig: { perAgentPerMinute: 1000, perAgentPerHour: 10000, perIPPerMinute: 10000, globalPerMinute: 50000, discoveryPerMinute: 100, authAttemptsPerMinute: 100 },
      offlineQueueConfig: { defaultTtlMs: 3_600_000, maxPerSenderPerRecipient: 20, maxPerRecipient: 100, maxPayloadBytesPerRecipient: 500_000 },
      abuseDetectorConfig: { sybilFirstHourLimit: 10000, sybilSecondHourLimit: 10000, spamUniqueRecipientsPerMinute: 10000 },
    });
    await relay.start();
    const relayUrl = `ws://127.0.0.1:${relay.address!.port}/v1/connect`;

    const rid = generateIdentityKeyPair();
    recipientFp = computeFingerprint(rid.publicKey);
    recipient = new RelayClient(
      { relayUrl, name: 'luna-dark', framework: 'test', capabilities: ['conversation'], version: '1.0.0', visibility: 'public' },
      { fingerprint: recipientFp, publicKey: rid.publicKey, privateKey: rid.privateKey, x25519PublicKey: deriveX25519PublicKey(rid.privateKey), createdAt: new Date().toISOString() },
    );
    await recipient.connect();

    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-peer-dark-'));
    stateDir = path.join(projectDir, '.instar');
    fs.mkdirSync(path.join(stateDir, 'threadline'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ projectName: 'echo-dark' }));

    sender = new ThreadlineClient({ name: 'echo-dark', relayUrl, visibility: 'public', stateDir: path.join(stateDir, 'threadline') });
    await sender.connect();
    expect(await sender.resolveAgent('luna-dark')).toBe(recipientFp);

    tracker = A2ADeliveryTracker.openMemory();
    sender.on('relay-verdict', (v: RelayVerdict) => tracker.recordRelayStatus(v));
    listener = new ListenerSessionManager(stateDir, 'listener-token');

    config = {
      projectDir, stateDir, projectName: 'echo-dark', port: 4042, authToken: TOKEN,
      threadline: { peerDarkNotice: { enabled: true, dryRun: true, queuedDarkAfterMs: 2 * H } },
    } as typeof config;
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
    SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: 'tests/integration/threadline/a2a-peer-dark-route.test.ts' });
    SafeFsExecutor.safeRmSync(relayDataDir, { recursive: true, force: true, operation: 'tests/integration/threadline/a2a-peer-dark-route.test.ts' });
  });

  it('a live recipient: health not dark, connectedNow true from the presence map (the discover that resolved the name)', async () => {
    const h = await get(`/threadline/peers/${recipientFp}/health`);
    expect(h.status).toBe(200);
    expect(h.body).toMatchObject({ dark: false, darkSince: null, queuedCount: 0, queuedExpiresAt: null, lastDeliveredAt: null, connectedNow: true });
    const all = await get('/threadline/peers/health');
    expect(all.body.darkCount).toBe(0);
  });

  it('after the recipient goes offline and rows have been queued past the threshold: peerDark on the send (dry-run keeps the legacy sentence, logs would-sentence)', async () => {
    recipient.disconnect();
    await new Promise((r) => setTimeout(r, 150));
    // The relay pushes presence; one refresh makes the map's answer deterministic.
    expect(await sender.refreshPresence()).toBe(true);
    expect(sender.peerConnectedNow(recipientFp)).toBe(false);
    // A row queued 3 h ago with nothing back since (seeded — the test cannot wait 2 h).
    const oldSent = new Date(Date.now() - 3 * H).toISOString();
    tracker.recordSent({ messageId: 'seed-old', peerFp: recipientFp, peerName: 'luna-dark', threadId: 't-old', transport: 'relay', sentAt: oldSent });
    tracker.recordRelayStatus({ messageId: 'seed-old', status: 'queued', ttlSec: 3600 }, oldSent);

    const { status, body } = await post({ targetAgent: 'luna-dark', message: 'are you there?' });
    expect(status).toBe(200);
    expect(body.relayStatus).toBe('queued');
    expect(body.peerDark).toMatchObject({ since: oldSent, queuedCount: 2, connectedNow: false });
    expect(typeof (body.peerDark as { expiresAt: unknown }).expiresAt).toBe('string');
    // dry-run: the legacy sentence stands; the would-sentence row is recorded.
    expect(String(body.deliveryOutcome)).toContain('peer offline; the relay holds it');
    const rows = auditRows();
    expect(rows.some((r) => r.kind === 'would-sentence' && r.peerFp === recipientFp && r.dryRun === true)).toBe(true);
    expect(rows.some((r) => r.kind === 'sentence')).toBe(false);

    const h = await get(`/threadline/peers/${recipientFp}/health`);
    expect(h.body).toMatchObject({ dark: true, darkSince: oldSent, connectedNow: false });
    expect(h.body.queuedCount).toBe(2);
    const all = await get('/threadline/peers/health');
    expect(all.body.darkCount).toBe(1);
    expect((all.body.peers as Array<Record<string, unknown>>).find((p) => p.peerFp === recipientFp)).toMatchObject({ dark: true, connectedNow: false });
  });

  it('with the notice LIVE (dryRun:false) the deliveryOutcome is the worded sentence and a `sentence` row is recorded', async () => {
    config.threadline.peerDarkNotice.dryRun = false;
    const { status, body } = await post({ targetAgent: 'luna-dark', message: 'third' });
    expect(status).toBe(200);
    expect(body.relayStatus).toBe('queued');
    expect(body.peerDark).toMatchObject({ queuedCount: 3, connectedNow: false });
    const s = String(body.deliveryOutcome);
    expect(s).toMatch(/^no acknowledgement from luna-dark \(/);
    expect(s).toContain('this and 2 other messages are still queued (oldest expires ');
    expect(s).toContain('is not connected to the relay right now — it may be offline, or listening under a different address.');
    expect(s).not.toContain('nothing will arrive');
    expect(auditRows().some((r) => r.kind === 'sentence' && r.dryRun === false)).toBe(true);
  });

  it('the MCP HTTP client passes `peerDark` through additively', async () => {
    const r = await sendMessageViaHttp({ targetAgent: 'luna-dark', message: 'via mcp' }, port, TOKEN);
    expect(r.success).toBe(true);
    expect(r.relayStatus).toBe('queued');
    expect(r.peerDark).toMatchObject({ connectedNow: false });
    expect((r.peerDark as { queuedCount: number }).queuedCount).toBeGreaterThanOrEqual(4);
  });

  it('a health read with the threshold raised above the silence reads not-dark (the threshold is config, read live)', async () => {
    config.threadline.peerDarkNotice.queuedDarkAfterMs = 48 * H;
    const h = await get(`/threadline/peers/${recipientFp}/health`);
    expect(h.body).toMatchObject({ dark: false, darkSince: null });
    expect(h.body.queuedCount).toBeGreaterThanOrEqual(4); // still queued — just not old enough
    config.threadline.peerDarkNotice.queuedDarkAfterMs = 2 * H;
  });

  it('the recipient reconnecting clears dark on the next delivered verdict (a sign of life) — a live peer never carries peerDark', async () => {
    await recipient.connect();
    await new Promise((r) => setTimeout(r, 200));
    const { status, body } = await post({ targetAgent: 'luna-dark', message: 'back?' });
    expect(status).toBe(200);
    expect(body.relayStatus).toBe('delivered');
    expect(body.peerDark).toBeUndefined();
    expect(String(body.deliveryOutcome)).toContain("handed to the peer's relay connection");
    const h = await get(`/threadline/peers/${recipientFp}/health`);
    expect(h.body).toMatchObject({ dark: false, darkSince: null, queuedCount: 0 });
    expect(h.body.lastDeliveredAt).not.toBeNull();
    expect((await get('/threadline/peers/health')).body.darkCount).toBe(0);
  });
});
