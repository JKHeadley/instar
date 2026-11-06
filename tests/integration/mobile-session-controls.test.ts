/**
 * HTTP pipeline for the session screen's controls (docs/specs/mobile-native-session-controls.md): keys,
 * attachments and the hop to another machine, through the production authMiddleware + deviceAuthenticator
 * + the device router, with a stub main router standing in for the dashboard's handlers in routes.ts, and
 * a second router standing in for the machine that runs the session.
 */
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { authMiddleware } from '../../src/server/middleware.js';
import { MobilePairingService, deviceAuthenticator, type MobilePairingDeps } from '../../src/server/mobilePairingRoutes.js';
import { createMobileSessionTerminalRouter, BAD_KEY_REASON, REMOTE_INPUT_OFF_REASON, type SessionRecordLike } from '../../src/server/mobileSessionTerminalRoutes.js';
import { mountMobileSessionControlsRoutes, type RouteAnswer } from '../../src/server/mobileSessionControlsRoutes.js';
import { canonicalString } from '../../src/core/MobileDeviceKeys.js';
import { makeDevice } from '../helpers/mobileDevice.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const HOST = 'echo.example.dev';
const TOKEN = 'tok-integration-0123456789';
const PIN = '482913';
const PEER_PIN = '777123';
const dirs: string[] = [];
const services: MobilePairingService[] = [];
afterAll(() => {
  for (const s of services) s.stop();
  for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/integration/mobile-session-controls.test.ts' });
});

const RECORDS: SessionRecordLike[] = [{ id: 'sid-1', name: 'Topic seven', tmuxSession: 'echo-topic-7', status: 'running' }];

/** The machine that runs the session: only its relay routes matter here. */
function peerApp(allowRemoteInput: boolean) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'msc-peer-'));
  dirs.push(dir);
  fs.writeFileSync(path.join(dir, 'users.json'), JSON.stringify([{ id: 'justin', name: 'Justin', channels: [], permissions: ['user'] }]));
  const svc = new MobilePairingService({ config: { projectName: 'echo', stateDir: dir, authToken: TOKEN, developmentAgent: true, mobilePairing: { multiRoute: { enabled: false } } } as never, stateDir: dir, holdsLease: () => true, selfMachineId: 'm_peer' } as MobilePairingDeps);
  services.push(svc);
  const typed: string[] = [];
  const keys: string[] = [];
  const app = express();
  app.use(express.json());
  app.use(authMiddleware(() => TOKEN, 'echo', undefined, deviceAuthenticator(svc)));
  app.use(createMobileSessionTerminalRouter({
    pairing: svc,
    listSessions: () => [{ id: 'peer-sid', name: 'Peer topic', tmuxSession: 'echo-topic-9', status: 'running' }],
    captureOutputAsync: async () => `peer pane ${TOKEN} ${PEER_PIN} and ${PIN}`,
    sendInput: (_t, text) => { typed.push(text); return true; },
    sendKey: (_t, key) => { keys.push(key); return true; },
    lookupPeers: async () => [],
    nicknameOf: () => null,
    selfNickname: () => 'Mac Mini',
    selfMachineId: () => 'm_peer',
    secrets: () => [TOKEN, PEER_PIN],
    allowRemoteInput: () => allowRemoteInput,
    stateDir: dir,
  }));
  // The dashboard's handler on that machine: proves the relay route lands on it for the session it resolved.
  const saved: string[] = [];
  app.post('/sessions/:name/attachments', (req, res) => { saved.push(req.params.name); res.status(201).json({ ok: true, path: `/peer/uploads/${req.body.filename}`, bytes: 777123 }); });
  return { app, typed, keys, saved };
}

interface Opts { peer?: 'ok' | 'off' | 'old' | 'gone'; noMesh?: boolean }

