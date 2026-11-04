/**
 * HTTP pipeline for the phone's native Messages to you and Insights reads
 * (docs/specs/mobile-native-phones-messages.md) through the production authMiddleware +
 * deviceAuthenticator: an owner phone and the bearer token are served; an MSP phone, a demoted phone,
 * a removed person's phone, a revoked phone, an unsigned or tampered request, the notification read
 * token and a POST are refused. The answers carry no operation, topic, machine or record id, no
 * dashboard deep link and no planted credential. Plus the real origin runtime wired through
 * createRoutes: the phone's summary reads the same held rows /telegram/origins/status lists.
 */
import { describe, it, expect, afterAll, afterEach, beforeAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { authMiddleware } from '../../src/server/middleware.js';
import { MobilePairingService, deviceAuthenticator, type MobilePairingDeps } from '../../src/server/mobilePairingRoutes.js';
import { mountMobilePhonesMessagesRoutes, summarizeLocalMessages, type MobilePhonesMessagesDeps } from '../../src/server/mobilePhonesMessagesRoutes.js';
import { canonicalString } from '../../src/core/MobileDeviceKeys.js';
import { makeDevice } from '../helpers/mobileDevice.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { createRoutes } from '../../src/server/routes.js';
import { TelegramOriginRuntime } from '../../src/messaging/telegram-origin/TelegramOriginRuntime.js';
import { compileOriginWorker, temporaryState } from '../helpers/telegramOriginStore.js';

const HOST = 'echo.example.dev';
const NOW = Date.parse('2026-11-04T02:00:00.000Z');
const H = (h: number) => new Date(NOW - h * 3_600_000).toISOString();
const dirs: string[] = [];
const services: MobilePairingService[] = [];
afterAll(() => {
  for (const s of services) s.stop();
  for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/integration/mobile-native-phones-messages.test.ts' });
});

const FAKE_KEY = 'ghp_' + 'Q'.repeat(36);
const held = [
  { operationId: 'op-secret-1', hold_reason: 'lease-not-held', since: H(2), topicId: '134088', producerKind: 'session', holder: 'm_holder', deadlineAt: H(-1) },
  { operationId: 'op-secret-2', hold_reason: `odd-${FAKE_KEY}`, since: H(1), producerKind: 'server-automation', destination: { kind: 'chat', id: '-100777', topicId: null } },
];
const statusData = { held, heldForward: { expiredUnreported: 0, topics: ['134088'] }, expiredHolds: { totalSinceBoot: 0 }, metrics: { counts: { 'attempt:accepted': 10 } },
  activation: { complete: false, observations: [{ obligation: 'bot-writers', subject: 'bot-1', state: 'held', reason: 'not-bound' }] } };
const insightsData = { pages: [{ page: 'jobs', title: 'Schedule', tab: 'jobs', headline: `Two jobs ran late ${FAKE_KEY}`, source: 'llm', cacheHit: true, asOf: H(1), stale: false,
  lines: [{ text: 'reflection ran late', severity: 'watch', action: 'Open Schedule' }], metrics: [{ label: 'Late', value: '2' }] }] };

function deps(over: Partial<MobilePhonesMessagesDeps> = {}): MobilePhonesMessagesDeps {
  return {
    originStatus: async () => ({ state: 'ok', data: statusData }),
    heldForward: () => ({ count: 1 }),
    peerMessages: async () => [{ machineId: 'm_peer', state: 'unreached' }],
    topicName: (id) => (id === '134088' ? 'Instar app' : null),
    insights: async () => ({ state: 'ok', data: insightsData }),
    peerInsights: async () => [],
    offlineMachineIds: () => ['m_far'],
    nicknameOf: (id) => (id === 'm_peer' ? 'Mac Mini' : id === 'm_far' ? 'Laptop' : null),
    bearerOk: (req) => req.headers.authorization === 'Bearer tok-1',
    now: () => NOW,
    ...over,
  };
}
function setup(over: Partial<MobilePhonesMessagesDeps> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mpm-int-'));
  dirs.push(dir);
  fs.writeFileSync(path.join(dir, 'users.json'), JSON.stringify([{ id: 'justin', name: 'Justin', channels: [], permissions: ['user'] }]));
  const config = { projectName: 'echo', stateDir: dir, authToken: 'tok-1', developmentAgent: true, mobilePairing: { multiRoute: { enabled: false } } } as never;
  const pdeps: MobilePairingDeps = { config, stateDir: dir, holdsLease: () => true, selfMachineId: 'm_self' };
  const svc = new MobilePairingService(pdeps);
  services.push(svc);
  const app = express();
  app.use(express.json({ verify: (req, _res, buf) => { (req as unknown as { rawBody: Buffer }).rawBody = buf; } }));
  app.use(authMiddleware(() => 'tok-1', 'echo', undefined, deviceAuthenticator(svc)));
  const router = express.Router();
  mountMobilePhonesMessagesRoutes(router, deps(over));
  app.use(router);
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
function signedGet(c: { app: express.Express; dev: ReturnType<typeof makeDevice>; id: string }, p: string) {
  const time = String(Date.now() + (tick++ % 1000));
  const sig = c.dev.sign(canonicalString(c.id, HOST, 'GET', p, time, undefined));
  return request(c.app).get(p).set('X-Instar-Device', c.id).set('X-Instar-Device-Time', time).set('X-Instar-Device-Sig', sig);
}

const ROUTES = ['/mobile/messages', '/mobile/insights'];
const LEAKS = ['op-secret', '134088', '-100777', 'm_holder', 'm_self', 'm_peer', 'm_far', 'ghp_QQQQ', 'bot-1', '"tab"', '"jobs"', 'deadlineAt', 'operationId'];

describe('owner phone: served, trimmed', () => {
  it('GET /mobile/messages groups held replies with reason words and says which machines did not answer', async () => {
    const c = setup();
    const r = await signedGet(c, '/mobile/messages');
    expect(r.status).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.body).toMatchObject({ schemaVersion: 1, state: 'ok', tone: 'attn', recording: 'not fully set up', unread: { count: 1, names: ['Mac Mini'] }, offline: { count: 1, names: ['Laptop'] } });
    expect(r.body.headline).toBe('1 reply and 1 automatic message are held on this machine. Machines that did not answer or can\'t tell are not counted.');
    expect(r.body.groups.map((g: { title: string; reasonWords: string }) => [g.title, g.reasonWords]).sort()).toEqual([
      ['1 delayed message', 'held for another reason'],
      ['Instar app', 'waiting to be routed through the machine that holds the conversation'],
    ]);
    expect(r.body.machines).toEqual([{ name: 'This machine', count: 2, complete: true, state: 'ok' }]);
    const text = JSON.stringify(r.body);
    for (const leak of LEAKS) expect(text, leak).not.toContain(leak);
  });

  it('GET /mobile/insights trims pages and drops the deep link', async () => {
    const c = setup();
    const r = await signedGet(c, '/mobile/insights');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ state: 'ok', selfState: 'ok', truncated: false });
    expect(r.body.pages[0]).toMatchObject({ title: 'Schedule', sourceWords: 'AI summary, saved', machine: null, lines: [{ text: 'reflection ran late', severity: 'watch', action: 'Open Schedule' }] });
    const text = JSON.stringify(r.body);
    for (const leak of LEAKS) expect(text, leak).not.toContain(leak);
  });

  it('?scope=local answers this machine only and never reads peers', async () => {
    let peerReads = 0;
    const c = setup({ peerMessages: async () => { peerReads++; return []; }, peerInsights: async () => { peerReads++; return []; } });
    const m = await request(c.app).get('/mobile/messages?scope=local').set('Authorization', 'Bearer tok-1');
    const i = await request(c.app).get('/mobile/insights?scope=local').set('Authorization', 'Bearer tok-1');
    expect(m.status).toBe(200);
    expect(i.status).toBe(200);
    expect(peerReads).toBe(0);
    expect(m.body.machines).toBeUndefined();
    expect(m.body.heldCount).toBe(2);
    expect(i.body.offline).toEqual({ count: 0, names: [] });
  });

  it('the bearer token is served too', async () => {
    const c = setup();
    for (const p of ROUTES) expect((await request(c.app).get(p).set('Authorization', 'Bearer tok-1')).status, p).toBe(200);
  });

  it('a part that throws reads as unavailable while the rest still shows', async () => {
    const c = setup({ originStatus: async () => { throw new Error('boom /Users/x'); }, insights: async () => { throw new Error('boom'); }, peerInsights: async () => [{ machineId: 'm_peer', state: 'ok', data: { selfState: 'ok', pages: [{ title: 'Peer page', headline: 'All quiet.', sourceWords: 'Plain summary', lines: [], metrics: [] }] } }] });
    const m = await signedGet(c, '/mobile/messages');
    expect(m.status).toBe(200);
    expect(m.body).toMatchObject({ state: 'unavailable', headline: '1 reply is waiting to be passed to the machine that holds the conversation. Machines that did not answer or can\'t tell are not counted.' });
    const i = await signedGet(c, '/mobile/insights');
    expect(i.body).toMatchObject({ state: 'ok', selfState: 'unavailable' });
    expect(i.body.pages[0]).toMatchObject({ title: 'Peer page', machine: 'Mac Mini' });
    expect(JSON.stringify(m.body) + JSON.stringify(i.body)).not.toContain('boom');
  });

  it('a read that throws answers a fixed error code', async () => {
    const c = setup({ nicknameOf: () => { throw new Error('registry exploded /Users/x'); } });
    const r = await signedGet(c, '/mobile/messages');
    expect(r.status).toBe(500);
    expect(r.body).toEqual({ error: 'messages-unavailable' });
  });
});

