/**
 * HTTP pipeline for the phone's native schedule, promises and machines reads
 * (docs/specs/mobile-native-ops-screens.md) through the production authMiddleware +
 * deviceAuthenticator: an owner phone and the bearer token are served; an MSP phone, a revoked
 * phone, an unsigned or tampered request, the notification read token and a POST are refused.
 * The answers carry no prompt, script, path, hostname or token.
 */
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { authMiddleware } from '../../src/server/middleware.js';
import { MobilePairingService, deviceAuthenticator, DEVICE_ALLOWLIST, type MobilePairingDeps } from '../../src/server/mobilePairingRoutes.js';
import { mountMobileOpsRoutes } from '../../src/server/mobileOpsRoutes.js';
import { canonicalString } from '../../src/core/MobileDeviceKeys.js';
import { makeDevice } from '../helpers/mobileDevice.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const HOST = 'echo.example.dev';
const NOW = Date.parse('2026-11-03T22:00:00.000Z');
const dirs: string[] = [];
const services: MobilePairingService[] = [];
afterAll(() => {
  for (const s of services) s.stop();
  for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/integration/mobile-native-ops-screens.test.ts' });
});

const SECRET_PROMPT = 'SECRET-PROMPT-do-not-leak';
const jobsPayload = {
  jobs: [
    { slug: 'health-check', name: 'Health check', description: 'Checks things', schedule: '*/5 * * * *', enabled: true, priority: 'high', runsOnThisMachine: true,
      execute: { type: 'prompt', value: SECRET_PROMPT }, resolvedPath: '/Users/x/.instar/jobs/health-check.md', bodyHash: 'abc',
      state: { lastRun: '2026-11-03T21:55:00.000Z', lastResult: 'success', nextScheduled: '2026-11-03T22:05:00.000Z', consecutiveFailures: 0 },
      machineId: 'm_self', machineNickname: 'Studio' },
    { slug: 'git-sync', name: 'Git sync', description: 'token=abcdefghijklmnopqrstuvwxyz', schedule: '0 * * * *', enabled: true, runsOnThisMachine: true,
      execute: { type: 'script', value: '/bin/secret.sh' },
      state: { lastRun: '2026-11-03T21:00:00.000Z', lastResult: 'failure', nextScheduled: '2026-11-03T23:00:00.000Z', consecutiveFailures: 2 },
      machineId: 'm_self', machineNickname: 'Studio' },
  ],
  pool: { failed: [{ machineId: 'm_peer', error: 'HTTP 500 at /Users/x' }] },
};
const commitments = [
  { id: 'CMT-1', userRequest: 'send the summary', agentResponse: 'I will send the summary tonight', status: 'pending', createdAt: '2026-11-03T20:00:00.000Z', hardDeadlineAt: '2026-11-03T23:00:00.000Z', verificationCount: 0, violationCount: 0, configPath: '/secret/path', behavioralRule: 'internal rule' },
  { id: 'CMT-2', userRequest: 'old', agentResponse: 'done long ago', status: 'delivered', createdAt: '2026-10-01T00:00:00.000Z', resolvedAt: '2026-10-02T00:00:00.000Z' },
];
const poolPayload = {
  enabled: true, selfMachineId: 'm_self', router: { holder: 'm_self' },
  machines: [
    { machineId: 'm_self', nickname: 'Studio', online: true, liveness: { state: 'live', source: 'self' }, livenessLine: 'live (this machine)', loadVerdict: 'ok', loadAvg: 2, activeSessionCount: 3, maxSessions: 10, hardware: { cpuCores: 8, instarVersion: '1.3.1647', hostname: 'studio.local', cpuModel: 'Apple M2' } },
    { machineId: 'm_peer', nickname: 'Mac Mini', online: false, liveness: { state: 'unreachable', shape: 'silent' }, livenessLine: 'unreachable (silent), last evidence 20 min ago from heartbeat', hardware: { cpuCores: 4, hostname: 'mini.local' } },
  ],
  sshEnrollment: { secret: 'x' },
};

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mops-int-'));
  dirs.push(dir);
  fs.writeFileSync(path.join(dir, 'users.json'), JSON.stringify([{ id: 'justin', name: 'Justin', channels: [], permissions: ['user'] }]));
  const config = { projectName: 'echo', stateDir: dir, authToken: 'tok-1', developmentAgent: true, mobilePairing: { multiRoute: { enabled: false } } } as never;
  const deps: MobilePairingDeps = { config, stateDir: dir, holdsLease: () => true, selfMachineId: 'm_self' };
  const svc = new MobilePairingService(deps);
  services.push(svc);
  const app = express();
  app.use(express.json({ verify: (req, _res, buf) => { (req as unknown as { rawBody: Buffer }).rawBody = buf; } }));
  app.use(authMiddleware(() => 'tok-1', 'echo', undefined, deviceAuthenticator(svc)));
  const router = express.Router();
  mountMobileOpsRoutes(router, {
    jobsView: async () => jobsPayload,
    schedulerRunning: () => true,
    commitmentsView: async () => commitments,
    poolView: () => poolPayload,
    nicknameOf: (id) => (id === 'm_self' ? 'Studio' : id === 'm_peer' ? 'Mac Mini' : null),
    selfVersion: () => '1.3.1647',
    bearerOk: (req) => req.headers.authorization === 'Bearer tok-1',
    now: () => NOW,
  });
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

