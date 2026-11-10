/**
 * The §9 status table: owner, `msp` with no orgRole, member, guest and a removed person (no admins in step 2a), on
 * EVERY route in the device allowlist, with team access off, on and after `team-off`. Paths are
 * generated from the allowlist itself, so a route added later is in the table without anyone
 * remembering. This tests the gate alone: past it, a stub answers 299.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { ProcessIntegrity } from '../../src/core/ProcessIntegrity.js';
import { authMiddleware } from '../../src/server/middleware.js';
import { DEVICE_ALLOWLIST, MobilePairingService, deviceAuthenticator, teamConversationTarget, type MobilePairingDeps } from '../../src/server/mobilePairingRoutes.js';
import { createTeamRouter } from '../../src/server/teamRoutes.js';
import { mountMobilePermissionsRoutes, permissionPresenceMessage, type MobilePermissionsDeps } from '../../src/server/mobilePermissionsRoutes.js';
import { MobileDeviceKeyLedger } from '../../src/core/MobileDeviceKeyLedger.js';
import { identityKeyLookup, loadMachineSigner } from '../../src/core/AppRecordSignatures.js';
import { MachineIdentityManager } from '../../src/core/MachineIdentity.js';
import { canonicalString } from '../../src/core/MobileDeviceKeys.js';
import { tierAtLeast, type Tier } from '../../src/permissions/TeamAccess.js';
import { makeDevice } from '../helpers/mobileDevice.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const HOST = 'echo.example.dev';
const UUID = '11111111-1111-4111-8111-111111111111';
const dirs: string[] = [];
const services: MobilePairingService[] = [];
beforeAll(() => { ProcessIntegrity.reset(); ProcessIntegrity.initialize('1.2.36', null); });
afterAll(() => {
  ProcessIntegrity.reset();
  for (const s of services) s.stop();
  for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/integration/team-access-status-table.test.ts' });
});

/** One concrete path for an allowlist pattern. */
function sample(re: RegExp): string {
  return re.source
    .replace(/^\^/, '').replace(/\$$/, '')
    .replace(/\[0-9a-f\]\{8\}-\[0-9a-f\]\{4\}-[^)]*?\{12\}/g, UUID)
    .replace(/\[0-9a-f\]\{64\}/g, 'a'.repeat(64))
    .replace(/\(\?:/g, '(')
    .replace(/\(([^()|]+)(\|[^()]*)?\)\??/g, '$1')
    .replace(/\[[^\]]*\](\{[^}]*\}|\+|\*)?/g, 'x')
    .replace(/\\d(\{[^}]*\}|\+)?/g, '50')
    .replace(/\\\//g, '/').replace(/\\\./g, '.').replace(/\\-/g, '-');
}

async function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'team-tbl-'));
  dirs.push(dir);
  fs.writeFileSync(path.join(dir, 'users.json'), JSON.stringify([{ id: 'mo', name: 'Mo', channels: [], permissions: ['user'] }]));
  await new MachineIdentityManager(dir).generateIdentity({ name: 'test' });
  const config = { projectName: 'echo', projectDir: dir, stateDir: dir, port: 0, authToken: 'tok-1', developmentAgent: true, dashboardPin: '424242', tunnel: { enabled: true, type: 'named', token: 'x', hostname: HOST }, mobilePairing: { multiRoute: { enabled: false } } };
  const svc = new MobilePairingService({
    config: config as never, stateDir: dir, holdsLease: () => true, selfMachineId: 'm1', teamGate: () => 'ok',
    tunnel: () => ({ lifecycleState: { lastState: 'active', activeProvider: 'cloudflare-named' } }), ownerDM: async () => 1,
  } as MobilePairingDeps);
  services.push(svc);
  svc.nativeOn = true;
  const signer = loadMachineSigner(dir)!;
  svc.keyLedger = new MobileDeviceKeyLedger({ stateDir: dir, signer, keyLookup: identityKeyLookup(dir) });
  svc.useAppConversationStore({ getConversation: () => ({ ownerPerson: null }) });
  svc.deviceRateOk = () => true;
  const app = express();
  app.use(express.raw({ type: () => true, limit: '2mb' }));
  app.use((req, _res, next) => { (req as unknown as { rawBody: Buffer }).rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0); next(); });
  app.use(authMiddleware(() => 'tok-1', 'echo', undefined, deviceAuthenticator(svc)));
  // Only the team writes this table drives run for real; everything else stops at the stub.
  const team = createTeamRouter(svc, {
    signer: () => signer, applyConversationChange: async (_ref, change) => change(),
    isSystemTopic: () => false, isJobTopic: () => false,
    ownerProfile: () => ({ userId: 'owner-1', several: false, links: {} }),
    logsDir: path.join(dir, 'logs'), stateDir: dir, conversationTitle: () => null, restoreRefs: () => ({ teamRefs: [], allRefs: () => [] }), requireMemoryPrivacy: () => true,
  });
  const permissions = express.Router();
  mountMobilePermissionsRoutes(permissions, {
    pairing: () => svc, config: () => config as never, stateDir: dir, bearerOk: () => false,
    teamAction: async (kind, req, deviceId) => svc.teamActionRunner!(kind, req, deviceId) as never,
  } as unknown as MobilePermissionsDeps);
  const live = { setup: false };
  app.use((req, res, next) => {
    if (!live.setup) { res.status(299).json({ passed: true }); return; }
    req.body = JSON.parse((req as unknown as { rawBody: Buffer }).rawBody.toString() || '{}');
    team(req, res, () => permissions(req, res, next));
  });
  const log = svc.teamLog()!;
  const makePhone = (person?: { userId: string; role: 'msp' | 'team' }) => {
    const dev = makeDevice();
    const c = svc.devices.createPending({ deviceName: 'p', label: null, publicKey: dev.publicKey, host: HOST, ...(person ?? {}) });
    if (!c.ok) throw new Error('setup');
    svc.devices.applyConfirm(c.device.id, { ok: true });
    return { dev, id: c.device.id };
  };
  return { app, svc, log, makePhone, live };
}
type Env = Awaited<ReturnType<typeof setup>>;
type Phone = ReturnType<Env['makePhone']> & { presence?: ReturnType<typeof makeDevice> };

