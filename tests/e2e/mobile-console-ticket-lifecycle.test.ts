/**
 * Feature-is-alive proof for console sign-in from an owner phone
 * (docs/specs/mobile-console-device-signin.md): an AgentServer booted on its production path
 * (development agent, mobile pairing on), a phone paired through the real redeem/confirm path,
 * the presence key enrolled, a ticket minted, and the PUBLIC redeem route answering the API token,
 * which then opens GET /sessions on the same server. Wiring integrity: the three device routes are
 * on the production device allowlist (not 403 device-not-allowed), the redeem is mounted before
 * the bearer gate (not 401), and none of them answers 404/503.
 */
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { InitiativeTracker } from '../../src/core/InitiativeTracker.js';
import { createMockSessionManager } from '../helpers/setup.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { InstarConfig } from '../../src/core/types.js';
import { canonicalString } from '../../src/core/MobileDeviceKeys.js';
import { presenceEnrollMessage, presenceMessage } from '../../src/server/mobileConsoleTicket.js';
import { makeDevice } from '../helpers/mobileDevice.js';
import { MachineIdentityManager } from '../../src/core/MachineIdentity.js';

const HOST = 'echo-console-ticket-e2e.example.dev';
const servers: AgentServer[] = [];
const dirs: string[] = [];

afterAll(async () => {
  for (const s of servers) await s.stop();
  for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/e2e/mobile-console-ticket-lifecycle.test.ts' });
});

async function boot() {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'console-ticket-e2e-'));
  dirs.push(dir);
  const stateDir = path.join(dir, '.instar');
  for (const d of ['state/sessions', 'state/jobs', 'logs']) fs.mkdirSync(path.join(stateDir, d), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'config.json'), '{}');
  await new MachineIdentityManager(stateDir).generateIdentity({ name: 'e2e machine' });
  const config = {
    projectName: 'console-ticket-e2e', projectDir: dir, stateDir, port: 0, authToken: 'e2e-token', developmentAgent: true,
    mobilePairing: { multiRoute: { enabled: false } },
    tunnel: { enabled: true, type: 'named', token: 'x', hostname: HOST },
    sessions: { claudePath: '/usr/bin/echo', maxSessions: 1, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5_000 },
    scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 }, messaging: [], updates: {},
    threadline: { ownerName: 'Justin' },
  } as unknown as InstarConfig;
  const sessionManager = createMockSessionManager() as any;
  sessionManager.on = () => undefined;
  const tunnel = { lifecycleState: { lastState: 'active', activeProvider: 'cloudflare-named' }, url: `https://${HOST}`, on: () => undefined } as any;
  const server = new AgentServer({ config, sessionManager, state: new StateManager(stateDir), initiativeTracker: new InitiativeTracker(stateDir), tunnel });
  servers.push(server);
  return { server };
}

describe('console ticket — production wiring', () => {
  it('is alive: enroll, mint and the public redeem return the token that opens /sessions', async () => {
    const { server } = await boot();
    const app = server.getApp();
    expect(server.mobilePairing).not.toBeNull();

    server.mobilePairing!.deps.fetchFn = (async (url: string) => {
      const u = new URL(url);
      const r = await request(app).get(u.pathname + u.search).set('Host', HOST);
      return { ok: r.status === 200, status: r.status, json: async () => r.body } as unknown as Response;
    }) as unknown as typeof fetch;
    const m = await request(app).post('/mobile/pairing-codes').set('Authorization', 'Bearer e2e-token').set('X-Instar-AgentId', 'console-ticket-e2e').send({});
    expect(m.status).toBe(200);
    const dms: string[] = [];
    server.mobilePairing!.deps.ownerDM = async (text) => { dms.push(text); return 1; };
    server.mobilePairing!.deps.telegramOwnerPresent = () => true;
    const dev = makeDevice();
    const presence = makeDevice();
    const r = await request(app).post('/mobile/pairing-codes/redeem').set('Host', HOST).send({ code: m.body.code, deviceName: 'e2e phone', devicePublicKey: dev.publicKey });
    expect(r.status).toBe(200);
    const deviceId = r.body.deviceId as string;
    const code = /is (\d{3}) (\d{3})\./.exec(dms[0]!)!.slice(1).join('');
    let t = Date.now();
    const send = (p: string, body: unknown) => {
      const raw = Buffer.from(JSON.stringify(body));
      const time = String(++t);
      const sig = dev.sign(canonicalString(deviceId, HOST, 'POST', p, time, raw));
      return request(app).post(p).set('Host', HOST).set('Content-Type', 'application/json')
        .set('X-Instar-Device', deviceId).set('X-Instar-Device-Time', time).set('X-Instar-Device-Sig', sig).send(raw.toString());
    };
    expect((await send('/mobile/device/confirm', { code })).body.status).toBe('active');

    const enrolled = await send('/mobile/device/presence-key', { publicKey: presence.publicKey, proof: presence.sign(presenceEnrollMessage(deviceId, HOST, presence.publicKey)) });
    expect(enrolled.status).toBe(200);
    const challenge = await send('/mobile/console-ticket/challenge', {});
    expect(challenge.status).toBe(200);
    const minted = await send('/mobile/console-ticket', { challenge: challenge.body.challenge, presenceSig: presence.sign(presenceMessage(deviceId, HOST, challenge.body.challenge)) });
    expect(minted.status).toBe(200);
    expect(minted.body.redeemOrigin).toBe(`https://${HOST}`);

    // The public redeem: no bearer, mounted before the gate.
    const redeemed = await request(app).post('/dashboard/console-ticket').set('Host', HOST).send({ ticket: minted.body.ticket });
    expect(redeemed.status).toBe(200);
    expect(redeemed.body).toEqual({ token: 'e2e-token' });
    const sessions = await request(app).get('/sessions').set('Authorization', `Bearer ${redeemed.body.token}`).set('X-Instar-AgentId', 'console-ticket-e2e');
    expect(sessions.status).toBe(200);
    expect((await request(app).post('/dashboard/console-ticket').set('Host', HOST).send({ ticket: minted.body.ticket })).status).toBe(401);

    // The console page that consumes it is served and wired.
    const page = await request(app).get('/dashboard/console/ticket-model.js');
    expect(page.status).toBe(200);
    expect(page.text).toContain('instar_console_ticket');
    const boot = await request(app).get('/dashboard/console/console.js');
    expect(boot.text).toContain('signInAtBoot');

    // A bearer caller is refused at mint (alive: 403, not 503/404).
    const bearer = await request(app).post('/mobile/console-ticket/challenge').set('Authorization', 'Bearer e2e-token').set('X-Instar-AgentId', 'console-ticket-e2e').send({});
    expect(bearer.status).toBe(403);
  });
});