describe('refused', () => {
  it('an MSP phone gets 403 owner-phone-required from the device layer on every route', async () => {
    let reads = 0;
    const c = setup({ originStatus: async () => { reads++; return { state: 'ok', data: statusData }; } });
    const msp = c.pair({ userId: 'justin', role: 'msp' });
    for (const p of ROUTES) {
      const r = await signedGet({ app: c.app, dev: msp.dev, id: msp.id }, p);
      expect(r.status, p).toBe(403);
      expect(r.body.error).toBe('owner-phone-required');
    }
    expect(reads).toBe(0);
  });

  it('a phone demoted from owner to MSP is refused on its next read', async () => {
    const c = setup();
    expect((await signedGet(c, '/mobile/messages')).status).toBe(200);
    c.svc.devices.setPerson(c.id, { userId: 'justin', role: 'msp' });
    const r = await signedGet(c, '/mobile/messages');
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('owner-phone-required');
  });

  it('a phone whose person was removed gets person-unknown before the route runs', async () => {
    const c = setup();
    const ghost = c.pair({ userId: 'nobody', role: 'msp' } as never);
    const r = await signedGet({ app: c.app, dev: ghost.dev, id: ghost.id }, '/mobile/insights');
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('person-unknown');
  });

  it('a revoked phone is refused', async () => {
    const c = setup();
    c.svc.devices.revoke(c.id);
    for (const p of ROUTES) expect((await signedGet(c, p)).status, p).toBe(401);
  });

  it('an unsigned device request, a tampered query and no credentials are refused', async () => {
    const c = setup();
    for (const p of ROUTES) {
      expect((await request(c.app).get(p).set('X-Instar-Device', c.id)).status, p).toBe(401);
      expect((await request(c.app).get(p)).status, p).toBe(401);
    }
    const time = String(Date.now());
    const sig = c.dev.sign(canonicalString(c.id, HOST, 'GET', '/mobile/messages', time, undefined));
    const tampered = await request(c.app).get('/mobile/messages?scope=local').set('X-Instar-Device', c.id).set('X-Instar-Device-Time', time).set('X-Instar-Device-Sig', sig);
    expect(tampered.status).toBe(401);
  });

  it('the notification read token does not open these routes', async () => {
    const c = setup();
    for (const p of ROUTES) {
      const r = await request(c.app).get(p).set('X-Instar-Device', c.id).set('X-Instar-Notify-Token', 'a'.repeat(64));
      expect(r.status).toBe(403);
      expect(r.body.error).toBe('notify-token-not-allowed');
    }
  });

  it('a POST is refused by the device check', async () => {
    const c = setup();
    const time = String(Date.now());
    const raw = Buffer.from('{}');
    const sig = c.dev.sign(canonicalString(c.id, HOST, 'POST', '/mobile/messages', time, raw));
    const post = await request(c.app).post('/mobile/messages').set('Content-Type', 'application/json')
      .set('X-Instar-Device', c.id).set('X-Instar-Device-Time', time).set('X-Instar-Device-Sig', sig).send('{}');
    expect(post.status).toBe(403);
    expect(post.body.error).toBe('device-not-allowed');
  });

  it('the shared bucket stops a phone after 20 reads a minute', async () => {
    const c = setup();
    let last = 0;
    for (let i = 0; i < 21; i++) last = (await signedGet(c, ROUTES[i % 2])).status;
    expect(last).toBe(429);
  });
});

