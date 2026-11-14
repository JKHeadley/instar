/**
 * HTTP pipeline for starting an account sign-in from the owner's phone with Face ID instead of the
 * dashboard PIN (docs/specs/account-sign-in-face-id.md), through the production authMiddleware +
 * deviceAuthenticator + the real MobilePairingService and its device allowlist:
 * an owner phone with a fresh presence signature over `account-sign-in <accountId>@<machineId>`
 * reaches the injected start-cell core and gets its body back unchanged; a member phone, the bearer, a
 * bad signature, a signature for another account or machine, a replayed challenge and malformed ids
 * are refused before the core runs, and each refusal is audited.
 */
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { authMiddleware } from '../../src/server/middleware.js';
import { MobilePairingService, deviceAuthenticator, type MobilePairingDeps } from '../../src/server/mobilePairingRoutes.js';
import { mountMobilePermissionsRoutes, permissionPresenceMessage, type MobilePermissionsDeps, type ActionResult } from '../../src/server/mobilePermissionsRoutes.js';
import { canonicalString } from '../../src/core/MobileDeviceKeys.js';
import { makeDevice } from '../helpers/mobileDevice.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const HOST = 'echo.example.dev';
const ROUTE = '/mobile/accounts/sign-in/start';
const MACHINE = 'm_03b30f5b32c6ef3eb0afd3ca7054e252';
const OTHER_MACHINE = 'm_11111111111111111111111111111111';
const dirs: string[] = [];
const services: MobilePairingService[] = [];
afterAll(() => {
  for (const s of services) s.stop();
  for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/integration/account-sign-in-face-id.test.ts' });
});

/** The body start-cell answers on success (routes.ts runMatrixStartCell), as the phone already parses it. */
const STARTED = { verificationUrl: 'https://claude.ai/oauth/authorize?x=1', loginId: 'gearfinity3d', machineId: MACHINE, expectedEmail: 'gear@example.com', ttlExpiresAt: '2026-11-10T06:00:00.000Z', notice: null, kind: 'claude' };

function setup(opts: { withCore?: boolean } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acct-faceid-int-'));
  dirs.push(dir);
  fs.writeFileSync(path.join(dir, 'users.json'), JSON.stringify([{ id: 'justin', name: 'Justin', channels: [], permissions: ['user'] }]));
  const config = { projectName: 'echo', stateDir: dir, authToken: 'tok-1', developmentAgent: true, dashboardPin: '424242', mobilePairing: { multiRoute: { enabled: false } } } as never;
  const svc = new MobilePairingService({ config, stateDir: dir, holdsLease: () => true, selfMachineId: 'm_self' } as MobilePairingDeps);
  services.push(svc);
  const calls: Array<[string, string]> = [];
  const deps = {
    pairing: () => svc,
    config: () => config,
    stateDir: dir,
    bearerOk: (req: express.Request) => req.headers.authorization === 'Bearer tok-1',
    ...(opts.withCore === false ? {} : {
      startAccountSignIn: async (accountId: string, machineId: string): Promise<ActionResult> => {
        calls.push([accountId, machineId]);
        return accountId === 'missing' ? { status: 404, body: { error: 'no such account', code: 'subscription-account-not-found', accountId, repairRequired: true } } : { status: 201, body: { ...STARTED, loginId: accountId, machineId } };
      },
    }),
  } as unknown as MobilePermissionsDeps;
  const app = express();
  app.use(express.json({ verify: (req, _res, buf) => { (req as unknown as { rawBody: Buffer }).rawBody = buf; } }));
  app.use(authMiddleware(() => 'tok-1', 'echo', undefined, deviceAuthenticator(svc)));
  const router = express.Router();
  mountMobilePermissionsRoutes(router, deps);
  app.use(router);
  const pair = (person?: { userId: string; role: 'msp' | 'team' }) => {
    const dev = makeDevice();
    const presence = makeDevice();
    const created = svc.devices.createPending({ deviceName: 'iPhone', label: null, publicKey: dev.publicKey, host: HOST, ...(person ?? {}) });
    if (!created.ok) throw new Error('setup');
    svc.devices.applyConfirm(created.device.id, { ok: true });
    svc.devices.setPresenceKey(created.device.id, presence.publicKey);
    return { dev, presence, id: created.device.id };
  };
  return { app, calls, pair, dir };
}

