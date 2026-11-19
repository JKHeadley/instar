/**
 * Feature-is-alive proof for approving a code-owner pull request from the owner's phone
 * (docs/specs/github-approval-from-the-app.md): an AgentServer on its production path, a phone paired through
 * the real redeem/confirm path with its presence key enrolled, then the challenge, approve and result routes.
 * Wiring integrity: the routes are on the production device allowlist, mounted, and wired to the real
 * GithubOwnerApproval service built in routes.ts (its own plain reasons come back), never 503 for want of a port.
 */
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { InitiativeTracker } from '../../src/core/InitiativeTracker.js';
import { createMockSessionManager } from '../helpers/setup.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { InstarConfig } from '../../src/core/types.js';
import { canonicalString } from '../../src/core/MobileDeviceKeys.js';
import { presenceEnrollMessage } from '../../src/server/mobileConsoleTicket.js';
import { permissionPresenceMessage } from '../../src/server/mobilePermissionsRoutes.js';
import { makeDevice } from '../helpers/mobileDevice.js';
import { MachineIdentityManager } from '../../src/core/MachineIdentity.js';
import { allowTestIdentities } from '../helpers/allow-test-identities.js';

const HOST = 'echo-gh-approval-e2e.example.dev';
const PIN = '424242';
const HEAD = 'a'.repeat(40);
const servers: AgentServer[] = [];
const dirs: string[] = [];

afterAll(async () => {
  for (const s of servers) await s.stop();
  for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/e2e/github-approval-alive.test.ts' });
});

async function boot(ownerApproval: Record<string, unknown>) {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'gh-approval-e2e-'));
  dirs.push(dir);
  const stateDir = path.join(dir, '.instar');
  for (const d of ['state/sessions', 'state/jobs', 'logs']) fs.mkdirSync(path.join(stateDir, d), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'config.json'), '{}');
  allowTestIdentities(stateDir);
  await new MachineIdentityManager(stateDir).generateIdentity({ name: 'e2e machine' });
  const config = {
    projectName: 'gh-approval-e2e', projectDir: dir, stateDir, host: '127.0.0.1', port: 0, authToken: 'e2e-token', developmentAgent: true, dashboardPin: PIN,
    mobilePairing: { multiRoute: { enabled: false } },
    tunnel: { enabled: true, type: 'named', token: 'x', hostname: HOST },
    sessions: { claudePath: '/usr/bin/echo', maxSessions: 1, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5_000 },
    scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 }, messaging: [], updates: {},
    threadline: { ownerName: 'Justin' },
    github: { ownerApproval },
  } as unknown as InstarConfig;
  const sessionManager = createMockSessionManager() as any;
  sessionManager.on = () => undefined;
  const tunnel = { lifecycleState: { lastState: 'active', activeProvider: 'cloudflare-named' }, url: `https://${HOST}`, on: () => undefined } as any;
  const server = new AgentServer({ config, sessionManager, state: new StateManager(stateDir), initiativeTracker: new InitiativeTracker(stateDir), tunnel } as never);
  servers.push(server);
  return { server, app: server.getApp(), stateDir };
}

async function pairPhone(server: AgentServer, app: any) {
  const bearer = (r: request.Test) => r.set('Authorization', 'Bearer e2e-token').set('X-Instar-AgentId', 'gh-approval-e2e');
  server.mobilePairing!.deps.fetchFn = (async (url: string) => {
    const u = new URL(url);
    const r = await request(app).get(u.pathname + u.search).set('Host', HOST);
    return { ok: r.status === 200, status: r.status, json: async () => r.body } as unknown as Response;
  }) as unknown as typeof fetch;
  const m = await bearer(request(app).post('/mobile/pairing-codes')).send({});
  expect(m.status).toBe(200);
  const dms: string[] = [];
  server.mobilePairing!.deps.ownerDM = async (text) => { dms.push(text); return 1; };
  server.mobilePairing!.deps.telegramOwnerPresent = () => true;
  const dev = makeDevice();
  const presence = makeDevice();
  const redeemed = await request(app).post('/mobile/pairing-codes/redeem').set('Host', HOST).send({ code: m.body.code, deviceName: 'e2e phone', devicePublicKey: dev.publicKey });
  expect(redeemed.status).toBe(200);
  const deviceId = redeemed.body.deviceId as string;
  const code = /is (\d{3}) (\d{3})\./.exec(dms[0]!)!.slice(1).join('');
  let t = Date.now();
  const signed = (p: string, body: unknown, method: 'POST' | 'GET' = 'POST') => {
    const raw = method === 'POST' ? Buffer.from(JSON.stringify(body)) : undefined;
    const time = String(++t);
    const sig = dev.sign(canonicalString(deviceId, HOST, method, p, time, raw));
    const r = method === 'POST' ? request(app).post(p).set('Content-Type', 'application/json') : request(app).get(p);
    const s = r.set('Host', HOST).set('X-Instar-Device', deviceId).set('X-Instar-Device-Time', time).set('X-Instar-Device-Sig', sig);
    return method === 'POST' ? s.send(raw!.toString()) : s;
  };
  expect((await signed('/mobile/device/confirm', { code })).body.status).toBe('active');
  expect((await signed('/mobile/device/presence-key', { publicKey: presence.publicKey, proof: presence.sign(presenceEnrollMessage(deviceId, HOST, presence.publicKey)) })).status).toBe(200);
  return { signed, deviceId, presence, bearer };
}

describe('approve a code-owner pull request from the phone — production wiring', () => {
  it('is alive: the routes are on the device allowlist, mounted and wired to the approval service', async () => {
    const { server, app } = await boot({ enabled: false });
    const { signed, bearer } = await pairPhone(server, app);
    // The challenge reaches the real service: off here, so it answers 503 with the service's own plain reason.
    const ch = await signed('/mobile/permissions/challenge', { action: 'github-approval', target: '3478', headSha: HEAD });
    expect(ch.status, JSON.stringify(ch.body)).toBe(503);
    expect(ch.body).toMatchObject({ error: 'github-approval-unavailable', reason: expect.stringMatching(/switched off/) });
    // The approve route is admitted (not 403 device-not-allowed) and mounted (not 404): a forged proof is refused by the challenge.
    const ap = await signed('/mobile/github/approvals/3478/approve', { headSha: HEAD, challenge: 'x'.repeat(43), presenceSig: 'AAAA' });
    expect(ap.status, JSON.stringify(ap.body)).toBe(401);
    expect(ap.body.error).toBe('challenge-invalid');
    // The result read is wired to the service (state none here), and the bearer cannot use the phone write.
    const read = await signed('/mobile/github/approvals/3478', null, 'GET');
    expect(read.status, JSON.stringify(read.body)).toBe(200);
    expect(read.body).toMatchObject({ state: 'none', pr: 3478 });
    expect((await bearer(request(app).post('/mobile/github/approvals/3478/approve')).send({ headSha: HEAD })).status).toBe(403);
  });

  it('switched on without a merge watcher, it says in plain words why it cannot approve here', async () => {
    const { server, app } = await boot({ enabled: true, playwrightCoreDir: '/nonexistent' });
    const { signed } = await pairPhone(server, app);
    const ch = await signed('/mobile/permissions/challenge', { action: 'github-approval', target: '3478', headSha: HEAD });
    expect(ch.status).toBe(503);
    expect(ch.body.reason).toMatch(/does not name a repository/);
  });
});