function setup(opts: Opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'msc-int-'));
  dirs.push(dir);
  fs.writeFileSync(path.join(dir, 'users.json'), JSON.stringify([{ id: 'justin', name: 'Justin', channels: [], permissions: ['user'] }]));
  const config = { projectName: 'echo', stateDir: dir, authToken: TOKEN, developmentAgent: true, mobilePairing: { multiRoute: { enabled: false } } } as never;
  const svc = new MobilePairingService({ config, stateDir: dir, holdsLease: () => true, selfMachineId: 'm_self' } as MobilePairingDeps);
  services.push(svc);
  const keys: Array<{ tmux: string; key: string }> = [];
  const typed: string[] = [];
  const peer = peerApp(opts.peer !== 'off');
  const app = express();
  app.use(express.json({ limit: '12mb', verify: (req, _res, buf) => { (req as unknown as { rawBody: Buffer }).rawBody = buf; } }));
  app.use(authMiddleware(() => TOKEN, 'echo', undefined, deviceAuthenticator(svc)));
  app.use(createMobileSessionTerminalRouter({
    pairing: svc,
    listSessions: () => RECORDS,
    captureOutputAsync: async () => 'pane',
    sendInput: (_t, text) => { typed.push(text); return true; },
    sendKey: (tmux, key) => { keys.push({ tmux, key }); return true; },
    lookupPeers: async () => [],
    nicknameOf: (id) => (id === 'm_peer' ? 'Mac Mini' : null),
    selfNickname: () => 'Studio',
    selfMachineId: () => (opts.noMesh ? null : 'm_self'),
    secrets: () => [TOKEN, PIN],
    allowRemoteInput: () => false,
    relayToPeer: async (machineId, method, p, body) => {
      if (machineId !== 'm_peer' || opts.peer === 'gone') return null;
      if (opts.peer === 'old') return { status: 404, body: null };
      const r = method === 'GET'
        ? await request(peer.app).get(p).set('Authorization', `Bearer ${TOKEN}`).set('X-Instar-AgentId', 'echo')
        : await request(peer.app).post(p).set('Authorization', `Bearer ${TOKEN}`).set('X-Instar-AgentId', 'echo').send(body as object);
      return { status: r.status, body: r.body };
    },
    stateDir: dir,
  }));
  // The history read, through the mount, with a stand-in for the dashboard's transcript route.
  const router = express.Router();
  const transcript = { entries: [{ role: 'user', text: `here is ${TOKEN}`, at: '2026-11-05T10:00:00.000Z' }, { role: 'assistant', text: 'ok', at: null }, { role: 'system', text: '' }], nextBefore: 12 };
  const calls: string[] = [];
  mountMobileSessionControlsRoutes(router, {
    call: async (method, p, _b, machine): Promise<RouteAnswer> => {
      calls.push(`${method} ${p}${machine ? ` @${machine}` : ''}`);
      if (machine === 'm_old') return { status: 404, body: null };
      if (machine === 'm_peer') return { status: 200, body: { entries: [{ role: 'user', text: `their words and ${PIN}`, at: null }], nextBefore: null } };
      if (p.startsWith('/sessions/echo-topic-7/transcript')) return { status: 200, body: transcript };
      if (p.startsWith('/sessions/none/transcript')) return { status: 404, body: { error: 'x', reason: 'no-transcript' } };
      return { status: 500, body: null };
    },
    actions: () => ({ state: 'console-only' }),
    bearerOk: () => false,
    selfMachineId: () => 'm_self',
    secrets: () => [TOKEN, PIN],
  });
  app.use(router);
  // Stand-in for the dashboard's handler: proves next() reaches it, and that a Bearer request passes through.
  const saved: Array<{ name: string; filename: unknown }> = [];
  app.post('/sessions/:name/attachments', (req, res) => { saved.push({ name: req.params.name, filename: req.body.filename }); res.status(201).json({ ok: true, path: '/state/dashboard-uploads/x.png', bytes: 3 }); });
  const pair = (person?: { userId: string; role: 'msp' }) => {
    const dev = makeDevice();
    const created = svc.devices.createPending({ deviceName: 'iPhone', label: null, publicKey: dev.publicKey, host: HOST, ...(person ?? {}) });
    if (!created.ok) throw new Error('setup');
    svc.devices.applyConfirm(created.device.id, { ok: true });
    return { dev, id: created.device.id };
  };
  return { app, svc, owner: pair(), pair, keys, typed, saved, peer, dir, calls };
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