type Phone = { dev: ReturnType<typeof makeDevice>; presence: ReturnType<typeof makeDevice>; id: string };
let tick = 0;
function send(app: express.Express, phone: Phone, p: string, body: unknown) {
  const time = String(Date.now() + (tick++ % 1000));
  const raw = Buffer.from(JSON.stringify(body));
  const sig = phone.dev.sign(canonicalString(phone.id, HOST, 'POST', p, time, raw));
  return request(app).post(p).set('Content-Type', 'application/json')
    .set('X-Instar-Device', phone.id).set('X-Instar-Device-Time', time).set('X-Instar-Device-Sig', sig)
    .send(raw.toString());
}
async function challenge(app: express.Express, phone: Phone, target: string) {
  const r = await send(app, phone, '/mobile/permissions/challenge', { action: 'account-sign-in', target });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body.challenge as string;
}
const sig = (phone: Phone, c: string, line: string) => phone.presence.sign(permissionPresenceMessage(phone.id, HOST, c, line));
const auditRows = (dir: string) => fs.readFileSync(path.join(dir, 'state', 'mobile-permission-actions.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

describe('POST /mobile/accounts/sign-in/start', () => {
  it('owner phone + a valid Face ID signature starts the sign-in and answers start-cell\'s body unchanged', async () => {
    const c = setup();
    const owner = c.pair();
    const ch = await challenge(c.app, owner, `gearfinity3d@${MACHINE}`);
    const r = await send(c.app, owner, ROUTE, { accountId: 'gearfinity3d', machineId: MACHINE, challenge: ch, presenceSig: sig(owner, ch, `account-sign-in gearfinity3d@${MACHINE}`) });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body).toEqual({ ...STARTED, loginId: 'gearfinity3d' });
    expect(r.headers['cache-control']).toBe('no-store');
    expect(c.calls).toEqual([['gearfinity3d', MACHINE]]);
    const row = auditRows(c.dir).find((x) => x.event === 'account-sign-in');
    expect(row).toMatchObject({ deviceId: owner.id, action: 'account-sign-in', target: `gearfinity3d@${MACHINE}`, status: 201 });
    // The challenge is single-use: the same proof again is refused and the core does not run twice.
    const again = await send(c.app, owner, ROUTE, { accountId: 'gearfinity3d', machineId: MACHINE, challenge: ch, presenceSig: sig(owner, ch, `account-sign-in gearfinity3d@${MACHINE}`) });
    expect(again.status).toBe(401);
    expect(again.body.error).toBe('challenge-invalid');
    expect(c.calls).toHaveLength(1);
  });

  it('a core refusal (unknown account) reaches the phone with start-cell\'s status and body', async () => {
    const c = setup();
    const owner = c.pair();
    const ch = await challenge(c.app, owner, `missing@${MACHINE}`);
    const r = await send(c.app, owner, ROUTE, { accountId: 'missing', machineId: MACHINE, challenge: ch, presenceSig: sig(owner, ch, `account-sign-in missing@${MACHINE}`) });
    expect(r.status).toBe(404);
    expect(r.body).toMatchObject({ code: 'subscription-account-not-found', accountId: 'missing' });
    expect(auditRows(c.dir).at(-1)).toMatchObject({ event: 'refused', action: 'account-sign-in', status: 404 });
  });

  it('a member phone is refused (403) and the core never runs', async () => {
    const c = setup();
    const msp = c.pair({ userId: 'justin', role: 'msp' });
    const ch = await send(c.app, msp, '/mobile/permissions/challenge', { action: 'account-sign-in', target: `gearfinity3d@${MACHINE}` });
    expect(ch.status).toBe(403);
    const r = await send(c.app, msp, ROUTE, { accountId: 'gearfinity3d', machineId: MACHINE, challenge: 'x'.repeat(43), presenceSig: 'AAAA' });
    expect(r.status).toBe(403);
    expect(c.calls).toEqual([]);
  });

  it('a team phone is refused (403) and the core never runs', async () => {
    const c = setup();
    let team: Phone;
    team = c.pair({ userId: 'justin', role: 'team' });
    const r = await send(c.app, team, ROUTE, { accountId: 'gearfinity3d', machineId: MACHINE, challenge: 'x'.repeat(43), presenceSig: 'AAAA' });
    expect(r.status).toBe(403);
    expect(c.calls).toEqual([]);
  });

  it('the bearer token is refused: only the owner phone may start a sign-in here', async () => {
    const c = setup();
    const r = await request(c.app).post(ROUTE).set('Authorization', 'Bearer tok-1').send({ accountId: 'gearfinity3d', machineId: MACHINE, challenge: 'x', presenceSig: 'y' });
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('device-signature-required');
    expect(c.calls).toEqual([]);
  });

  it('a bad presence signature is refused (401 presence-invalid)', async () => {
    const c = setup();
    const owner = c.pair();
    const stranger = makeDevice();
    const ch = await challenge(c.app, owner, `gearfinity3d@${MACHINE}`);
    const r = await send(c.app, owner, ROUTE, { accountId: 'gearfinity3d', machineId: MACHINE, challenge: ch, presenceSig: stranger.sign(permissionPresenceMessage(owner.id, HOST, ch, `account-sign-in gearfinity3d@${MACHINE}`)) });
    expect(r.status).toBe(401);
    expect(r.body.error).toBe('presence-invalid');
    expect(c.calls).toEqual([]);
    expect(auditRows(c.dir).at(-1)).toMatchObject({ event: 'refused', reason: 'presence-invalid', target: `gearfinity3d@${MACHINE}` });
  });

  it('a Face ID proof for one account cannot start another account, or the same account on another machine', async () => {
    const c = setup();
    const owner = c.pair();
    // Challenge and signature for gearfinity3d, body names another account: the challenge does not match.
    const ch1 = await challenge(c.app, owner, `gearfinity3d@${MACHINE}`);
    const other = await send(c.app, owner, ROUTE, { accountId: 'sagemind-justin', machineId: MACHINE, challenge: ch1, presenceSig: sig(owner, ch1, `account-sign-in gearfinity3d@${MACHINE}`) });
    expect(other.status).toBe(401);
    expect(other.body.error).toBe('challenge-invalid');
    // Challenge for the other account, but the Face ID signature was over gearfinity3d: the signature does not match.
    const ch2 = await challenge(c.app, owner, `sagemind-justin@${MACHINE}`);
    const crossSig = await send(c.app, owner, ROUTE, { accountId: 'sagemind-justin', machineId: MACHINE, challenge: ch2, presenceSig: sig(owner, ch2, `account-sign-in gearfinity3d@${MACHINE}`) });
    expect(crossSig.status).toBe(401);
    expect(crossSig.body.error).toBe('presence-invalid');
    // Same account, another machine.
    const ch3 = await challenge(c.app, owner, `gearfinity3d@${MACHINE}`);
    const moved = await send(c.app, owner, ROUTE, { accountId: 'gearfinity3d', machineId: OTHER_MACHINE, challenge: ch3, presenceSig: sig(owner, ch3, `account-sign-in gearfinity3d@${MACHINE}`) });
    expect(moved.status).toBe(401);
    expect(c.calls).toEqual([]);
  });

  it('malformed account or machine ids are refused before any challenge or core', async () => {
    const c = setup();
    const owner = c.pair();
    for (const target of ['Gearfinity3D@' + MACHINE, 'gear finity@' + MACHINE, `gearfinity3d@${MACHINE}@x`, 'gearfinity3d@', '@' + MACHINE, 'gearfinity3d', `${'a'.repeat(65)}@${MACHINE}`, 'gearfinity3d@m 1', 'gearfinity3d@m.1']) {
      const r = await send(c.app, owner, '/mobile/permissions/challenge', { action: 'account-sign-in', target });
      expect(r.status, target).toBe(400);
      expect(r.body.error).toBe('bad-target');
    }
    // A second owner phone: each phone has a 12-per-minute allowance for these actions.
    const owner2 = c.pair();
    for (const body of [{ accountId: 'Gear', machineId: MACHINE }, { accountId: 'gearfinity3d', machineId: 'm@1' }, { accountId: 7, machineId: MACHINE }, { machineId: MACHINE }]) {
      const r = await send(c.app, owner2, ROUTE, { ...body, challenge: 'x'.repeat(43), presenceSig: 'AAAA' });
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(r.body.error).toBe('bad-target');
    }
    expect(c.calls).toEqual([]);
  });

  it('answers 503 in plain words when this agent has no sign-in core wired', async () => {
    const c = setup({ withCore: false });
    const owner = c.pair();
    const ch = await challenge(c.app, owner, `gearfinity3d@${MACHINE}`);
    const r = await send(c.app, owner, ROUTE, { accountId: 'gearfinity3d', machineId: MACHINE, challenge: ch, presenceSig: sig(owner, ch, `account-sign-in gearfinity3d@${MACHINE}`) });
    expect(r.status).toBe(503);
    expect(r.body.error).toBe('account-sign-in-unavailable');
  });
});