let tick = 0;
async function hit(e: Env, p: Phone, method: string, url: string, body: string | undefined): Promise<number> {
  const octet = body === 'octet';
  const raw = body === 'json' ? Buffer.from('{}') : octet ? Buffer.from('x') : undefined;
  const time = String(Date.now() + (tick++ % 1000));
  const sig = p.dev.sign(canonicalString(p.id, HOST, method, url, time, raw));
  const verb = method.toLowerCase() as 'get' | 'post' | 'put' | 'patch' | 'delete';
  const q = request(e.app)[verb](url).set('X-Instar-Device', p.id).set('X-Instar-Device-Time', time).set('X-Instar-Device-Sig', sig);
  const r = raw ? await q.set('Content-Type', octet ? 'application/octet-stream' : 'application/json').send(raw.toString()) : await q;
  return r.status;
}

async function post(e: Env, p: Phone, url: string, body: unknown): Promise<number> {
  const raw = Buffer.from(JSON.stringify(body));
  const time = String(Date.now() + (tick++ % 1000));
  const sig = p.dev.sign(canonicalString(p.id, HOST, 'POST', url, time, raw));
  const r = await request(e.app).post(url).set('X-Instar-Device', p.id).set('X-Instar-Device-Time', time).set('X-Instar-Device-Sig', sig).set('Content-Type', 'application/json').send(raw.toString());
  return r.status;
}

/** Real signed invites, so standing comes from the real log. */
async function teamOn(e: Env, owner: Phone) {
  e.svc.keyLedger!.recordActivation(e.svc.devices.get(owner.id)!, 'telegram-dm', new Date(Date.now() - 60_000).toISOString());
  owner.presence = makeDevice();
  e.svc.devices.setPresenceKey(owner.id, owner.presence.publicKey);
  e.live.setup = true;
  const status = await post(e, owner, '/mobile/team/invites', { events: [
    { type: 'team-on' }, { type: 'owner-pin', personKey: 'owner-1' },
    { type: 'person-add', personKey: 'p-member', name: 'M', role: 'member' },
  ] });
  const second = await post(e, owner, '/mobile/team/invites', { events: [{ type: 'person-add', personKey: 'p-guest', name: 'G', role: 'guest' }] });
  e.live.setup = false;
  expect([status, second]).toEqual([200, 200]);
  expect(e.svc.teamStanding('p-member')?.tier).toBe('member');
}
/** The real Face ID route, so the signed `team-off` row is the real one. */
async function teamOff(e: Env, owner: Phone) {
  const presence = owner.presence!;
  e.live.setup = true;
  const raw = (url: string, body: unknown) => {
    const text = JSON.stringify(body);
    const time = String(Date.now() + (tick++ % 1000));
    const sig = owner.dev.sign(canonicalString(owner.id, HOST, 'POST', url, time, Buffer.from(text)));
    return request(e.app).post(url).set('X-Instar-Device', owner.id).set('X-Instar-Device-Time', time).set('X-Instar-Device-Sig', sig).set('Content-Type', 'application/json').send(text);
  };
  const c = await raw('/mobile/permissions/challenge', { action: 'team-off', target: 'team' });
  const presenceSig = presence.sign(permissionPresenceMessage(owner.id, HOST, c.body.challenge, 'team-off team'));
  const r = await raw('/mobile/team/off', { events: [{ type: 'team-off' }], challenge: c.body.challenge, presenceSig });
  e.live.setup = false;
  return r;
}

