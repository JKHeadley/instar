/**
 * The quick actions on a health problem (docs/specs/health-quick-actions.md) through the production authMiddleware
 * and deviceAuthenticator: an owner phone and the bearer can choose, undo and read the Hidden list; an MSP phone,
 * an unsigned request and a tampered body can't; a phone can't reach the routes machines use with each other.
 */
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { authMiddleware } from '../../src/server/middleware.js';
import { MobilePairingService, deviceAuthenticator, type MobilePairingDeps } from '../../src/server/mobilePairingRoutes.js';
import { mountMobileHealthRoutes, type HealthChoicePeers } from '../../src/server/mobileHealthRoutes.js';
import { HealthChoiceStore } from '../../src/monitoring/healthChoices.js';
import { canonicalString } from '../../src/core/MobileDeviceKeys.js';
import { makeDevice } from '../helpers/mobileDevice.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const HOST = 'echo.example.dev';
const CHOICES = '/mobile/health-issues/choices';
const dirs: string[] = [];
const services: MobilePairingService[] = [];
afterAll(() => {
  for (const s of services) s.stop();
  for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/integration/health-quick-actions.test.ts' });
});

function setup(events: Array<Record<string, unknown>>, peers?: HealthChoicePeers, body: Record<string, unknown> = { status: 'degraded', uptimeHuman: '2h' }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hchoice-int-'));
  dirs.push(dir);
  fs.writeFileSync(path.join(dir, 'users.json'), JSON.stringify([{ id: 'justin', name: 'Justin', channels: [], permissions: ['user'] }]));
  const config = { projectName: 'echo', stateDir: dir, authToken: 'tok-1', developmentAgent: true, mobilePairing: { multiRoute: { enabled: false } } } as unknown as MobilePairingDeps['config'];
  const svc = new MobilePairingService({ config, stateDir: dir, holdsLease: () => true, selfMachineId: 'm_self' });
  services.push(svc);
  const app = express();
  app.use(express.json({ verify: (req, _res, buf) => { (req as unknown as { rawBody: Buffer }).rawBody = buf; } }));
  app.use(authMiddleware(() => 'tok-1', 'echo', undefined, deviceAuthenticator(svc)));
  const router = express.Router();
  const choices = new HealthChoiceStore({ stateDir: dir, origin: 'm_self' });
  mountMobileHealthRoutes(router, { readHealth: async () => ({ status: 200, body }), recentEvents: () => events, bearerOk: (req) => req.headers.authorization === 'Bearer tok-1', choices, peers });
  app.use(router);
  const pair = (person?: { userId: string; role: 'msp' }) => {
    const dev = makeDevice();
    const created = svc.devices.createPending({ deviceName: 'iPhone', label: null, publicKey: dev.publicKey, host: HOST, ...(person ?? {}) });
    if (!created.ok) throw new Error('setup');
    svc.devices.applyConfirm(created.device.id, { ok: true });
    return { dev, id: created.device.id };
  };
  return { app, pair, choices };
}

let tick = 0;
function signed(app: express.Express, d: { dev: ReturnType<typeof makeDevice>; id: string }, p: string, body?: unknown, tamper = false) {
  const time = String(Date.now() + (tick++ % 1000));
  const raw = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  const sig = d.dev.sign(canonicalString(d.id, HOST, body === undefined ? 'GET' : 'POST', p, time, raw));
  const q = body === undefined ? request(app).get(p) : request(app).post(p).set('Content-Type', 'application/json');
  q.set('X-Instar-Device', d.id).set('X-Instar-Device-Time', time).set('X-Instar-Device-Sig', sig);
  return raw ? q.send(tamper ? JSON.stringify({ ...(body as object), choice: 'ignore' }) : raw.toString()) : q;
}
const bearer = (app: express.Express, p: string, body?: unknown) => {
  const q = body === undefined ? request(app).get(p) : request(app).post(p).send(body as object);
  return q.set('Authorization', 'Bearer tok-1').set('X-Instar-AgentId', 'echo');
};
const slack = { feature: 'Slack', timestamp: '2026-11-05T10:00:00.000Z', narrative: 'Slack is off.' };