describe('wiring: the real origin runtime through createRoutes', () => {
  let worker: URL;
  const runtimes: TelegramOriginRuntime[] = [];
  const privateKey = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  beforeAll(async () => { worker = await compileOriginWorker(); });
  afterEach(async () => { for (const r of runtimes.splice(0)) await r.close(); vi.unstubAllGlobals(); });

  it('deliverySummaryInputs is the status() subset the phone reads, and /mobile/messages serves it', async () => {
    const stateDir = temporaryState();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }))));
    const runtime = await TelegramOriginRuntime.open({ storage: { stateDir, agentId: 'echo' }, workerUrl: worker,
      identity: { agentId: 'echo', agentName: 'Echo', originMachineId: 'studio', originMachineName: 'Mac Studio' },
      signingKey: { privateKey, keyId: 'studio-1', keyEpoch: 1 }, bot: { token: `123:${randomUUID()}`, accountId: 'bot-1', chatId: '-100123' },
      isSessionLive: () => true, attachSessionLifecycle: () => undefined, display: () => ({}),
      authorize: () => true, diagnoseUnknown: async () => undefined, alertDestinations: () => [],
      getAlertPolicy: () => null, onNoticeState: () => undefined,
    } as never);
    runtimes.push(runtime);
    const full = await runtime.status() as Record<string, unknown>;
    const lite = await runtime.deliverySummaryInputs() as Record<string, unknown>;
    expect(Object.keys(lite).sort()).toEqual(['activation', 'expiredHolds', 'held', 'heldComplete', 'heldForward', 'metrics']);
    for (const k of ['held', 'heldForward', 'expiredHolds']) expect(lite[k], k).toEqual(full[k]);
    expect((lite.activation as { state: unknown }).state).toBe((full.activation as { state: unknown }).state);
    const app = express(); app.use(express.json());
    app.use((req, res, next) => { if (req.get('Authorization') !== 'Bearer agent-test') { res.sendStatus(401); return; } next(); });
    app.use(createRoutes({ config: { authToken: 'agent-test', stateDir, port: 0, projectName: 'echo', messaging: [] },
      telegramOrigin: runtime, verifyDashboardOperatorSession: (proof: string) => proof === 'operator-test', sessionManager: { clearInjectionTracker: () => undefined } } as never));
    const phone = await request(app).get('/mobile/messages').set('Authorization', 'Bearer agent-test');
    expect(phone.status).toBe(200);
    expect(phone.body.state).toBe('ok');
    const raw = await request(app).get('/telegram/origins/status').set('Authorization', 'Bearer agent-test').set('X-Instar-Operator-Session', 'operator-test');
    expect(raw.status).toBe(200);
    expect(phone.body.heldCount).toBe((raw.body.held as unknown[]).length);
    expect(phone.body).toEqual(expect.objectContaining({ recording: summarizeLocalMessages({ state: 'ok', data: raw.body }, { now: Date.now(), topicName: () => null, nicknameOf: () => null }).recording }));
    // The raw route keeps its operator-session gate for the bearer alone.
    expect((await request(app).get('/telegram/origins/status').set('Authorization', 'Bearer agent-test')).status).toBe(403);
  });
});