/** Patterns the generator cannot read: a lookahead, or a shape it would get wrong. */
const NAMED: Array<[RegExp, string]> = [
  [/attention/, '/mobile/attention/item-1/choice'],
  [/chat\\\/slack.*pins/, '/mobile/chat/slack/-5/pins'],
  [/chat\\\/\[1-9\].*pins/, '/mobile/chat/50/pins'],
  [/chat\\\/slack.*messages/, '/mobile/chat/slack/-5/messages'],
  [/chat\\\/slack/, '/mobile/chat/slack/-5'],
  [/sessions\\\/door/, '/mobile/sessions/door/50'],
  [/sessions\\\/move/, '/mobile/sessions/move/50'],
  [/secrets\\\/requests.*cancel/, '/mobile/secrets/requests/abcdef0123456789/cancel'],
];
const pathFor = (re: RegExp) => {
  const s = sample(re);
  if (re.test(s)) return s;
  return NAMED.map(([m, url]) => (m.test(re.source) && re.test(url) ? url : null)).find(Boolean) ?? s;
};
const rules = DEVICE_ALLOWLIST.map((r) => ({ rule: r, url: pathFor(r.re) }));
const unsampled = rules.filter(({ rule, url }) => !rule.re.test(url)).map(({ rule }) => rule.re.source);
const refused = (s: number) => s === 403 || s === 404 || s === 401;
/** `/health` is public, so no device check runs on it at all. */
const open = (r: (typeof rules)[number]) => r.rule.unassignedOk || r.url === '/health';

describe('the status table', () => {
  it('every allowlist route has a generated path', () => {
    expect(unsampled).toEqual([]);
  });

  const teamMay = (tier: Exclude<Tier, 'owner'>, r: (typeof rules)[number]) => {
    if (!tierAtLeast(tier, r.rule.tier as Tier)) return false;
    // A conversation route names a conversation nobody here holds, so it is refused for everyone.
    return !teamConversationTarget(r.rule.method, r.url);
  };

  it('team access ON: each team tier passes exactly its routes, on both sides', async () => {
    const e = await setup();
    await teamOn(e, e.makePhone());
    const wrong: string[] = [];
    for (const [tier, personKey] of [['member', 'p-member'], ['guest', 'p-guest']] as const) {
      const p = e.makePhone({ userId: personKey, role: 'team' });
      for (const r of rules) {
        const s = await hit(e, p, r.rule.method, r.url, r.rule.body);
        const expected = teamMay(tier, r);
        if (expected ? s !== 299 : !refused(s)) wrong.push(`${tier} ${r.rule.method} ${r.url} -> ${s}, expected ${expected ? 'pass' : 'refuse'}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it('team access ON: the owner passes every route; an msp phone passes every route that is not owner-only', async () => {
    const e = await setup();
    const owner = e.makePhone();
    await teamOn(e, owner);
    const msp = e.makePhone({ userId: 'mo', role: 'msp' });
    const wrong: string[] = [];
    for (const r of rules) {
      const json = r.rule.body;
      const o = await hit(e, owner, r.rule.method, r.url, json);
      if (o !== 299) wrong.push(`owner ${r.rule.method} ${r.url} -> ${o}`);
      const m = await hit(e, msp, r.rule.method, r.url, json);
      if (r.rule.ownerOnly ? !refused(m) : (m !== 299 && !(teamConversationTarget(r.rule.method, r.url)))) wrong.push(`msp ${r.rule.method} ${r.url} -> ${m}`);
    }
    expect(wrong).toEqual([]);
  });

  it.each([['with team access never on', false], ['after team-off', true]])('%s: every team phone is refused everywhere and owner and msp are as before', async (_n, wasOn) => {
    const e = await setup();
    const first = e.makePhone();
    if (wasOn) { await teamOn(e, first); expect((await teamOff(e, first)).status).toBe(200); }
    const owner = e.makePhone(); // a fresh phone: the Face ID steps above share a rate bucket with this table
    const member = e.makePhone({ userId: 'p-member', role: 'team' });
    const msp = e.makePhone({ userId: 'mo', role: 'msp' });
    const wrong: string[] = [];
    for (const r of rules) {
      const json = r.rule.body;
      const t = await hit(e, member, r.rule.method, r.url, json);
      if (open(r) ? t !== 299 : !refused(t)) wrong.push(`team ${r.rule.method} ${r.url} -> ${t}`);
      const o = await hit(e, owner, r.rule.method, r.url, json);
      if (o !== 299) wrong.push(`owner ${r.rule.method} ${r.url} -> ${o}`);
      const m = await hit(e, msp, r.rule.method, r.url, json);
      if (r.rule.ownerOnly ? !refused(m) : (m !== 299 && !teamConversationTarget(r.rule.method, r.url))) wrong.push(`msp ${r.rule.method} ${r.url} -> ${m}`);
    }
    expect(wrong).toEqual([]);
  });

  it('a removed person is refused on every route', async () => {
    const e = await setup();
    await teamOn(e, e.makePhone());
    const p = e.makePhone({ userId: 'p-gone', role: 'team' });
    const wrong: string[] = [];
    for (const r of rules) {
      const s = await hit(e, p, r.rule.method, r.url, r.rule.body);
      // Its own status, confirm and self-revoke stay open, so a person can always unpair their phone.
      if (open(r) ? s !== 299 : !refused(s)) wrong.push(`${r.rule.method} ${r.url} -> ${s}`);
    }
    expect(wrong).toEqual([]);
  });
});
