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
import { TeamAccessLog } from '../../src/core/TeamAccessLog.js';
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

async function setup(overrides: Record<string, unknown> = {}, conversations: string[] = [], extraTeam: Partial<TeamRouteDeps> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'team-int-'));
  dirs.push(dir);
  fs.writeFileSync(path.join(dir, 'users.json'), JSON.stringify([{ id: 'mo', name: 'Mo', channels: [], permissions: ['user'] }]));
  await new MachineIdentityManager(dir).generateIdentity({ name: 'test' });
  const config = {
    projectName: 'echo', projectDir: dir, stateDir: dir, port: 0, authToken: 'tok-1', developmentAgent: true, dashboardPin: '424242',
    tunnel: { enabled: true, type: 'named', token: 'x', hostname: HOST }, mobilePairing: { multiRoute: { enabled: false } },
    ...overrides,
  };
  const gate = { now: 'ok' as 'ok' | 'memory-privacy-required', jobs: new Set<number>() };
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
  const spy = { changed: [] as string[], privacy: 0, held: [] as string[], lockedDuringCommit: [] as string[] };
  const spyOnCommit = (log: { appendSignedRequest: (...x: never[]) => unknown; appendMachineEvents: (...x: never[]) => unknown }) => {
    for (const name of ['appendSignedRequest', 'appendMachineEvents'] as const) {
      const real = log[name].bind(log);
      log[name] = ((...args: never[]) => { if (spy.held.length > 0) spy.lockedDuringCommit = [...spy.held]; return real(...args); }) as never;
    }
  };
  spyOnCommit(svc.teamLog() as never);
  const team: TeamRouteDeps = {
    signer: () => signer,
    // Stands in for the real lock: `held` is what is locked while the change runs.
    applyConversationChange: async (ref, change) => {
      spy.changed.push(ref);
      spy.held.push(ref);
      try { return await change(); } finally { spy.held.pop(); }
    },
    isSystemTopic: (id) => id === 1, isJobTopic: (id) => id === 2 || gate.jobs.has(id), isUnconfinableTopic: (id) => id === 3,
    ownerProfile: () => ({ userId: 'owner-1', several: false, links: {} }),
    logsDir: path.join(dir, 'logs'), stateDir: dir, conversationTitle: (ref) => (ref === 'telegram:50' ? 'Client work' : null),
    restoreRefs: () => ({ teamRefs: [], allRefs: () => conversations.map((ref) => ({ ref })) }),
    requireMemoryPrivacy: () => { spy.privacy++; return true; },
    agentSessionsWhenOn: () => (gate as { agentSessions?: 'own-place' | 'refused' | 'owner-reach' }).agentSessions ?? 'own-place',
    ...extraTeam,
  };
  const app = express();
  app.use(express.json({ verify: (req, _res, buf) => { (req as unknown as { rawBody: Buffer }).rawBody = buf; } }));
  mountPublicMobilePairingRoutes(app, svc);
  app.use(authMiddleware(() => 'tok-1', 'echo', undefined, deviceAuthenticator(svc)));
  app.use((req, res, next) => {
    const scoped = req.headers['x-test-session'];
    if (typeof scoped === 'string') res.locals.memorySession = JSON.parse(scoped);
    next();
  });
  app.use(createTeamRouter(svc, team));
  const router = express.Router();
  mountMobilePermissionsRoutes(router, {
    pairing: () => svc, config: () => config as never, stateDir: dir, bearerOk: () => false,
    teamAction: async (kind, req, deviceId, target) => svc.teamActionRunner!(kind, req, deviceId, target) as never,
  } as unknown as MobilePermissionsDeps);
  app.use(router);
  return { app, svc, gate, spy, dir };
}
type Env = Awaited<ReturnType<typeof setup>>;
type Phone = { dev: ReturnType<typeof makeDevice>; presence: ReturnType<typeof makeDevice>; id: string };

