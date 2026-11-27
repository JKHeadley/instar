/**
 * HTTP pipeline for adding a Claude or Codex account from the owner's phone with Face ID
 * (docs/specs/account-add-face-id.md), through the production authMiddleware + deviceAuthenticator + the
 * real MobilePairingService and its device allowlist: an owner phone with a fresh presence signature over
 * `account-add <kind>` reaches the injected add core and gets start-cell's body back; a member phone, the
 * bearer, a bad signature, a Claude proof used for Codex, a replay, credential-shaped fields and malformed
 * input are refused before the core runs, and each is audited.
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
const ROUTE = '/mobile/accounts/add';
const MACHINE = 'm_03b30f5b32c6ef3eb0afd3ca7054e252';
const dirs: string[] = [];
const services: MobilePairingService[] = [];
afterAll(() => {
  for (const s of services) s.stop();
  for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/integration/account-add-face-id.test.ts' });
});

/** start-cell's success shape (routes.ts runAddAccountSignIn answers it), as the phone already parses it. */
const STARTED = { verificationUrl: 'https://claude.ai/oauth/authorize?x=1', loginId: 'gear-a1b2', machineId: MACHINE, expectedEmail: 'gear@example.com', ttlExpiresAt: '2026-11-10T06:00:00.000Z', notice: null, kind: 'url-code-paste' };

