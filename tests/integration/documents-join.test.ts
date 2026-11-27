/**
 * A member's computer joins from the owner's team invite (docs/specs/member-browser-any-computer.md):
 * the HTTP pipeline with the real pairing service, real code stores and registry, and the real team-log
 * fold (rows appended through foldRowInto). Both sides of every rule: who may join, the code from the
 * owner's phone, the commit point and retries, the pool write gate, the allowance, Forget, and the
 * agent's own routes.
 */
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { authMiddleware } from '../../src/server/middleware.js';
import { MobilePairingService, deviceAuthenticator, type MobilePairingDeps } from '../../src/server/mobilePairingRoutes.js';
import { createDocumentJoinRoutes, joinConfirmString, joinForgetString, checkLetters, reconcileJoinedComputers } from '../../src/server/documentJoinRoutes.js';
import { deviceKeyHashOf, sha256Hex } from '../../src/core/AppRecordSignatures.js';
import { emptyState, foldRowInto, rowPayload, type MachineRow, type TeamAccessRow, type TeamAccessState } from '../../src/core/TeamAccessLog.js';
import { makeDevice } from '../helpers/mobileDevice.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { InstarConfig } from '../../src/core/types.js';

const HOST = 'echo-join.example.dev';
const dirs: string[] = [];
const services: MobilePairingService[] = [];
afterAll(() => {
  for (const s of services) s.stop();
  for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/integration/documents-join.test.ts' });
});

const verify = (row: TeamAccessRow) => {
  const { machineSig, ...rest } = row;
  return machineSig.sig === sha256Hex(rowPayload(rest as never)) ? 'verified' as const : 'failed' as const;
};

function setup(opts: { tier?: 'member' | 'guest' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'join-int-')); dirs.push(dir);
  const config = {
    projectName: 'echo', projectDir: dir, stateDir: dir, port: 0, authToken: 'tok-1', developmentAgent: true,
    documents: { enabled: true }, threadline: { ownerName: 'Justin' },
    tunnel: { enabled: true, type: 'named', token: 'x', hostname: HOST },
    mobilePairing: { multiRoute: { enabled: false } },
  } as unknown as InstarConfig;
  const deps: MobilePairingDeps = {
    config, stateDir: dir, tunnel: () => ({ lifecycleState: { lastState: 'active', activeProvider: 'cloudflare-named' } }), selfMachineId: 'm_studio',
    telegramOwnerPresent: () => true, holdsLease: () => true,
  };
  const svc = new MobilePairingService(deps);
  services.push(svc);
  svc.nativeOn = true;
  // The team log: the real fold over appended machine rows, Mara on the team.
  const state: TeamAccessState = emptyState();
  state.on = true;
  state.people.set('mara', { personKey: 'mara', name: 'Mara', role: opts.tier === 'guest' ? 'guest' : 'member', links: {} });
  let seq = 0;
  const appended: Array<Record<string, unknown>> = [];
  const log = {
    healthState: () => 'ok' as const,
    state: () => state,
    vector: () => ({}),
    gaps: () => [],
    wasRemoved: (k: string) => !state.people.has(k),
    appendMachineEvents: (events: Array<Record<string, unknown>>) => {
      seq++;
      const rest = { seq, kind: 'machine' as const, at: new Date().toISOString(), events: events as MachineRow['events'], origin: 'm_studio', incarnation: 'v1', prev: null, seen: {} };
      foldRowInto(state, { ...rest, machineSig: { machineId: 'm_studio', signerKeyHash: 'k', sig: sha256Hex(rowPayload(rest)) } }, verify);
      appended.push(...events);
    },
  };
  const activations: Array<{ id: string; approvedVia: string }> = [];
  const revoked = new Set<string>();
  const ledgerRows: Array<Record<string, unknown>> = [];
  const ledger = {
    recordActivation: (d: { id: string; browserPublicKey?: string }, approvedVia: string) => { activations.push({ id: d.id, approvedVia }); ledgerRows.push({ type: 'activation', deviceId: d.id, keyHash: deviceKeyHashOf(d.browserPublicKey!) }); return {}; },
    recordRevocation: (d: { browserPublicKey?: string }) => { if (d.browserPublicKey) revoked.add(deviceKeyHashOf(d.browserPublicKey)); return {}; },
    rows: () => ledgerRows,
    isRevoked: (kh: string) => revoked.has(kh),
    keyRevoked: (kh: string) => revoked.has(kh),
  };
  const s = svc as unknown as Record<string, unknown>;
  s.teamLog = () => log;
  s.keyLedger = ledger;
  s.browserOn = () => true;
  s.reportTeamFault = () => {};
  svc.computersCanJoin = () => true;
  const gate = { blockedBy: null as string | null };
  const notices: Array<{ key: string; title: string; open: boolean }> = [];
  const app = express();
  app.use(express.json({ verify: (req, _res, buf) => { (req as unknown as { rawBody: Buffer }).rawBody = buf; } }));
  app.use(authMiddleware(() => config.authToken, 'echo', undefined, deviceAuthenticator(svc)));
  app.use(createDocumentJoinRoutes({
    config: () => config, pairing: () => svc, machineId: () => 'm_studio',
    writesBlockedBy: () => gate.blockedBy, ownerName: () => 'Justin',
    notice: { raise: (key, title) => { const n = notices.find((x) => x.key === key); if (n) { n.title = title; n.open = true; } else notices.push({ key, title, open: true }); }, close: (key) => { const n = notices.find((x) => x.key === key); if (n) n.open = false; } },
    addresses: () => [`https://${HOST}`, 'https://echo-laptop.example.dev'],
  }));
  return { app, svc, state, appended, activations, revoked, gate, notices, config };
}

