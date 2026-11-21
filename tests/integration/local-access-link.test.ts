/**
 * Integration — the one-time local dashboard link (docs/specs/identity-security-piece1a-local-link.md)
 * over the full HTTP pipeline through a real AgentServer listening on 127.0.0.1.
 *
 * Proves: mint needs the private key proof (no bearer), refuses replays, pre-start stamps,
 * forwarding headers and wrong Hosts; the response proof covers the secret and origin; a real
 * exchange binds one key; and dashboard unlock with a verified credential is judged on the
 * verified-local budget while the loopback budget is exhausted, with today's rules otherwise.
 */
import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { createTempProject, createMockSessionManager } from '../helpers/setup.js';
import type { TempProject } from '../helpers/setup.js';
import type { InstarConfig } from '../../src/core/types.js';
import { challengeSecretProof, exchangeText, useText } from '../../src/core/LocalAccessStore.js';
import { hmac, mintProofText, mintResponseText, readListenerKey, sha256Hex } from '../../src/server/localAccessRoutes.js';

const AUTH = 'itest-auth-token-local-access';
const PIN = '135791';
const NAME = 'local-access-itest';

function makeConfig(stateDir: string, enabled = true): InstarConfig {
  return {
    projectName: NAME, projectDir: '/tmp/la', stateDir, port: 0,
    authToken: AUTH, dashboardPin: PIN,
    security: { localAccessLink: { enabled } },
    sessions: { tmuxPath: '/usr/bin/tmux', claudePath: '/usr/bin/claude', projectDir: '/tmp/la', maxSessions: 3, protectedSessions: [], completionPatterns: [] },
    scheduler: { jobsFile: '', enabled: false, maxParallelJobs: 2, quotaThresholds: { normal: 50, elevated: 70, critical: 85, shutdown: 95 } },
    users: [], messaging: [], monitoring: { quotaTracking: false, memoryMonitoring: false, healthCheckIntervalMs: 30000 },
  } as InstarConfig;
}

function keyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-65);
  return {
    publicKey: Buffer.from(raw).toString('base64url'),
    sign: (t: string) => {
      // low-S DER, as the browser helper produces
      const der = crypto.sign('sha256', Buffer.from(t), { key: privateKey, dsaEncoding: 'ieee-p1363' });
      const n = BigInt('0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551');
      const r = BigInt('0x' + der.subarray(0, 32).toString('hex'));
      let s = BigInt('0x' + der.subarray(32).toString('hex'));
      if (s > n >> 1n) s = n - s;
      const enc = (x: bigint) => { let h = x.toString(16); if (h.length % 2) h = '0' + h; let b = Buffer.from(h, 'hex'); if (b[0] & 0x80) b = Buffer.concat([Buffer.from([0]), b]); return Buffer.concat([Buffer.from([0x02, b.length]), b]); };
      const body = Buffer.concat([enc(r), enc(s)]);
      return Buffer.concat([Buffer.from([0x30, body.length]), body]).toString('base64url');
    },
  };
}

let project: TempProject;
let server: AgentServer;
let srv: http.Server;
let port: number;
let base: string;