describe('keys', () => {
  it('an owner phone presses a tray key, once, and it is audited with the key but no text', async () => {
    const c = setup();
    const r = await signed(c.app, c.owner, 'POST', '/sessions/echo-topic-7/key?sid=sid-1', { key: 'C-c' });
    expect(r.status).toBe(200);
    expect(c.keys).toEqual([{ tmux: 'echo-topic-7', key: 'C-c' }]);
    const row = JSON.parse(fs.readFileSync(path.join(c.dir, 'logs', 'mobile-session-input.jsonl'), 'utf8').trim());
    expect(row).toMatchObject({ deviceId: c.owner.id, sessionId: 'sid-1', key: 'C-c' });
  });
  it('anything but the tray is refused before tmux', async () => {
    const c = setup();
    for (const key of ['C-d', 'clear-history', 'Enter ; kill-server', '', 7]) {
      const r = await signed(c.app, c.owner, 'POST', '/sessions/echo-topic-7/key', { key });
      expect(r.status).toBe(400);
      expect(r.body).toEqual({ error: 'bad-key', reason: BAD_KEY_REASON });
    }
    expect(c.keys).toEqual([]);
  });
  it('the same signed press is refused the second time', async () => {
    const c = setup();
    const t = String(Date.now());
    expect((await signed(c.app, c.owner, 'POST', '/sessions/echo-topic-7/key', { key: 'y' }, t)).status).toBe(200);
    const again = await signed(c.app, c.owner, 'POST', '/sessions/echo-topic-7/key', { key: 'y' }, t);
    expect(again.status).not.toBe(200);
    expect(c.keys).toHaveLength(1);
  });
  it('a session the phone did not mean is not pressed', async () => {
    const c = setup();
    expect((await signed(c.app, c.owner, 'POST', '/sessions/echo-topic-7/key?sid=other', { key: 'y' })).status).toBe(409);
    expect((await signed(c.app, c.owner, 'POST', '/sessions/nothing/key?machine=m_self', { key: 'y' })).status).toBe(404);
    expect(c.keys).toEqual([]);
  });
  it('a phone that is not the owner, an unsigned request and the Bearer token do not reach keys', async () => {
    const c = setup();
    const msp = c.pair({ userId: 'justin', role: 'msp' });
    expect((await signed(c.app, msp, 'POST', '/sessions/echo-topic-7/key', { key: 'y' })).status).toBe(403);
    expect((await request(c.app).post('/sessions/echo-topic-7/key').send({ key: 'y' })).status).toBe(401);
    expect((await request(c.app).post('/sessions/echo-topic-7/key').set('Authorization', `Bearer ${TOKEN}`).set('X-Instar-AgentId', 'echo').send({ key: 'y' })).status).toBe(404);
    expect(c.keys).toEqual([]);
  });
});

describe('attachments', () => {
  it('an owner phone reaches the dashboard handler after the session is resolved', async () => {
    const c = setup();
    const r = await signed(c.app, c.owner, 'POST', '/sessions/echo-topic-7/attachments?sid=sid-1', { filename: 'a.png', dataBase64: 'AAAA' });
    expect(r.status).toBe(201);
    expect(c.saved).toEqual([{ name: 'echo-topic-7', filename: 'a.png' }]);
    const row = JSON.parse(fs.readFileSync(path.join(c.dir, 'logs', 'mobile-session-input.jsonl'), 'utf8').trim());
    expect(row).toMatchObject({ sessionId: 'sid-1', attachmentBase64Chars: 4 });
    expect(JSON.stringify(row)).not.toContain('a.png');
  });
  it('a stale session never reaches the handler', async () => {
    const c = setup();
    expect((await signed(c.app, c.owner, 'POST', '/sessions/echo-topic-7/attachments?sid=old', { filename: 'a', dataBase64: 'AAAA' })).status).toBe(409);
    expect((await signed(c.app, c.owner, 'POST', '/sessions/sid-1/attachments', { filename: 'a', dataBase64: 'AAAA' })).status).toBe(409);
    expect(c.saved).toEqual([]);
  });
  it('a Bearer request still reaches the handler untouched', async () => {
    const c = setup();
    const r = await request(c.app).post('/sessions/echo-topic-7/attachments').set('Authorization', `Bearer ${TOKEN}`).set('X-Instar-AgentId', 'echo').send({ filename: 'b', dataBase64: 'AAAA' });
    expect(r.status).toBe(201);
    expect(c.saved).toEqual([{ name: 'echo-topic-7', filename: 'b' }]);
  });
  it('an MSP phone is refused', async () => {
    const c = setup();
    const msp = c.pair({ userId: 'justin', role: 'msp' });
    expect((await signed(c.app, msp, 'POST', '/sessions/echo-topic-7/attachments', { filename: 'a', dataBase64: 'AAAA' })).status).toBe(403);
  });
});