const linkCode = (link: string) => new URLSearchParams(link.split('#')[1]).get('c')!;
const redeem = (app: express.Express, code: string, key: string) => request(app).post('/docs/_join/redeem').set('Host', HOST).set('X-Instar-Request', '1').send({ code, browserPublicKey: key });
function confirm(app: express.Express, dev: ReturnType<typeof makeDevice>, deviceId: string, code: string, over: { host?: string; time?: string } = {}) {
  const timeMs = over.time ?? String(Date.now());
  const sig = dev.sign(joinConfirmString(deviceId, over.host ?? HOST, timeMs, code));
  return request(app).post('/docs/_join/confirm').set('Host', HOST).set('X-Instar-Request', '1').send({ deviceId, code, timeMs, sig });
}
const heldCode = (svc: MobilePairingService, deviceId: string) => svc.dashboardApprovals().find((a) => a.device.id === deviceId)!.code;

describe('joining a computer from a team invite', () => {
  it('a team link carries j=1; redeem makes a waiting computer whose code only the owner\'s People read holds; confirm joins it', async () => {
    const ctx = setup();
    const m = ctx.svc.mintTeamLink('mara', null);
    if (!m.ok) throw new Error('mint');
    expect(m.link).toContain('&j=1');
    const dev = makeDevice();
    const r = await redeem(ctx.app, linkCode(m.link), dev.publicKey);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: 'pending', ownerName: 'Justin', checkLetters: checkLetters(dev.publicKey), host: HOST });
    const deviceId = r.body.deviceId as string;
    const rec = ctx.svc.devices.get(deviceId)!;
    expect(rec).toMatchObject({ joinedVia: 'team-invite', role: 'team', userId: 'mara', scope: 'documents', client: 'browser', status: 'pending' });
    expect(rec.deviceName).toMatch(new RegExp(`^Computer ${checkLetters(dev.publicKey)}, `));
    expect(ctx.notices[0]).toMatchObject({ key: `team-computer-waiting:${deviceId}`, open: true });
    // The lease-loss tick keeps it (held like a team phone's code).
    ctx.svc.leaseTick();
    expect(ctx.svc.devices.get(deviceId)!.status).toBe('pending');
    const code = heldCode(ctx.svc, deviceId);

    // A signature by another key, or on another host, is refused before any code is read.
    expect((await confirm(ctx.app, makeDevice(), deviceId, code)).status).toBe(401);
    expect((await confirm(ctx.app, dev, deviceId, code, { host: 'elsewhere.example.dev' })).status).toBe(401);
    expect((await confirm(ctx.app, dev, deviceId, code, { time: String(Date.now() - 10 * 60_000) })).body.error).toBe('clock-skew');
    const wrong = code === '111111' ? '222222' : '111111';
    const w = await confirm(ctx.app, dev, deviceId, wrong);
    expect(w.status).toBe(403);
    expect(w.body).toMatchObject({ error: 'wrong-code', attemptsLeft: 2 });

    const ok = await confirm(ctx.app, dev, deviceId, code);
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ status: 'active', deviceId, scope: 'documents', host: HOST });
    expect(ctx.activations).toEqual([{ id: deviceId, approvedVia: 'team-invite' }]);
    expect(ctx.svc.devices.get(deviceId)).toMatchObject({ status: 'active', approvedVia: 'team-invite' });
    const bind = ctx.appended.find((e) => e.type === 'computer-bind')!;
    expect(bind).toMatchObject({ keyHash: deviceKeyHashOf(dev.publicKey), deviceId, boundTo: 'mara', idleDays: 30, scope: 'documents' });
    expect(ctx.state.computerLinks.get(deviceKeyHashOf(dev.publicKey))?.signer).toBe('m_studio');
    expect(ctx.notices[0].open).toBe(false);
    // A retry after success answers active, not a wrong code; the code is consumed.
    expect((await confirm(ctx.app, dev, deviceId, code)).body).toEqual({ status: 'active' });
    expect(ctx.svc.dashboardApprovals().some((a) => a.device.id === deviceId)).toBe(false);
  });

  it('a guest\'s computer reads only', async () => {
    const ctx = setup({ tier: 'guest' });
    const m = ctx.svc.mintTeamLink('mara', null);
    if (!m.ok) throw new Error('mint');
    const r = await redeem(ctx.app, linkCode(m.link), makeDevice().publicKey);
    expect(ctx.svc.devices.get(r.body.deviceId)!.scope).toBe('documents-read');
  });

  it('an owner\'s pairing link opened on this route is spent and refused; a garbage code counts as a failure', async () => {
    const ctx = setup();
    const owner = ctx.svc.codes.mint(30 * 60_000, null, 'tok-1', { host: HOST, kind: 'cloudflare' });
    if (!owner.ok) throw new Error('mint');
    const r = await redeem(ctx.app, owner.code, makeDevice().publicKey);
    expect(r.status).toBe(403);
    expect(ctx.svc.codes.peekPerson(owner.code)).toBeNull();
    expect(ctx.svc.devices.list()).toHaveLength(0);
    const g = await redeem(ctx.app, 'A'.repeat(22), makeDevice().publicKey);
    expect(g.status).toBe(403);
  });

  it('a person removed between redeem and confirm is refused, and the waiting computer is declined', async () => {
    const ctx = setup();
    const m = ctx.svc.mintTeamLink('mara', null);
    if (!m.ok) throw new Error('mint');
    const dev = makeDevice();
    const r = await redeem(ctx.app, linkCode(m.link), dev.publicKey);
    const code = heldCode(ctx.svc, r.body.deviceId);
    ctx.state.people.delete('mara');
    const c = await confirm(ctx.app, dev, r.body.deviceId, code);
    expect(c.status).toBe(403);
    expect(c.body.error).toBe('person-unknown');
    expect(ctx.appended.some((e) => e.type === 'computer-bind')).toBe(false);
  });

  it('nothing is taken or written while another machine can\'t read computer rows', async () => {
    const ctx = setup();
    const m = ctx.svc.mintTeamLink('mara', null);
    if (!m.ok) throw new Error('mint');
    ctx.gate.blockedBy = 'echo-laptop';
    const r = await redeem(ctx.app, linkCode(m.link), makeDevice().publicKey);
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ error: 'peers-updating', machine: 'echo-laptop' });
    expect(ctx.svc.codes.peekPerson(linkCode(m.link))).toMatchObject({ userId: 'mara' }); // not spent
    const lim = await request(ctx.app).post('/team/computer-limits').set('Authorization', 'Bearer tok-1').send({ maxPerPerson: 5 });
    expect(lim.status).toBe(409);
  });

  it('the allowance is checked before the code is taken, from replicated rows and the limits row', async () => {
    const ctx = setup();
    ctx.state.computerRows.length = 0;
    const set = await request(ctx.app).post('/team/computer-limits').set('Authorization', 'Bearer tok-1').send({ personKey: 'mara', maxPerPerson: 1 });
    expect(set.status).toBe(200);
    expect(set.body).toMatchObject({ appliesTo: 'person', limits: { maxPerPerson: 1 } });
    const m1 = ctx.svc.mintTeamLink('mara', null);
    if (!m1.ok) throw new Error('mint');
    const dev = makeDevice();
    const r1 = await redeem(ctx.app, linkCode(m1.link), dev.publicKey);
    await confirm(ctx.app, dev, r1.body.deviceId, heldCode(ctx.svc, r1.body.deviceId));
    const m2 = ctx.svc.mintTeamLink('mara', null);
    if (!m2.ok) throw new Error('mint');
    const r2 = await redeem(ctx.app, linkCode(m2.link), makeDevice().publicKey);
    expect(r2.status).toBe(409);
    expect(r2.body.error).toBe('browser-link-limit');
    expect(r2.body.detail).not.toMatch(/Computer [0-9A-F]{4}/); // lists none of Mara's computers
    expect(ctx.svc.codes.peekPerson(linkCode(m2.link))).toMatchObject({ userId: 'mara' }); // not spent
  });

  it('the agent\'s routes need the token and refuse bad limits', async () => {
    const ctx = setup();
    expect((await request(ctx.app).post('/team/computer-limits').send({ maxPerPerson: 5 })).status).toBe(401);
    expect((await request(ctx.app).post('/team/computer-limits').set('Authorization', 'Bearer tok-1').send({ idleDays: 400 })).status).toBe(400);
    expect((await request(ctx.app).post('/team/computer-limits').set('Authorization', 'Bearer tok-1').send({ personKey: 'nobody', maxPerPerson: 2 })).status).toBe(404);
    const all = await request(ctx.app).get('/team/computers').set('Authorization', 'Bearer tok-1');
    expect(all.status).toBe(200);
    expect(all.body.people[0]).toMatchObject({ personKey: 'mara', computers: [], limits: { maxPerPerson: 3, idleDays: 30, maxDays: 90 } });
  });

  it('SEC-169: the public way-back list names only addresses where a computer is set up, never every machine', async () => {
    const ctx = setup();
    const list = async () => (await request(ctx.app).get('/docs/_join/addresses')).body.addresses as string[];
    // No computer anywhere: no machine's address is handed to an anonymous caller.
    expect(await list()).toEqual([]);
    // Mara joins a computer on this machine's address: that address, and only it, is a way back.
    const m = ctx.svc.mintTeamLink('mara', null);
    if (!m.ok) throw new Error('mint');
    const dev = makeDevice();
    const r = await redeem(ctx.app, linkCode(m.link), dev.publicKey);
    expect((await confirm(ctx.app, dev, r.body.deviceId, heldCode(ctx.svc, r.body.deviceId))).status).toBe(200);
    expect(await list()).toEqual([`https://${HOST}`]);
    // A phone-linked computer on the laptop's address adds that address: its own host from the signed body,
    // not the address the phone used.
    const body = Buffer.from(JSON.stringify({ host: 'echo-laptop.example.dev', nonce: 'n' })).toString('base64url');
    ctx.state.browserLinks.set('kh-phone-linked', { type: 'browser-bind', keyHash: 'kh-phone-linked', deviceId: 'd-pl', boundTo: 'mara', linkedByDeviceId: 'p1', linkedByKeyHash: 'pk', linkedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86_400_000).toISOString(), scope: 'documents', signed: { host: HOST, timeMs: String(Date.now()), sig: 's', bodyB64: body } });
    expect((await list()).sort()).toEqual([`https://${HOST}`, 'https://echo-laptop.example.dev'].sort());
    // Once Mara is off the team, neither of her computers is a way back any more.
    ctx.state.people.delete('mara');
    expect(await list()).toEqual([]);
  });

  it('Forget on the computer, and removal by the agent, end a joined computer for good', async () => {
    const ctx = setup();
    const join = async () => {
      const m = ctx.svc.mintTeamLink('mara', null);
      if (!m.ok) throw new Error('mint');
      const dev = makeDevice();
      const r = await redeem(ctx.app, linkCode(m.link), dev.publicKey);
      await confirm(ctx.app, dev, r.body.deviceId, heldCode(ctx.svc, r.body.deviceId));
      return { dev, deviceId: r.body.deviceId as string };
    };
    const a = await join();
    const timeMs = String(Date.now());
    const bad = await request(ctx.app).post('/docs/_link/forget-self').set('Host', HOST).set('X-Instar-Request', '1').send({ deviceId: a.deviceId, timeMs, sig: makeDevice().sign(joinForgetString(a.deviceId, HOST, timeMs)) });
    expect(bad.status).toBe(401);
    const f = await request(ctx.app).post('/docs/_link/forget-self').set('Host', HOST).set('X-Instar-Request', '1').send({ deviceId: a.deviceId, timeMs, sig: a.dev.sign(joinForgetString(a.deviceId, HOST, timeMs)) });
    expect(f.body).toEqual({ ok: true });
    expect(ctx.state.computerLinks.get(deviceKeyHashOf(a.dev.publicKey))?.unbound).toBe(true);
    expect(ctx.revoked.has(deviceKeyHashOf(a.dev.publicKey))).toBe(true);
    const b = await join();
    const listed = await request(ctx.app).get('/team/computers').set('Authorization', 'Bearer tok-1');
    expect(listed.body.people[0].computers.map((c: { deviceId: string }) => c.deviceId)).toEqual([b.deviceId]);
    const gone = await request(ctx.app).post(`/team/people/mara/computers/${b.deviceId}/forget`).set('Authorization', 'Bearer tok-1').send({});
    expect(gone.body).toEqual({ ok: true });
    expect(ctx.state.computerLinks.get(deviceKeyHashOf(b.dev.publicKey))?.unbound).toBe(true);
  });

  it('reconcile finishes an admission whose commit point was written before a crash', async () => {
    const ctx = setup();
    const m = ctx.svc.mintTeamLink('mara', null);
    if (!m.ok) throw new Error('mint');
    const dev = makeDevice();
    const r = await redeem(ctx.app, linkCode(m.link), dev.publicKey);
    const d = ctx.svc.devices.get(r.body.deviceId)!;
    // The ledger activation (the commit point) landed; the registry and bind did not.
    (ctx.svc as unknown as { keyLedger: { recordActivation: (d: unknown, v: string) => unknown } }).keyLedger.recordActivation(d, 'team-invite');
    expect(reconcileJoinedComputers(ctx.svc, { writesBlockedBy: () => 'echo-laptop' }, Date.now())).toBe(0); // held while the gate is closed
    expect(reconcileJoinedComputers(ctx.svc, { writesBlockedBy: () => null }, Date.now())).toBe(1);
    expect(ctx.svc.devices.get(d.id)!.status).toBe('active');
    expect(ctx.state.computerLinks.has(deviceKeyHashOf(dev.publicKey))).toBe(true);
    expect(reconcileJoinedComputers(ctx.svc, { writesBlockedBy: () => null }, Date.now())).toBe(0); // idempotent
  });
});