function phone(e: Env, person?: { userId: string; role: 'msp' | 'team' }, withFaceId = true): Phone {
  const dev = makeDevice();
  const presence = makeDevice();
  const c = e.svc.devices.createPending({ deviceName: 'iPhone', label: null, publicKey: dev.publicKey, host: HOST, ...(person ?? {}) });
  if (!c.ok) throw new Error('setup');
  e.svc.devices.applyConfirm(c.device.id, { ok: true });
  e.svc.keyLedger!.recordActivation(e.svc.devices.get(c.device.id)!, 'telegram-dm', new Date(Date.now() - 60_000).toISOString());
  if (withFaceId) e.svc.devices.setPresenceKey(c.device.id, presence.publicKey);
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

  it.each(['telegram:01', 'telegram:0', 'telegram:1e3', 'telegram:'])('a non-standard reference %s is refused', async (ref) => {
    const e = await setup();
    const r = await send(e, phone(e), 'POST', '/mobile/team/invites', firstInvite('p-1', [grant(ref)]));
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(e.svc.teamOn()).toBe(false);
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

describe('what the app needs to show', () => {
  const code = (link: string) => new URLSearchParams(link.split('#')[1]).get('c')!;

  it('redeem says the code is with the inviter, and offers no page to open', async () => {
    const e = await setup();
    const owner = phone(e);
    const inv = await send(e, owner, 'POST', '/mobile/team/invites', firstInvite());
    const dev = makeDevice();
    const r = await request(e.app).post('/mobile/pairing-codes/redeem').set('Host', HOST).send({ code: code(inv.body.link), deviceName: 'Mia', devicePublicKey: dev.publicKey, appCaps: ['standing'] });
    expect(r.body.approval).toBe('inviter');
    expect(r.body.codePageUrl).toBeUndefined();
    expect(r.body.codeAt).toBeUndefined();
  });

  it('every gate refusal a phone can hit has words with it', async () => {
    const e = await setup();
    const owner = phone(e);
    await send(e, owner, 'POST', '/mobile/team/invites', firstInvite());
    const member = phone(e, { userId: 'p-1', role: 'team' });
    const r = await send(e, member, 'GET', '/mobile/team/context');
    expect(r.body.error).toBe('owner-phone-required');
    expect(r.body.detail).toMatch(/owner/);
    e.gate.now = 'memory-privacy-required';
    const off = await send(e, member, 'GET', '/mobile/team/people');
    expect(off.body.error).toBe('memory-privacy-required');
    expect(off.body.detail).toMatch(/memory privacy/);
  });

  it.each([
    ['ENOENT /secret/path/log.jsonl', true],
    ['ENOSPC /secret/path/log.jsonl', true],
    ['private credential failure', false],
  ] as const)('a failed Face ID action keeps %s private and names only storage failures', async (message, storage) => {
    const e = await setup();
    const identity = new MachineIdentityManager(e.dir);
    const local = identity.loadIdentity();
    identity.updateNickname(local.machineId, 'Mac Studio');
    const owner = phone(e);
    await send(e, owner, 'POST', '/mobile/team/invites', firstInvite());
    e.svc.teamActionRunner = async () => { throw new Error(message); };
    const r = await faceId(e, owner, 'team-off', '/mobile/team/off', { events: [{ type: 'team-off' }] });
    expect(r.status).toBe(500);
    expect(r.body.error).toBe('team-action-failed');
    expect(JSON.stringify(r.body)).not.toMatch(/secret|private credential|ENOENT|ENOSPC/);
    expect(r.body.detail).toMatch(/Try again/);
    if (storage) expect(r.body.detail).toContain('Mac Studio');
    else expect(r.body.detail).toBe('That did not work, and nothing changed. Try again.');
  });

  it('context says when the record needs restoring, before any write fails', async () => {
    const e = await setup();
    const owner = phone(e);
    await send(e, owner, 'POST', '/mobile/team/invites', firstInvite());
    expect((await send(e, owner, 'GET', '/mobile/team/context')).body.record).toEqual({ health: 'ok', restoreNeeded: false });
    fs.writeFileSync(path.join(e.dir, 'state', 'team-access', 'confined.json'), 'not json');
    expect((await send(e, owner, 'GET', '/mobile/team/context')).body.record.restoreNeeded).toBe(true);
  });

  it('context tells the turn-on sheet what other agents will get', async () => {
    const e = await setup();
    const owner = phone(e);
    expect((await send(e, owner, 'GET', '/mobile/team/context')).body.agentSessions).toBe('own-place');
    (e.gate as { agentSessions?: string }).agentSessions = 'refused';
    expect((await send(e, owner, 'GET', '/mobile/team/context')).body.agentSessions).toBe('refused');
  });

  it('context lists the MSP phones an invite will make read-only', async () => {
    const e = await setup();
    const owner = phone(e);
    expect((await send(e, owner, 'GET', '/mobile/team/context')).body.mspPhones).toEqual([]);
    phone(e, { userId: 'mo', role: 'msp' });
    expect((await send(e, owner, 'GET', '/mobile/team/context')).body.mspPhones).toEqual([{ deviceName: 'iPhone', personName: 'Mo' }]);
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

describe('a write means what it says', () => {
  it('refuses an address the log would not accept, before anything changes', async () => {
    const e = await setup();
    const owner = phone(e);
    await send(e, owner, 'POST', '/mobile/team/invites', firstInvite());
    for (const url of ['/mobile/team/grants/', '/mobile/team/grants?x=1']) {
      const r = await send(e, owner, 'POST', url, { events: [grant('telegram:50')] });
      expect(r.status).toBe(400);
    }
    expect(e.spy.changed).toEqual([]);
    expect(e.svc.teamLog()!.isConfined('telegram:50')).toBe(false);
  });

  it('team-off cannot ride the invite route to skip Face ID', async () => {
    const e = await setup();
    const owner = phone(e);
    await send(e, owner, 'POST', '/mobile/team/invites', firstInvite());
    const r = await send(e, owner, 'POST', '/mobile/team/invites', { events: [{ type: 'team-off' }, { type: 'person-add', personKey: 'p-2', name: 'B', role: 'guest' }] });
    expect(r.status).toBe(400);
    expect(e.svc.teamOn()).toBe(true);
  });

  it('a phone the ledger does not know gets a plain failure, never an ok that changed nothing', async () => {
    const e = await setup();
    const owner = phone(e);
    await send(e, owner, 'POST', '/mobile/team/invites', firstInvite());
    const stranger = makeDevice();
    const c = e.svc.devices.createPending({ deviceName: 'x', label: null, publicKey: stranger.publicKey, host: HOST });
    if (!c.ok) throw new Error('setup');
    e.svc.devices.applyConfirm(c.device.id, { ok: true }); // active, but never written to the ledger
    const r = await send(e, { dev: stranger, presence: stranger, id: c.device.id }, 'POST', '/mobile/team/grants', { events: [grant('telegram:50')] });
    expect(r.status).toBe(500);
    expect(r.body.detail).toMatch(/not saved/);
    expect(e.svc.teamLog()!.grantOf('p-1', 'telegram:50')).toBeNull();
  });

  it('removing a person ends their own conversations too', async () => {
    const e = await setup();
    const owner = phone(e);
    await send(e, owner, 'POST', '/mobile/team/invites', firstInvite('p-1', [grant('telegram:50')]));
    e.svc.confineOwnConversation('-77', 'p-1');
    e.spy.changed.length = 0;
    await bearer(e, '/team/people/p-1/lower', { remove: true });
    expect(e.spy.changed.sort()).toEqual(['-77', 'telegram:50']);
  });

  it('a snapshot is kept, so a rolled-back log is noticed', async () => {
    const e = await setup();
    const owner = phone(e);
    await send(e, owner, 'POST', '/mobile/team/invites', firstInvite());
    const log = path.join(e.dir, 'state', 'team-access', 'log.jsonl');
    const before = fs.readFileSync(log, 'utf8');
    await send(e, owner, 'POST', '/mobile/team/grants', { events: [grant('telegram:50')] });
    fs.writeFileSync(log, before); // an attacker, or a restore, puts the older log back
    e.svc.teamLog()!.load();
    expect(e.svc.teamLog()!.healthState()).toBe('unreadable');
    expect(e.svc.teamOn()).toBe(true); // the strict direction
  });
});

describe('a change and its session end are one step', () => {
  it('the row is written while every affected lock is held', async () => {
    const e = await setup();
    const owner = phone(e);
    await send(e, owner, 'POST', '/mobile/team/invites', firstInvite('p-1', [grant('telegram:50'), grant('-7')]));
    expect(e.spy.lockedDuringCommit).toEqual(['-7', 'telegram:50']);
    e.spy.lockedDuringCommit = [];
    await bearer(e, '/team/people/p-1/lower', { remove: true });
    expect(e.spy.lockedDuringCommit).toEqual(['-7', 'telegram:50']);
  });
});

describe('restoring a lost list', () => {
  it('a read-only grant comes back, though it left no message, and an own conversation keeps its person', async () => {
    const e = await setup();
    const owner = phone(e);
    await send(e, owner, 'POST', '/mobile/team/invites', firstInvite('p-1', [grant('telegram:50', 'read')]));
    e.svc.confineOwnConversation('-77', 'p-1');
    const dir = path.join(e.dir, 'state');
    SafeFsExecutor.safeRmSync(path.join(dir, 'team-access', 'confined.json'), { force: true, operation: 'test' });
    SafeFsExecutor.safeRmSync(path.join(dir, 'team-access-last-good'), { recursive: true, force: true, operation: 'test' });
    expect((await faceId(e, owner, 'team-restore', '/mobile/team/restore')).status).toBe(200);
    const list = e.svc.teamLog()!.readConfined()!;
    expect(list.find((x) => x.ref === 'telegram:50')).toBeTruthy();
    expect(list.find((x) => x.ref === '-77')).toMatchObject({ personKey: 'p-1' });
  });
});

describe('restoring with damaged history', () => {
  const dirOf = (e: Env) => path.join(e.dir, 'state');
  const loseList = (e: Env) => {
    SafeFsExecutor.safeRmSync(path.join(dirOf(e), 'team-access', 'confined.json'), { force: true, operation: 'test' });
    SafeFsExecutor.safeRmSync(path.join(dirOf(e), 'team-access-last-good'), { recursive: true, force: true, operation: 'test' });
  };

  it('nothing is damaged: restore refuses, because confinement has no undo', async () => {
    const e = await setup({}, ['telegram:50', 'telegram:60']);
    const owner = phone(e);
    await send(e, owner, 'POST', '/mobile/team/invites', firstInvite());
    e.spy.changed.length = 0;
    const r = await faceId(e, owner, 'team-restore', '/mobile/team/restore');
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('nothing-to-restore');
    expect(e.spy.changed).toEqual([]);
    expect(e.svc.teamLog()!.readConfined()).toEqual([]);
  });

  it('an agent that never had a team cannot lock itself', async () => {
    const e = await setup({}, ['telegram:50']);
    const owner = phone(e);
    const r = await faceId(e, owner, 'team-restore', '/mobile/team/restore');
    expect(r.status).toBe(409);
    expect(fs.existsSync(path.join(dirOf(e), 'team-access', 'confined.json'))).toBe(false);
  });

  it('list gone, log whole: only what the log shows comes back', async () => {
    const e = await setup({}, ['telegram:50', 'telegram:60']);
    const owner = phone(e);
    await send(e, owner, 'POST', '/mobile/team/invites', firstInvite('p-1', [grant('telegram:50', 'read')]));
    loseList(e);
    await faceId(e, owner, 'team-restore', '/mobile/team/restore');
    expect(e.svc.teamLog()!.readConfined()!.map((x) => x.ref)).toEqual(['telegram:50']);
  });

  it('list gone, log with a row missing: nothing is released, so every conversation is confined', async () => {
    const e = await setup({}, ['telegram:50', 'telegram:60']);
    const owner = phone(e);
    await send(e, owner, 'POST', '/mobile/team/invites', firstInvite('p-1'));
    await send(e, owner, 'POST', '/mobile/team/grants', { events: [grant('telegram:50', 'read')] });
    await send(e, owner, 'POST', '/mobile/team/grants', { events: [grant('telegram:60', 'read')] });
    loseList(e);
    const log = path.join(dirOf(e), 'team-access', 'log.jsonl');
    const rows = fs.readFileSync(log, 'utf8').trim().split('\n');
    fs.writeFileSync(log, `${[...rows.slice(0, -2), rows[rows.length - 1]].join('\n')}\n`); // a gap in the middle
    e.svc.teamLog()!.load();
    expect((await faceId(e, owner, 'team-restore', '/mobile/team/restore')).status).toBe(200);
    expect(e.svc.teamLog()!.readConfined()!.map((x) => x.ref).sort()).toEqual(['telegram:50', 'telegram:60']);
  });

  it('ends every session first, under the lock', async () => {
    const e = await setup({}, ['telegram:50', 'telegram:60']);
    const owner = phone(e);
    await send(e, owner, 'POST', '/mobile/team/invites', firstInvite());
    loseList(e);
    e.spy.changed.length = 0;
    await faceId(e, owner, 'team-restore', '/mobile/team/restore');
    expect(e.spy.changed.sort()).toEqual(['telegram:50', 'telegram:60']);
  });
});

describe('order within a change', () => {
  it('a grant listed before its person is refused, not silently dropped', async () => {
    const e = await setup();
    const r = await send(e, phone(e), 'POST', '/mobile/team/invites', { events: [
      { type: 'team-on' }, { type: 'owner-pin', personKey: 'owner-1' }, grant('telegram:50', 'use', 'p-1'), { type: 'person-add', personKey: 'p-1', name: 'Mia', role: 'member' },
    ] });
    expect(r.status).toBe(404);
    expect(e.svc.teamOn()).toBe(false);
    expect(e.svc.teamLog()!.isConfined('telegram:50')).toBe(false);
  });

  it('a link that cannot be made leaves nothing saved or confined', async () => {
    const e = await setup();
    const owner = phone(e);
    await send(e, owner, 'POST', '/mobile/team/invites', firstInvite());
    e.svc.mintTeamLink = () => ({ ok: false, status: 429, error: 'too-many-mints' });
    const r = await send(e, owner, 'POST', '/mobile/team/invites', { events: [{ type: 'person-add', personKey: 'p-2', name: 'Bo', role: 'guest' }, grant('telegram:50', 'read', 'p-2')] });
    expect(r.status).toBe(429);
    expect(e.svc.teamStanding('p-2')).toBeNull();
    expect(e.svc.teamLog()!.isConfined('telegram:50')).toBe(false);
  });
});

describe('a live log lost with its snapshot intact', () => {
  it('reads as damaged, and restore brings the team back', async () => {
    const e = await setup();
    const owner = phone(e);
    await send(e, owner, 'POST', '/mobile/team/invites', firstInvite());
    SafeFsExecutor.safeRmSync(path.join(e.dir, 'state', 'team-access', 'log.jsonl'), { force: true, operation: 'test' });
    e.svc.teamLog()!.load();
    expect(e.svc.teamLog()!.healthState()).toBe('unreadable');
    expect(e.svc.teamOn()).toBe(true);
    expect((await faceId(e, owner, 'team-restore', '/mobile/team/restore')).status).toBe(200);
    expect(e.svc.teamStanding('p-1')?.tier).toBe('member');
  });
});

describe('a log with a row missing from the middle', () => {
  const dropMiddleRow = (e: Env) => {
    const log = path.join(e.dir, 'state', 'team-access', 'log.jsonl');
    const rows = fs.readFileSync(log, 'utf8').trim().split('\n');
    fs.writeFileSync(log, `${[...rows.slice(0, -2), rows[rows.length - 1]].join('\n')}\n`);
  };

  it('cannot quietly give back what a lost row took away', async () => {
    const e = await setup();
    const owner = phone(e);
    await send(e, owner, 'POST', '/mobile/team/invites', firstInvite());
    const member = phone(e, { userId: 'p-1', role: 'team' });
    await send(e, owner, 'POST', '/mobile/team/people/p-1', { events: [{ type: 'person-set', personKey: 'p-1', role: 'guest' }] });
    await send(e, owner, 'POST', '/mobile/team/grants', { events: [grant('telegram:50', 'read')] });
    expect(e.svc.teamStanding('p-1')?.tier).toBe('guest');
    dropMiddleRow(e); // the downgrade
    e.svc.teamLog()!.load();
    expect(e.svc.teamLog()!.healthState()).toBe('unreadable');
    expect(e.svc.teamStanding('p-1')).toBeNull();
    expect((await send(e, member, 'GET', '/mobile/team/people')).status).toBe(403);
  });

  it('after a restore the owner accepted it, the same log reads as fine at the next boot', async () => {
    const e = await setup();
    const owner = phone(e);
    await send(e, owner, 'POST', '/mobile/team/invites', firstInvite());
    await send(e, owner, 'POST', '/mobile/team/grants', { events: [grant('telegram:50', 'read')] });
    await send(e, owner, 'POST', '/mobile/team/grants', { events: [grant('telegram:60', 'read')] });
    SafeFsExecutor.safeRmSync(path.join(e.dir, 'state', 'team-access-last-good'), { recursive: true, force: true, operation: 'test' });
    dropMiddleRow(e);
    e.svc.teamLog()!.load();
    expect(e.svc.teamLog()!.healthState()).toBe('unreadable');
    expect((await faceId(e, owner, 'team-restore', '/mobile/team/restore')).status).toBe(200);
    e.svc.teamLog()!.load();
    expect(e.svc.teamLog()!.healthState()).toBe('ok');
    expect((await send(e, owner, 'POST', '/mobile/team/grants', { events: [grant('telegram:70', 'read')] })).status).toBe(200);
    e.svc.teamLog()!.load();
    expect(e.svc.teamLog()!.healthState()).toBe('ok');
  });
});

describe('requests to the owner', () => {
  const ask = (e: Env, body: unknown, session?: unknown) => {
    const q = request(e.app).post('/team/proposals').set('Authorization', 'Bearer tok-1');
    return (session ? q.set('x-test-session', JSON.stringify(session)) : q).send(body as object);
  };
  const askGrant = { change: { kind: 'grant', personKey: 'p-1', ref: 'telegram:50', access: 'read' }, reason: 'Needs the client notes' };
  const asMia = { audience: { kind: 'person', userId: 'p-1' }, placeKey: 'x' };

  it('a request gives nothing by itself, and the owner sees a line built from typed fields', async () => {
    const e = await setup();
    const owner = phone(e);
    await send(e, owner, 'POST', '/mobile/team/invites', firstInvite());
    expect((await ask(e, askGrant, asMia)).status).toBe(201);
    expect(e.svc.teamLog()!.grantOf('p-1', 'telegram:50')).toBeNull();
    expect(e.svc.teamLog()!.isConfined('telegram:50')).toBe(false);
    const list = (await send(e, owner, 'GET', '/mobile/team/requests')).body.requests;
    expect(list).toHaveLength(1);
    expect(list[0].summary).toBe('Mia asks to read Client work');
    expect(list[0].reason).toBe('Needs the client notes');
    expect((await send(e, owner, 'GET', '/mobile/team/context')).body.openRequests).toBe(1);
  });

  it('the requester comes from the session, whatever the body claims', async () => {
    const e = await setup();
    const owner = phone(e);
    await send(e, owner, 'POST', '/mobile/team/invites', firstInvite());
    await ask(e, { ...askGrant, requester: { kind: 'agent', label: 'The owner' } }, asMia);
    const r = (await send(e, owner, 'GET', '/mobile/team/requests')).body.requests[0];
    expect(r.requester).toEqual({ kind: 'person', label: 'Mia' });
  });

  it('a shared place reads as someone in that conversation', async () => {
    const e = await setup();
    const owner = phone(e);
    await send(e, owner, 'POST', '/mobile/team/invites', firstInvite());
    await ask(e, askGrant, { audience: { kind: 'place', placeKey: 'telegram:topic:50' }, placeKey: 'telegram:topic:50' });
    expect((await send(e, owner, 'GET', '/mobile/team/requests')).body.requests[0].requester.label).toBe('Someone in a shared conversation');
  });

  it('one open request per person, and asking again after an answer works', async () => {
    const e = await setup();
    const owner = phone(e);
    await send(e, owner, 'POST', '/mobile/team/invites', firstInvite());
    const first = await ask(e, askGrant, asMia);
    const again = await ask(e, askGrant, asMia);
    expect(again.status).toBe(409);
    expect(again.body.error).toBe('one-open-request');
    expect((await send(e, owner, 'POST', `/mobile/team/requests/${first.body.id}/decline`, {})).status).toBe(200);
    expect((await ask(e, askGrant, asMia)).status).toBe(201);
  });

  it.each([[{ kind: 'admin-please' }], [{ kind: 'role', personKey: 'p-1', role: 'admin' }], [{ kind: 'role', personKey: 'p-1', role: 'owner' }], [{ kind: 'grant', personKey: 'p-1', ref: 'telegram:50', access: 'all' }], [undefined]])('an untyped change %j is refused', async (change) => {
    const e = await setup();
    expect((await ask(e, { change })).status).toBe(400);
  });

  it('approving is the owner\'s signed write of exactly that change, and closes the request', async () => {
    const e = await setup();
    const owner = phone(e);
    await send(e, owner, 'POST', '/mobile/team/invites', firstInvite());
    const id = (await ask(e, askGrant, asMia)).body.id;
    const wrong = await send(e, owner, 'POST', '/mobile/team/grants', { events: [grant('telegram:50', 'use')], requestId: id });
    expect(wrong.status).toBe(409);
    expect(wrong.body.error).toBe('request-mismatch');
    expect(e.svc.teamLog()!.grantOf('p-1', 'telegram:50')).toBeNull();
    const right = await send(e, owner, 'POST', '/mobile/team/grants', { events: [grant('telegram:50', 'read')], requestId: id });
    expect(right.status).toBe(200);
    expect(e.svc.teamLog()!.grantOf('p-1', 'telegram:50')).toBe('read');
    expect((await send(e, owner, 'GET', '/mobile/team/requests')).body.requests).toEqual([]);
  });

  it('an answered request cannot be answered again', async () => {
    const e = await setup();
    const owner = phone(e);
    await send(e, owner, 'POST', '/mobile/team/invites', firstInvite());
    const id = (await ask(e, askGrant, asMia)).body.id;
    await send(e, owner, 'POST', `/mobile/team/requests/${id}/decline`, {});
    expect((await send(e, owner, 'POST', '/mobile/team/grants', { events: [grant('telegram:50', 'read')], requestId: id })).body.error).toBe('request-gone');
    expect((await send(e, owner, 'POST', `/mobile/team/requests/${id}/decline`, {})).status).toBe(404);
  });

  it('only the owner reads or declines; a phone cannot ask through the agent route', async () => {
    const e = await setup();
    const owner = phone(e);
    await send(e, owner, 'POST', '/mobile/team/invites', firstInvite());
    const member = phone(e, { userId: 'p-1', role: 'team' });
    const msp = phone(e, { userId: 'mo', role: 'msp' });
    const id = (await ask(e, askGrant, asMia)).body.id;
    for (const p of [member, msp]) {
      expect((await send(e, p, 'GET', '/mobile/team/requests')).status).toBe(403);
      expect((await send(e, p, 'POST', `/mobile/team/requests/${id}/decline`, {})).status).toBe(403);
      expect((await send(e, p, 'POST', '/team/proposals', askGrant)).status).toBe(403);
    }
    expect((await send(e, owner, 'GET', '/mobile/team/requests')).body.requests).toHaveLength(1);
  });
});

describe('the activity history', () => {
  it('keeps a removed person\'s name, because the log still holds it', async () => {
    const e = await setup();
    const owner = phone(e);
    await send(e, owner, 'POST', '/mobile/team/invites', firstInvite('p-1', [grant('telegram:50')]));
    await bearer(e, '/team/people/p-1/lower', { remove: true });
    const lines = (await send(e, owner, 'GET', '/mobile/team/activity')).body.lines.map((l: { text: string }) => l.text);
    expect(lines).toEqual(['Mia was invited', 'Mia was given use of a conversation', 'Mia was removed']);
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
    expect((await send(e, owner, 'POST', '/mobile/team/people/p-1', { events: [{ type: 'person-set', personKey: 'p-1', role: 'guest' }] })).status).toBe(200);
    expect(e.svc.teamStanding('p-1')?.tier).toBe('guest');
    // Admins are not part of step 2a.
    const admin = await send(e, owner, 'POST', '/mobile/team/people/p-1', { events: [{ type: 'person-set', personKey: 'p-1', role: 'admin' }] });
    expect(admin.status).toBe(409);
    expect(admin.body.error).toBe('admin-not-yet');
    expect(e.svc.teamStanding('p-1')?.tier).toBe('guest');
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
    // Two changes at once must not answer ok having done one.
    expect((await bearer(e, '/team/people/p-1/lower', { ref: 'telegram:50', remove: true })).body.error).toBe('one-change-at-a-time');
    expect(e.svc.teamStanding('p-1')).not.toBeNull();
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
    expect((await send(e, member, 'GET', '/mobile/team/people')).status).toBe(401);
    expect(e.svc.devices.get(member.id)!.status).toBe('revoked');
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

describe('on an ordinary agent', () => {
  it('the owner can invite and can always turn it off, with no development switch or console PIN', async () => {
    const e = await setup({ developmentAgent: false, dashboardPin: undefined, mobilePairing: { enabled: true, multiRoute: { enabled: false } } });
    const owner = phone(e);
    expect((await send(e, owner, 'POST', '/mobile/team/invites', firstInvite())).status).toBe(200);
    const r = await faceId(e, owner, 'team-off', '/mobile/team/off', { events: [{ type: 'team-off' }] });
    expect(r.status).toBe(200);
    expect(e.svc.teamOn()).toBe(false);
  });

  it('an owner phone with no Face ID cannot invite, because it could not turn this off', async () => {
    const e = await setup();
    const owner = phone(e, undefined, false);
    const r = await send(e, owner, 'POST', '/mobile/team/invites', firstInvite());
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('face-id-required');
    expect(e.svc.teamOn()).toBe(false);
  });
});

describe('after someone leaves', () => {
  it('their phones are revoked, on removal and on team-off, and the owner\'s stay', async () => {
    const e = await setup();
    const owner = phone(e);
    await send(e, owner, 'POST', '/mobile/team/invites', firstInvite());
    await send(e, owner, 'POST', '/mobile/team/invites', { events: [{ type: 'person-add', personKey: 'p-2', name: 'Bo', role: 'guest' }] });
    const one = phone(e, { userId: 'p-1', role: 'team' });
    const two = phone(e, { userId: 'p-2', role: 'team' });
    await send(e, owner, 'POST', '/mobile/team/people/p-1', { events: [{ type: 'person-remove', personKey: 'p-1' }] });
    expect(e.svc.devices.get(one.id)!.status).toBe('revoked');
    expect(e.svc.devices.get(two.id)!.status).toBe('active');
    await faceId(e, owner, 'team-off', '/mobile/team/off', { events: [{ type: 'team-off' }] });
    expect(e.svc.devices.get(two.id)!.status).toBe('revoked');
    expect(e.svc.devices.get(owner.id)!.status).toBe('active');
  });

  it('their key cannot be added again, so nothing of theirs comes back', async () => {
    const e = await setup();
    const owner = phone(e);
    await send(e, owner, 'POST', '/mobile/team/invites', firstInvite());
    await send(e, owner, 'POST', '/mobile/team/people/p-1', { events: [{ type: 'person-remove', personKey: 'p-1' }] });
    const again = await send(e, owner, 'POST', '/mobile/team/invites', { events: [{ type: 'person-add', personKey: 'p-1', name: 'Mia', role: 'member' }] });
    expect(again.status).toBe(409);
    expect(again.body.error).toBe('person-key-used');
    expect((await send(e, owner, 'POST', '/mobile/team/invites', { events: [{ type: 'person-add', personKey: 'p-new', name: 'Mia', role: 'member' }] })).status).toBe(200);
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
    SafeFsExecutor.safeRmSync(path.join(e.dir, 'state', 'team-access', 'confined.json'), { force: true, operation: 'test' });
    expect((await faceId(e, owner, 'team-restore', '/mobile/team/restore')).status).toBe(200);
  });
});

describe('when a machine\'s record has a gap', () => {
  /** A real second machine, known to this one, writing an event from a newer build. */
  const peerRow = async (dir: string) => {
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'team-peer-'));
    await new MachineIdentityManager(other).generateIdentity({ name: 'peer' });
    const identity = JSON.parse(fs.readFileSync(path.join(other, 'machine', 'identity.json'), 'utf8'));
    const here = new MachineIdentityManager(dir);
    here.registerMachine(identity, 'standby');
    here.storeRemoteIdentity(identity);
    const log = new TeamAccessLog({ stateDir: other, signer: loadMachineSigner(other), verify: () => 'verified' });
    return log.appendMachineEvents([{ type: 'from-the-future' } as never]);
  };
  const gone = (machine: string, incarnation: string, throughSeq: number) => ({ events: [{ type: 'origin-gone', machine, incarnation, throughSeq }] });

  it('every team phone waits, the owner is told why, and only the owner with Face ID can settle it', async () => {
    const e = await setup();
    const owner = phone(e);
    await send(e, owner, 'POST', '/mobile/team/invites', firstInvite('p-1', [grant('telegram:50')]));
    const member = phone(e, { userId: 'p-1', role: 'team' });
    expect((await send(e, member, 'GET', '/mobile/team/people')).status).toBe(200);

    const row = await peerRow(e.dir);
    expect(e.svc.teamLog()!.ingest([row]).added).toBe(1);
    const peer = row.origin as string; const stream = row.incarnation as string;
    const held = await send(e, member, 'GET', '/mobile/team/people');
    expect(held.status).toBe(403);
    expect(held.body.error).toBe('access-being-checked');
    const context = await send(e, owner, 'GET', '/mobile/team/context');
    expect(context.body.refusal).toBe('access-being-checked');
    expect(context.body.held.map((g: { kind: string }) => g.kind)).toEqual(['unplaced']);

    const body = gone(peer, stream, 1);
    expect((await send(e, member, 'POST', '/mobile/team/origin-gone', body)).status).toBe(403);
    expect((await send(e, owner, 'POST', '/mobile/team/origin-gone', body)).status).toBe(401);
    const self = loadMachineSigner(e.dir)!.machineId();
    expect((await faceId(e, owner, 'team-origin-gone', '/mobile/team/origin-gone', gone(self, e.svc.teamLog()!.currentIncarnation(), 0))).body.error).toBe('origin-is-this-machine');
    expect((await faceId(e, owner, 'team-origin-gone', '/mobile/team/origin-gone', gone('peer-c', 'i1', 0))).body.error).toBe('unknown-origin');
    expect((await faceId(e, owner, 'team-origin-gone', '/mobile/team/origin-gone', gone(peer, stream, 9))).body.error).toBe('unknown-origin');
    expect((await send(e, member, 'GET', '/mobile/team/people')).status).toBe(403);

    const settled = await faceId(e, owner, 'team-origin-gone', '/mobile/team/origin-gone', body);
    expect(settled.status).toBe(200);
    expect((await send(e, member, 'GET', '/mobile/team/people')).status).toBe(200);
    e.svc.teamLog()!.load();
    expect(e.svc.teamLog()!.gaps()).toEqual([]);
  });

  it('a peer with no rows here can be retired, but only a peer this machine knows', async () => {
    const e = await setup();
    const owner = phone(e);
    await send(e, owner, 'POST', '/mobile/team/invites', firstInvite('p-1', [grant('telegram:50')]));
    e.svc.teamPuller = { knows: (m: string) => m === 'retired', refusing: () => false, belowFloor: () => [], waitingOn: () => [] } as never;
    expect((await faceId(e, owner, 'team-origin-gone', '/mobile/team/origin-gone', gone('stranger', 'none', 0))).body.error).toBe('unknown-origin');
    expect((await faceId(e, owner, 'team-origin-gone', '/mobile/team/origin-gone', gone('retired', 'none', 3))).body.error).toBe('unknown-origin');
    expect((await faceId(e, owner, 'team-origin-gone', '/mobile/team/origin-gone', gone('retired', 'none', 0))).status).toBe(200);
    e.svc.teamPuller = null;
  });
});

describe('a machine that cannot keep a team\'s promises', () => {
  const stuck = { belowFloor: () => [{ machineId: 'laptop', reason: 'old-build' }], waitingOn: () => [], refusing: () => false, behind: () => false };

  it('blocks new invites and grants, says which machine, and leaves existing phones working', async () => {
    const e = await setup();
    const owner = phone(e);
    await send(e, owner, 'POST', '/mobile/team/invites', firstInvite('p-1', [grant('telegram:50')]));
    const member = phone(e, { userId: 'p-1', role: 'team' });
    e.svc.teamPuller = stuck as never;
    const invite = await send(e, owner, 'POST', '/mobile/team/invites', { events: [{ type: 'person-add', personKey: 'p-2', name: 'Bo', role: 'guest' }] });
    expect(invite.status).toBe(409);
    expect(invite.body.error).toBe('machine-below-floor');
    expect(invite.body.machines).toEqual([{ machineId: 'laptop', reason: 'old-build' }]);
    expect((await send(e, owner, 'POST', '/mobile/team/grants', { events: [grant('telegram:51')] })).body.error).toBe('machine-below-floor');
    expect((await send(e, owner, 'GET', '/mobile/team/context')).body.machinesBelowFloor).toHaveLength(1);
    expect((await send(e, member, 'GET', '/mobile/team/people')).status).toBe(200);
    e.svc.teamPuller = null;
    expect((await send(e, owner, 'POST', '/mobile/team/grants', { events: [grant('telegram:51')] })).status).toBe(200);
  });
});

describe('a grant this machine would have refused', () => {
  it('is undone by a row this machine signs, and a grant it would accept stays', async () => {
    const e = await setup();
    const owner = phone(e);
    await send(e, owner, 'POST', '/mobile/team/invites', firstInvite('p-1', [grant('telegram:50'), grant('telegram:51')]));
    e.gate.jobs.add(50); // only this machine knows it is a job's topic
    e.svc.reconcileTeamPhones();
    const held = e.svc.teamLog()!.state().grants.get('p-1')!;
    expect(held.has('telegram:50')).toBe(false);
    expect(held.has('telegram:51')).toBe(true);
    const rows = e.svc.teamLog()!.allRows();
    expect(rows[rows.length - 1]).toMatchObject({ kind: 'machine', events: [{ type: 'lower', personKey: 'p-1', ref: 'telegram:50' }] });
  });
});

describe('a message that waited', () => {
  it('is judged at delivery: a person removed or a read-only grant is refused, and a hold stops everyone', async () => {
    const e = await setup();
    const owner = phone(e);
    await send(e, owner, 'POST', '/mobile/team/invites', firstInvite('p-1', [grant('telegram:50'), { ...grant('telegram:51'), access: 'read' }]));
    expect(e.svc.teamMayDeliver('p-1', 'telegram:50')).toBe(true);
    expect(e.svc.teamMayDeliver('p-1', 'telegram:51')).toBe(false);
    expect(e.svc.teamMayDeliver('p-1', 'telegram:52')).toBe(false);
    expect(e.svc.teamMayDeliver('stranger', 'telegram:50')).toBe(false);
    e.gate.now = 'memory-privacy-required';
    expect(e.svc.teamMayDeliver('p-1', 'telegram:50')).toBe(false);
    e.gate.now = 'ok';
    await send(e, owner, 'POST', '/mobile/team/people/p-1', { events: [{ type: 'person-remove', personKey: 'p-1' }] });
    expect(e.svc.teamMayDeliver('p-1', 'telegram:50')).toBe(false);
  });
});

describe('team settings for the whole agent (team-switches-agent-wide)', () => {
  const faceIdSwitch = async (e: Env, p: Phone, setting: string) => {
    const c = await send(e, p, 'POST', '/mobile/permissions/challenge', { action: 'team-switch-on', target: setting });
    expect(c.status).toBe(200);
    const presenceSig = p.presence.sign(permissionPresenceMessage(p.id, HOST, c.body.challenge, `team-switch-on ${setting}`));
    return send(e, p, 'POST', '/mobile/team/switches/turn-on', { setting, challenge: c.body.challenge, presenceSig });
  };
  const rig = async () => {
    const asked: string[] = [];
    const machines = [
      { machineId: 'studio', self: true, outcome: 'applied', result: 'applied', restarting: true, willRetry: false },
      { machineId: 'laptop', self: false, outcome: 'unreachable', result: 'unreachable', restarting: false, willRetry: true },
    ];
    const e = await setup({}, [], {
      turnOnEverywhere: async (setting) => { asked.push(setting); return { setting, machines: machines as never }; },
      selfStanding: () => ({ machineId: 'studio', standing: { enforcement: 1, native: true, privacy: false } }),
      switchRequests: () => [{ setting: 'memory-privacy', machineId: 'laptop' }],
    });
    e.svc.teamPuller = {
      belowFloor: () => [{ machineId: 'laptop', reason: 'memory-privacy-off' }, { machineId: 'mama', reason: 'native-off' }],
      standings: () => [
        { machineId: 'laptop', standing: { enforcement: 1, native: true, privacy: false } },
        { machineId: 'mama', standing: { enforcement: 1, native: false, privacy: true } },
      ],
      waitingOn: () => [], refusing: () => false, behind: () => false, knows: () => true,
    } as never;
    return { e, asked, machines };
  };

  it('the context gives one line per setting, counting this machine, and keeps machinesBelowFloor for older apps', async () => {
    const { e } = await rig();
    const owner = phone(e);
    const ctx = await send(e, owner, 'GET', '/mobile/team/context');
    expect(ctx.status).toBe(200);
    expect(ctx.body.teamSwitches).toEqual([
      { setting: 'app-conversations', on: false, offOn: ['mama'], action: 'turn-on-everywhere', requested: [] },
      { setting: 'memory-privacy', on: false, offOn: ['studio', 'laptop'], action: 'turn-on-everywhere', requested: ['laptop'] },
    ]);
    expect(ctx.body.machinesBelowFloor).toHaveLength(2);
    expect(ctx.body.waitingOn).toEqual([]);
  });

  it('the agent reads the same lines the phone shows, and its token cannot read the phone route or turn anything on', async () => {
    const { e, asked } = await rig();
    const owner = phone(e);
    const ctx = await send(e, owner, 'GET', '/mobile/team/context');
    // GET /team/people serves exactly this summary to the agent token.
    expect(e.svc.teamSwitchesSummary).toBeTypeOf('function');
    expect(e.svc.teamSwitchesSummary!()).toEqual(ctx.body.teamSwitches);
    expect((await request(e.app).get('/mobile/team/context').set('Authorization', 'Bearer tok-1')).status).toBe(403);
    for (const setting of ['memory-privacy', 'app-conversations', 'team-access']) {
      const r = await bearer(e, '/mobile/team/switches/turn-on', { setting });
      expect([401, 403]).toContain(r.status);
    }
    expect([401, 403]).toContain((await bearer(e, '/mobile/team/memory-privacy', {})).status);
    expect(asked).toEqual([]);
  });

  it('the owner turns a setting on for every machine with Face ID, and the answer lists each machine', async () => {
    const { e, asked, machines } = await rig();
    const owner = phone(e);
    const r = await faceIdSwitch(e, owner, 'memory-privacy');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, setting: 'memory-privacy', restarting: true, machines });
    expect(asked).toEqual(['memory-privacy']);
    // The older memory-privacy action now reaches every machine too.
    const c = await send(e, owner, 'POST', '/mobile/permissions/challenge', { action: 'team-memory-privacy', target: 'team' });
    const presenceSig = owner.presence.sign(permissionPresenceMessage(owner.id, HOST, c.body.challenge, 'team-memory-privacy team'));
    expect((await send(e, owner, 'POST', '/mobile/team/memory-privacy', { challenge: c.body.challenge, presenceSig })).status).toBe(200);
    expect(asked).toEqual(['memory-privacy', 'memory-privacy']);
    expect(e.spy.privacy).toBe(0);
  });

  it('the owner turns files on for every machine with Face ID (the media-off notice\'s one-tap path), and team-access never includes it', async () => {
    const { e, asked, machines } = await rig();
    const owner = phone(e);
    const r = await faceIdSwitch(e, owner, 'files');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, setting: 'files', restarting: true, machines });
    expect(asked).toEqual(['files']);
    expect((await bearer(e, '/mobile/team/switches/turn-on', { setting: 'files' })).status).toBeGreaterThanOrEqual(401);
  });

  it('one Face ID turns on everything team access needs (team-access), and a team-access signature is not a single-setting one', async () => {
    // Operator 2026-11-09: "it should be one single thing for the whole agent".
    const { e, asked } = await rig();
    const owner = phone(e);
    const r = await faceIdSwitch(e, owner, 'team-access');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, setting: 'team-access', restarting: true, settings: ['app-conversations', 'memory-privacy'] });
    expect(asked).toEqual(['app-conversations', 'memory-privacy']);
    // A challenge issued for team-access cannot be spent as memory-privacy: the signed line names the target.
    const c = await send(e, owner, 'POST', '/mobile/permissions/challenge', { action: 'team-switch-on', target: 'team-access' });
    const sig = owner.presence.sign(permissionPresenceMessage(owner.id, HOST, c.body.challenge, 'team-switch-on team-access'));
    expect((await send(e, owner, 'POST', '/mobile/team/switches/turn-on', { setting: 'memory-privacy', challenge: c.body.challenge, presenceSig: sig })).status).not.toBe(200);
  });

  it('nobody but the owner, with Face ID, and only a named setting', async () => {
    const { e, asked } = await rig();
    const owner = phone(e);
    await send(e, owner, 'POST', '/mobile/team/invites', firstInvite());
    const member = phone(e, { userId: 'p-1', role: 'team' });
    expect((await send(e, member, 'POST', '/mobile/team/switches/turn-on', { setting: 'memory-privacy' })).status).toBe(403);
    expect((await bearer(e, '/mobile/team/switches/turn-on', { setting: 'memory-privacy' })).status).toBe(403);
    expect((await send(e, owner, 'POST', '/mobile/team/switches/turn-on', { setting: 'memory-privacy' })).status).toBe(401);
    const c = await send(e, owner, 'POST', '/mobile/permissions/challenge', { action: 'team-switch-on', target: 'memoryPrivacy.enabled' });
    expect(c.status).toBe(400);
    // A signature for one setting cannot turn on another.
    const ok = await send(e, owner, 'POST', '/mobile/permissions/challenge', { action: 'team-switch-on', target: 'memory-privacy' });
    const presenceSig = owner.presence.sign(permissionPresenceMessage(owner.id, HOST, ok.body.challenge, 'team-switch-on memory-privacy'));
    expect((await send(e, owner, 'POST', '/mobile/team/switches/turn-on', { setting: 'app-conversations', challenge: ok.body.challenge, presenceSig })).status).toBe(401);
    expect(asked).toEqual([]);
  });

  it('a failure on this machine is a failure, with every machine listed', async () => {
    const e = await setup({}, [], { turnOnEverywhere: async (setting) => ({ setting, machines: [{ machineId: 's', self: true, outcome: 'failed', result: 'failed', restarting: false, willRetry: false }] }) });
    const owner = phone(e);
    const r = await faceIdSwitch(e, owner, 'app-conversations');
    expect(r.status).toBe(503);
    expect(r.body.error).toBe('restart-unavailable');
    expect(r.body.machines).toHaveLength(1);
  });

  it('a setting that is off blocks an invite with a whole-agent fix, never a mark-it-gone', async () => {
    const { e } = await rig();
    const owner = phone(e);
    const r = await send(e, owner, 'POST', '/mobile/team/invites', firstInvite());
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('machine-below-floor');
    expect(r.body.detail).toContain('whole agent');
    expect(r.body.detail).not.toContain('gone');
    expect(r.body.teamSwitches).toHaveLength(2);
  });
});