describe('choosing', () => {
  it('an owner phone hides a problem: it leaves the list and the count, and the Hidden list has it', async () => {
    const { app, pair } = setup([slack]);
    const phone = pair();
    const r = await signed(app, phone, CHOICES, { id: 'Slack', keys: ['Slack'], choice: 'snooze', hours: 24 });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, note: null, verdict: 'running', counts: { userAffecting: 0 } });
    expect(r.body.issues).toEqual([]);
    expect(r.body.hidden[0]).toMatchObject({ key: 'Slack', mode: 'snooze', by: 'phone', happening: true });
    const read = await signed(app, phone, '/mobile/health-issues');
    expect(read.body.hidden[0].key).toBe('Slack');
  });
  it('the bearer can choose too, and the row says it wasn’t the phone', async () => {
    const { app } = setup([slack]);
    const r = await bearer(app, CHOICES, { id: 'Slack', keys: ['Slack'], choice: 'hide' });
    expect(r.status).toBe(200);
    expect(r.body.hidden[0].by).toBe('dashboard-or-agent');
  });
  it('binds to what is showing: a problem that has stopped has nothing to hide', async () => {
    const { app, choices } = setup([slack]);
    const r = await bearer(app, CHOICES, { id: 'NotHappening', keys: ['NotHappening'], choice: 'ignore' });
    expect(r.status).toBe(404);
    expect(r.body.error).toBe('issue-gone');
    expect(choices.rows()).toEqual([]);
  });
  it('binds to what was on screen: a family member that arrived since stays showing', async () => {
    const ts = slack.timestamp;
    const { app, choices } = setup([{ feature: 'unjustifiedStopGate.db', timestamp: ts }, { feature: 'unjustifiedStopGate.route', timestamp: ts }]);
    const r = await bearer(app, CHOICES, { id: 'unjustifiedStopGate.*', keys: ['unjustifiedStopGate.db'], choice: 'hide' });
    expect(r.status).toBe(200);
    expect(choices.hidesNow('unjustifiedStopGate.db')).toBe(true);
    expect(choices.hidesNow('unjustifiedStopGate.route')).toBe(false);
    expect(r.body.issues[0].keys).toEqual(['unjustifiedStopGate.route']);
    expect((await bearer(app, CHOICES, { id: 'unjustifiedStopGate.*', keys: ['SomethingElse'], choice: 'hide' })).status).toBe(404);
  });
  it('refuses what isn’t offered, on the server and not only on the screen', async () => {
    const { app, choices } = setup([{ feature: 'SecretStore.dualKeyRead', timestamp: slack.timestamp }]);
    for (const choice of ['hide', 'ignore']) expect((await bearer(app, CHOICES, { id: 'SecretStore.dualKeyRead', keys: ['SecretStore.dualKeyRead'], choice })).status).toBe(409);
    expect(choices.rows()).toEqual([]);
    expect((await bearer(app, CHOICES, { id: 'SecretStore.dualKeyRead', keys: ['SecretStore.dualKeyRead'], choice: 'snooze', hours: 1 })).status).toBe(200);
  });
  it('a live reading can’t be ignored, and an unnamed problem can’t be hidden at all', async () => {
    const full = setup([], undefined, { status: 'degraded', sessions: { current: 2, max: 2 } });
    expect((await bearer(full.app, CHOICES, { id: 'health:sessions-full', keys: ['health:sessions-full'], choice: 'ignore' })).status).toBe(409);
    expect((await bearer(full.app, CHOICES, { id: 'health:sessions-full', keys: ['health:sessions-full'], choice: 'hide' })).status).toBe(200);
    const unnamed = setup([]);
    expect((await bearer(unnamed.app, CHOICES, { id: 'health:unnamed', keys: ['health:unnamed'], choice: 'snooze', hours: 1 })).status).toBe(409);
  });
  it('takes only the three durations', async () => {
    const { app } = setup([slack]);
    for (const body of [{ choice: 'snooze' }, { choice: 'snooze', hours: 2 }, { choice: 'snooze', hours: '24' }, { choice: 'hide', hours: 1 }, { choice: 'forget' }, {}]) {
      expect((await bearer(app, CHOICES, { id: 'Slack', keys: ['Slack'], ...body })).status, JSON.stringify(body)).toBe(400);
    }
    expect((await bearer(app, CHOICES, { keys: ['Slack'], choice: 'hide' })).status).toBe(400);
    expect((await bearer(app, CHOICES, { id: 'Slack', choice: 'hide' })).status).toBe(400);
    expect((await bearer(app, CHOICES, { id: 'Slack', keys: [], choice: 'hide' })).status).toBe(400);
  });
  it('only the owner: MSP phone, unsigned and tampered requests are refused', async () => {
    const { app, pair, choices } = setup([slack]);
    expect((await signed(app, pair({ userId: 'someone', role: 'msp' }), CHOICES, { id: 'Slack', keys: ['Slack'], choice: 'hide' })).status).toBe(403);
    expect((await request(app).post(CHOICES).send({ id: 'Slack', keys: ['Slack'], choice: 'hide' })).status).toBe(401);
    expect((await signed(app, pair(), CHOICES, { id: 'Slack', keys: ['Slack'], choice: 'hide' }, true)).status).toBe(401);
    expect(choices.rows()).toEqual([]);
  });
});

