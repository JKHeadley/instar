/**
 * E2E lifecycle — threadline identity single writer (ACT-062).
 * Spec: docs/specs/threadline-identity-single-writer.md
 *
 * The production path: bootstrapThreadline() + the real /threadline/health
 * route + a real in-process RelayServer (the same code that answered
 * "Invalid public key — expected raw 32-byte Ed25519, got 48 bytes").
 *
 *  1. First boot, relay OFF → poll /threadline/health → restart, relay ON:
 *     the relay accepts the agent, the key it was offered is 32 bytes, and the
 *     registered fingerprint equals the one health advertises.
 *  2. An agent ALREADY poisoned by the old code (hex legacy + hex canonical)
 *     connects on its next boot with the fingerprint its hex key implies.
 *  3. The boot line never says "connected" when connect() was rejected.
 *
 * The auth frame is inspected for LENGTH only; no key is printed.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { WebSocket } from 'ws';
import { bootstrapThreadline, type ThreadlineBootstrapResult } from '../../../src/threadline/ThreadlineBootstrap.js';
import { createThreadlineRoutes } from '../../../src/threadline/ThreadlineEndpoints.js';
import { createUnifiedTrustSystem } from '../../../src/threadline/UnifiedTrustWiring.js';
import { describeRelayBootStatus } from '../../../src/threadline/relayBootStatus.js';
import { RelayServer } from '../../../src/threadline/relay/RelayServer.js';
import { computeFingerprint } from '../../../src/threadline/client/MessageEncryptor.js';
import { generateIdentityKeyPair } from '../../../src/threadline/ThreadlineCrypto.js';
import { computeCanonicalId, computeDisplayFingerprint } from '../../../src/identity/types.js';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';

interface AuthOffer { agentId: string; publicKeyBytes: number }

describe('threadline identity single writer — boot lifecycle against a real relay', () => {
  let relay: RelayServer;
  let relayUrl: string;
  let relayDataDir: string;
  let realHome: string | undefined;
  let tmpDir: string;
  let projectDir: string;
  let stateDir: string;
  let booted: ThreadlineBootstrapResult[];
  let offers: AuthOffer[];

  const legacyFile = (): string => path.join(stateDir, 'threadline', 'identity.json');
  const canonicalFile = (): string => path.join(stateDir, 'identity.json');

  const boot = async (relayEnabled: boolean, url = relayUrl): Promise<ThreadlineBootstrapResult> => {
    const result = await bootstrapThreadline({
      agentName: 'lifecycle-agent',
      stateDir,
      projectDir,
      port: 4040,
      relayEnabled,
      relayUrl: url,
      relayRearmAfterDisplacedMs: 0,
    });
    booted.push(result);
    return result;
  };

  /** The health route exactly as the server mounts it for a booted stack. */
  const healthOf = async (result: ThreadlineBootstrapResult): Promise<Record<string, unknown>> => {
    const app = express();
    app.use(express.json());
    app.use(createThreadlineRoutes(result.handshakeManager, null, {
      localAgent: 'lifecycle-agent',
      version: '1.0',
      stateDir,
    }));
    const res = await request(app).get('/threadline/health');
    expect(res.status).toBe(200);
    return res.body as Record<string, unknown>;
  };

  beforeAll(async () => {
    relayDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-single-writer-relay-'));
    // bootstrapThreadline registers an MCP entry under the user's home. Point
    // HOME at a temp dir so this test never writes to the real ~/.claude.json.
    realHome = process.env.HOME;
    process.env.HOME = path.join(relayDataDir, 'home');
    fs.mkdirSync(process.env.HOME, { recursive: true });
    relay = new RelayServer({
      port: 0,
      // Never the default ./data: the test relay's registry stays in a temp dir.
      registryDataDir: relayDataDir,
      rateLimitConfig: {
        perAgentPerMinute: 1000,
        perAgentPerHour: 10000,
        perIPPerMinute: 10000,
        globalPerMinute: 50000,
        discoveryPerMinute: 100,
        authAttemptsPerMinute: 100,
      },
    });
    await relay.start();
    relayUrl = `ws://127.0.0.1:${relay.address!.port}/v1/connect`;
  });

  afterAll(async () => {
    await relay.stop();
    if (realHome === undefined) delete process.env.HOME;
    else process.env.HOME = realHome;
    SafeFsExecutor.safeRmSync(relayDataDir, { recursive: true, force: true, operation: 'tests/e2e/threadline/identity-single-writer-lifecycle.test.ts:relay-cleanup' });
  });

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-single-writer-e2e-'));
    projectDir = path.join(tmpDir, 'project');
    stateDir = path.join(projectDir, '.instar');
    fs.mkdirSync(stateDir, { recursive: true });
    booted = [];
    offers = [];
    // Record what the client offers the relay: the agent id and the key LENGTH.
    const realSend = WebSocket.prototype.send;
    vi.spyOn(WebSocket.prototype, 'send').mockImplementation(function (this: WebSocket, ...args: unknown[]) {
      try {
        const frame = JSON.parse(String(args[0]));
        if (frame?.type === 'auth' && typeof frame.publicKey === 'string') {
          offers.push({ agentId: frame.agentId, publicKeyBytes: Buffer.from(frame.publicKey, 'base64').length });
        }
      } catch { /* not a JSON frame */ }
      return (realSend as (...a: unknown[]) => void).apply(this, args);
    });
  });

  afterEach(async () => {
    for (const result of booted) await result.shutdown();
    vi.restoreAllMocks();
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/e2e/threadline/identity-single-writer-lifecycle.test.ts:cleanup' });
  });

  it('relay off → health polled → relay on: the relay is offered a 32-byte key and the fingerprint matches health', async () => {
    // ── Boot 1: the default, relay off ────────────────────────────
    const first = await boot(false);
    expect(first.relayClient).toBeUndefined();

    // Other local agents' discovery polls health. Before the fix this minted a
    // hex identity file; now it mints nothing.
    for (let i = 0; i < 3; i++) {
      const body = await healthOf(first);
      expect(body).not.toHaveProperty('identityPub');
      expect(body).not.toHaveProperty('fingerprint');
    }
    expect(fs.existsSync(legacyFile())).toBe(false);
    expect(fs.existsSync(canonicalFile())).toBe(false);
    await first.shutdown();

    // ── Boot 2: the operator enables the relay ───────────────────
    const second = await boot(true);
    expect(second.relayClient).toBeDefined();
    expect(second.relayClient!.connectionState).toBe('connected');

    expect(offers.length).toBeGreaterThan(0);
    for (const offer of offers) expect(offer.publicKeyBytes).toBe(32);

    const body = await healthOf(second);
    expect(typeof body.fingerprint).toBe('string');
    expect(body.fingerprint).toBe(second.relayClient!.fingerprint);
    expect(offers[offers.length - 1].agentId).toBe(body.fingerprint);
    expect(computeFingerprint(Buffer.from(body.identityPub as string, 'hex'))).toBe(body.fingerprint);

    // The trust system migrates that identity; the canonical file must hold a
    // real 32-byte key, so the NEXT boot connects too.
    const trust = createUnifiedTrustSystem(second.trustManager!, { stateDir });
    trust.shutdown();
    const canonical = JSON.parse(fs.readFileSync(canonicalFile(), 'utf-8'));
    expect(Buffer.from(canonical.publicKey, 'base64').length).toBe(32);
    await second.shutdown();

    // ── Boot 3: still the same address ───────────────────────────
    offers.length = 0;
    const third = await boot(true);
    expect(third.relayClient!.connectionState).toBe('connected');
    expect(third.relayClient!.fingerprint).toBe(body.fingerprint);
    for (const offer of offers) expect(offer.publicKeyBytes).toBe(32);

    const line = describeRelayBootStatus('relay.test', third.relayClient!.connectionState);
    expect(line.connected).toBe(true);
  });

  it('an agent already poisoned by the old code connects on its next boot, with the fingerprint its hex key implies', async () => {
    const kp = generateIdentityKeyPair();
    const expectedFingerprint = computeFingerprint(kp.publicKey);
    // Exactly the on-disk state the old code left behind.
    fs.mkdirSync(path.dirname(legacyFile()), { recursive: true });
    fs.writeFileSync(legacyFile(), JSON.stringify({
      publicKey: kp.publicKey.toString('hex'),
      privateKey: kp.privateKey.toString('hex'),
    }, null, 2));
    const badId = computeCanonicalId(Buffer.from(kp.publicKey.toString('hex'), 'base64'));
    fs.writeFileSync(canonicalFile(), JSON.stringify({
      version: 1,
      publicKey: kp.publicKey.toString('hex'),
      privateKey: kp.privateKey.toString('hex'),
      privateKeyEncryption: 'none',
      canonicalId: badId,
      displayFingerprint: computeDisplayFingerprint(badId),
      createdAt: '2026-10-01T00:00:00.000Z',
    }, null, 2));

    const result = await boot(true);
    expect(result.relayClient!.connectionState).toBe('connected');
    expect(result.relayClient!.fingerprint).toBe(expectedFingerprint);
    expect(offers.length).toBeGreaterThan(0);
    for (const offer of offers) {
      expect(offer.publicKeyBytes).toBe(32); // was 48: the relay's rejection
      expect(offer.agentId).toBe(expectedFingerprint);
    }

    const body = await healthOf(result);
    expect(body.fingerprint).toBe(expectedFingerprint);

    for (const file of [legacyFile(), canonicalFile()]) {
      const stored = JSON.parse(fs.readFileSync(file, 'utf-8'));
      expect(Buffer.from(stored.publicKey, 'base64').equals(kp.publicKey)).toBe(true);
      expect(Buffer.from(stored.privateKey, 'base64').equals(kp.privateKey)).toBe(true);
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    }

    // The trust system loads the repaired canonical file with the right id.
    const trust = createUnifiedTrustSystem(result.trustManager!, { stateDir });
    expect(trust.identity.get()?.canonicalId).toBe(computeCanonicalId(kp.publicKey));
    trust.shutdown();
  });

  it('prints no "connected" line when connect() was rejected', async () => {
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logs.push(a.join(' ')); });
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { logs.push(a.join(' ')); });

    // An identity file that cannot be used: connect() rejects before any socket.
    fs.writeFileSync(canonicalFile(), '{"publicKey":"zz"}');
    const result = await boot(true);

    expect(result.relayClient).toBeDefined();
    expect(result.relayClient!.connectionState).not.toBe('connected');
    expect(logs.some(l => /relay connection failed/.test(l))).toBe(true);
    // No socket was ever opened, so nothing retries — the line must not claim it does.
    expect(logs.some(l => /NOT retrying/.test(l))).toBe(true);
    expect(logs.some(l => /retrying in the background/.test(l))).toBe(false);
    expect(logs.some(l => /Threadline: relay connected/.test(l))).toBe(false);

    // The line server.ts prints for this client.
    const line = describeRelayBootStatus('relay.test', result.relayClient!.connectionState);
    expect(line.connected).toBe(false);
    expect(line.text).toMatch(/NOT connected/);
    expect(line.text).not.toMatch(/relay connected to/);

    // Nothing was minted over the bad file, and no key was offered to the relay.
    expect(fs.readFileSync(canonicalFile(), 'utf-8')).toBe('{"publicKey":"zz"}');
    expect(fs.existsSync(legacyFile())).toBe(false);
    expect(offers).toEqual([]);
  });

  it('prints no "connected" line when the relay is unreachable', async () => {
    const errors: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { errors.push(a.join(' ')); });
    const result = await boot(true, 'ws://127.0.0.1:1/v1/connect');
    expect(result.relayClient!.connectionState).not.toBe('connected');
    expect(describeRelayBootStatus('relay.test', result.relayClient!.connectionState).connected).toBe(false);
    // A real connection attempt does retry.
    expect(errors.some(l => /retrying in the background with backoff/.test(l))).toBe(true);
  });
});