const ROUTES = ['/mobile/jobs', '/mobile/commitments', '/mobile/machines'];

describe('owner phone: served, trimmed', () => {
  it('GET /mobile/jobs lists failing first, with no prompt, script or path', async () => {
    const c = setup();
    const r = await signedGet(c, '/mobile/jobs');
    expect(r.status).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.body.schemaVersion).toBe(1);
    expect(r.body.jobs.map((j: { slug: string }) => j.slug)).toEqual(['git-sync', 'health-check']);
    expect(r.body.jobs[0]).toMatchObject({ status: 'failing', needsLook: true, consecutiveFailures: 2, machines: ['Studio'] });
    expect(r.body.jobs[1]).toMatchObject({ status: 'ok', scheduleWords: 'Every 5 minutes', nextRunAt: '2026-11-03T22:05:00.000Z' });
    expect(r.body.unread).toEqual({ count: 1, names: ['Mac Mini'] });
    const text = JSON.stringify(r.body);
    for (const leak of [SECRET_PROMPT, '/bin/secret.sh', '/Users/x', 'abcdefghijklmnopqrstuvwxyz', 'execute', 'resolvedPath', 'bodyHash', 'HTTP 500']) expect(text).not.toContain(leak);
  });

  it('GET /mobile/commitments lists open promises with due dates; old closed ones and internal fields are left out', async () => {
    const c = setup();
    const r = await signedGet(c, '/mobile/commitments');
    expect(r.status).toBe(200);
    expect(r.body.enabled).toBe(true);
    expect(r.body.commitments).toHaveLength(1);
    expect(r.body.commitments[0]).toMatchObject({ id: 'CMT-1', text: 'I will send the summary tonight', open: true, dueAt: '2026-11-03T23:00:00.000Z', overdue: false });
    const text = JSON.stringify(r.body);
    expect(text).not.toContain('/secret/path');
    expect(text).not.toContain('internal rule');
  });

  it('GET /mobile/machines names each machine with a status line, unreachable first, no hostname', async () => {
    const c = setup();
    const r = await signedGet(c, '/mobile/machines');
    expect(r.status).toBe(200);
    expect(r.body.headline).toBe("Mac Mini isn't answering.");
    expect(r.body.machines.map((m: { name: string }) => m.name)).toEqual(['Mac Mini', 'Studio']);
    expect(r.body.machines[1]).toMatchObject({ isSelf: true, leading: true, state: 'live', loadPerCore: 0.25, sessions: 3, version: '1.3.1647' });
    const text = JSON.stringify(r.body);
    for (const leak of ['studio.local', 'mini.local', 'sshEnrollment', 'Apple M2', 'm_peer', 'm_self']) expect(text).not.toContain(leak);
  });

  it('the bearer token is served too', async () => {
    const c = setup();
    for (const p of ROUTES) expect((await request(c.app).get(p).set('Authorization', 'Bearer tok-1')).status).toBe(200);
  });
});

