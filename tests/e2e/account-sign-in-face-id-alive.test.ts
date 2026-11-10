/**
 * Feature-is-alive proof for starting an account sign-in from the owner's phone with Face ID
 * instead of the dashboard PIN (docs/specs/account-sign-in-face-id.md): an AgentServer booted on its
 * production path (development agent, mobile pairing on, a dashboard PIN, a real SubscriptionPool and
 * EnrollmentWizard whose sign-in driver is a stand-in, so no real account is touched), a phone paired
 * through the real redeem/confirm path, its presence key enrolled through the real route, then
 * POST /mobile/accounts/sign-in/start with a real P-256 presence signature over
 * `account-sign-in <accountId>@<machineId>`. Wiring integrity: the route is on the production device
 * allowlist (not 403 device-not-allowed), mounted (not 404), wired to start-cell's own core (not 503
 * account-sign-in-unavailable), creates the same pending login the PIN route would, and answers the
 * body the app parses from start-cell. The dashboard's PIN route still answers the same shape.
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
import { SubscriptionPool } from '../../src/core/SubscriptionPool.js';
import { EnrollmentWizard } from '../../src/core/EnrollmentWizard.js';
import { PendingLoginStore } from '../../src/core/PendingLoginStore.js';
import { createMockSessionManager } from '../helpers/setup.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { InstarConfig } from '../../src/core/types.js';
import { canonicalString } from '../../src/core/MobileDeviceKeys.js';
import { presenceEnrollMessage } from '../../src/server/mobileConsoleTicket.js';
import { permissionPresenceMessage } from '../../src/server/mobilePermissionsRoutes.js';
import { makeDevice } from '../helpers/mobileDevice.js';
import { MachineIdentityManager } from '../../src/core/MachineIdentity.js';
import { allowTestIdentities } from '../helpers/allow-test-identities.js';

const HOST = 'echo-acct-faceid-e2e.example.dev';
const PIN = '424242';
const servers: AgentServer[] = [];
const listeners: Server[] = [];
const dirs: string[] = [];

afterAll(async () => {
  for (const l of listeners) await new Promise<void>((r) => l.close(() => r()));
  for (const s of servers) await s.stop();
  for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/e2e/account-sign-in-face-id-alive.test.ts' });
});

async function boot() {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'acct-faceid-e2e-'));
  dirs.push(dir);
  const stateDir = path.join(dir, '.instar');
  for (const d of ['state/sessions', 'state/jobs', 'logs']) fs.mkdirSync(path.join(stateDir, d), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'config.json'), '{}');
  allowTestIdentities(stateDir);
  await new MachineIdentityManager(stateDir).generateIdentity({ name: 'e2e machine' });
  const config = {
    projectName: 'acct-faceid-e2e', projectDir: dir, stateDir, host: '127.0.0.1', port: 0, authToken: 'e2e-token', developmentAgent: true, dashboardPin: PIN,
    mobilePairing: { multiRoute: { enabled: false } },
    multiMachine: { accountFollowMe: {} },
    tunnel: { enabled: true, type: 'named', token: 'x', hostname: HOST },
    sessions: { claudePath: '/usr/bin/echo', maxSessions: 1, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5_000 },
    scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 }, messaging: [], updates: {},
    threadline: { ownerName: 'Justin' },
  } as unknown as InstarConfig;
  // A real pool with one account and a real wizard whose sign-in driver is a stand-in: no real account is signed in.
  const subscriptionPool = new SubscriptionPool({ stateDir });
  subscriptionPool.addFixture({ id: 'gearfinity3d', nickname: 'Gearfinity3D', provider: 'anthropic', framework: 'claude-code', configHome: path.join(dir, 'gear'), email: 'gear@example.com' } as never);
  const drives: string[] = [];
  const enrollmentWizard = new EnrollmentWizard({
    store: new PendingLoginStore({ stateDir }),
    driveLogin: async (input: { id?: string } = {}) => { drives.push(String(input.id ?? '')); return { verificationUrl: 'https://claude.com/oauth/e2e', userCode: 'WXYZ-1234', ttlMs: 15 * 60_000 }; },
    ensureReady: () => ({ patched: false, reason: 'already interactive-ready' }),
  } as never);
  const sessionManager = createMockSessionManager() as any;
  sessionManager.on = () => undefined;
  const tunnel = { lifecycleState: { lastState: 'active', activeProvider: 'cloudflare-named' }, url: `https://${HOST}`, on: () => undefined } as any;
  const server = new AgentServer({ config, sessionManager, state: new StateManager(stateDir), initiativeTracker: new InitiativeTracker(stateDir), tunnel, subscriptionPool, enrollmentWizard } as never);
  servers.push(server);
  // start-cell drives the SELF enroll/start over loopback, so the app listens and the live port is wired back.
  const app = server.getApp();
  const listener = await new Promise<Server>((resolve) => { const l = app.listen(0, '127.0.0.1', () => resolve(l)); });
  listeners.push(listener);
  (config as unknown as { port: number }).port = (listener.address() as AddressInfo).port;
  return { server, app, stateDir, enrollmentWizard, drives };
}

describe('account sign-in with Face ID — production wiring', () => {
  it('is alive: an owner phone starts a sign-in with a fresh Face ID proof and gets start-cell\'s answer', async () => {
    const { server, app, stateDir, enrollmentWizard } = await boot();
    expect(server.mobilePairing).not.toBeNull();
    const bearer = (r: request.Test) => r.set('Authorization', 'Bearer e2e-token').set('X-Instar-AgentId', 'acct-faceid-e2e');

    // Pair a phone through the real path.
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
    const signed = (p: string, body: unknown) => {
      const raw = Buffer.from(JSON.stringify(body));
      const time = String(++t);
      const sig = dev.sign(canonicalString(deviceId, HOST, 'POST', p, time, raw));
      return request(app).post(p).set('Content-Type', 'application/json').set('Host', HOST)
        .set('X-Instar-Device', deviceId).set('X-Instar-Device-Time', time).set('X-Instar-Device-Sig', sig).send(raw.toString());
    };
    expect((await signed('/mobile/device/confirm', { code })).body.status).toBe('active');
    expect((await signed('/mobile/device/presence-key', { publicKey: presence.publicKey, proof: presence.sign(presenceEnrollMessage(deviceId, HOST, presence.publicKey)) })).status).toBe(200);

    // The machine id start-cell treats as this machine (the same one the matrix names).
    const pool = await bearer(request(app).get('/pool'));
    const self = (pool.body?.selfMachineId as string | undefined) ?? 'local';
    const target = `gearfinity3d@${self}`;

    const ch = await signed('/mobile/permissions/challenge', { action: 'account-sign-in', target });
    expect(ch.status, JSON.stringify(ch.body)).toBe(200);
    const started = await signed('/mobile/accounts/sign-in/start', { accountId: 'gearfinity3d', machineId: self, challenge: ch.body.challenge, presenceSig: presence.sign(permissionPresenceMessage(deviceId, HOST, ch.body.challenge, `account-sign-in ${target}`)) });
    expect(started.status, JSON.stringify(started.body)).toBe(201);
    expect(started.body).toMatchObject({ verificationUrl: 'https://claude.com/oauth/e2e', loginId: 'gearfinity3d', machineId: self, expectedEmail: 'gear@example.com' });
    expect(typeof started.body.ttlExpiresAt).toBe('string');
    // The real start-cell core ran: one pending login carrying the approved email.
    expect(enrollmentWizard.pending().filter((l) => l.id === 'gearfinity3d' && l.status === 'pending')).toHaveLength(1);
    expect(enrollmentWizard.pending()[0]).toMatchObject({ id: 'gearfinity3d', expectedEmail: 'gear@example.com' });

    // The dashboard's PIN route still works and answers the same shape (a re-tap reuses the live login).
    const viaPin = await bearer(request(app).post('/subscription-pool/matrix/start-cell')).send({ accountId: 'gearfinity3d', machineId: self, pin: PIN });
    expect(viaPin.status, JSON.stringify(viaPin.body)).toBe(201);
    expect(viaPin.body).toMatchObject({ verificationUrl: started.body.verificationUrl, loginId: 'gearfinity3d', machineId: self, reused: true });

    // The phone audit records it; the bearer cannot use the phone route.
    const rows = fs.readFileSync(path.join(stateDir, 'state', 'mobile-permission-actions.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(rows.some((x) => x.event === 'account-sign-in' && x.deviceId === deviceId && x.target === target && x.status === 201)).toBe(true);
    expect((await bearer(request(app).post('/mobile/accounts/sign-in/start')).send({ accountId: 'gearfinity3d', machineId: self })).status).toBe(403);
  });
});
