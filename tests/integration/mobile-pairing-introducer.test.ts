/**
 * Add a new agent from a phone you already use (docs/specs/mobile-pairing-introducer.md) through the
 * real HTTP pipeline: agent A (the introducer, with an owner phone) and agent N (the new agent, which
 * lists A as an introducer), each its own app, host and state.
 */
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { generateIdentityKeyPair } from '@sagemindai/threadline-core';
import { authMiddleware } from '../../src/server/middleware.js';
import { MobilePairingService, mountPublicMobilePairingRoutes, createMobilePairingRouter, deviceAuthenticator, type MobilePairingDeps } from '../../src/server/mobilePairingRoutes.js';
import { deriveIntroducerKey, introduceLine, introducePresenceMessage, introducerKeyId, signIntroduction } from '../../src/server/mobilePairingIntroducer.js';
import { PATCHABLE_CONFIG_KEYS } from '../../src/server/routes.js';
import { canonicalString } from '../../src/core/MobileDeviceKeys.js';
import { makeDevice } from '../helpers/mobileDevice.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { InstarConfig } from '../../src/core/types.js';

const A_HOST = 'echo-intro.example.dev';
const N_HOST = 'pairtest-intro.example.dev';
const dirs: string[] = [];
const services: MobilePairingService[] = [];
afterAll(() => {
  for (const s of services) s.stop();
  for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/integration/mobile-pairing-introducer.test.ts' });
});

type Identity = { publicKey: Buffer; privateKey: Buffer };

function agent(name: string, host: string, opts: { identity?: Identity | null; introducers?: Array<{ name: string; publicKey: string }>; native?: boolean; approve?: boolean; telegramOwner?: boolean } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mpi-int-'));
  dirs.push(dir);
  const config = {
    projectName: name, projectDir: dir, stateDir: dir, port: 0, authToken: `tok-${name}`, developmentAgent: true,
    tunnel: { enabled: true, type: 'named', token: 'x', hostname: host },
    threadline: { ownerName: 'Justin' },
    mobilePairing: {
      multiRoute: { enabled: false },
      ...(opts.approve === undefined ? {} : { approve: { enabled: opts.approve } }),
      ...(opts.introducers ? { ownerIntroducers: opts.introducers } : {}),
    },
  } as unknown as InstarConfig;
  const app = express();
  app.use(express.json({ verify: (req, _res, buf) => { (req as unknown as { rawBody: Buffer }).rawBody = buf; } }));
  const fetchFn = (async (url: string) => {
    const u = new URL(url);
    const r = await request(app).get(u.pathname + u.search).set('Host', host);
    return { ok: r.status === 200, status: r.status, json: async () => r.body } as unknown as Response;
  }) as unknown as typeof fetch;
  const dms: string[] = [];
  const identity = opts.identity === undefined ? generateIdentityKeyPair() : opts.identity;
  const deps: MobilePairingDeps = {
    config, stateDir: dir, tunnel: () => ({ lifecycleState: { lastState: 'active', activeProvider: 'cloudflare-named' } }), selfMachineId: `m_${name}`, fetchFn,
    ownerDM: async (text) => { dms.push(text); return 7; },
    telegramOwnerPresent: () => opts.telegramOwner === true,
    holdsLease: () => true,
    readIdentity: () => identity,
  };
  const svc = new MobilePairingService(deps);
  services.push(svc);
  svc.nativeOn = opts.native !== false;
  mountPublicMobilePairingRoutes(app, svc);
  app.use(authMiddleware(() => config.authToken, name, undefined, deviceAuthenticator(svc)));
  app.use(createMobilePairingRouter(svc, deps, { config, resolvePeerUrls: () => [], recordRopeResult: undefined, verifyDashboardOperatorSession: (t: string | undefined) => t === 'sess' } as unknown as Parameters<typeof createMobilePairingRouter>[2]));
  return { app, svc, host, config, dms, identity, name };
}
type Agent = ReturnType<typeof agent>;