async function boot(enabled = true) {
  project = createTempProject();
  const config = makeConfig(project.stateDir, enabled);
  server = new AgentServer({ config, sessionManager: createMockSessionManager() as any, state: project.state } as any);
  const app = server.getApp();
  srv = await new Promise<http.Server>((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  port = (srv.address() as AddressInfo).port;
  base = `http://127.0.0.1:${port}`;
  // Piece 1c counts a loopback request as this machine only when its Host names the configured port.
  config.port = port;
  // The test listens itself (AgentServer.start is not used), so point the service at this socket and run its start-up step.
  Object.assign((server as any).localAccess.deps, { boundAddress: () => srv.address() });
  (server as any).localAccess.startSweeps();
}

async function mint(over: Partial<{ timeMs: number; nonce: string; browserPort: number; proof: string; host: string }> = {}) {
  const key = readListenerKey(project.stateDir);
  const timeMs = over.timeMs ?? Date.now();
  const clientNonce = over.nonce ?? crypto.randomBytes(18).toString('base64url');
  const browserPort = over.browserPort ?? port;
  const proof = over.proof ?? hmac(key, mintProofText(NAME, port, browserPort, 'terminal', timeMs, clientNonce));
  const res = await request(srv).post('/local-access/v1/mint').set('Host', over.host ?? `127.0.0.1:${port}`)
    .send({ browserPort, startedBy: 'terminal', timeMs, clientNonce, proof });
  return { res, key, clientNonce };
}

async function redeem(origin = base) {
  const { res } = await mint({ browserPort: Number(new URL(origin).port) });
  expect(res.status).toBe(200);
  const k = keyPair();
  const host = new URL(origin).host;
  const ch = await request(srv).post('/local-access/v1/challenge').set('Host', host).set('Origin', origin)
    .send({ ticketId: res.body.id, secretProof: challengeSecretProof(res.body.secret), publicKey: k.publicKey });
  expect(ch.status).toBe(200);
  const ex = await request(srv).post('/local-access/v1/exchange').set('Host', host).set('Origin', origin)
    .send({ ticketId: res.body.id, secret: res.body.secret, publicKey: k.publicKey, challenge: ch.body.challenge, signature: k.sign(exchangeText(NAME, res.body.id, ch.body.challenge, origin)) });
  expect(ex.status).toBe(200);
  return { k, credentialId: ex.body.credentialId as string, ticket: res.body };
}

async function localAccessProof(k: ReturnType<typeof keyPair>, credentialId: string, origin = base) {
  const host = new URL(origin).host;
  const uc = await request(srv).post('/local-access/v1/use-challenge').set('Host', host).set('Origin', origin).send({ credentialId, action: 'dashboard-unlock' });
  expect(uc.status).toBe(200);
  return { credentialId, challenge: uc.body.challenge, signature: k.sign(useText(NAME, credentialId, 'dashboard-unlock', uc.body.challenge, origin, 'POST /dashboard/unlock')) };
}

const unlock = (body: Record<string, unknown>, origin = base) =>
  request(srv).post('/dashboard/unlock').set('Host', new URL(origin).host).set('Origin', origin).send(body);

afterEach(async () => {
  await new Promise<void>((r) => srv.close(() => r()));
  (server as any).localAccess?.close();
  project.cleanup();
});

describe('local access link — switch on', () => {
  beforeEach(async () => { await boot(true); });

  it('mints with the key proof only and answers with a response proof over the secret and origin', async () => {
    const { res, key, clientNonce } = await mint();
    expect(res.status).toBe(200);
    expect(res.body.origin).toBe(base);
    const expected = hmac(key, mintResponseText(clientNonce, res.body.id, sha256Hex(res.body.secret), res.body.expiresAt, res.body.launchName, base));
    expect(res.body.responseProof).toBe(expected);
    expect(res.body.url).toBeUndefined();
  });

  it('refuses a wrong proof, a replayed nonce, a stamp from before the server started, a forwarding header and a tunnel Host', async () => {
    expect((await mint({ proof: 'x'.repeat(43) })).res.status).toBe(403);
    const nonce = crypto.randomBytes(18).toString('base64url');
    expect((await mint({ nonce })).res.status).toBe(200);
    expect((await mint({ nonce })).res.status).toBe(409);
    expect((await mint({ timeMs: Date.now() - 30_000 })).res.status).toBe(400);
    // stamped after the process started but before it began listening: refused too
    const beforeListen = Date.now() - 5;
    (server as any).localAccess.startSweeps();
    expect((await mint({ timeMs: beforeListen })).res.status).toBe(400);
    const key = readListenerKey(project.stateDir);
    const t = Date.now(); const n = crypto.randomBytes(18).toString('base64url');
    const fwd = await request(srv).post('/local-access/v1/mint').set('Host', `127.0.0.1:${port}`).set('X-Forwarded-For', '203.0.113.9')
      .send({ browserPort: port, startedBy: 'terminal', timeMs: t, clientNonce: n, proof: hmac(key, mintProofText(NAME, port, port, 'terminal', t, n)) });
    expect(fwd.status).toBe(404);
    expect((await mint({ host: 'agent.trycloudflare.com' })).res.status).toBe(404);
  });

  it('a different key cannot take a redeemed ticket; a wrong Origin is refused', async () => {
    const { ticket } = await redeem();
    const other = keyPair();
    const bad = await request(srv).post('/local-access/v1/challenge').set('Host', `127.0.0.1:${port}`).set('Origin', 'http://127.0.0.1:1')
      .send({ ticketId: ticket.id, secretProof: challengeSecretProof(ticket.secret), publicKey: other.publicKey });
    expect(bad.status).toBe(403);
    const ch = await request(srv).post('/local-access/v1/challenge').set('Host', `127.0.0.1:${port}`).set('Origin', base)
      .send({ ticketId: ticket.id, secretProof: challengeSecretProof(ticket.secret), publicKey: other.publicKey });
    expect(ch.status).toBe(403);
    expect(ch.body.error).toBe('bound-to-other-key');
  });

  it('serves the exchange page with a strict CSP', async () => {
    const page = await request(srv).get('/local-access/v1/open').set('Host', `127.0.0.1:${port}`);
    expect(page.status).toBe(200);
    expect(page.headers['content-security-policy']).toContain("default-src 'none'");
    expect(page.headers['cache-control']).toContain('no-store');
    expect(page.text).not.toContain('<script>');
  });

  it('a verified link unlocks with the right PIN while the loopback budget is exhausted, and charges only its own budget', async () => {
    // drain today's local budget from an unverified local caller
    for (let i = 0; i < 10; i++) await unlock({ pin: '000000' });
    expect((await unlock({ pin: PIN })).status).toBe(429);
    const { k, credentialId } = await redeem();
    const ok = await unlock({ pin: PIN, localAccess: await localAccessProof(k, credentialId) });
    expect(ok.status).toBe(200);
    expect(ok.body.token).toBeDefined();
    // an invalid proof is treated exactly as today: the loopback budget still refuses
    const bad = await unlock({ pin: PIN, localAccess: { credentialId, challenge: 'nope', signature: 'x' } });
    expect(bad.status).toBe(429);
  });

  it('a verified link has its own budget of 10, then falls back to today\'s rules', async () => {
    const { k, credentialId } = await redeem();
    for (let i = 0; i < 10; i++) {
      const r = await unlock({ pin: '000000', localAccess: await localAccessProof(k, credentialId) });
      expect(r.status).toBe(403);
    }
    // verified budget full: today's local rules apply (the loopback budget is untouched, so the right PIN works)
    const r = await unlock({ pin: PIN, localAccess: await localAccessProof(k, credentialId) });
    expect(r.status).toBe(200);
  });

  it('print mode: a different browser port works end to end with Host and Origin on that port', async () => {
    const origin = 'http://127.0.0.1:54321';
    const { k, credentialId } = await redeem(origin);
    for (let i = 0; i < 10; i++) await unlock({ pin: '000000' });
    const ok = await unlock({ pin: PIN, localAccess: await localAccessProof(k, credentialId, origin) }, origin);
    expect(ok.status).toBe(200);
  });

  it('a ticket minted before a restart is refused after it', async () => {
    const { res } = await mint();
    (server as any).localAccess.startSweeps();
    const k = keyPair();
    const ch = await request(srv).post('/local-access/v1/challenge').set('Host', `127.0.0.1:${port}`).set('Origin', base)
      .send({ ticketId: res.body.id, secretProof: challengeSecretProof(res.body.secret), publicKey: k.publicKey });
    expect(ch.status).toBe(403);
    expect(ch.body.error).toBe('revoked');
  });
});

describe('local access link — switch off', () => {
  beforeEach(async () => { await boot(false); });

  it('answers 404 and the unlock route ignores localAccess', async () => {
    const page = await request(srv).get('/local-access/v1/open').set('Host', `127.0.0.1:${port}`);
    expect(page.status).toBe(404);
    const m = await request(srv).post('/local-access/v1/mint').set('Host', `127.0.0.1:${port}`).send({});
    expect(m.status).toBe(404);
    for (let i = 0; i < 10; i++) await unlock({ pin: '000000' });
    expect((await unlock({ pin: PIN, localAccess: { credentialId: 'A'.repeat(22), challenge: 'x', signature: 'y' } })).status).toBe(429);
  });
});
