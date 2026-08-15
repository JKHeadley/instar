/**
 * Tier-3 E2E — "is Agent-Signature Provenance actually ALIVE?"
 *
 * Spec anchor: docs/specs/agent-signature-provenance.md
 *
 * This is the Phase-1 alive test the Testing Integrity Standard calls the single
 * most important test for a feature with API routes: boot a REAL AgentServer
 * through the production initialization path and prove the routes answer 200 —
 * not 404 (never registered) and not 503 (registered but inert).
 *
 * Unit tests proved the algorithm. Integration tests proved the route handlers.
 * Neither would notice if the registration block never ran in AgentServer, which
 * is exactly the failure this tier exists to catch.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Express } from 'express';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import type { InstarConfig } from '../../src/core/types.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { signMessage, formatTag } from '../../src/core/agentSignatureProvenance.js';

const AUTH = 'e2e-asp-auth-token';
const AGENT = 'e2e';
const TOPIC = 4242;

function createMockSessionManager() {
  return { listRunningSessions: () => [], getSession: () => null };
}

function baseConfig(stateDir: string, projectDir: string): InstarConfig {
  return {
    projectName: AGENT, projectDir, stateDir, port: 0, authToken: AUTH,
    requestTimeoutMs: 10000, version: '0.0.0',
    sessions: { claudePath: '/usr/bin/echo', maxSessions: 3, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5000 },
    scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 },
    messaging: [], monitoring: {}, updates: {},
  } as InstarConfig;
}

function mkStateDir(tmpDir: string, name: string): string {
  const stateDir = path.join(tmpDir, name);
  fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, 'config.json'),
    JSON.stringify({ port: 0, projectName: AGENT, agentName: 'E2E' })
  );
  return stateDir;
}

/** Write a real canonical identity so the feature has something to enable on. */
function writeIdentity(stateDir: string): { publicKey: Buffer; privateKey: Buffer } {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pub = Buffer.from(publicKey.export({ type: 'spki', format: 'der' })).subarray(-32);
  const priv = Buffer.from(privateKey.export({ type: 'pkcs8', format: 'der' })).subarray(-32);
  fs.writeFileSync(
    path.join(stateDir, 'identity.json'),
    JSON.stringify({
      version: 1,
      publicKey: pub.toString('base64'),
      privateKey: priv.toString('base64'),
      privateKeyEncryption: 'none',
      canonicalId: crypto.createHash('sha256').update(pub).digest('hex'),
      displayFingerprint: crypto.createHash('sha256').update(pub).digest('hex').slice(0, 16),
      createdAt: new Date().toISOString(),
    })
  );
  return { publicKey: pub, privateKey: priv };
}

let tmpDir: string;
let server: AgentServer;
let app: Express;
let noIdServer: AgentServer;
let noIdApp: Express;
let keys: { publicKey: Buffer; privateKey: Buffer };