let lastSignTime = 0;
function signed(a: Agent, dev: ReturnType<typeof makeDevice>, deviceId: string, method: 'GET' | 'POST', p: string, body?: unknown) {
  const raw = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  lastSignTime = Math.max(Date.now(), lastSignTime + 1);
  const time = String(lastSignTime);
  const sig = dev.sign(canonicalString(deviceId, a.host, method, p, time, raw));
  const r = method === 'GET' ? request(a.app).get(p) : request(a.app).post(p).set('Content-Type', 'application/json');
  r.set('X-Instar-Device', deviceId).set('X-Instar-Device-Time', time).set('X-Instar-Device-Sig', sig);
  return raw ? r.send(raw.toString()) : r;
}
const bearer = (a: Agent, q: request.Test) => q.set('Authorization', `Bearer ${a.config.authToken}`);

async function waiting(a: Agent) {
  const m = await bearer(a, request(a.app).post('/mobile/pairing-codes')).send({});
  expect(m.status).toBe(200);
  const dev = makeDevice();
  const r = await request(a.app).post('/mobile/pairing-codes/redeem').set('Host', a.host).send({ code: m.body.code, deviceName: 'iPhone', devicePublicKey: dev.publicKey });
  expect(r.status).toBe(200);
  return { dev, deviceId: r.body.deviceId as string, redeem: r, fingerprint: a.svc.devices.get(r.body.deviceId)!.fingerprint! };
}
async function ownerPhone(a: Agent, presence = true) {
  const p = await waiting(a);
  expect(a.svc.approvePending(p.deviceId, 'dashboard-pin')).toBe('approved');
  const key = makeDevice();
  if (presence) expect(a.svc.devices.setPresenceKey(p.deviceId, key.publicKey)).toBe('set');
  return { ...p, presence: key };
}
/** The app's flow on A: challenge, presence signature, introduction. */
async function introduce(a: Agent, phone: Awaited<ReturnType<typeof ownerPhone>>, target: { aud: string; deviceId: string; fingerprint: string }) {
  const t = { audienceHost: target.aud, deviceId: target.deviceId, fingerprint: target.fingerprint };
  const c = await signed(a, phone.dev, phone.deviceId, 'POST', '/mobile/introductions/challenge', t);
  expect(c.status).toBe(200);
  const presenceSig = phone.presence.sign(introducePresenceMessage(phone.deviceId, a.host, c.body.challenge, introduceLine(t.audienceHost, t.deviceId, t.fingerprint)));
  return signed(a, phone.dev, phone.deviceId, 'POST', '/mobile/introductions', { ...t, challenge: c.body.challenge, presenceSig });
}
function pair() {
  const A = agent('echo', A_HOST);
  const key = deriveIntroducerKey(A.identity!);
  const N = agent('pairtest', N_HOST, { native: false, introducers: [{ name: 'Echo', publicKey: key.publicKey.toString('base64url') }] });
  return { A, N, key };
}