describe('a session on another machine', () => {
  it('output comes through this machine, with both machines secrets removed and this registry naming it', async () => {
    const c = setup({ peer: 'ok' });
    const r = await signed(c.app, c.owner, 'GET', '/sessions/echo-topic-9/output?machine=m_peer&lines=50');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ sessionId: 'peer-sid', machineNickname: 'Mac Mini' });
    expect(r.body.output).toContain('peer pane');
    for (const secret of [TOKEN, PEER_PIN, PIN]) expect(r.body.output).not.toContain(secret);
  });
  it('typing and keys go through, under its rule, and are recorded here', async () => {
    const c = setup({ peer: 'ok' });
    expect((await signed(c.app, c.owner, 'POST', '/sessions/echo-topic-9/input?machine=m_peer', { text: 'hello' })).status).toBe(200);
    expect((await signed(c.app, c.owner, 'POST', '/sessions/echo-topic-9/key?machine=m_peer', { key: 'Enter' })).status).toBe(200);
    expect(c.peer.typed).toEqual(['hello']);
    expect(c.peer.keys).toEqual(['Enter']);
    expect(c.typed).toEqual([]);
    expect(c.keys).toEqual([]);
    const rows = fs.readFileSync(path.join(c.dir, 'logs', 'mobile-session-input.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(rows).toEqual([expect.objectContaining({ machineId: 'm_peer', textLength: 5 }), expect.objectContaining({ machineId: 'm_peer', key: 'Enter' })]);
  });
  it('typing is refused where that machine has it off, with a way forward; reading still works', async () => {
    const c = setup({ peer: 'off' });
    const r = await signed(c.app, c.owner, 'POST', '/sessions/echo-topic-9/input?machine=m_peer', { text: 'hello' });
    expect(r.status).toBe(409);
    expect(r.body).toEqual({ error: 'input-not-allowed', reason: REMOTE_INPUT_OFF_REASON });
    expect((await signed(c.app, c.owner, 'POST', '/sessions/echo-topic-9/key?machine=m_peer', { key: 'y' })).status).toBe(409);
    expect(c.peer.typed).toEqual([]);
    expect((await signed(c.app, c.owner, 'GET', '/sessions/echo-topic-9/output?machine=m_peer')).status).toBe(200);
  });
  it('an older machine: named, nothing typed, no local session touched', async () => {
    const c = setup({ peer: 'old' });
    const r = await signed(c.app, c.owner, 'POST', '/sessions/echo-topic-7/input?machine=m_peer', { text: 'hello' });
    expect(r.status).toBe(404);
    expect(r.body).toMatchObject({ error: 'session-on-other-machine', peerTooOld: true });
    expect(r.body.reason).toContain('Mac Mini needs the latest Instar update');
    expect(c.typed).toEqual([]);
  });
  it('with no mesh id here, a write naming a machine never lands on a same-named session here', async () => {
    const c = setup({ noMesh: true });
    expect((await signed(c.app, c.owner, 'POST', '/sessions/echo-topic-7/key?machine=m_peer', { key: 'C-c' })).body.error).toBe('session-on-other-machine');
    expect((await signed(c.app, c.owner, 'POST', '/sessions/echo-topic-7/input?machine=m_peer', { text: 'x' })).body.error).toBe('session-on-other-machine');
    expect((await signed(c.app, c.owner, 'POST', '/sessions/echo-topic-7/attachments?machine=m_peer', { filename: 'a', dataBase64: 'AAAA' })).body.error).toBe('session-on-other-machine');
    expect(c.keys).toEqual([]);
    expect(c.typed).toEqual([]);
    expect(c.saved).toEqual([]);
  });
  it('a machine not answering is a moment, not the session being gone', async () => {
    const c = setup({ peer: 'gone' });
    const r = await signed(c.app, c.owner, 'GET', '/sessions/echo-topic-9/output?machine=m_peer');
    expect(r.status).toBe(503);
    expect(r.body.error).toBe('peer-unreachable');
    expect(r.body.reason).toContain("Mac Mini isn't answering");
  });
  it('that machine resolves the session itself: a replaced one and a missing one are said plainly', async () => {
    const c = setup({ peer: 'ok' });
    expect((await signed(c.app, c.owner, 'GET', '/sessions/echo-topic-9/output?machine=m_peer&sid=old')).body.error).toBe('session-replaced');
    expect((await signed(c.app, c.owner, 'GET', '/sessions/echo-topic-1/output?machine=m_peer')).body.error).toBe('session-not-running');
  });
  it('a phone can not call the relay routes itself; the token can, and it says the machine rule', async () => {
    const c = setup({ peer: 'ok' });
    expect((await signed(c.app, c.owner, 'POST', '/mobile/sessions/relay/echo-topic-7/input', { text: 'x' })).status).toBe(403);
    expect((await signed(c.app, c.owner, 'GET', '/mobile/sessions/relay/echo-topic-7/output')).status).toBe(403);
    const s = await request(c.peer.app).get('/mobile/sessions/relay/echo-topic-9/state').set('Authorization', `Bearer ${TOKEN}`).set('X-Instar-AgentId', 'echo');
    expect(s.body).toEqual({ inputAllowed: true, keysSupported: true });
  });
});

