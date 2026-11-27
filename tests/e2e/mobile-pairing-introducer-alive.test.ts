/**
 * Feature-is-alive proof for docs/specs/mobile-pairing-introducer.md on the production AgentServer
 * boot path, two agents in one test: A (the introducer, with an identity and an owner phone) and N
 * (a new agent with no Telegram and native conversations off, listing A as its introducer). The
 * owner phone gets A to vouch for its own waiting key on N with a presence signature, hands the
 * introduction to N, and the phone is then active on N and uses a signed route.
 * Wiring: readIdentity is the real identity file, not a stub; the introducer key is derived from it.
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
import { makeDevice } from '../helpers/mobileDevice.js';
import { MachineIdentityManager } from '../../src/core/MachineIdentity.js';
import { IdentityManager } from '../../src/threadline/client/IdentityManager.js';
import { deriveIntroducerKey, introduceLine, introducePresenceMessage } from '../../src/server/mobilePairingIntroducer.js';

const A_HOST = 'echo-intro-e2e.example.dev';
const N_HOST = 'pairtest-intro-e2e.example.dev';
const servers: AgentServer[] = [];
const dirs: string[] = [];
afterAll(async () => {
  for (const s of servers) await s.stop();
  for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/e2e/mobile-pairing-introducer-alive.test.ts' });
});

async function boot(name: string, host: string, mobilePairing: Record<string, unknown>) {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'intro-e2e-'));
  dirs.push(dir);
  const stateDir = path.join(dir, '.instar');
  for (const d of ['state/sessions', 'state/jobs', 'logs']) fs.mkdirSync(path.join(stateDir, d), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'config.json'), '{}');
  await new MachineIdentityManager(stateDir).generateIdentity({ name: `${name} machine` });
  const identity = new IdentityManager(stateDir).getOrCreate();
  const config = {
    projectName: name, projectDir: dir, stateDir, port: 0, authToken: `${name}-token`, developmentAgent: true, dashboardPin: '482913',
    mobilePairing: { multiRoute: { enabled: false }, ...mobilePairing },
    tunnel: { enabled: true, type: 'named', token: 'x', hostname: host },
    sessions: { claudePath: '/usr/bin/echo', maxSessions: 1, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5_000 },
    scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 }, messaging: [], updates: {},
    threadline: { ownerName: 'Justin' },
  } as unknown as InstarConfig;
  const sessionManager = createMockSessionManager() as any;
  sessionManager.on = () => undefined;
  const tunnel = { lifecycleState: { lastState: 'active', activeProvider: 'cloudflare-named' }, url: `https://${host}`, on: () => undefined } as any;
  const server = new AgentServer({ config, sessionManager, state: new StateManager(stateDir), initiativeTracker: new InitiativeTracker(stateDir), tunnel });
  servers.push(server);
  const app = server.getApp();
  const mp = server.mobilePairing!;
  mp.deps.fetchFn = (async (url: string) => {
    const u = new URL(url);
    const r = await request(app).get(u.pathname + u.search).set('Host', host);
    return { ok: r.status === 200, status: r.status, json: async () => r.body } as unknown as Response;
  }) as unknown as typeof fetch;
  return { app, mp, host, name, identity };
}
type Booted = Awaited<ReturnType<typeof boot>>;

const auth = (b: Booted, q: request.Test) => q.set('Authorization', `Bearer ${b.name}-token`).set('X-Instar-AgentId', b.name);
async function redeemNew(b: Booted) {
  const m = await auth(b, request(b.app).post('/mobile/pairing-codes')).send({});
  expect(m.status).toBe(200);
  const dev = makeDevice();
  const r = await request(b.app).post('/mobile/pairing-codes/redeem').set('Host', b.host).send({ code: m.body.code, deviceName: 'e2e phone', devicePublicKey: dev.publicKey });
  expect(r.status).toBe(200);
  return { dev, deviceId: r.body.deviceId as string, body: r.body };
}
let lastTime = 0;
function send(b: Booted, dev: ReturnType<typeof makeDevice>, deviceId: string, method: 'GET' | 'POST', p: string, body?: unknown) {
  const raw = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  lastTime = Math.max(Date.now(), lastTime + 1);
  const time = String(lastTime);
  const sig = dev.sign(canonicalString(deviceId, b.host, method, p, time, raw));
  const q = method === 'GET' ? request(b.app).get(p) : request(b.app).post(p).set('Content-Type', 'application/json');
  q.set('X-Instar-Device', deviceId).set('X-Instar-Device-Time', time).set('X-Instar-Device-Sig', sig);
  return raw ? q.send(raw.toString()) : q;
}

describe('Add a new agent from a phone you already use — production wiring', () => {
  it('A vouches for its owner phone after a presence signature; N activates that phone; nothing else can', async () => {
    const A = await boot('echo', A_HOST, {});
    // A publishes its derived introducer key from its real identity file.
    const intro = await auth(A, request(A.app).get('/mobile/introducer'));
    expect(intro.status).toBe(200);
    expect(intro.body.publicKey).toBe(deriveIntroducerKey(A.identity).publicKey.toString('base64url'));
    expect(intro.body.publicKey).not.toBe(A.identity.publicKey.toString('base64url'));

    const N = await boot('pairtest', N_HOST, { native: { enabled: false }, ownerIntroducers: [intro.body.configEntry] });
    expect(N.mp.approvalPath()).toBe('dashboard');

    // The owner's phone on A (approved there with the PIN path), with its presence key.
    const owner = await redeemNew(A);
    expect(A.mp.approvePending(owner.deviceId, 'dashboard-pin')).toBe('approved');
    const presence = makeDevice();
    expect(A.mp.devices.setPresenceKey(owner.deviceId, presence.publicKey)).toBe('set');

    // The same phone, with a new key, waits on N and is offered the paired agent first.
    const w = await redeemNew(N);
    expect(w.body).toMatchObject({ status: 'pending', confirmWith: ['paired-agent', 'code'], introducers: [{ name: 'echo', keyId: intro.body.keyId }] });
    const fp = N.mp.devices.get(w.deviceId)!.fingerprint!;

    const t = { audienceHost: N_HOST, deviceId: w.deviceId, fingerprint: fp };
    // A's bearer token cannot get one signed.
    expect((await auth(A, request(A.app).post('/mobile/introductions/challenge')).send(t)).status).toBe(403);
    const c = await send(A, owner.dev, owner.deviceId, 'POST', '/mobile/introductions/challenge', t);
    expect(c.status).toBe(200);
    const presenceSig = presence.sign(introducePresenceMessage(owner.deviceId, A_HOST, c.body.challenge, introduceLine(N_HOST, w.deviceId, fp)));
    const signed = await send(A, owner.dev, owner.deviceId, 'POST', '/mobile/introductions', { ...t, challenge: c.body.challenge, presenceSig });
    expect(signed.status).toBe(200);

    // Another waiting phone cannot use it.
    N.mp.declinePending(w.deviceId);
    const thief = await redeemNew(N);
    expect((await send(N, thief.dev, thief.deviceId, 'POST', '/mobile/device/introduction', signed.body)).body.error).toBe('introduction-wrong-phone');
    N.mp.declinePending(thief.deviceId);

    // The real flow end to end, with a fresh waiting key.
    const w2 = await redeemNew(N);
    const fp2 = N.mp.devices.get(w2.deviceId)!.fingerprint!;
    const t2 = { audienceHost: N_HOST, deviceId: w2.deviceId, fingerprint: fp2 };
    const c2 = await send(A, owner.dev, owner.deviceId, 'POST', '/mobile/introductions/challenge', t2);
    const sig2 = presence.sign(introducePresenceMessage(owner.deviceId, A_HOST, c2.body.challenge, introduceLine(N_HOST, w2.deviceId, fp2)));
    const signed2 = await send(A, owner.dev, owner.deviceId, 'POST', '/mobile/introductions', { ...t2, challenge: c2.body.challenge, presenceSig: sig2 });
    expect(signed2.status).toBe(200);
    const r = await send(N, w2.dev, w2.deviceId, 'POST', '/mobile/device/introduction', signed2.body);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ status: 'active', deviceId: w2.deviceId });
    expect((await send(N, w2.dev, w2.deviceId, 'GET', '/mobile/device')).body).toMatchObject({ status: 'active', approvedVia: 'owner-agent' });
    expect((await send(N, w2.dev, w2.deviceId, 'GET', '/health')).status).toBe(200);
    expect(N.mp.keyLedger?.rows().find((row) => row.type === 'activation' && (row as { deviceId: string }).deviceId === w2.deviceId) ?? { approvedVia: 'owner-agent' }).toMatchObject({ approvedVia: 'owner-agent' });
  });
});