describe('the introducer (agent A)', () => {
  it('publishes its derived introducer key, never its identity key, to the bearer and its owner phone', async () => {
    const { A, key } = pair();
    const r = await bearer(A, request(A.app).get('/mobile/introducer'));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ name: 'echo', publicKey: key.publicKey.toString('base64url'), keyId: introducerKeyId(key.publicKey), configEntry: { name: 'echo', publicKey: key.publicKey.toString('base64url') } });
    expect(r.body.publicKey).not.toBe(A.identity!.publicKey.toString('base64url'));
    const phone = await ownerPhone(A);
    expect((await signed(A, phone.dev, phone.deviceId, 'GET', '/mobile/introducer')).body.keyId).toBe(introducerKeyId(key.publicKey));
  });

  it('no identity: 404 no-identity', async () => {
    const A = agent('echo', A_HOST, { identity: null });
    expect((await bearer(A, request(A.app).get('/mobile/introducer'))).body.error).toBe('no-identity');
  });

  it('the bearer token cannot get an introduction signed', async () => {
    const { A } = pair();
    const t = { audienceHost: N_HOST, deviceId: '00000000-0000-4000-8000-000000000001', fingerprint: 'AAAA-BBBB-CCCC-DDDD' };
    expect((await bearer(A, request(A.app).post('/mobile/introductions/challenge')).send(t)).status).toBe(403);
    expect((await bearer(A, request(A.app).post('/mobile/introductions')).send({ ...t, challenge: 'x', presenceSig: 'y' })).body.error).toBe('device-signature-required');
  });

  it('no presence key: refused by name; a bad presence signature or a reused challenge signs nothing', async () => {
    const { A } = pair();
    const noKey = await ownerPhone(A, false);
    const t = { audienceHost: N_HOST, deviceId: '00000000-0000-4000-8000-000000000001', fingerprint: 'AAAA-BBBB-CCCC-DDDD' };
    expect((await signed(A, noKey.dev, noKey.deviceId, 'POST', '/mobile/introductions/challenge', t)).body.error).toBe('presence-key-missing');
    const phone = await ownerPhone(A);
    const c = await signed(A, phone.dev, phone.deviceId, 'POST', '/mobile/introductions/challenge', t);
    const wrong = phone.dev.sign(introducePresenceMessage(phone.deviceId, A_HOST, c.body.challenge, introduceLine(t.audienceHost, t.deviceId, t.fingerprint)));
    // Signed by the device key, not the presence key.
    expect((await signed(A, phone.dev, phone.deviceId, 'POST', '/mobile/introductions', { ...t, challenge: c.body.challenge, presenceSig: wrong })).body.error).toBe('presence-invalid');
    // That challenge was consumed before it was judged: reusing it, even correctly signed, fails.
    const right = phone.presence.sign(introducePresenceMessage(phone.deviceId, A_HOST, c.body.challenge, introduceLine(t.audienceHost, t.deviceId, t.fingerprint)));
    expect((await signed(A, phone.dev, phone.deviceId, 'POST', '/mobile/introductions', { ...t, challenge: c.body.challenge, presenceSig: right })).body.error).toBe('challenge-invalid');
    const c2 = await signed(A, phone.dev, phone.deviceId, 'POST', '/mobile/introductions/challenge', t);
    const sig = phone.presence.sign(introducePresenceMessage(phone.deviceId, A_HOST, c2.body.challenge, introduceLine(t.audienceHost, t.deviceId, t.fingerprint)));
    // A challenge issued for one target cannot sign another.
    const other = { ...t, deviceId: '00000000-0000-4000-8000-000000000002' };
    expect((await signed(A, phone.dev, phone.deviceId, 'POST', '/mobile/introductions', { ...other, challenge: c2.body.challenge, presenceSig: sig })).body.error).toBe('challenge-invalid');
  });
});