describe('a file for a session on another machine', () => {
  it('lands on that machine, for the session that machine resolved; a number holding a PIN does not corrupt the answer', async () => {
    const c = setup({ peer: 'ok' });
    const r = await signed(c.app, c.owner, 'POST', '/sessions/echo-topic-9/attachments?machine=m_peer&sid=peer-sid', { filename: 'a.png', dataBase64: 'AAAA' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.path).toBe('/peer/uploads/a.png');
    expect(r.body.bytes).toBe(777123);
    expect(c.peer.saved).toEqual(['echo-topic-9']);
    expect(c.saved).toEqual([]);
  });
  it('follows that machine rule about typing, and its idea of the session', async () => {
    const off = setup({ peer: 'off' });
    expect((await signed(off.app, off.owner, 'POST', '/sessions/echo-topic-9/attachments?machine=m_peer', { filename: 'a', dataBase64: 'AAAA' })).body.error).toBe('input-not-allowed');
    expect(off.peer.saved).toEqual([]);
    const on = setup({ peer: 'ok' });
    expect((await signed(on.app, on.owner, 'POST', '/sessions/echo-topic-9/attachments?machine=m_peer&sid=old', { filename: 'a', dataBase64: 'AAAA' })).body.error).toBe('session-replaced');
    expect(on.peer.saved).toEqual([]);
  });
});

describe('history', () => {
  it('trims and removes secrets', async () => {
    const c = setup();
    const r = await signed(c.app, c.owner, 'GET', '/mobile/sessions/history?name=echo-topic-7&limit=500&before=40');
    expect(r.status).toBe(200);
    expect(r.body.entries).toEqual([{ role: 'user', text: 'here is [redacted]', at: '2026-11-05T10:00:00.000Z' }, { role: 'assistant', text: 'ok', at: null }]);
    expect(r.body.nextBefore).toBe(12);
    expect(c.calls[0]).toBe('GET /sessions/echo-topic-7/transcript?limit=100&before=40&redact=device');
  });
  it('another machine reads its own record, and this machine removes its secrets too; an older one says so', async () => {
    const c = setup();
    const r = await signed(c.app, c.owner, 'GET', '/mobile/sessions/history?name=echo-topic-9&machine=m_peer');
    expect(r.status).toBe(200);
    expect(c.calls[0]).toBe('GET /mobile/sessions/relay/echo-topic-9/history?limit=50 @m_peer');
    expect(r.body.entries[0].text).toBe('their words and [redacted]');
    const old = await signed(c.app, c.owner, 'GET', '/mobile/sessions/history?name=echo-topic-9&machine=m_old');
    expect(old.status).toBe(404);
    expect(old.body.reason).toContain('needs the latest Instar update');
  });
  it('a phone can not call the history relay itself', async () => {
    const c = setup();
    expect((await signed(c.app, c.owner, 'GET', '/mobile/sessions/relay/echo-topic-7/history')).status).toBe(403);
  });
  it('a missing record says so, in plain words', async () => {
    const c = setup();
    const r = await signed(c.app, c.owner, 'GET', '/mobile/sessions/history?name=none');
    expect(r.status).toBe(404);
    expect(r.body.reason).toBe('This session has no conversation record yet.');
  });
  it('a bad name is refused; an MSP phone is refused', async () => {
    const c = setup();
    expect((await signed(c.app, c.owner, 'GET', '/mobile/sessions/history?name=a%2Fb')).status).toBe(400);
    const msp = c.pair({ userId: 'justin', role: 'msp' });
    expect((await signed(c.app, msp, 'GET', '/mobile/sessions/history?name=echo-topic-7')).status).toBe(403);
  });
});
