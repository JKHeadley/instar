/**
 * HTTP pipeline for the native session screen (docs/specs/mobile-native-session-screen.md):
 * GET /sessions/:name/output and POST /sessions/:name/input through the production authMiddleware +
 * deviceAuthenticator + the device router, in front of a stub "main" router standing in for the
 * Bearer handlers in routes.ts. Both sides of the allowlist: an owner phone is allowed; an MSP,
 * unassigned, pending, revoked (registry and ledger-less), notify-token, unsigned and Bearer-less
 * request is refused; a Bearer request passes through untouched.
 */
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { authMiddleware } from '../../src/server/middleware.js';
import { MobilePairingService, deviceAuthenticator, type MobilePairingDeps } from '../../src/server/mobilePairingRoutes.js';
import {
  createMobileSessionTerminalRouter, NOT_RUNNING_REASON, LOCATION_UNKNOWN_REASON, BAD_TEXT_REASON, type PeerLookup, type SessionRecordLike,
} from '../../src/server/mobileSessionTerminalRoutes.js';
import { canonicalString } from '../../src/core/MobileDeviceKeys.js';
import { makeDevice } from '../helpers/mobileDevice.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const HOST = 'echo.example.dev';
const TOKEN = 'tok-integration-0123456789';
const PIN = '482913';
const dirs: string[] = [];
const services: MobilePairingService[] = [];
afterAll(() => {
  for (const s of services) s.stop();
  for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/integration/mobile-session-terminal.test.ts' });
});

interface Opts { peers?: (name: string) => Promise<PeerLookup[]>; selfMachineId?: string | null; dir?: string }

function setup(opts: Opts = {}) {
  const dir = opts.dir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'mst-int-'));
  if (!opts.dir) dirs.push(dir);
  fs.writeFileSync(path.join(dir, 'users.json'), JSON.stringify([{ id: 'justin', name: 'Justin', channels: [], permissions: ['user'] }]));
  const config = { projectName: 'echo', stateDir: dir, authToken: TOKEN, developmentAgent: true, mobilePairing: { multiRoute: { enabled: false } } } as never;
  const deps: MobilePairingDeps = { config, stateDir: dir, holdsLease: () => true, selfMachineId: 'm_self' };
  const svc = new MobilePairingService(deps);
  services.push(svc);
  const records: SessionRecordLike[] = [
    { id: 'sid-1', name: 'Topic seven', tmuxSession: 'echo-topic-7', status: 'running', startedAt: '2026-11-03T18:00:00.000Z' },
    { id: 'sid-2', name: 'done', tmuxSession: 'echo-done', status: 'completed' },
  ];
  const typed: Array<{ tmux: string; text: string }> = [];
  const peerCalls: string[] = [];
  let sendOk = true;
  const app = express();
  app.use(express.json({ verify: (req, _res, buf) => { (req as unknown as { rawBody: Buffer }).rawBody = buf; } }));
  app.use(authMiddleware(() => TOKEN, 'echo', undefined, deviceAuthenticator(svc)));
  app.use(createMobileSessionTerminalRouter({
    pairing: svc,
    listSessions: () => records,
    captureOutputAsync: async (tmux) => (tmux === 'echo-topic-7' ? `\x1b[32mhello\x1b[0m\ncurl -H "Authorization: Bearer ${TOKEN}" /view/1?sig=${'ab'.repeat(16)}\nPIN ${PIN}` : null),
    sendInput: (tmux, text) => { typed.push({ tmux, text }); return sendOk; },
    lookupPeers: async (name) => { peerCalls.push(name); return opts.peers ? opts.peers(name) : []; },
    nicknameOf: (id) => (id === 'm_peer' ? 'Mac Mini' : id === 'm_self' ? 'Studio' : null),
    selfNickname: () => 'Studio',
    selfMachineId: () => (opts.selfMachineId === undefined ? 'm_self' : opts.selfMachineId),
    secrets: () => [TOKEN, PIN],
    stateDir: dir,
  }));
  // Stand-in for the Bearer handlers in routes.ts: proves non-device requests pass through.
  app.get('/sessions/:name/output', (_req, res) => { res.json({ bearerHandler: true }); });
  app.post('/sessions/:name/input', (_req, res) => { res.json({ bearerHandler: true }); });
  const pair = (person?: { userId: string; role: 'msp' }) => {
    const dev = makeDevice();
    const created = svc.devices.createPending({ deviceName: 'iPhone', label: null, publicKey: dev.publicKey, host: HOST, ...(person ?? {}) });
    if (!created.ok) throw new Error('setup');
    svc.devices.applyConfirm(created.device.id, { ok: true });
    return { dev, id: created.device.id };
  };
  const owner = pair();
  return { app, svc, owner, pair, records, typed, peerCalls, dir, setSendOk: (v: boolean) => { sendOk = v; } };
}