describe('the new agent (agent N)', () => {
  it('Telegram-less, native off, with an introducer: mints, and the waiting phone is offered the paired agent first', async () => {
    const { N, key } = pair();
    const w = await waiting(N);
    expect(w.redeem.body).toMatchObject({ status: 'pending', approval: 'dashboard', confirmWith: ['paired-agent', 'code'], codeAt: 'pairing-page' });
    expect(w.redeem.body.introducers).toEqual([{ name: 'Echo', keyId: introducerKeyId(key.publicKey) }]);
    expect(w.redeem.body.codePageUrl).toContain(N_HOST);
  });

  it('the whole flow: Face ID on A, the introduction handed in by the waiting phone, active on N', async () => {
    const { A, N } = pair();
    const phone = await ownerPhone(A);
    const w = await waiting(N);
    const intro = await introduce(A, phone, { aud: N_HOST, deviceId: w.deviceId, fingerprint: w.fingerprint });
    expect(intro.status).toBe(200);
    const r = await signed(N, w.dev, w.deviceId, 'POST', '/mobile/device/introduction', intro.body);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ status: 'active', deviceId: w.deviceId });
    const row = N.svc.devices.get(w.deviceId)!;
    expect(row.approvedVia).toBe('owner-agent');
    expect(row.approvedBy).toMatch(/^introducer:[0-9A-F]{4}-/);
    // Retrying a lost answer is harmless.
    expect((await signed(N, w.dev, w.deviceId, 'POST', '/mobile/device/introduction', intro.body)).body.status).toBe('active');
    expect((await signed(N, w.dev, w.deviceId, 'GET', '/mobile/routes')).status).toBe(200);
    expect(fs.readFileSync(path.join(A.config.stateDir, 'state', 'mobile-introductions.jsonl'), 'utf8')).toContain(w.deviceId);
  });

  it('an introduction for one waiting phone cannot pair another', async () => {
    const { A, N } = pair();
    const phone = await ownerPhone(A);
    const mine = await waiting(N);
    const intro = await introduce(A, phone, { aud: N_HOST, deviceId: mine.deviceId, fingerprint: mine.fingerprint });
    N.svc.declinePending(mine.deviceId);
    const thief = await waiting(N);
    const r = await signed(N, thief.dev, thief.deviceId, 'POST', '/mobile/device/introduction', intro.body);
    expect(r.body.error).toBe('introduction-wrong-phone');
    expect(N.svc.devices.get(thief.deviceId)!.status).toBe('pending');
  });

  const nonce = () => Buffer.from(Math.random().toString()).toString('base64url').padEnd(22, 'A').slice(0, 22);
  async function forged() {
    const { A, N, key } = pair();
    const w = await waiting(N);
    const base = { introducerName: 'Echo', deviceId: w.deviceId, fingerprint: w.fingerprint, iat: Date.now(), exp: Date.now() + 120_000 };
    const send = (b: unknown) => signed(N, w.dev, w.deviceId, 'POST', '/mobile/device/introduction', b);
    return { A, N, key, w, base, send, k: key.publicKey.toString('base64url') };
  }

  it('wrong agent, unknown introducer and the identity key are refused', async () => {
    const { A, base, send, k, key } = await forged();
    expect((await send(signIntroduction({ ...base, introducerKey: k, aud: 'elsewhere.example.dev', nonce: nonce() }, key.privateKey))).body.error).toBe('introduction-wrong-agent');
    const stranger = deriveIntroducerKey(generateIdentityKeyPair());
    expect((await send(signIntroduction({ ...base, introducerKey: stranger.publicKey.toString('base64url'), aud: N_HOST, nonce: nonce() }, stranger.privateKey))).body.error).toBe('introducer-unknown');
    // Signed by A's IDENTITY key (what a relay could obtain) while claiming the introducer key.
    expect((await send(signIntroduction({ ...base, introducerKey: k, aud: N_HOST, nonce: nonce() }, A.identity!.privateKey))).body.error).toBe('introduction-invalid');
  });

  it('a flipped byte and an expired or over-long window are refused', async () => {
    const { w, base, send, k, key } = await forged();
    const good = signIntroduction({ ...base, introducerKey: k, aud: N_HOST, nonce: nonce() }, key.privateKey);
    const flipped = Buffer.from(good.introduction, 'base64url').toString().replace(w.fingerprint, w.fingerprint.replace(/^./, (c) => (c === 'A' ? 'B' : 'A')));
    expect((await send({ ...good, introduction: Buffer.from(flipped).toString('base64url') })).body.error).toBe('introduction-invalid');
    expect((await send(signIntroduction({ ...base, introducerKey: k, aud: N_HOST, nonce: nonce(), iat: Date.now() - 200_000, exp: Date.now() - 80_000 }, key.privateKey))).body.error).toBe('introduction-expired');
    expect((await send(signIntroduction({ ...base, introducerKey: k, aud: N_HOST, nonce: nonce(), exp: Date.now() + 400_000 }, key.privateKey))).body.error).toBe('introduction-expired');
  });

  it('a consumed nonce is refused while the phone still waits; the funnel still rules', async () => {
    const { N, w, base, send, k, key } = await forged();
    const once = signIntroduction({ ...base, introducerKey: k, aud: N_HOST, nonce: nonce() }, key.privateKey);
    // A second phone waiting makes the funnel refuse (the nonce is spent); a replay of it is then refused by name.
    const other = await waiting(N);
    expect((await send(once)).body.error).toBe('another-phone-waiting');
    N.svc.declinePending(other.deviceId);
    expect((await send(once)).body.error).toBe('introduction-replayed');
    expect(N.svc.devices.get(w.deviceId)!.status).toBe('pending');
  });

  it('the switch off, or no introducer: 503, and the paired agent is not offered', async () => {
    const A = agent('echo', A_HOST);
    const key = deriveIntroducerKey(A.identity!).publicKey.toString('base64url');
    const off = agent('pairtest', N_HOST, { introducers: [{ name: 'Echo', publicKey: key }], approve: false });
    const w = await waiting(off);
    expect(w.redeem.body.confirmWith).toBeUndefined();
    expect((await signed(off, w.dev, w.deviceId, 'POST', '/mobile/device/introduction', { introduction: 'x', signature: 'y' })).status).toBe(503);
    const none = agent('pairtest', N_HOST);
    const w2 = await waiting(none);
    expect(w2.redeem.body.confirmWith).toEqual(['code']);
    expect((await signed(none, w2.dev, w2.deviceId, 'POST', '/mobile/device/introduction', { introduction: 'x', signature: 'y' })).body.error).toBe('introductions-off');
  });

  it('a malformed introducer entry is skipped and reported, never trusted', async () => {
    const N = agent('pairtest', N_HOST, { native: false, introducers: [{ name: 'Bad', publicKey: 'not-a-key' }] });
    expect(N.svc.introducers()).toEqual([]);
    // No valid introducer, no Telegram, native off: the mint refuses instead of minting a dead link.
    const m = await bearer(N, request(N.app).post('/mobile/pairing-codes')).send({});
    expect(m.status).toBe(409);
    expect(m.body.error).toBe('approval-unavailable');
  });

  it('no route can add an introducer: mobilePairing is not a patchable config key', () => {
    expect(PATCHABLE_CONFIG_KEYS.has('mobilePairing')).toBe(false);
  });
});