describe('refused', () => {
  it('an MSP phone gets 403 owner-phone-required on every route', async () => {
    const c = setup();
    const msp = c.pair({ userId: 'justin', role: 'msp' });
    for (const p of ROUTES) {
      const r = await signedGet({ app: c.app, dev: msp.dev, id: msp.id }, p);
      expect(r.status, p).toBe(403);
      expect(r.body.error).toBe('owner-phone-required');
      expect(r.body.jobs ?? r.body.commitments ?? r.body.machines).toBeUndefined();
    }
  });

  it('a phone demoted from owner to MSP is refused on its next read', async () => {
    const c = setup();
    expect((await signedGet(c, '/mobile/jobs')).status).toBe(200);
    c.svc.devices.setPerson(c.id, { userId: 'justin', role: 'msp' });
    const r = await signedGet(c, '/mobile/jobs');
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('owner-phone-required');
  });

  it('a phone whose person was removed gets person-unknown before the route runs', async () => {
    const c = setup();
    const ghost = c.pair({ userId: 'nobody', role: 'msp' } as never);
    const r = await signedGet({ app: c.app, dev: ghost.dev, id: ghost.id }, '/mobile/jobs');
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('person-unknown');
  });

  it('a revoked phone is refused', async () => {
    const c = setup();
    c.svc.devices.revoke(c.id);
    for (const p of ROUTES) expect((await signedGet(c, p)).status, p).toBe(401);
  });

  it('an unsigned device request, a tampered path and no credentials are refused', async () => {
    const c = setup();
    for (const p of ROUTES) {
      expect((await request(c.app).get(p).set('X-Instar-Device', c.id)).status, p).toBe(401);
      expect((await request(c.app).get(p)).status, p).toBe(401);
    }
    const time = String(Date.now());
    const sig = c.dev.sign(canonicalString(c.id, HOST, 'GET', '/mobile/jobs', time, undefined));
    const tampered = await request(c.app).get('/mobile/machines').set('X-Instar-Device', c.id).set('X-Instar-Device-Time', time).set('X-Instar-Device-Sig', sig);
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

  it('allowlist: GET only, active devices, no body; a POST is refused before any route runs', async () => {
    for (const p of ROUTES) {
      const rule = DEVICE_ALLOWLIST.find((x) => x.method === 'GET' && x.re.test(p));
      expect(rule, p).toBeDefined();
      expect([...rule!.statuses]).toEqual(['active']);
      expect(rule!.body).toBe('none');
      expect(rule!.conversationRef).toBeUndefined();
      expect(rule!.ownerOnly).toBe(true);
      expect(DEVICE_ALLOWLIST.some((x) => x.method !== 'GET' && x.re.test(p))).toBe(false);
    }
    // The raw Bearer routes stay off the allowlist.
    for (const p of ['/jobs', '/commitments', '/pool', '/machines']) expect(DEVICE_ALLOWLIST.some((x) => x.re.test(p)), p).toBe(false);
    const c = setup();
    const time = String(Date.now());
    const raw = Buffer.from('{}');
    const sig = c.dev.sign(canonicalString(c.id, HOST, 'POST', '/mobile/jobs', time, raw));
    const post = await request(c.app).post('/mobile/jobs').set('Content-Type', 'application/json')
      .set('X-Instar-Device', c.id).set('X-Instar-Device-Time', time).set('X-Instar-Device-Sig', sig).send('{}');
    expect(post.status).toBe(403);
    expect(post.body.error).toBe('device-not-allowed');
  });
});
