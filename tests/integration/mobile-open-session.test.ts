/**
 * HTTP pipeline for "Open session" (GET /mobile/conversations/session), through the production
 * authMiddleware + deviceAuthenticator: active, inactive, another machine's conversation, wrong
 * refs, Bearer refused, and the device allowlist entry.
 */
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { authMiddleware } from '../../src/server/middleware.js';
import { MobilePairingService, deviceAuthenticator, DEVICE_ALLOWLIST, type MobilePairingDeps } from '../../src/server/mobilePairingRoutes.js';
import { createMobileSessionRouter, NO_SESSION_REASON, type SessionConversationRef } from '../../src/server/mobileSessionRoutes.js';
import { canonicalString } from '../../src/core/MobileDeviceKeys.js';
import { makeDevice } from '../helpers/mobileDevice.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const HOST = 'echo.example.dev';
const APP = '22222222-2222-4222-8222-222222222222';
const dirs: string[] = [];
const services: MobilePairingService[] = [];
afterAll(() => {
  for (const s of services) s.stop();
  for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/integration/mobile-open-session.test.ts' });
});

function setup(opts: { namedTunnel?: string } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mopen-int-'));
  dirs.push(dir);
  // The agent's user registry: Justin is a person an MSP phone can belong to.
  fs.writeFileSync(path.join(dir, 'users.json'), JSON.stringify([{ id: 'justin', name: 'Justin', channels: [], permissions: ['user'] }]));
  const config = {
    projectName: 'echo', stateDir: dir, authToken: 'tok-1', developmentAgent: true,
    mobilePairing: { multiRoute: { enabled: false } },
    ...(opts.namedTunnel ? { tunnel: { enabled: true, type: 'named', token: 'x', hostname: opts.namedTunnel } } : {}),
  } as never;
  const deps: MobilePairingDeps = {
    config, stateDir: dir, holdsLease: () => true, selfMachineId: 'm_self',
    ...(opts.namedTunnel ? { tunnel: () => ({ lifecycleState: { lastState: 'active', activeProvider: 'cloudflare-named' } }) as never } : {}),
  };
  const svc = new MobilePairingService(deps);
  services.push(svc);
  // The app conversation belongs to another person on this machine (people and roles §3.4).
  svc.appConversationOwner = (key) => (key === APP ? { machineId: 'm_self', userId: 'someone-else' } as never : undefined);
  // This machine: topic 7 runs "echo-topic-7"; topic 8 is known with no session; topic 9 runs on m_peer.
  const bindings = new Map<string, string>([['telegram:7', 'echo-topic-7'], [`app:${APP}`, 'echo-app-1']]);
  const running = new Map<string, { startedAt: string; framework: string }>([
    ['echo-topic-7', { startedAt: '2026-11-03T18:00:00.000Z', framework: 'claude-code' }],
  ]);
  const known = new Set(['telegram:7', 'telegram:8', 'telegram:9', `app:${APP}`, 'slack:T1:C1']);
  const app = express();
  app.use(express.json({ verify: (req, _res, buf) => { (req as unknown as { rawBody: Buffer }).rawBody = buf; } }));
  app.use(authMiddleware(() => 'tok-1', 'echo', undefined, deviceAuthenticator(svc)));
  app.use(createMobileSessionRouter({
    pairing: svc,
    conversationKnown: (r: SessionConversationRef) => known.has(r.ref),
    sessionNameFor: (r) => bindings.get(r.ref) ?? null,
    runningSession: (n) => running.get(n) ?? null,
    ownerMachineFor: (r) => (r.ref === 'telegram:9' ? 'm_peer' : null),
    selfMachineId: () => 'm_self',
    nicknameOf: (id) => (id === 'm_self' ? 'Studio' : id === 'm_peer' ? 'Mac Mini' : null),
  }));
  const pair = (person?: { userId: string; role: 'msp' }) => {
    const dev = makeDevice();
    const created = svc.devices.createPending({ deviceName: 'iPhone', label: null, publicKey: dev.publicKey, host: HOST, ...(person ?? {}) });
    if (!created.ok) throw new Error('setup');
    svc.devices.applyConfirm(created.device.id, { ok: true });
    return { dev, id: created.device.id };
  };
  const owner = pair();
  return { app, svc, dev: owner.dev, id: owner.id, pair };
}

let tick = 0;
function signedGet(c: ReturnType<typeof setup>, p: string) {
  const time = String(Date.now() + (tick++ % 1000));
  const sig = c.dev.sign(canonicalString(c.id, HOST, 'GET', p, time, undefined));
  return request(c.app).get(p).set('X-Instar-Device', c.id).set('X-Instar-Device-Time', time).set('X-Instar-Device-Sig', sig);
}
const q = (ref: string) => `/mobile/conversations/session?ref=${encodeURIComponent(ref)}`;