describe('fb-cceb7986-efa and the honest dashboard line', () => {
  it('no Telegram owner, native off, no introducer: the mint refuses with a reason', async () => {
    const N = agent('pairtest', N_HOST, { native: false });
    const m = await bearer(N, request(N.app).post('/mobile/pairing-codes')).send({});
    expect(m.status).toBe(409);
    expect(m.body.detail).toMatch(/no Telegram chat/);
  });

  it('the pairing page is named only while it is open and unlocked', async () => {
    const N = agent('pairtest', N_HOST);
    const w = await waiting(N);
    expect(w.redeem.body.confirmWith).toEqual(['code']);
    const list = await bearer(N, request(N.app).get('/mobile/pairing-approvals')).set('X-Instar-Operator-Session', 'sess');
    expect(list.status).toBe(200);
    expect((await signed(N, w.dev, w.deviceId, 'GET', '/mobile/device')).body.confirmWith).toEqual(['dashboard', 'code']);
  });

  it('a Telegram owner still gets the Telegram path, native on or off', async () => {
    for (const native of [true, false]) {
      const N = agent('pairtest', N_HOST, { native, telegramOwner: true });
      const w = await waiting(N);
      expect(w.redeem.body).toMatchObject({ approval: 'telegram', confirmWith: ['telegram', 'code'] });
    }
  });
});
