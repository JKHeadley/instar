/**
 * Feature-is-alive proof for Android push (docs/specs/mobile-android-app.md §7 E2E): an AgentServer
 * booted on the production path. With no Firebase key, an Android phone's FCM registration is
 * accepted with `ready: false`, status says `fcmConfigured: false`, and nothing is sent. With a
 * Firebase key in the vault (a test key; Google replaced by a transport double), the register
 * answer is `ready: true` and an attention trigger reaches the double. The recheck route is mounted.
 * Wiring integrity: the push service is the real one AgentServer builds, reading the vault entry
 * `fcm_service_account_json` itself.
 */
import { describe, it, expect, afterAll } from 'vitest';
import crypto from 'node:crypto';
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
import { MobilePushService, type FcmTransport } from '../../src/core/MobilePush.js';
import { SecretStore } from '../../src/core/SecretStore.js';
import { makeDevice } from '../helpers/mobileDevice.js';

const HOST = 'echo-android-e2e.example.dev';
const servers: AgentServer[] = [];
const dirs: string[] = [];
const FCM_TOKEN = 'cE2e:APA91b' + 'Q'.repeat(150);
const { privateKey: rsa } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const SA = JSON.stringify({ type: 'service_account', project_id: 'instar-c1a64', client_email: 'instar-push@instar-c1a64.iam.gserviceaccount.com', private_key: rsa.export({ format: 'pem', type: 'pkcs8' }).toString() });

afterAll(async () => {
  for (const s of servers) await s.stop();
  for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/e2e/mobile-android-push-alive.test.ts' });
});

async function boot(withKey: boolean) {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'android-push-e2e-'));
  dirs.push(dir);
  const stateDir = path.join(dir, '.instar');
  for (const d of ['state/sessions', 'state/jobs', 'logs']) fs.mkdirSync(path.join(stateDir, d), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'config.json'), '{}');
  if (withKey) new SecretStore({ stateDir, forceFileKey: true }).set('fcm_service_account_json', SA);
  const config = {
    projectName: 'android-e2e', projectDir: dir, stateDir, port: 0, authToken: 'e2e-token', developmentAgent: true,
    secrets: { forceFileKey: true },
    mobilePairing: { multiRoute: { enabled: false } },
    tunnel: { enabled: true, type: 'named', token: 'x', hostname: HOST },
    sessions: { claudePath: '/usr/bin/echo', maxSessions: 1, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5_000 },
    scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 }, messaging: [], updates: {},
  } as unknown as InstarConfig;
  const sessionManager = createMockSessionManager() as any;
  sessionManager.on = () => undefined;
  const tunnel = { lifecycleState: { lastState: 'active', activeProvider: 'cloudflare-named' }, url: `https://${HOST}`, on: () => undefined } as any;
  const server = new AgentServer({ config, sessionManager, state: new StateManager(stateDir), initiativeTracker: new InitiativeTracker(stateDir), tunnel });
  servers.push(server);
  const app = server.getApp();
  const mp = server.mobilePairing!;
  // An active Android phone (pairing itself is proven in mobile-pairing-alive).
  const dev = makeDevice();
  const created = mp.devices.createPending({ deviceName: 'Pixel', label: null, publicKey: dev.publicKey, host: HOST });
  if (!created.ok) throw new Error('setup');
  mp.devices.applyConfirm(created.device.id, { ok: true });
  const deviceId = created.device.id;
  let n = 0;
  const send = (p: string, body: unknown) => {
    const raw = Buffer.from(JSON.stringify(body));
    const time = String(Date.now() + n++);
    const sig = dev.sign(canonicalString(deviceId, HOST, 'POST', p, time, raw));
    return request(app).post(p).set('Content-Type', 'application/json').set('X-Instar-Device', deviceId).set('X-Instar-Device-Time', time).set('X-Instar-Device-Sig', sig).send(raw.toString());
  };
  // Google is replaced by doubles; the key itself is read from the vault by the production wiring.
  const fcmSent: Array<{ projectId: string; body: any }> = [];
  const double: FcmTransport = async (projectId, _a, body) => { fcmSent.push({ projectId, body: JSON.parse(body) }); return { status: 200, tokenFieldViolation: false }; };
  const push = mp.push as unknown as { fcmTransport: FcmTransport; fcmOAuth: (a: string) => Promise<unknown> };
  push.fcmTransport = double;
  push.fcmOAuth = async () => ({ status: 200, accessToken: 'e2e-access' });
  return { server, app, mp, send, fcmSent };
}

const bearer = (app: ReturnType<AgentServer['getApp']>, method: 'get' | 'post', p: string) =>
  request(app)[method](p).set('Authorization', 'Bearer e2e-token').set('X-Instar-AgentId', 'android-e2e');
const hash = crypto.createHash('sha256').update('read').digest('hex');

describe('Android push — production wiring', () => {
  it('with no Firebase key: the FCM registration is accepted with ready false, status fcmConfigured false, nothing sent', async () => {
    const { app, mp, send, fcmSent } = await boot(false);
    expect(mp.push).toBeInstanceOf(MobilePushService);
    const r = await send('/mobile/device/push', { provider: 'fcm', token: FCM_TOKEN, notifyTokenHash: hash, revision: 1 });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, revision: 1, ready: false });
    const st = await bearer(app, 'get', '/mobile/push');
    expect(st.status).toBe(200);
    expect(st.body).toMatchObject({ enabled: true, fcmConfigured: false, pausedReasons: { apns: null, fcm: null } });
    expect(st.body.devices[0]).toMatchObject({ provider: 'fcm', environment: null });
    await mp.push!.receive({ kind: 'item', itemId: 'ATT-1', dedupeKey: 'e2e-1', sourceMachine: 'local' }, false);
    expect(fcmSent).toHaveLength(0);
    // The recheck route is mounted behind the bearer gate.
    const rc = await bearer(app, 'post', '/mobile/push/recheck').send({ provider: 'fcm' });
    expect(rc.status).toBe(200);
    expect(rc.body.machines[0]).toMatchObject({ armed: false, reason: 'no-key' });
  });

  it('with a Firebase key in the vault: ready true and an attention trigger reaches the transport', async () => {
    const { app, mp, send, fcmSent } = await boot(true);
    const r = await send('/mobile/device/push', { provider: 'fcm', token: FCM_TOKEN, notifyTokenHash: hash, revision: 1 });
    expect(r.body).toEqual({ ok: true, revision: 1, ready: true });
    expect((await bearer(app, 'get', '/mobile/push')).body.fcmConfigured).toBe(true);
    const n = await bearer(app, 'post', '/mobile/push/notify').send({ kind: 'item', itemId: 'ATT-7', dedupeKey: 'e2e-7', sourceMachine: 'peer-m' });
    expect(n.status).toBe(202);
    for (let i = 0; i < 50 && fcmSent.length === 0; i++) await new Promise((res) => setTimeout(res, 20));
    expect(fcmSent).toHaveLength(1);
    expect(fcmSent[0]!.projectId).toBe('instar-c1a64');
    expect(fcmSent[0]!.body.message.token).toBe(FCM_TOKEN);
    expect(JSON.parse(fcmSent[0]!.body.message.data.instar)).toMatchObject({ kind: 'item', itemId: 'ATT-7', machine: 'peer-m' });
    expect(mp.push!.status()).toMatchObject({ devices: [{ lastSend: { outcome: 'sent' } }] });
  });
});