describe('undo', () => {
  it('brings it back from the phone, at once', async () => {
    const { app, pair } = setup([slack]);
    const phone = pair();
    await signed(app, phone, CHOICES, { id: 'Slack', keys: ['Slack'], choice: 'ignore' });
    const r = await signed(app, phone, `${CHOICES}/undo`, { key: 'Slack' });
    expect(r.status).toBe(200);
    expect(r.body.issues[0].id).toBe('Slack');
    expect(r.body.hidden).toEqual([]);
  });
  it('says so when it isn’t hidden', async () => {
    const { app } = setup([slack]);
    expect((await bearer(app, `${CHOICES}/undo`, { key: 'Slack' })).status).toBe(404);
    expect((await bearer(app, `${CHOICES}/undo`, {})).status).toBe(400);
  });
});

describe('other machines', () => {
  it('a choice is pushed to them, and one that didn’t answer is named plainly', async () => {
    const pushed: unknown[] = [];
    const peers: HealthChoicePeers = { list: () => ['m2', 'm3'], pull: async () => [], push: async (rows) => { pushed.push(...rows); return { reached: 1, unreached: 1 }; } };
    const { app } = setup([slack], peers);
    const r = await bearer(app, CHOICES, { id: 'Slack', keys: ['Slack'], choice: 'hide' });
    expect(pushed).toHaveLength(1);
    expect(r.body.note).toMatch(/One of this agent’s other machines didn’t answer/);
  });
  it('a push that fails outright never fails the choice', async () => {
    const peers: HealthChoicePeers = { list: () => ['m2'], pull: async () => [], push: async () => { throw new Error('down'); } };
    const { app, choices } = setup([slack], peers);
    const r = await bearer(app, CHOICES, { id: 'Slack', keys: ['Slack'], choice: 'hide' });
    expect(r.status).toBe(200);
    expect(r.body.note).toMatch(/didn’t answer/);
    expect(choices.hidesNow('Slack')).toBe(true);
  });
  it('a machine reads and merges with the bearer; a phone can reach neither route', async () => {
    const { app, pair, choices } = setup([slack]);
    const at = new Date().toISOString();
    const row = { key: 'Slack', mode: 'hide', until: null, at, title: 'Slack', by: 'phone', origin: 'm2', removed: false };
    expect((await bearer(app, `${CHOICES}/merge`, { rows: [row] })).body).toMatchObject({ ok: true, changed: 1 });
    expect(choices.hidesNow('Slack')).toBe(true);
    // A peer's word on who chose can't be checked, so a row from one never claims to be from the phone.
    expect((await bearer(app, '/mobile/health-issues')).body.hidden[0].by).toBe('another-machine');
    expect((await bearer(app, `${CHOICES}?scope=local`)).body.rows[0].key).toBe('Slack');
    const phone = pair();
    expect((await signed(app, phone, `${CHOICES}/merge`, { rows: [] })).status).toBe(403);
    expect((await signed(app, phone, CHOICES)).status).toBe(403);
  });
});
