// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * Tier-3 E2E "feature is alive" test for docs/specs/identity-security-piece1a-local-link.md.
 *
 * Boots the REAL AgentServer, listens on 127.0.0.1, and drives the link through the CLI's own
 * mint code (src/commands/dashboardOpen.ts `mintLink`) and a real exchange, then a dashboard
 * unlock that is judged on the verified-local budget. The switch resolves through the dev gate:
 * live on a development agent with `enabled` omitted, dark (404) on a fleet agent.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import type { InstarConfig } from '../../src/core/types.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { challengeSecretProof, exchangeText, useText } from '../../src/core/LocalAccessStore.js';
import { mintLink } from '../../src/commands/dashboardOpen.js';

const PIN = '864209';
const NAME = 'e2e-local-link';

function keyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-65);
  const n = BigInt('0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551');
  return {
    publicKey: Buffer.from(raw).toString('base64url'),
    sign: (t: string) => {
      const p = crypto.sign('sha256', Buffer.from(t), { key: privateKey, dsaEncoding: 'ieee-p1363' });
      const r = BigInt('0x' + p.subarray(0, 32).toString('hex'));
      let s = BigInt('0x' + p.subarray(32).toString('hex'));
      if (s > n >> 1n) s = n - s;
      const enc = (x: bigint) => { let h = x.toString(16); if (h.length % 2) h = '0' + h; let b = Buffer.from(h, 'hex'); if (b[0] & 0x80) b = Buffer.concat([Buffer.from([0]), b]); return Buffer.concat([Buffer.from([0x02, b.length]), b]); };
      const body = Buffer.concat([enc(r), enc(s)]);
      return Buffer.concat([Buffer.from([0x30, body.length]), body]).toString('base64url');
    },
  };
}

let tmpDir = '';
let srv: http.Server | null = null;
let server: AgentServer | null = null;

async function boot(developmentAgent: boolean) {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-link-e2e-'));
  const stateDir = path.join(tmpDir, '.instar');
  fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
  const config = {
    projectName: NAME, projectDir: tmpDir, stateDir, port: 0, authToken: 'e2e-local-link-token', dashboardPin: PIN, developmentAgent,
    sessions: { tmuxPath: '/usr/bin/tmux', claudePath: '/usr/bin/echo', projectDir: tmpDir, maxSessions: 3, protectedSessions: [], completionPatterns: [] },
    scheduler: { jobsFile: '', enabled: false, maxParallelJobs: 2, quotaThresholds: { normal: 50, elevated: 70, critical: 85, shutdown: 95 } },
    users: [], messaging: [], monitoring: { quotaTracking: false, memoryMonitoring: false, healthCheckIntervalMs: 30000 },
  } as unknown as InstarConfig;
  server = new AgentServer({ config, sessionManager: { listRunningSessions: () => [], getSession: () => null } as any, state: new StateManager(stateDir) } as any);
  srv = await new Promise<http.Server>((resolve) => { const s = server!.getApp().listen(0, '127.0.0.1', () => resolve(s)); });
  const port = (srv.address() as AddressInfo).port;
  // Piece 1c counts a loopback request as this machine only when its Host names the configured port.
  (config as { port: number }).port = port;
  fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ port, projectName: NAME }));
  const la = (server as any).localAccess;
  expect(la).toBeTruthy();
  Object.assign(la.deps, { boundAddress: () => srv!.address() });
  la.startSweeps();
  return { stateDir, port, base: `http://127.0.0.1:${port}` };
}

afterEach(async () => {
  if (srv) await new Promise<void>((r) => srv!.close(() => r()));
  (server as any)?.localAccess?.close();
  srv = null; server = null;
  if (tmpDir) SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/e2e/local-access-link-alive.test.ts:cleanup' });
});

describe('local access link — E2E lifecycle (feature is alive)', () => {
  it('on a development agent: the CLI mints, a browser key redeems, and unlock is judged on the verified-local budget', async () => {
    const { stateDir, port, base } = await boot(true);
    const m = await mintLink({ projectDir: tmpDir, stateDir, port, agentName: NAME, tunnelUrl: null }, port);
    expect(m.ok).toBe(true);
    if (!m.ok) return;
    const k = keyPair();
    const host = `127.0.0.1:${port}`;
    const ch = await request(srv!).post('/local-access/v1/challenge').set('Host', host).set('Origin', base)
      .send({ ticketId: m.id, secretProof: challengeSecretProof(m.secret), publicKey: k.publicKey });
    expect(ch.status).toBe(200);
    const ex = await request(srv!).post('/local-access/v1/exchange').set('Host', host).set('Origin', base)
      .send({ ticketId: m.id, secret: m.secret, publicKey: k.publicKey, challenge: ch.body.challenge, signature: k.sign(exchangeText(NAME, m.id, ch.body.challenge, base)) });
    expect(ex.status).toBe(200);
    // exhaust today's loopback budget, then unlock through the link
    for (let i = 0; i < 10; i++) await request(srv!).post('/dashboard/unlock').set('Host', host).set('Origin', base).send({ pin: '000000' });
    expect((await request(srv!).post('/dashboard/unlock').set('Host', host).set('Origin', base).send({ pin: PIN })).status).toBe(429);
    const uc = await request(srv!).post('/local-access/v1/use-challenge').set('Host', host).set('Origin', base).send({ credentialId: ex.body.credentialId, action: 'dashboard-unlock' });
    expect(uc.status).toBe(200);
    const localAccess = { credentialId: ex.body.credentialId, challenge: uc.body.challenge, signature: k.sign(useText(NAME, ex.body.credentialId, 'dashboard-unlock', uc.body.challenge, base, 'POST /dashboard/unlock')) };
    const ok = await request(srv!).post('/dashboard/unlock').set('Host', host).set('Origin', base).send({ pin: PIN, localAccess });
    expect(ok.status).toBe(200);
    expect(ok.body.token).toBeDefined();
    // the key material sits in a private directory
    expect(fs.statSync(path.join(stateDir, 'local-access')).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(stateDir, 'local-access', 'listener.key')).mode & 0o777).toBe(0o600);
  });

  it('on a fleet agent (gate dark): the routes answer 404 and the CLI says the link is off', async () => {
    const { stateDir, port } = await boot(false);
    const page = await request(srv!).get('/local-access/v1/open').set('Host', `127.0.0.1:${port}`);
    expect(page.status).toBe(404);
    const m = await mintLink({ projectDir: tmpDir, stateDir, port, agentName: NAME, tunnelUrl: null }, port);
    expect(m.ok).toBe(false);
  });
});