describe('GET /mobile/conversations/session', () => {
  it('active: names the session and links the dashboard focused on it, with no token or PIN in the link', async () => {
    const c = setup();
    const r = await signedGet(c, q('telegram:7'));
    expect(r.status).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.body).toEqual({
      active: true, sessionName: 'echo-topic-7', startedAt: '2026-11-03T18:00:00.000Z', framework: 'claude-code',
      machineNickname: 'Studio', dashboardUrl: `https://${HOST}/dashboard?session=echo-topic-7`,
    });
    expect(r.body.dashboardUrl).not.toMatch(/token|pin|sig=/i);
  });

  it('prefers the pairing origin (running named tunnel) for the link', async () => {
    const c = setup({ namedTunnel: 'agent.tunnel.example.dev' });
    const r = await signedGet(c, q('telegram:7'));
    expect(r.body.dashboardUrl).toBe('https://agent.tunnel.example.dev/dashboard?session=echo-topic-7');
  });

  it('inactive: a known conversation with no session, and a binding whose session is not running', async () => {
    const c = setup();
    const none = await signedGet(c, q('telegram:8'));
    expect(none.status).toBe(200);
    expect(none.body).toEqual({ active: false, machineNickname: 'Studio', reason: NO_SESSION_REASON });
    const stale = await signedGet(c, q(`app:${APP}`));
    expect(stale.body).toMatchObject({ active: false, reason: NO_SESSION_REASON });
    expect(stale.body.dashboardUrl).toBeUndefined();
  });

  it('another machine: active:false naming that machine', async () => {
    const c = setup();
    const r = await signedGet(c, q('telegram:9'));
    expect(r.body).toMatchObject({ active: false, ownerMachine: { machineId: 'm_peer', nickname: 'Mac Mini' } });
    expect(r.body.reason).toContain('Mac Mini');
  });

  it('wrong refs: malformed → 400, unknown → 404', async () => {
    const c = setup();
    expect((await signedGet(c, '/mobile/conversations/session')).status).toBe(400);
    expect((await signedGet(c, q('telegram:0'))).status).toBe(400);
    expect((await signedGet(c, q('app:not-a-uuid'))).status).toBe(400);
    expect((await signedGet(c, q('whatsapp:1'))).status).toBe(400);
    const unknown = await signedGet(c, q('telegram:12345'));
    expect(unknown.status).toBe(404);
    expect(unknown.body.error).toBe('unknown-conversation');
  });

  it('Bearer-only access is refused; an unsigned device request is refused', async () => {
    const c = setup();
    const bearer = await request(c.app).get(q('telegram:7')).set('Authorization', 'Bearer tok-1');
    expect(bearer.status).toBe(403);
    expect(bearer.body.error).toBe('operator-device-required');
    const unsigned = await request(c.app).get(q('telegram:7')).set('X-Instar-Device', c.id);
    expect(unsigned.status).toBe(401);
  });

  it('allowlist: GET only, active devices, no body, flagged as naming a conversation', async () => {
    const rule = DEVICE_ALLOWLIST.find((x) => x.method === 'GET' && x.re.test('/mobile/conversations/session'));
    expect(rule).toBeDefined();
    expect([...rule!.statuses]).toEqual(['active']);
    expect(rule!.body).toBe('none');
    expect(rule!.conversationRef).toBe(true);
    expect(DEVICE_ALLOWLIST.some((x) => x.method !== 'GET' && x.re.test('/mobile/conversations/session'))).toBe(false);
    // A POST to the path is refused by the device authenticator before any route runs.
    const c = setup();
    const time = String(Date.now());
    const raw = Buffer.from('{}');
    const sig = c.dev.sign(canonicalString(c.id, HOST, 'POST', '/mobile/conversations/session', time, raw));
    const post = await request(c.app).post('/mobile/conversations/session').set('Content-Type', 'application/json')
      .set('X-Instar-Device', c.id).set('X-Instar-Device-Time', time).set('X-Instar-Device-Sig', sig).send('{}');
    expect(post.status).toBe(403);
    expect(post.body.error).toBe('device-not-allowed');
  });

  it('the ref is covered by the signature: a request whose ref was changed after signing is refused', async () => {
    const c = setup();
    const time = String(Date.now());
    const sig = c.dev.sign(canonicalString(c.id, HOST, 'GET', q('telegram:7'), time, undefined));
    const tampered = await request(c.app).get(q('telegram:8')).set('X-Instar-Device', c.id).set('X-Instar-Device-Time', time).set('X-Instar-Device-Sig', sig);
    expect(tampered.status).toBe(401);
  });

  it('the notification read token does not open this route', async () => {
    const c = setup();
    const r = await request(c.app).get(q('telegram:7')).set('X-Instar-Device', c.id).set('X-Instar-Notify-Token', 'a'.repeat(64));
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('notify-token-not-allowed');
  });

  it('an MSP phone gets 404 for an app conversation it does not own and a Slack chat without the grant', async () => {
    const c = setup();
    const msp = c.pair({ userId: 'justin', role: 'msp' });
    const as = { ...c, dev: msp.dev, id: msp.id };
    expect((await signedGet(as, q(`app:${APP}`))).status).toBe(404);
    expect((await signedGet(as, q('slack:T1:C1'))).status).toBe(404);
    // A Telegram topic stays readable for an MSP phone, as on every other mobile route.
    expect((await signedGet(as, q('telegram:7'))).body.active).toBe(true);
    // The owner's phone reads both.
    expect((await signedGet(c, q(`app:${APP}`))).status).toBe(200);
    expect((await signedGet(c, q('slack:T1:C1'))).status).toBe(200);
  });

  it('a revoked phone is refused', async () => {
    const c = setup();
    c.svc.devices.revoke(c.id);
    expect((await signedGet(c, q('telegram:7'))).status).toBe(401);
  });
});
