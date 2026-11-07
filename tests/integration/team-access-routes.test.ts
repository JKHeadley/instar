/**
 * Team access routes through the production auth middleware, with real signed requests, a real
 * machine identity and the real signed log (docs/specs/team-roles-and-access.md §3.3, §3.4, §3.6).
 * Every role check is run from both sides: the person who may, and the person who may not.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { ProcessIntegrity } from '../../src/core/ProcessIntegrity.js';
import { authMiddleware } from '../../src/server/middleware.js';
import { MobilePairingService, deviceAuthenticator, mountPublicMobilePairingRoutes, type MobilePairingDeps } from '../../src/server/mobilePairingRoutes.js';
import { TeamRefusalLog, createTeamRouter, type TeamRouteDeps } from '../../src/server/teamRoutes.js';
import { mountMobilePermissionsRoutes, permissionPresenceMessage, type MobilePermissionsDeps } from '../../src/server/mobilePermissionsRoutes.js';
import { MobileDeviceKeyLedger } from '../../src/core/MobileDeviceKeyLedger.js';
import { identityKeyLookup, loadMachineSigner } from '../../src/core/AppRecordSignatures.js';
import { MachineIdentityManager } from '../../src/core/MachineIdentity.js';
import { canonicalString } from '../../src/core/MobileDeviceKeys.js';
import { makeDevice } from '../helpers/mobileDevice.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const HOST = 'echo.example.dev';
const dirs: string[] = [];
const services: MobilePairingService[] = [];
beforeAll(() => { ProcessIntegrity.reset(); ProcessIntegrity.initialize('1.2.36', null); });
afterAll(() => {
  ProcessIntegrity.reset();
  for (const s of services) s.stop();
  for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/integration/team-access-routes.test.ts' });
});

async function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'team-int-'));
  dirs.push(dir);
  fs.writeFileSync(path.join(dir, 'users.json'), JSON.stringify([{ id: 'mo', name: 'Mo', channels: [], permissions: ['user'] }]));
  await new MachineIdentityManager(dir).generateIdentity({ name: 'test' });
  const config = {
    projectName: 'echo', projectDir: dir, stateDir: dir, port: 0, authToken: 'tok-1', developmentAgent: true, dashboardPin: '424242',
    tunnel: { enabled: true, type: 'named', token: 'x', hostname: HOST }, mobilePairing: { multiRoute: { enabled: false } },
  };
  const gate = { now: 'ok' as 'ok' | 'memory-privacy-required' | 'team-needs-one-machine' };
  const deps: MobilePairingDeps = {
    config: config as never, stateDir: dir, holdsLease: () => true, selfMachineId: 'm1',
    tunnel: () => ({ lifecycleState: { lastState: 'active', activeProvider: 'cloudflare-named' } }),
    ownerDM: async () => 1, teamGate: () => gate.now,
  } as MobilePairingDeps;
  const svc = new MobilePairingService(deps);
  services.push(svc);
  svc.nativeOn = true;
  const signer = loadMachineSigner(dir)!;
  svc.keyLedger = new MobileDeviceKeyLedger({ stateDir: dir, signer, keyLookup: identityKeyLookup(dir) });
  const convs = new Map<string, { ownerPerson: unknown }>([['-7', { ownerPerson: null }], ['-8', { ownerPerson: { machineId: 'm1', userId: 'mo' } }]]);
  svc.useAppConversationStore({ getConversation: (k) => (convs.get(k) as never) ?? null });
  const spy = { changed: [] as string[], privacy: 0 };
  const team: TeamRouteDeps = {
    signer: () => signer,
    applyConversationChange: async (ref, change) => { spy.changed.push(ref); return change(); },
    isSystemTopic: (id) => id === 1, isJobTopic: (id) => id === 2, isUnconfinableTopic: (id) => id === 3,
    ownerProfile: () => ({ userId: 'owner-1', several: false, links: {} }),
    logsDir: path.join(dir, 'logs'),
    restoreRefs: () => ({ teamRefs: [], allRefs: () => [] }),
    requireMemoryPrivacy: () => { spy.privacy++; return true; },
  };
  const app = express();
  app.use(express.json({ verify: (req, _res, buf) => { (req as unknown as { rawBody: Buffer }).rawBody = buf; } }));
  mountPublicMobilePairingRoutes(app, svc);
  app.use(authMiddleware(() => 'tok-1', 'echo', undefined, deviceAuthenticator(svc)));
  app.use(createTeamRouter(svc, team));
  const router = express.Router();
  mountMobilePermissionsRoutes(router, {
    pairing: () => svc, config: () => config as never, stateDir: dir, bearerOk: () => false,
    teamAction: async (kind, req, deviceId) => svc.teamActionRunner!(kind, req, deviceId) as never,
  } as unknown as MobilePermissionsDeps);
  app.use(router);
  return { app, svc, gate, spy, dir };
}
type Env = Awaited<ReturnType<typeof setup>>;
type Phone = { dev: ReturnType<typeof makeDevice>; presence: ReturnType<typeof makeDevice>; id: string };

function phone(e: Env, person?: { userId: string; role: 'msp' | 'team' }): Phone {
  const dev = makeDevice();
  const presence = makeDevice();
  const c = e.svc.devices.createPending({ deviceName: 'iPhone', label: null, publicKey: dev.publicKey, host: HOST, ...(person ?? {}) });
  if (!c.ok) throw new Error('setup');
  e.svc.devices.applyConfirm(c.device.id, { ok: true });
  e.svc.keyLedger!.recordActivation(e.svc.devices.get(c.device.id)!, 'telegram-dm', new Date(Date.now() - 60_000).toISOString());
  e.svc.devices.setPresenceKey(c.device.id, presence.publicKey);
  return { dev, presence, id: c.device.id };
}

let tick = 0;
function send(e: Env, p: Phone, method: 'GET' | 'POST', url: string, body?: unknown) {
  const raw = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  const time = String(Date.now() + (tick++ % 1000));
  const sig = p.dev.sign(canonicalString(p.id, HOST, method, url, time, raw));
  const base = method === 'GET' ? request(e.app).get(url) : request(e.app).post(url).set('Content-Type', 'application/json');
  const q = base.set('X-Instar-Device', p.id).set('X-Instar-Device-Time', time).set('X-Instar-Device-Sig', sig);
  return raw ? q.send(raw.toString()) : q;
}
const bearer = (e: Env, url: string, body: unknown) => request(e.app).post(url).set('Authorization', 'Bearer tok-1').send(body as object);
const firstInvite = (personKey = 'p-1', extra: unknown[] = []) => ({
  events: [{ type: 'team-on' }, { type: 'owner-pin', personKey: 'owner-1' }, { type: 'person-add', personKey, name: 'Mia', role: 'member' }, ...extra],
});
const grant = (ref: string, access = 'use', personKey = 'p-1') => ({ type: 'grant', personKey, ref, access });
const faceId = async (e: Env, p: Phone, action: string, route: string, body: Record<string, unknown> = {}) => {
  const c = await send(e, p, 'POST', '/mobile/permissions/challenge', { action, target: 'team' });
  expect(c.status).toBe(200);
  const presenceSig = p.presence.sign(permissionPresenceMessage(p.id, HOST, c.body.challenge, `${action} team`));
  return send(e, p, 'POST', route, { ...body, challenge: c.body.challenge, presenceSig });
};

describe('team invites', () => {
  it('the owner phone invites; the first invite turns team access on and the row verifies after a reload', async () => {
    const e = await setup();
    const owner = phone(e);
    const r = await send(e, owner, 'POST', '/mobile/team/invites', firstInvite('p-1', [grant('telegram:50')]));
    expect(r.status).toBe(200);
    expect(r.body.link).toContain(HOST);
    expect(e.svc.teamOn()).toBe(true);
    expect(e.svc.teamStanding('p-1')).toEqual({ name: 'Mia', tier: 'member' });
    expect(e.spy.changed).toEqual(['telegram:50']);
    expect(e.svc.teamLog()!.isConfined('telegram:50')).toBe(true);
    e.svc.teamLog()!.load();
    expect(e.svc.teamLog()!.healthState()).toBe('ok');
    expect(e.svc.teamStanding('p-1')).toEqual({ name: 'Mia', tier: 'member' });
  });

  it('no one but the owner phone can invite: not an MSP phone, a member phone or the bearer', async () => {
    const e = await setup();
    const msp = phone(e, { userId: 'mo', role: 'msp' });
    expect((await send(e, msp, 'POST', '/mobile/team/invites', firstInvite())).status).toBe(403);
    expect((await bearer(e, '/mobile/team/invites', firstInvite())).status).toBe(403);
    expect(e.svc.teamOn()).toBe(false);
    const owner = phone(e);
    expect((await send(e, owner, 'POST', '/mobile/team/invites', firstInvite())).status).toBe(200);
    const member = phone(e, { userId: 'p-1', role: 'team' });
    const again = await send(e, member, 'POST', '/mobile/team/invites', firstInvite('p-2'));
    expect(again.status).toBe(403);
    expect(e.svc.teamStanding('p-2')).toBeNull();
  });

  it('refuses with a plain reason when memory privacy is off or the agent has a second machine', async () => {
    const e = await setup();
    const owner = phone(e);
    e.gate.now = 'memory-privacy-required';
    let r = await send(e, owner, 'POST', '/mobile/team/invites', firstInvite());
    expect(r.status).toBe(409);
    expect(r.body.detail).toMatch(/memory privacy/i);
    e.gate.now = 'team-needs-one-machine';
    r = await send(e, owner, 'POST', '/mobile/team/invites', firstInvite());
    expect(r.status).toBe(409);
    expect(r.body.detail).toMatch(/next step/);
    expect(e.svc.teamOn()).toBe(false);
    e.gate.now = 'ok';
    expect((await send(e, owner, 'POST', '/mobile/team/invites', firstInvite())).status).toBe(200);
  });

  it('a first invite must turn team access on; a later one need not', async () => {
    const e = await setup();
    const owner = phone(e);
    const add = (k: string) => ({ events: [{ type: 'person-add', personKey: k, name: 'Bo', role: 'guest' }] });
    expect((await send(e, owner, 'POST', '/mobile/team/invites', add('p-9'))).body.error).toBe('first-invite-incomplete');
    expect((await send(e, owner, 'POST', '/mobile/team/invites', firstInvite())).status).toBe(200);
    expect((await send(e, owner, 'POST', '/mobile/team/invites', add('p-9'))).status).toBe(200);
  });

  it('the owner role can never be invited', async () => {
    const e = await setup();
    const r = await send(e, phone(e), 'POST', '/mobile/team/invites', { events: [{ type: 'team-on' }, { type: 'person-add', personKey: 'x', name: 'X', role: 'owner' }] });
    expect(r.status).toBe(400);
    expect(e.svc.teamOn()).toBe(false);
  });

  it.each([
    ['slack:C1', 'slack-not-yet'], ['telegram:1', 'system-topic'], ['telegram:2', 'job-topic'],
    ['telegram:3', 'topic-cannot-be-confined'], ['-8', 'own-conversation'], ['-99', 'unknown-conversation'],
  ])('a grant of %s is refused and writes nothing', async (ref, error) => {
    const e = await setup();
    const r = await send(e, phone(e), 'POST', '/mobile/team/invites', firstInvite('p-1', [grant(ref)]));
    expect(r.body.error).toBe(error);
    expect(e.svc.teamOn()).toBe(false);
    expect(e.svc.teamLog()!.isConfined(ref)).toBe(false);
  });

  it('an ordinary topic and a shared app conversation can be granted', async () => {
    const e = await setup();
    const r = await send(e, phone(e), 'POST', '/mobile/team/invites', firstInvite('p-1', [grant('telegram:50', 'read'), grant('-7')]));
    expect(r.status).toBe(200);
    expect(e.svc.teamLog()!.grantOf('p-1', '-7')).toBe('use');
    expect(e.svc.teamLog()!.grantOf('p-1', 'telegram:50')).toBe('read');
  });
});

describe('redeeming a team link', () => {
  const code = (link: string) => new URLSearchParams(link.split('#')[1]).get('c')!;

  it('an old app is told to update and the link survives; a current app pairs with a code held for the owner', async () => {
    const e = await setup();
    const owner = phone(e);
    const inv = await send(e, owner, 'POST', '/mobile/team/invites', firstInvite());
    const c = code(inv.body.link);
    const dev = makeDevice();
    const redeem = (appCaps?: string[]) => request(e.app).post('/mobile/pairing-codes/redeem').set('Host', HOST).send({ code: c, deviceName: 'Mia', devicePublicKey: dev.publicKey, ...(appCaps ? { appCaps } : {}) });
    expect((await redeem()).status).toBe(426);
    const r = await redeem(['standing']);
    expect(r.status).toBe(200);
    const device = e.svc.devices.get(r.body.deviceId)!;
    expect(device).toMatchObject({ userId: 'p-1', role: 'team', status: 'pending' });
    const waiting = await send(e, owner, 'GET', '/mobile/team/invites/p-1');
    expect(waiting.body.waiting).toHaveLength(1);
    expect(waiting.body.waiting[0].deviceId).toBe(r.body.deviceId);
  });

  it('a link for a person removed before it is used does not pair', async () => {
    const e = await setup();
    const owner = phone(e);
    const inv = await send(e, owner, 'POST', '/mobile/team/invites', firstInvite());
    expect((await bearer(e, '/team/people/p-1/lower', { remove: true })).status).toBe(200);
    const r = await request(e.app).post('/mobile/pairing-codes/redeem').set('Host', HOST).send({ code: code(inv.body.link), deviceName: 'Mia', devicePublicKey: makeDevice().publicKey, appCaps: ['standing'] });
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('That link has expired or was already used.');
    expect(e.svc.codes.peekPerson(code(inv.body.link))?.userId).toBe('p-1'); // refused by standing, so the code was real
  });
});

describe('reading people', () => {
  it('the owner sees everyone; a member sees only their own row', async () => {
    const e = await setup();
    const owner = phone(e);
    await send(e, owner, 'POST', '/mobile/team/invites', firstInvite('p-1', [grant('telegram:50')]));
    await send(e, owner, 'POST', '/mobile/team/invites', { events: [{ type: 'person-add', personKey: 'p-2', name: 'Bo', role: 'guest' }] });
    const member = phone(e, { userId: 'p-1', role: 'team' });
    expect((await send(e, owner, 'GET', '/mobile/team/people')).body.people.map((p: { personKey: string }) => p.personKey).sort()).toEqual(['p-1', 'p-2']);
    const own = await send(e, member, 'GET', '/mobile/team/people');
    expect(own.status).toBe(200);
    expect(own.body.people.map((p: { personKey: string }) => p.personKey)).toEqual(['p-1']);
    expect(own.body.people[0].conversations).toEqual([{ ref: 'telegram:50', access: 'use' }]);
  });

  it('context and activity are the owner\'s alone', async () => {
    const e = await setup();
    const owner = phone(e);
    await send(e, owner, 'POST', '/mobile/team/invites', firstInvite());
    const member = phone(e, { userId: 'p-1', role: 'team' });
    expect((await send(e, owner, 'GET', '/mobile/team/context')).status).toBe(200);
    expect((await send(e, owner, 'GET', '/mobile/team/activity')).body.lines.map((l: { text: string }) => l.text)).toContain('Mia was invited');
    expect((await send(e, member, 'GET', '/mobile/team/context')).status).toBe(403);
    expect((await send(e, member, 'GET', '/mobile/team/activity')).status).toBe(403);
  });
});

describe('changing access', () => {
  it('the owner changes grants and roles; a member cannot, even on themselves', async () => {
    const e = await setup();
    const owner = phone(e);
    await send(e, owner, 'POST', '/mobile/team/invites', firstInvite());
    const member = phone(e, { userId: 'p-1', role: 'team' });
    const events = { events: [grant('telegram:50')] };
    expect((await send(e, member, 'POST', '/mobile/team/grants', events)).status).toBe(403);
    expect((await send(e, member, 'POST', '/mobile/team/people/p-1', { events: [{ type: 'person-set', personKey: 'p-1', role: 'admin' }] })).status).toBe(403);
    expect(e.svc.teamStanding('p-1')?.tier).toBe('member');
    expect((await send(e, owner, 'POST', '/mobile/team/grants', events)).status).toBe(200);
    expect((await send(e, owner, 'POST', '/mobile/team/people/p-1', { events: [{ type: 'person-set', personKey: 'p-1', role: 'admin' }] })).status).toBe(200);
    expect(e.svc.teamStanding('p-1')?.tier).toBe('admin');
  });

  it('a people route refuses events about someone else, and a grants route refuses anything but grants', async () => {
    const e = await setup();
    const owner = phone(e);
    await send(e, owner, 'POST', '/mobile/team/invites', firstInvite());
    expect((await send(e, owner, 'POST', '/mobile/team/people/p-1', { events: [{ type: 'person-remove', personKey: 'p-2' }] })).status).toBe(400);
    expect((await send(e, owner, 'POST', '/mobile/team/grants', { events: [{ type: 'team-off' }] })).status).toBe(400);
    expect(e.svc.teamOn()).toBe(true);
  });

  it('the bearer can lower and never raise', async () => {
    const e = await setup();
    const owner = phone(e);
    await send(e, owner, 'POST', '/mobile/team/invites', firstInvite('p-1', [grant('telegram:50')]));
    expect((await bearer(e, '/team/people/p-1/lower', { role: 'admin' })).body.error).toBe('can-only-lower');
    expect((await bearer(e, '/team/people/p-1/lower', { role: 'owner' })).body.error).toBe('can-only-lower');
    expect(e.svc.teamStanding('p-1')?.tier).toBe('member');
    expect((await bearer(e, '/team/people/p-1/lower', { role: 'guest' })).status).toBe(200);
    expect(e.svc.teamStanding('p-1')?.tier).toBe('guest');
    expect((await bearer(e, '/team/people/p-1/lower', { ref: 'telegram:50' })).status).toBe(200);
    expect(e.svc.teamLog()!.grantOf('p-1', 'telegram:50')).toBeNull();
    expect((await bearer(e, '/team/people/p-1/lower', {})).body.error).toBe('nothing-to-lower');
    expect((await bearer(e, '/team/people/nobody/lower', { remove: true })).status).toBe(404);
  });

  it('a phone cannot use the lower route', async () => {
    const e = await setup();
    const owner = phone(e);
    await send(e, owner, 'POST', '/mobile/team/invites', firstInvite());
    expect((await send(e, owner, 'POST', '/team/people/p-1/lower', { remove: true })).status).toBe(403);
    expect(e.svc.teamStanding('p-1')).not.toBeNull();
  });
});

describe('failures answer plainly', () => {
  it('a grant for someone not on the agent is refused and confines nothing', async () => {
    const e = await setup();
    const owner = phone(e);
    await send(e, owner, 'POST', '/mobile/team/invites', firstInvite());
    const r = await send(e, owner, 'POST', '/mobile/team/grants', { events: [grant('telegram:50', 'use', 'nobody')] });
    expect(r.status).toBe(404);
    expect(e.svc.teamLog()!.isConfined('telegram:50')).toBe(false);
  });

  it('a change to someone not on the agent is a 404', async () => {
    const e = await setup();
    const owner = phone(e);
    await send(e, owner, 'POST', '/mobile/team/invites', firstInvite());
    expect((await send(e, owner, 'POST', '/mobile/team/people/nobody', { events: [{ type: 'person-remove', personKey: 'nobody' }] })).status).toBe(404);
  });

  it('an unreadable log refuses every write with a way forward, and a member loses access', async () => {
    const e = await setup();
    const owner = phone(e);
    await send(e, owner, 'POST', '/mobile/team/invites', firstInvite());
    const member = phone(e, { userId: 'p-1', role: 'team' });
    expect((await send(e, member, 'GET', '/mobile/team/people')).status).toBe(200);
    const log = path.join(e.dir, 'state', 'team-access', 'log.jsonl');
    fs.writeFileSync(log, 'not json\n');
    e.svc.teamLog()!.load();
    expect(e.svc.teamLog()!.healthState()).toBe('unreadable');
    const r = await send(e, owner, 'POST', '/mobile/team/grants', { events: [grant('telegram:50')] });
    expect(r.status).toBe(409);
    expect(r.body.detail).toMatch(/Restore/);
    expect(e.svc.teamOn()).toBe(true); // the strict direction
    expect((await send(e, member, 'GET', '/mobile/team/people')).status).toBe(403);
  });

  it('a removed person\'s paired phone is refused straight away', async () => {
    const e = await setup();
    const owner = phone(e);
    await send(e, owner, 'POST', '/mobile/team/invites', firstInvite());
    const member = phone(e, { userId: 'p-1', role: 'team' });
    expect((await send(e, member, 'GET', '/mobile/team/people')).status).toBe(200);
    await bearer(e, '/team/people/p-1/lower', { remove: true });
    expect((await send(e, member, 'GET', '/mobile/team/people')).status).toBe(403);
  });

  it('the invite and a member\'s own row carry the scheduled-jobs disclosure; the owner\'s list does not need it', async () => {
    const e = await setup();
    const owner = phone(e);
    const inv = await send(e, owner, 'POST', '/mobile/team/invites', firstInvite());
    expect(inv.body.disclosure).toMatch(/Scheduled jobs run for the owner/);
    const member = phone(e, { userId: 'p-1', role: 'team' });
    expect((await send(e, member, 'GET', '/mobile/team/people')).body.disclosure).toMatch(/Scheduled jobs/);
  });

  it('a refusal is logged once per device, route and minute', async () => {
    let t = 1_000_000;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'team-ref-'));
    dirs.push(dir);
    const file = path.join(dir, 'team-access.jsonl');
    const log = new TeamRefusalLog(file, () => t);
    log.record('d1', '/x', 'no');
    log.record('d1', '/x', 'no');
    log.record('d1', '/y', 'no');
    t += 60_001;
    log.record('d1', '/x', 'no');
    expect(fs.readFileSync(file, 'utf8').trim().split('\n')).toHaveLength(3);
  });
});

describe('Face ID actions', () => {
  it('team-off needs the owner and a fresh Face ID proof; it removes everyone and the conversation stays confined', async () => {
    const e = await setup();
    const owner = phone(e);
    await send(e, owner, 'POST', '/mobile/team/invites', firstInvite('p-1', [grant('telegram:50')]));
    const member = phone(e, { userId: 'p-1', role: 'team' });
    expect((await send(e, member, 'POST', '/mobile/team/off', { events: [{ type: 'team-off' }] })).status).toBe(403);
    expect((await send(e, owner, 'POST', '/mobile/team/off', { events: [{ type: 'team-off' }] })).status).toBe(401);
    expect(e.svc.teamOn()).toBe(true);
    const r = await faceId(e, owner, 'team-off', '/mobile/team/off', { events: [{ type: 'team-off' }] });
    expect(r.status).toBe(200);
    expect(e.svc.teamOn()).toBe(false);
    expect(e.svc.teamStanding('p-1')).toBeNull();
    expect(e.svc.teamLog()!.isConfined('telegram:50')).toBe(true);
    e.svc.teamLog()!.load();
    expect(e.svc.teamOn()).toBe(false);
  });

  it('team-off with other events in the signed body is refused', async () => {
    const e = await setup();
    const owner = phone(e);
    await send(e, owner, 'POST', '/mobile/team/invites', firstInvite());
    const r = await faceId(e, owner, 'team-off', '/mobile/team/off', { events: [{ type: 'team-off' }, { type: 'person-remove', personKey: 'p-1' }] });
    expect(r.status).toBe(400);
    expect(e.svc.teamOn()).toBe(true);
  });

  it('memory privacy is set by the owner with Face ID, never by a member', async () => {
    const e = await setup();
    const owner = phone(e);
    await send(e, owner, 'POST', '/mobile/team/invites', firstInvite());
    const member = phone(e, { userId: 'p-1', role: 'team' });
    expect((await send(e, member, 'POST', '/mobile/team/memory-privacy', {})).status).toBe(403);
    expect(e.spy.privacy).toBe(0);
    expect((await faceId(e, owner, 'team-memory-privacy', '/mobile/team/memory-privacy')).status).toBe(200);
    expect(e.spy.privacy).toBe(1);
  });

  it('restore is the owner\'s with Face ID', async () => {
    const e = await setup();
    const owner = phone(e);
    await send(e, owner, 'POST', '/mobile/team/invites', firstInvite());
    expect((await send(e, owner, 'POST', '/mobile/team/restore', {})).status).toBe(401);
    expect((await faceId(e, owner, 'team-restore', '/mobile/team/restore')).status).toBe(200);
  });
});