let tick = 0;
type Phone = { dev: ReturnType<typeof makeDevice>; id: string };
function signed(app: express.Express, phone: Phone, method: 'GET' | 'POST', p: string, body?: unknown, time?: string) {
  const raw = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  const t = time ?? String(Date.now() + (tick++ % 1000));
  const sig = phone.dev.sign(canonicalString(phone.id, HOST, method, p, t, raw));
  const q = method === 'GET' ? request(app).get(p) : request(app).post(p).set('Content-Type', 'application/json');
  q.set('X-Instar-Device', phone.id).set('X-Instar-Device-Time', t).set('X-Instar-Device-Sig', sig);
  return raw ? q.send(raw.toString()) : q;
}

describe('device session output', () => {
  it('an owner phone reads a local session: plain answer, no-store, credentials redacted', async () => {
    const c = setup();
    const r = await signed(c.app, c.owner, 'GET', '/sessions/echo-topic-7/output?lines=50');
    expect(r.status).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.body).toMatchObject({ session: 'Topic seven', sessionId: 'sid-1', tmuxSession: 'echo-topic-7', startedAt: '2026-11-03T18:00:00.000Z', machineNickname: 'Studio' });
    expect(r.body.output).toContain('hello');
    expect(r.body.output).not.toContain(TOKEN);
    expect(r.body.output).not.toContain(PIN);
    expect(r.body.output).toContain('sig=removed');
    expect(r.body.bearerHandler).toBeUndefined();
  });

  it('resolves by id and name too; finished sessions are not reachable', async () => {
    const c = setup();
    expect((await signed(c.app, c.owner, 'GET', '/sessions/sid-1/output')).status).toBe(200);
    const done = await signed(c.app, c.owner, 'GET', '/sessions/echo-done/output');
    expect(done.status).toBe(404);
    expect(done.body).toEqual({ error: 'session-not-running', reason: NOT_RUNNING_REASON });
  });

  it('a Bearer request passes straight through to the existing handler', async () => {
    const c = setup();
    const r = await request(c.app).get('/sessions/echo-topic-7/output').set('Authorization', `Bearer ${TOKEN}`);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ bearerHandler: true });
    const i = await request(c.app).post('/sessions/echo-topic-7/input').set('Authorization', `Bearer ${TOKEN}`).send({ text: 'x' });
    expect(i.body).toEqual({ bearerHandler: true });
    expect(c.typed).toHaveLength(0);
  });

  it('refuses a request with no credentials at all, and an unsigned device request', async () => {
    const c = setup();
    expect((await request(c.app).get('/sessions/echo-topic-7/output')).status).toBe(401);
    expect((await request(c.app).post('/sessions/echo-topic-7/input').send({ text: 'x' })).status).toBe(401);
    expect((await request(c.app).get('/sessions/echo-topic-7/output').set('X-Instar-Device', c.owner.id)).status).toBe(401);
    expect((await request(c.app).post('/sessions/echo-topic-7/input').set('X-Instar-Device', c.owner.id).send({ text: 'x' })).status).toBe(401);
    expect(c.typed).toHaveLength(0);
  });

  it('refuses an MSP phone, an unassigned phone, a pending phone, a revoked phone and the notification token', async () => {
    const c = setup();
    const msp = c.pair({ userId: 'justin', role: 'msp' });
    const r = await signed(c.app, msp, 'GET', '/sessions/echo-topic-7/output');
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('owner-phone-required');
    expect((await signed(c.app, msp, 'POST', '/sessions/echo-topic-7/input', { text: 'hi' })).status).toBe(403);
    // An MSP phone whose person was removed from the registry.
    const gone = c.pair({ userId: 'nobody', role: 'msp' });
    const g = await signed(c.app, gone, 'GET', '/sessions/echo-topic-7/output');
    expect(g.status).toBe(403);
    expect(g.body.error).toBe('person-unknown');
    // A phone that never confirmed its code.
    const dev = makeDevice();
    const pending = c.svc.devices.createPending({ deviceName: 'iPhone', label: null, publicKey: dev.publicKey, host: HOST });
    if (!pending.ok) throw new Error('setup');
    expect((await signed(c.app, { dev, id: pending.device.id }, 'GET', '/sessions/echo-topic-7/output')).status).toBe(401);
    // Revoked.
    const other = c.pair();
    c.svc.devices.revoke(other.id);
    expect((await signed(c.app, other, 'GET', '/sessions/echo-topic-7/output')).status).toBe(401);
    expect((await signed(c.app, other, 'POST', '/sessions/echo-topic-7/input', { text: 'hi' })).status).toBe(401);
    // The notification read token opens neither route.
    const n = await request(c.app).get('/sessions/echo-topic-7/output').set('X-Instar-Device', c.owner.id).set('X-Instar-Notify-Token', 'a'.repeat(64));
    expect(n.status).toBe(403);
    expect(c.typed).toHaveLength(0);
  });

  it('a phone record with no role (paired before people and roles) is the owner', async () => {
    const c = setup();
    const rec = c.svc.devices.get(c.owner.id)!;
    expect(rec.role).toBeUndefined();
    expect((await signed(c.app, c.owner, 'GET', '/sessions/echo-topic-7/output')).status).toBe(200);
  });

  it('other device session routes stay refused', async () => {
    const c = setup();
    const r = await signed(c.app, c.owner, 'POST', '/sessions/echo-topic-7/attachments', { dataBase64: 'aGk=' });
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('device-not-allowed');
  });
});

