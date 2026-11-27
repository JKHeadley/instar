/**
 * HTTP pipeline for approving a code-owner pull request from the owner's phone with Face ID
 * (docs/specs/github-approval-from-the-app.md), through the production authMiddleware + deviceAuthenticator +
 * the real MobilePairingService and its device allowlist, with a fake approval port.
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
const dirs: string[] = [];
const services: MobilePairingService[] = [];
afterAll(() => {
  for (const s of services) s.stop();
  for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/integration/github-approval-routes.test.ts' });
});

const HEAD = 'a'.repeat(40);
const NEWER = 'b'.repeat(40);

function setup(opts: { withPort?: boolean; live?: { head: string } } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-approval-int-'));
  dirs.push(dir);
  fs.writeFileSync(path.join(dir, 'users.json'), JSON.stringify([{ id: 'justin', name: 'Justin', channels: [], permissions: ['user'] }]));
  const config = { projectName: 'echo', stateDir: dir, authToken: 'tok-1', developmentAgent: true, dashboardPin: '424242', mobilePairing: { multiRoute: { enabled: false } } } as never;
  const svc = new MobilePairingService({ config, stateDir: dir, holdsLease: () => true, selfMachineId: 'm_self' } as MobilePairingDeps);
  services.push(svc);
  const live = opts.live ?? { head: HEAD };
  const calls: Array<{ pr: number; headSha: string }> = [];
  const port = {
    precheck: async (pr: number, headSha: unknown): Promise<ActionResult | null> => (pr !== 3478 ? { status: 409, body: { error: 'not-awaiting-owner-review' } } : headSha !== live.head ? { status: 409, body: { error: 'head-changed', currentHead: live.head } } : null),
    start: async (input: { pr: number; headSha: string }): Promise<ActionResult> => {
      calls.push({ pr: input.pr, headSha: input.headSha });
      if (input.headSha !== live.head) return { status: 409, body: { error: 'head-changed', currentHead: live.head } };
      return { status: 200, body: { approved: true, already: false, reviewId: 99, commitId: input.headSha, verifiedAt: '2026-11-19T18:00:00.000Z' } };
    },
    runView: async (pr: number) => ({ state: 'approved', pr, reviewId: 99 }),
  };
  const deps = {
    pairing: () => svc,
    config: () => config,
    stateDir: dir,
    bearerOk: (req: express.Request) => req.headers.authorization === 'Bearer tok-1',
    ...(opts.withPort === false ? {} : { githubApproval: port }),
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
  return { app, calls, pair, dir, live };
}

type Phone = { dev: ReturnType<typeof makeDevice>; presence: ReturnType<typeof makeDevice>; id: string };
let tick = 0;
function send(app: express.Express, phone: Phone, p: string, body: unknown, method: 'POST' | 'GET' = 'POST') {
  const time = String(Date.now() + (tick++ % 1000));
  const raw = method === 'POST' ? Buffer.from(JSON.stringify(body)) : Buffer.alloc(0);
  const sigv = phone.dev.sign(canonicalString(phone.id, HOST, method, p, time, method === 'POST' ? raw : undefined));
  const r = method === 'POST' ? request(app).post(p).set('Content-Type', 'application/json') : request(app).get(p);
  const t = r.set('X-Instar-Device', phone.id).set('X-Instar-Device-Time', time).set('X-Instar-Device-Sig', sigv);
  return method === 'POST' ? t.send(raw.toString()) : t;
}
const sig = (phone: Phone, c: string, line: string) => phone.presence.sign(permissionPresenceMessage(phone.id, HOST, c, line));
const ROUTE = '/mobile/github/approvals/3478/approve';

describe('POST /mobile/github/approvals/:pr/approve', () => {
  it('owner phone + Face ID over `github-approval <n>` + the head stored with the challenge → the service answer', async () => {
    const c = setup();
    const owner = c.pair();
    const ch = await send(c.app, owner, '/mobile/permissions/challenge', { action: 'github-approval', target: '3478', headSha: HEAD });
    expect(ch.status, JSON.stringify(ch.body)).toBe(200);
    const r = await send(c.app, owner, ROUTE, { headSha: HEAD, challenge: ch.body.challenge, presenceSig: sig(owner, ch.body.challenge, 'github-approval 3478') });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ approved: true, reviewId: 99, commitId: HEAD });
    expect(c.calls).toEqual([{ pr: 3478, headSha: HEAD }]);
    const again = await send(c.app, owner, ROUTE, { headSha: HEAD, challenge: ch.body.challenge, presenceSig: sig(owner, ch.body.challenge, 'github-approval 3478') });
    expect(again.status).toBe(401);
    expect(c.calls).toHaveLength(1);
    const rows = fs.readFileSync(path.join(c.dir, 'state', 'mobile-permission-actions.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(rows.find((x) => x.event === 'github-approval')).toMatchObject({ deviceId: owner.id, action: 'github-approval', target: '3478', status: 200 });
  });

  it('the challenge needs the head and is refused before Face ID when the head moved', async () => {
    const c = setup({ live: { head: NEWER } });
    const owner = c.pair();
    expect((await send(c.app, owner, '/mobile/permissions/challenge', { action: 'github-approval', target: '3478' })).body.error).toBe('bad-head-sha');
    const moved = await send(c.app, owner, '/mobile/permissions/challenge', { action: 'github-approval', target: '3478', headSha: HEAD });
    expect(moved.status).toBe(409);
    expect(moved.body).toMatchObject({ error: 'head-changed', currentHead: NEWER });
    expect((await send(c.app, owner, '/mobile/permissions/challenge', { action: 'github-approval', target: '12', headSha: HEAD })).body.error).toBe('not-awaiting-owner-review');
    expect((await send(c.app, owner, '/mobile/permissions/challenge', { action: 'github-approval', target: '03478', headSha: HEAD })).body.error).toBe('bad-target');
    expect(c.calls).toEqual([]);
  });

  it('an approve naming another head than the challenge stored is refused (head-changed), the service never runs', async () => {
    const c = setup();
    const owner = c.pair();
    const ch = await send(c.app, owner, '/mobile/permissions/challenge', { action: 'github-approval', target: '3478', headSha: HEAD });
    c.live.head = NEWER;
    const r = await send(c.app, owner, ROUTE, { headSha: NEWER, challenge: ch.body.challenge, presenceSig: sig(owner, ch.body.challenge, 'github-approval 3478') });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('head-changed');
    expect(c.calls).toEqual([]);
  });

  it('refuses a bad presence signature, a member phone and the bearer', async () => {
    const c = setup();
    const owner = c.pair();
    const ch = await send(c.app, owner, '/mobile/permissions/challenge', { action: 'github-approval', target: '3478', headSha: HEAD });
    const bad = await send(c.app, owner, ROUTE, { headSha: HEAD, challenge: ch.body.challenge, presenceSig: sig(owner, ch.body.challenge, 'github-approval 3479') });
    expect(bad.status).toBe(401);
    expect(bad.body.error).toBe('presence-invalid');
    const msp = c.pair({ userId: 'justin', role: 'msp' });
    expect((await send(c.app, msp, ROUTE, { headSha: HEAD, challenge: 'x'.repeat(43), presenceSig: 'AAAA' })).status).toBe(403);
    const team = c.pair({ userId: 'justin', role: 'team' });
    expect((await send(c.app, team, ROUTE, { headSha: HEAD, challenge: 'x'.repeat(43), presenceSig: 'AAAA' })).status).toBe(403);
    const bearer = await request(c.app).post(ROUTE).set('Authorization', 'Bearer tok-1').send({ headSha: HEAD, challenge: 'x', presenceSig: 'y' });
    expect(bearer.status).toBe(403);
    expect(c.calls).toEqual([]);
  });

  it('answers 503 at the challenge when this agent cannot approve from the app', async () => {
    const c = setup({ withPort: false });
    const owner = c.pair();
    const r = await send(c.app, owner, '/mobile/permissions/challenge', { action: 'github-approval', target: '3478', headSha: HEAD });
    expect(r.status).toBe(503);
    expect(r.body.error).toBe('github-approval-unavailable');
  });
});

describe('GET /mobile/github/approvals/:pr', () => {
  it('the owner phone reads the result; a malformed number is refused', async () => {
    const c = setup();
    const owner = c.pair();
    const r = await send(c.app, owner, '/mobile/github/approvals/3478', null, 'GET');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ state: 'approved', pr: 3478 });
  });
});