function setup(opts: { withCore?: boolean } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acct-add-int-'));
  dirs.push(dir);
  fs.writeFileSync(path.join(dir, 'users.json'), JSON.stringify([{ id: 'justin', name: 'Justin', channels: [], permissions: ['user'] }]));
  const config = { projectName: 'echo', stateDir: dir, authToken: 'tok-1', developmentAgent: true, dashboardPin: '424242', mobilePairing: { multiRoute: { enabled: false } } } as never;
  const svc = new MobilePairingService({ config, stateDir: dir, holdsLease: () => true, selfMachineId: 'm_self' } as MobilePairingDeps);
  services.push(svc);
  const calls: Array<{ kind: string; nickname: string | null; email: string }> = [];
  const deps = {
    pairing: () => svc,
    config: () => config,
    stateDir: dir,
    bearerOk: (req: express.Request) => req.headers.authorization === 'Bearer tok-1',
    ...(opts.withCore === false ? {} : {
      addAccount: async (input: { kind: string; nickname: string | null; email: string }): Promise<ActionResult> => {
        calls.push(input);
        return input.email === 'dup@example.com' ? { status: 409, body: { error: 'That account is already added. Sign it in from its row instead.', code: 'account-already-added', accountId: 'dup-1234' } } : { status: 201, body: { ...STARTED, expectedEmail: input.email } };
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
  const r = await send(app, phone, '/mobile/permissions/challenge', { action: 'account-add', target });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body.challenge as string;
}
const sig = (phone: Phone, c: string, line: string) => phone.presence.sign(permissionPresenceMessage(phone.id, HOST, c, line));
const auditRows = (dir: string) => fs.readFileSync(path.join(dir, 'state', 'mobile-permission-actions.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

const ok = (phone: Phone, c: string, kind: string, extra: Record<string, unknown> = {}) => ({ provider: kind, email: 'gear@example.com', nickname: 'Gearfinity3D', ...extra, challenge: c, presenceSig: sig(phone, c, `account-add ${kind}`) });

describe('POST /mobile/accounts/add', () => {
  it('owner phone + a valid Face ID signature adds the account and answers start-cell\'s body', async () => {
    const c = setup();
    const owner = c.pair();
    const ch = await challenge(c.app, owner, 'claude');
    const r = await send(c.app, owner, ROUTE, ok(owner, ch, 'claude'));
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body).toEqual(STARTED);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(c.calls).toEqual([{ kind: 'claude', nickname: 'Gearfinity3D', email: 'gear@example.com' }]);
    expect(auditRows(c.dir).find((x) => x.event === 'account-add')).toMatchObject({ deviceId: owner.id, action: 'account-add', target: 'claude', status: 201 });
    const again = await send(c.app, owner, ROUTE, ok(owner, ch, 'claude'));
    expect(again.status).toBe(401);
    expect(again.body.error).toBe('challenge-invalid');
    expect(c.calls).toHaveLength(1);
  });

  it('codex works the same way, and the nickname is optional', async () => {
    const c = setup();
    const owner = c.pair();
    const ch = await challenge(c.app, owner, 'codex');
    const r = await send(c.app, owner, ROUTE, { provider: 'codex', email: ' sam@example.com ', challenge: ch, presenceSig: sig(owner, ch, 'account-add codex') });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(c.calls).toEqual([{ kind: 'codex', nickname: null, email: 'sam@example.com' }]);
  });

  it('a core refusal (already added) reaches the phone with its status and body', async () => {
    const c = setup();
    const owner = c.pair();
    const ch = await challenge(c.app, owner, 'claude');
    const r = await send(c.app, owner, ROUTE, ok(owner, ch, 'claude', { email: 'dup@example.com' }));
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ code: 'account-already-added', accountId: 'dup-1234' });
  });

  it('a member phone is refused (403) and the core never runs', async () => {
    const c = setup();
    const msp = c.pair({ userId: 'justin', role: 'msp' });
    expect((await send(c.app, msp, '/mobile/permissions/challenge', { action: 'account-add', target: 'claude' })).status).toBe(403);
    expect((await send(c.app, msp, ROUTE, { provider: 'claude', email: 'gear@example.com', challenge: 'x'.repeat(43), presenceSig: 'AAAA' })).status).toBe(403);
    expect(c.calls).toEqual([]);
  });

  it('a team phone and the bearer are refused (403)', async () => {
    const c = setup();
    const team = c.pair({ userId: 'justin', role: 'team' });
    expect((await send(c.app, team, ROUTE, { provider: 'claude', email: 'gear@example.com', challenge: 'x'.repeat(43), presenceSig: 'AAAA' })).status).toBe(403);
    const r = await request(c.app).post(ROUTE).set('Authorization', 'Bearer tok-1').send({ provider: 'claude', email: 'gear@example.com', challenge: 'x', presenceSig: 'y' });
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('device-signature-required');
    expect(c.calls).toEqual([]);
  });

  it('a bad presence signature is refused (401 presence-invalid)', async () => {
    const c = setup();
    const owner = c.pair();
    const ch = await challenge(c.app, owner, 'claude');
    const r = await send(c.app, owner, ROUTE, { provider: 'claude', email: 'gear@example.com', challenge: ch, presenceSig: makeDevice().sign(permissionPresenceMessage(owner.id, HOST, ch, 'account-add claude')) });
    expect(r.status).toBe(401);
    expect(r.body.error).toBe('presence-invalid');
    expect(c.calls).toEqual([]);
  });

  it('a Face ID proof for Claude cannot add a Codex account', async () => {
    const c = setup();
    const owner = c.pair();
    const ch1 = await challenge(c.app, owner, 'claude');
    const swapped = await send(c.app, owner, ROUTE, { provider: 'codex', email: 'gear@example.com', challenge: ch1, presenceSig: sig(owner, ch1, 'account-add claude') });
    expect(swapped.status).toBe(401);
    expect(swapped.body.error).toBe('challenge-invalid');
    const ch2 = await challenge(c.app, owner, 'codex');
    const crossSig = await send(c.app, owner, ROUTE, { provider: 'codex', email: 'gear@example.com', challenge: ch2, presenceSig: sig(owner, ch2, 'account-add claude') });
    expect(crossSig.status).toBe(401);
    expect(crossSig.body.error).toBe('presence-invalid');
    expect(c.calls).toEqual([]);
  });

  it('refuses credential-shaped or unknown fields and malformed input before Face ID or the core', async () => {
    const c = setup();
    const owner = c.pair();
    const owner2 = c.pair();
    const cases: Array<[Phone, Record<string, unknown>, string]> = [
      [owner, { provider: 'claude', email: 'gear@example.com', token: 'sk-ant-xxxx' }, 'unexpected-field'],
      [owner, { provider: 'claude', email: 'gear@example.com', password: 'hunter2' }, 'unexpected-field'],
      [owner, { provider: 'claude', email: 'gear@example.com', configHome: '/etc' }, 'unexpected-field'],
      [owner, { provider: 'claude', email: 'gear@example.com', id: 'mine' }, 'unexpected-field'],
      [owner, { provider: 'gemini', email: 'gear@example.com' }, 'bad-target'],
      [owner, { email: 'gear@example.com' }, 'bad-target'],
      [owner2, { provider: 'claude', email: 'not-an-email' }, 'bad-email'],
      [owner2, { provider: 'claude' }, 'bad-email'],
      [owner2, { provider: 'claude', email: 'a@b@c' }, 'bad-email'],
      [owner2, { provider: 'claude', email: 'gear@example.com', nickname: ' padded ' }, 'bad-nickname'],
      [owner2, { provider: 'claude', email: 'gear@example.com', nickname: 'x'.repeat(61) }, 'bad-nickname'],
      [owner2, { provider: 'claude', email: 'gear@example.com', nickname: 7 }, 'bad-nickname'],
    ];
    for (const [phone, body, error] of cases) {
      const r = await send(c.app, phone, ROUTE, { ...body, challenge: 'x'.repeat(43), presenceSig: 'AAAA' });
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(r.body.error, JSON.stringify(body)).toBe(error);
    }
    expect(c.calls).toEqual([]);
    expect(JSON.stringify(auditRows(c.dir))).not.toContain('sk-ant-xxxx');
    expect(JSON.stringify(auditRows(c.dir))).not.toContain('hunter2');
  });

  it('answers 503 in plain words when this agent has no add core wired', async () => {
    const c = setup({ withCore: false });
    const owner = c.pair();
    const ch = await challenge(c.app, owner, 'claude');
    const r = await send(c.app, owner, ROUTE, ok(owner, ch, 'claude'));
    expect(r.status).toBe(503);
    expect(r.body.error).toBe('account-add-unavailable');
  });
});