describe('session binding and location', () => {
  it('sid of a replaced session → 409; machine of another machine → named without touching a local session', async () => {
    const c = setup();
    const replaced = await signed(c.app, c.owner, 'GET', '/sessions/echo-topic-7/output?sid=sid-old');
    expect(replaced.status).toBe(409);
    expect(replaced.body.error).toBe('session-replaced');
    const remote = await signed(c.app, c.owner, 'POST', '/sessions/echo-topic-7/input?machine=m_peer', { text: 'hi' });
    expect(remote.status).toBe(404);
    expect(remote.body).toMatchObject({ error: 'session-on-other-machine', ownerMachine: { machineId: 'm_peer', nickname: 'Mac Mini' } });
    expect(remote.body.reason).toContain('Mac Mini');
    expect(c.typed).toHaveLength(0);
    expect(c.peerCalls).toHaveLength(0);
  });

  it('a local miss bound to this machine never fans out', async () => {
    const c = setup({ peers: async () => [{ machineId: 'm_peer', found: true }] });
    const r = await signed(c.app, c.owner, 'GET', '/sessions/main/output?machine=m_self');
    expect(r.body).toEqual({ error: 'session-not-running', reason: NOT_RUNNING_REASON });
    expect(c.peerCalls).toHaveLength(0);
  });

  it('an unbound local miss: named when one peer lists it, unknown when a peer is silent or two list it; cached', async () => {
    const found = setup({ peers: async () => [{ machineId: 'm_peer', found: true }] });
    const a = await signed(found.app, found.owner, 'GET', '/sessions/elsewhere/output');
    expect(a.status).toBe(404);
    expect(a.body).toMatchObject({ error: 'session-on-other-machine', ownerMachine: { machineId: 'm_peer', nickname: 'Mac Mini' } });
    await signed(found.app, found.owner, 'GET', '/sessions/elsewhere/output');
    expect(found.peerCalls).toEqual(['elsewhere']);

    const silent = setup({ peers: async () => [{ machineId: 'm_peer', found: false }, { machineId: 'not-asked', failed: true }] });
    expect((await signed(silent.app, silent.owner, 'GET', '/sessions/x/output')).body).toEqual({ error: 'session-location-unknown', reason: LOCATION_UNKNOWN_REASON });
    const two = setup({ peers: async () => [{ machineId: 'm_peer', found: true }, { machineId: 'm_x', found: true }] });
    expect((await signed(two.app, two.owner, 'GET', '/sessions/x/output')).body.error).toBe('session-location-unknown');
    const none = setup({ peers: async () => [{ machineId: 'm_peer', found: false }] });
    expect((await signed(none.app, none.owner, 'GET', '/sessions/x/output')).body.error).toBe('session-not-running');
  });

  it('at most 8 distinct missing names are looked up per device per minute', async () => {
    const c = setup({ peers: async () => [{ machineId: 'm_peer', found: false }] });
    for (let i = 0; i < 10; i++) await signed(c.app, c.owner, 'GET', `/sessions/missing-${i}/output`);
    expect(c.peerCalls).toHaveLength(8);
  });
});

