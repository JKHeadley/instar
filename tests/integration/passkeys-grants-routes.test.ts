/**
 * Integration tests — passkey grants / issuers / passkey-cell mandate routes (Tier 2).
 * Spec: docs/specs/agent-held-google-passkey.md §3.2 / §3.3 / §5.2.
 * Real createRoutes() behind the real authMiddleware, real on-disk grant/issuer/nonce files, a real
 * Ed25519 identity pair per machine (injected through a coordinator.managers.identityManager fake),
 * and the peer-delivery seam injected so a two-machine flow can be driven in one process.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRoutes } from '../../src/server/routes.js';
import type { RouteContext } from '../../src/server/routes.js';
import { authMiddleware } from '../../src/server/middleware.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { packageMandateForDelivery } from '../../src/coordination/AccountFollowMeMandateBridge.js';
import { mintPasskeyCellBody, signPasskeyCellMandate } from '../../src/core/PasskeyCellMandate.js';
import type { CoordinationMandate } from '../../src/coordination/types.js';

const AUTH_TOKEN = 'test-passkey-grants-bearer';
const PIN = '246810';

interface Machine { id: string; dir: string; keys: crypto.KeyPairKeyObjectResult; app: express.Express; ctx: RouteContext & { deliverPasskeyCellMandate?: unknown } }

function machine(id: string, world: Map<string, Machine>, opts: { developmentAgent?: boolean; pin?: string | null; registryStatus?: Record<string, 'active' | 'revoked' | 'pending'> } = {}): Machine {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `pk-routes-${id}-`));
  const stateDir = path.join(dir, '.instar'); fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'config.json'), '{}\n');
  const keys = crypto.generateKeyPairSync('ed25519');
  const pem = (k: crypto.KeyObject) => k.export({ type: 'spki', format: 'pem' }).toString();
  const identityManager = {
    loadIdentity: () => ({ machineId: id }),
    loadSigningKey: () => keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    getSigningPublicKeyPem: (mid: string) => world.get(mid) ? pem(world.get(mid)!.keys.publicKey) : null,
    loadRegistry: () => ({ version: 1, machines: Object.fromEntries([...world.keys()].map((m) => [m, { status: opts.registryStatus?.[m] ?? 'active' }])) }),
    getActiveMachines: () => [...world.keys()].filter((m) => (opts.registryStatus?.[m] ?? 'active') === 'active').map((m) => ({ machineId: m, entry: {} })),
  };
  const ctx = {
    config: { projectName: 'pk', projectDir: dir, stateDir, port: 0, authToken: AUTH_TOKEN, developmentAgent: opts.developmentAgent ?? true,
      ...(opts.pin === null ? {} : { dashboardPin: opts.pin ?? PIN }), sessions: {}, scheduler: {} },
    sessionManager: { listRunningSessions: () => [] }, state: { getJobState: () => null, getSession: () => null },
    sessionRefresh: null, startTime: new Date(), meshSelfId: id,
    coordinator: { managers: { identityManager } },
    // In-process "mesh": deliver to the target machine's own /passkeys/cell-action route.
    deliverPasskeyCellMandate: async ({ targetMachineId, portable }: { targetMachineId: string; portable: unknown }) => {
      const target = world.get(targetMachineId);
      if (!target) return { ok: false, status: 0, reason: 'no-peer-url' };
      const res = await request(target.app).post('/passkeys/cell-action').set('Authorization', `Bearer ${AUTH_TOKEN}`).send({ portable });
      return { ok: res.status === 200 && res.body.applied === true, status: res.status, reason: res.body.reason, result: res.body };
    },
  } as unknown as Machine['ctx'];
  const app = express(); app.use(express.json()); app.use(authMiddleware(AUTH_TOKEN)); app.use('/', createRoutes(ctx));
  const m: Machine = { id, dir, keys, app, ctx };
  world.set(id, m);
  return m;
}

describe('passkey grants / issuers / cell-action routes (integration)', () => {
  const world = new Map<string, Machine>();
  const auth = () => ({ Authorization: `Bearer ${AUTH_TOKEN}` });
  beforeEach(() => world.clear());
  afterEach(() => { for (const m of world.values()) SafeFsExecutor.safeRmSync(m.dir, { recursive: true, force: true, operation: 'tests/integration/passkeys-grants-routes.test.ts:afterEach' }); });

  it('401 without a bearer; 503 on every route when dark (fleet config)', async () => {
    const m = machine('m1', world, { developmentAgent: false });
    expect((await request(m.app).get('/passkeys/grants')).status).toBe(401);
    for (const r of [
      request(m.app).get('/passkeys/grants').set(auth()),
      request(m.app).post('/passkeys/grant').set(auth()).send({ pin: PIN, email: 'a@example.com' }),
      request(m.app).post('/passkeys/revoke').set(auth()).send({ pin: PIN, email: 'a@example.com' }),
      request(m.app).post('/passkeys/issuer-add').set(auth()).send({ pin: PIN, machineId: 'm2' }),
      request(m.app).post('/passkeys/cell-action').set(auth()).send({ portable: {} }),
    ]) expect((await r).status).toBe(503);
  });

  it('PIN gate: 403 without / with a wrong PIN and when no PIN is configured; 400 on a missing email; nothing written', async () => {
    const m = machine('m1', world);
    for (const body of [{}, { pin: '000000', email: 'a@example.com' }]) expect((await request(m.app).post('/passkeys/grant').set(auth()).send(body)).status).toBe(403);
    const noPin = machine('m9', world, { pin: null });
    expect((await request(noPin.app).post('/passkeys/grant').set(auth()).send({ pin: PIN, email: 'a@example.com' })).status).toBe(503);
    // The shared limiter: repeated wrong PINs from one client are throttled (429), like the mandate routes.
    const lim = machine('m8', world);
    let last = 0;
    for (let i = 0; i < 7; i++) last = (await request(lim.app).post('/passkeys/grant').set(auth()).send({ pin: '999999', email: 'a@example.com' })).status;
    expect(last).toBe(429);
    expect((await request(m.app).post('/passkeys/grant').set(auth()).send({ pin: PIN })).status).toBe(400);
    const list = await request(m.app).get('/passkeys/grants').set(auth());
    expect(list.body.grants).toEqual([]);
    expect(list.body.issuers.self).toBe(false); // a failed PIN never adds self as issuer
  });

  it('single-machine agent: grant → list → revoke, self becomes an issuer on the first good PIN, audit rows carry no email', async () => {
    const m = machine('m1', world);
    // A body-supplied `principal` is IGNORED: the recorded principal is the verified fact (the PIN on this machine).
    const g = await request(m.app).post('/passkeys/grant').set(auth()).send({ pin: PIN, email: 'Justin@Example.com', principal: 'justin' });
    expect(g.status).toBe(200);
    expect(g.body).toMatchObject({ applied: true, op: 'grant', target: 'm1', result: { localSeq: 1, created: true, grantedBy: 'dashboard-pin@m1' } });
    const list = await request(m.app).get('/passkeys/grants').set(auth());
    expect(list.body).toMatchObject({ machineId: 'm1', revokeHighWater: 0, issuerBootstrapRequired: false, issuers: { self: true, peers: [] } });
    expect(list.body.grants).toEqual([expect.objectContaining({ canonicalEmail: 'justin@example.com', machineId: 'm1', status: 'active', origin: 'local-pin' })]);
    const r = await request(m.app).post('/passkeys/revoke').set(auth()).send({ pin: PIN, email: 'justin@example.com' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ applied: true, op: 'revoke', result: { covered: [1], appliedCutoffSeq: 1, reverted: [] } });
    const after = await request(m.app).get('/passkeys/grants').set(auth());
    expect(after.body.grants[0].status).toBe('revoked');
    expect(after.body.revokeHighWater).toBe(1);
    const audit = fs.readFileSync(path.join(m.dir, 'logs', 'playwright-profiles.jsonl'), 'utf8');
    expect(audit).toContain('passkey-grant');
    expect(audit).not.toContain('justin@example.com');
  });

  it('multi-machine: the first grant is refused until a peer issuer is confirmed; a peer grant travels as a signed passkey-cell mandate and is accepted only from a confirmed issuer', async () => {
    const a = machine('mA', world); const b = machine('mB', world);
    // A has no confirmed peer issuer yet → its own grant is refused (409, FD21).
    const early = await request(a.app).post('/passkeys/grant').set(auth()).send({ pin: PIN, email: 'a@example.com' });
    expect(early.status).toBe(409);
    expect(early.body).toMatchObject({ applied: false, reason: 'issuer-bootstrap-required' });
    // B has NOT confirmed A as an issuer: A's peer grant is signed + delivered but REFUSED on B.
    const refused = await request(a.app).post('/passkeys/grant').set(auth()).send({ pin: PIN, email: 'a@example.com', targetMachineId: 'mB' });
    expect(refused.status).toBe(502);
    expect(refused.body).toMatchObject({ delivered: false, reason: 'issuer-not-trusted' });
    expect((await request(b.app).get('/passkeys/grants').set(auth())).body.grants).toEqual([]);
    // Operator confirms A as an issuer ON B's own dashboard (B's PIN, B's registry). issuer-add needs an ACTIVE machine.
    expect((await request(b.app).post('/passkeys/issuer-add').set(auth()).send({ pin: PIN, machineId: 'nope' })).status).toBe(409);
    const confirm = await request(b.app).post('/passkeys/issuer-add').set(auth()).send({ pin: PIN, machineId: 'mA' });
    expect(confirm.status).toBe(200);
    expect((await request(b.app).get('/passkeys/grants').set(auth())).body.issuers.peers.map((i: { machineId: string; addedVia: string }) => [i.machineId, i.addedVia])).toEqual([['mA', 'operator-confirmed']]);
    // Now A's peer grant lands on B, and A keeps a non-secret copy of what it issued.
    const ok = await request(a.app).post('/passkeys/grant').set(auth()).send({ pin: PIN, email: 'a@example.com', targetMachineId: 'mB' });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ delivered: true, result: { applied: true, op: 'grant' } });
    const onB = await request(b.app).get('/passkeys/grants').set(auth());
    expect(onB.body.grants).toEqual([expect.objectContaining({ canonicalEmail: 'a@example.com', machineId: 'mB', origin: 'mandate', grantedBy: 'dashboard-pin@mA' })]);
    // A keeps a non-secret copy INCLUDING the peer's sequence, so a later revoke names the instance.
    expect((await request(a.app).get('/passkeys/grants').set(auth())).body.issuedPeerGrants).toEqual([expect.objectContaining({ canonicalEmail: 'a@example.com', targetMachineId: 'mB', targetLocalSeq: 1 })]);
    // A confirms B as an issuer on its own dashboard → A's own grant is now allowed.
    await request(a.app).post('/passkeys/issuer-add').set(auth()).send({ pin: PIN, machineId: 'mB' });
    expect((await request(a.app).post('/passkeys/grant').set(auth()).send({ pin: PIN, email: 'a@example.com' })).status).toBe(200);
    // A peer revoke from A removes B's grant.
    const rv = await request(a.app).post('/passkeys/revoke').set(auth()).send({ pin: PIN, email: 'a@example.com', targetMachineId: 'mB' });
    expect(rv.status).toBe(200);
    expect(rv.body.result.result.appliedCutoffSeq).toBe(1); // the known peer sequence travelled in the mandate
    expect((await request(b.app).get('/passkeys/grants').set(auth())).body.grants[0].status).toBe('revoked');
    expect((await request(a.app).get('/passkeys/grants').set(auth())).body.issuedPeerGrants).toEqual([]);
  });

  it('cell-action receiver: refuses a follow-me bundle, a replayed nonce, an expired mandate, and a non-issuer signer — and never writes on refusal', async () => {
    const a = machine('mA', world); const b = machine('mB', world); const rogue = machine('mR', world);
    await request(b.app).post('/passkeys/issuer-add').set(auth()).send({ pin: PIN, machineId: 'mA' });
    // follow-me bundle → 400 not-a-passkey-cell-mandate
    const fm = packageMandateForDelivery({ id: 'x', scope: 's', agents: ['a', 'b'], author: 'j', issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      authorities: [{ action: 'account-follow-me', bounds: { accountId: 'acct', targetMachineId: 'mB', mechanism: 're-mint' } }], revoked: false } as unknown as CoordinationMandate, 'mA', a.keys.privateKey);
    const fmRes = await request(b.app).post('/passkeys/cell-action').set(auth()).send({ portable: fm });
    expect(fmRes.status).toBe(400);
    expect(fmRes.body.reason).toBe('not-a-passkey-cell-mandate');
    // valid grant from A → accepted; the SAME bundle again → duplicate (applied:true, no second instance)
    const body = mintPasskeyCellBody({ principal: 'uid:1', canonicalEmail: 'z@example.com', targetMachineId: 'mB', op: 'grant' });
    const portable = signPasskeyCellMandate(body, 'mA', a.keys.privateKey);
    expect((await request(b.app).post('/passkeys/cell-action').set(auth()).send({ portable })).body).toMatchObject({ applied: true, op: 'grant' });
    expect((await request(b.app).post('/passkeys/cell-action').set(auth()).send({ portable })).body).toMatchObject({ applied: true, duplicate: true });
    expect((await request(b.app).get('/passkeys/grants').set(auth())).body.grants).toHaveLength(1);
    // expired grant mandate → 403 expired
    const old = signPasskeyCellMandate(mintPasskeyCellBody({ principal: 'uid:1', canonicalEmail: 'y@example.com', targetMachineId: 'mB', op: 'grant', now: Date.now() - 20 * 60_000 }), 'mA', a.keys.privateKey);
    const exp = await request(b.app).post('/passkeys/cell-action').set(auth()).send({ portable: old });
    expect(exp.status).toBe(403); expect(exp.body.reason).toBe('expired');
    // rogue (registered, active, but NOT a confirmed issuer on B) → issuer-not-trusted
    const rg = signPasskeyCellMandate(mintPasskeyCellBody({ principal: 'uid:1', canonicalEmail: 'y@example.com', targetMachineId: 'mB', op: 'grant' }), 'mR', rogue.keys.privateKey);
    const rgRes = await request(b.app).post('/passkeys/cell-action').set(auth()).send({ portable: rg });
    expect(rgRes.status).toBe(403); expect(rgRes.body.reason).toBe('issuer-not-trusted');
    // rogue claiming to be A → bad-signature
    const forged = signPasskeyCellMandate(mintPasskeyCellBody({ principal: 'uid:1', canonicalEmail: 'y@example.com', targetMachineId: 'mB', op: 'grant' }), 'mA', rogue.keys.privateKey);
    expect((await request(b.app).post('/passkeys/cell-action').set(auth()).send({ portable: forged })).body.reason).toBe('bad-signature');
    expect((await request(b.app).get('/passkeys/grants').set(auth())).body.grants.map((g: { canonicalEmail: string }) => g.canonicalEmail)).toEqual(['z@example.com']);
  });
});