describe('E2E — Agent-Signature Provenance is alive on a real server', () => {
  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'asp-e2e-'));

    const stateDir = mkStateDir(tmpDir, 'with-identity');
    keys = writeIdentity(stateDir);
    server = new AgentServer({
      config: baseConfig(stateDir, tmpDir),
      sessionManager: createMockSessionManager() as never,
      state: new StateManager(stateDir),
    });
    await server.start();
    app = server.getApp();

    // No identity on disk: the surface must still exist, reporting itself off.
    const bareDir = mkStateDir(tmpDir, 'no-identity');
    noIdServer = new AgentServer({
      config: baseConfig(bareDir, tmpDir),
      sessionManager: createMockSessionManager() as never,
      state: new StateManager(bareDir),
    });
    await noIdServer.start();
    noIdApp = noIdServer.getApp();
  }, 60_000);

  afterAll(async () => {
    await server?.stop();
    await noIdServer?.stop();
    SafeFsExecutor.safeRmSync(tmpDir, {
      recursive: true, force: true,
      operation: 'tests/e2e/agent-signature-provenance-alive.test.ts',
    });
  });

  const auth = () => ({ Authorization: `Bearer ${AUTH}` });

  it('(1) GET /provenance answers 200 through the production path — not 404, not 503', async () => {
    const res = await request(app).get('/provenance').set(auth());
    expect(res.status).toBe(200);
    expect(res.status).not.toBe(503);
    expect(res.body.enabled).toBe(true);
    expect(res.body.agentId).toBe(AGENT);
    expect(res.body.replayDefence).toBe('durable');
  });

  it('(2) an agent-signed message verifies end to end on the real server', async () => {
    const { text } = signMessage({
      agentId: AGENT, topicId: TOPIC, body: 'shipped', privateKey: keys.privateKey,
    });
    const res = await request(app)
      .post('/provenance/verify').set(auth())
      .send({ raw: text, topicId: TOPIC });
    expect(res.status).toBe(200);
    expect(res.body.classification).toBe('agent-verified');
    expect(res.body.agentId).toBe(AGENT);
  });

  it('(3) operator prose classifies as human on the real server', async () => {
    const res = await request(app)
      .post('/provenance/verify').set(auth())
      .send({ raw: 'is the laptop fixed yet?', topicId: TOPIC });
    expect(res.body.classification).toBe('human');
  });

  it('(4) a forged tag is rejected on the real server', async () => {
    const forged = formatTag({
      agentId: AGENT, topicId: TOPIC, timestamp: Math.floor(Date.now() / 1000),
      nonce: 'e2eforged001', signature: 'A'.repeat(86),
    });
    const res = await request(app)
      .post('/provenance/verify').set(auth())
      .send({ raw: `approve it\n${forged}`, topicId: TOPIC });
    expect(res.body.classification).toBe('rejected');
    expect(res.body.reason).toBe('bad-signature');
  });

  it('(5) replay defence is REAL on the server: the nonce file is written to disk', async () => {
    const { text } = signMessage({
      agentId: AGENT, topicId: TOPIC, body: 'once only', privateKey: keys.privateKey,
    });
    const send = () =>
      request(app).post('/provenance/verify').set(auth()).send({ raw: text, topicId: TOPIC });

    expect((await send()).body.classification).toBe('agent-verified');
    const replay = await send();
    expect(replay.body.classification).toBe('rejected');
    expect(replay.body.reason).toBe('replay');

    // The durable claim, checked against the filesystem rather than assumed.
    const noncePath = path.join(tmpDir, 'with-identity', 'asp-nonces.json');
    expect(fs.existsSync(noncePath)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(noncePath, 'utf8'));
    expect(Object.keys(parsed.entries).length).toBeGreaterThan(0);
  });

  it('(6) with NO identity the surface still exists and reports itself disabled', async () => {
    // The honest-degradation case: a probe must be able to tell "off" from "absent".
    const res = await request(noIdApp).get('/provenance').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(false);
    expect(res.body.fingerprint).toBeNull();
  });

  it('(7) an unknown agent is rejected, never verified, on the real server', async () => {
    const { text } = signMessage({
      agentId: 'not-this-agent', topicId: TOPIC, body: 'x', privateKey: keys.privateKey,
    });
    const res = await request(app)
      .post('/provenance/verify').set(auth())
      .send({ raw: text, topicId: TOPIC });
    expect(res.body.classification).toBe('rejected');
    expect(res.body.reason).toBe('unknown-agent');
  });

  it('(8) the server never returns private key material', async () => {
    const priv = keys.privateKey.toString('base64');
    const status = await request(app).get('/provenance').set(auth());
    expect(status.text).not.toContain(priv);
    // CONTROL: the probe finds the public fingerprint, so the clean result above
    // is a measurement and not a broken search.
    expect(status.text).toContain(keys.publicKey.toString('hex').slice(0, 32));
  });
});