describe('device session input', () => {
  it('an owner phone types plain text into a local session, once, and it is audited without the text', async () => {
    const c = setup();
    const r = await signed(c.app, c.owner, 'POST', '/sessions/echo-topic-7/input?sid=sid-1', { text: 'hello\nsecond line' });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true });
    expect(c.typed).toEqual([{ tmux: 'echo-topic-7', text: 'hello\nsecond line' }]);
    const audit = fs.readFileSync(path.join(c.dir, 'logs', 'mobile-session-input.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ deviceId: c.owner.id, role: 'owner', sessionId: 'sid-1', tmuxSession: 'echo-topic-7', textLength: 17 });
    expect(JSON.stringify(audit[0])).not.toContain('hello');
  });

  it('refuses control characters, empty text and over-long text before anything is typed', async () => {
    const c = setup();
    const ctl = await signed(c.app, c.owner, 'POST', '/sessions/echo-topic-7/input', { text: 'stop\x03' });
    expect(ctl.status).toBe(400);
    expect(ctl.body).toEqual({ error: 'bad-text', reason: BAD_TEXT_REASON });
    expect((await signed(c.app, c.owner, 'POST', '/sessions/echo-topic-7/input', { text: '\x1b[201~x' })).status).toBe(400);
    expect((await signed(c.app, c.owner, 'POST', '/sessions/echo-topic-7/input', { text: '' })).status).toBe(400);
    expect((await signed(c.app, c.owner, 'POST', '/sessions/echo-topic-7/input', { text: 'x'.repeat(8001) })).status).toBe(400);
    expect(c.typed).toHaveLength(0);
  });

  it('the same signed request is never typed twice, even after the router restarts on the same state', async () => {
    const c = setup();
    const p = '/sessions/echo-topic-7/input';
    const body = { text: 'once' };
    const time = String(Date.now());
    const raw = Buffer.from(JSON.stringify(body));
    const sig = c.owner.dev.sign(canonicalString(c.owner.id, HOST, 'POST', p, time, raw));
    const send = (app: express.Express) => request(app).post(p).set('Content-Type', 'application/json')
      .set('X-Instar-Device', c.owner.id).set('X-Instar-Device-Time', time).set('X-Instar-Device-Sig', sig).send(raw.toString());
    expect((await send(c.app)).status).toBe(200);
    // A second server process on the same state: a fresh in-memory replay set, the same device record.
    const fresh = setup({ dir: c.dir });
    fresh.svc.devices.get(c.owner.id); // the device registry is re-read from disk
    const again = await send(fresh.app);
    expect(again.status).toBe(409);
    expect(again.body.error).toBe('replay');
    expect([...c.typed, ...fresh.typed]).toHaveLength(1);
  });

  it('a send the session refuses answers 409 send-failed and is not audited', async () => {
    const c = setup();
    c.setSendOk(false);
    const r = await signed(c.app, c.owner, 'POST', '/sessions/echo-topic-7/input', { text: 'hi' });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('send-failed');
    expect(fs.existsSync(path.join(c.dir, 'logs', 'mobile-session-input.jsonl'))).toBe(false);
  });

  it('per-phone input bucket: the 13th input in a minute is refused', async () => {
    const c = setup();
    const statuses: number[] = [];
    for (let i = 0; i < 13; i++) statuses.push((await signed(c.app, c.owner, 'POST', '/sessions/echo-topic-7/input', { text: `m${i}` })).status);
    expect(statuses.slice(0, 12).every((s) => s === 200)).toBe(true);
    expect(statuses[12]).toBe(429);
  });

  it('machine-wide input window: 12 inputs a minute across all phones', async () => {
    const c = setup();
    const phones = [c.owner, c.pair(), c.pair()];
    const statuses: number[] = [];
    for (let i = 0; i < 13; i++) statuses.push((await signed(c.app, phones[i % 3]!, 'POST', '/sessions/echo-topic-7/input', { text: `m${i}` })).status);
    expect(statuses.filter((s) => s === 200)).toHaveLength(12);
    expect(statuses[12]).toBe(429);
  });
});
