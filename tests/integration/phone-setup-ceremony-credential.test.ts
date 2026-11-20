/**
 * Identity A5 over the real HTTP pipeline (docs/specs/identity-security-piece3e-same-network-first-phone.md §4.6):
 * the Instar app on the agent's own computer adds the first phone with a one-time credential its command made
 * inside the agent's own system, in place of the PIN nobody was told. And the home port the app asks for (§3.1).
 * Both sides of every boundary: where it is accepted, and every way it is refused without falling back to the PIN.
 */
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { authMiddleware } from '../../src/server/middleware.js';
import { MobilePairingService, mountPublicMobilePairingRoutes, createMobilePairingRouter, deviceAuthenticator, DEVICE_ALLOWLIST, type MobilePairingDeps } from '../../src/server/mobilePairingRoutes.js';
import { SameNetworkListener } from '../../src/server/sameNetworkListener.js';
import { sameNetworkGate, homeAddressInUse } from '../../src/server/phoneSetupRoutes.js';
import { ceremonyCredentialPath, mintCeremonyCredential } from '../../src/core/ceremonyCredential.js';
import type { NetworkObservation } from '../../src/core/SameNetworkNetwork.js';
import { makeDevice } from '../helpers/mobileDevice.js';
import { pinnedRequest, signedHeaders } from '../helpers/pinnedPhone.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { InstarConfig } from '../../src/core/types.js';

const PIN = '482915';
const MAIN = 4321;
const LOCAL_HOST = `127.0.0.1:${MAIN}`;
const HOME: NetworkObservation = { kind: 'observed', network: { iface: 'wlan0', router: '192.168.1.1', address: '192.168.1.20', range: '192.168.1.0/24' } };
const dirs: string[] = [];
const cleanups: Array<() => Promise<void> | void> = [];
afterAll(async () => {
  for (const c of cleanups) await c();
  for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/integration/phone-setup-ceremony-credential.test.ts' });
});

function setup(opts: { telegramOwner?: boolean; noPin?: boolean; app?: 'here' | 'elsewhere' | 'none' | 'no-machine' | 'two'; lease?: boolean; wslMode?: 'nat' | 'mirrored' | 'other' | 'unknown' } = {}) {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'icc-int-'));
  dirs.push(dir);
  // This computer's identity for the agent, as `instar init` writes it (the command mints under it).
  fs.mkdirSync(path.join(dir, 'machine'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'machine', 'identity.json'), JSON.stringify({ machineId: 'm_self' }));
  const config = {
    projectName: 'Wintest', projectDir: dir, stateDir: dir, port: MAIN, authToken: 'tok-1', developmentAgent: true,
    ...(opts.noPin ? {} : { dashboardPin: PIN }),
    mobilePairing: { multiRoute: { enabled: false } },
  } as unknown as InstarConfig;
  const app = express();
  app.use(express.json({ verify: (req, _res, buf) => { (req as unknown as { rawBody: Buffer }).rawBody = buf; } }));
  const telegram = { owner: opts.telegramOwner === true };
  const lease = { holds: opts.lease !== false };
  const deps: MobilePairingDeps = {
    config, stateDir: dir, selfMachineId: 'm_self', holdsLease: () => lease.holds,
    telegramOwnerPresent: () => telegram.owner,
    ownerDM: async () => 7,
  };
  const svc = new MobilePairingService(deps);
  const listener: SameNetworkListener = new SameNetworkListener({
    stateDir: dir, agentName: 'Wintest', machineName: 'DESKTOP-1', mainPort: MAIN, app, port: 0, announce: false,
    ...(opts.wslMode
      // Inside WSL: the mode as read; WSL's "NAT address" is loopback so the test binds it on any host.
      ? { wsl: true, observe: async () => ({ kind: 'delegated' as const, observer: 'windows-app' as const }), wslMode: async () => ({ mode: opts.wslMode!, source: 'wslinfo' as const, detail: opts.wslMode! }), wslNatAddress: () => '127.0.0.1' }
      : { wsl: false, bindHost: '127.0.0.1', observe: async () => HOME }),
    inUse: () => homeAddressInUse(svc),
    gate: sameNetworkGate({ device: (id) => svc.devices.get(id), deviceRoute: (m, p) => DEVICE_ALLOWLIST.some((r) => r.method === m && r.re.test(p)), ownHost: () => (listener.listening() ? listener.host() : null) }),
  });
  svc.sameNetwork = listener;
  cleanups.push(async () => { await listener.stop(); svc.stop(); });
  mountPublicMobilePairingRoutes(app, svc);
  app.use(authMiddleware(() => config.authToken, 'Wintest', undefined, deviceAuthenticator(svc)));
  app.use(createMobilePairingRouter(svc, deps, { config, resolvePeerUrls: () => [] } as unknown as Parameters<typeof createMobilePairingRouter>[2]));
  // The Instar app the installer enrolled (the one-time ticket): a local-install computer record on this machine.
  const which = opts.app ?? 'here';
  if (which !== 'none') {
    const r = svc.devices.createActiveLocalOwner({ id: 'app-1', publicKey: makeDevice().publicKey, host: LOCAL_HOST, label: 'Instar on this PC', machineId: which === 'here' || which === 'two' ? 'm_self' : which === 'elsewhere' ? 'm_other' : null, approvedAt: new Date().toISOString() });
    expect(r.ok).toBe(true);
  }
  if (which === 'two') {
    // A second record on this machine (written past the registry's one-owner rule, as a damaged or old state could).
    const file = path.join(dir, 'state', 'mobile-devices.json');
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
    raw.devices.push({ ...raw.devices[0], id: 'app-2', publicKey: makeDevice().publicKey });
    fs.writeFileSync(file, JSON.stringify(raw));
  }
  return { app, svc, listener, telegram, lease, dir };
}

const mint = (dir: string, machineId = 'm_self') => mintCeremonyCredential(dir, { scope: 'phone-setup', machineId }).credential;
const post = (app: express.Express, body: Record<string, unknown>, host = LOCAL_HOST) =>
  request(app).post('/mobile/phone-setup').set('Authorization', 'Bearer tok-1').set('Host', host).send(body);
const spent = (dir: string) => !fs.existsSync(ceremonyCredentialPath(dir));

async function freePort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  const p = (s.address() as net.AddressInfo).port;
  await new Promise((r) => s.close(() => r(undefined)));
  return p;
}

describe('identity A5: the app on the agent\'s own computer adds the first phone with a one-time credential', () => {
  it('end to end without the PIN (the agent has none anybody knows): credential, QR, pinned redeem, number, signed activation', async () => {
    const ctx = setup({ noPin: true });
    const s = await post(ctx.app, { ceremonyCredential: mint(ctx.dir), address: 'home' });
    expect(s.status).toBe(200);
    expect(s.body.linkVersion).toBe(2);
    expect(s.body.approval).toBe('computer');
    expect(spent(ctx.dir)).toBe(true);
    const q = new URLSearchParams(String(s.body.link).split('#')[1]);
    const host = q.get('h')!; const pin = q.get('k')!; const code = q.get('c')!;
    const port = Number(host.split(':')[1]);
    const dev = makeDevice();
    const r = await pinnedRequest({ port, pin, method: 'POST', path: '/mobile/pairing-codes/redeem', body: JSON.stringify({ code, deviceName: 'Phone', devicePublicKey: dev.publicKey, pinnedKeyHash: pin }) });
    expect(r.status).toBe(200);
    const n = await request(ctx.app).post(`/mobile/phone-setup/${s.body.setupId}/number`).set('Authorization', 'Bearer tok-1').send({ number: r.json.number });
    expect(n.status).toBe(200);
    const body = JSON.stringify({ pinnedKeyHash: pin });
    const act = await pinnedRequest({ port, pin, method: 'POST', path: '/mobile/device/activate-at-computer', body, headers: signedHeaders(dev, String(r.json.deviceId), host, 'POST', '/mobile/device/activate-at-computer', body) });
    expect(act.status).toBe(200);
    expect(act.json).toEqual({ status: 'active', approvedVia: 'at-computer', canApprove: false });
    // Once a phone is paired, a new credential opens nothing (and is not spent on the refusal).
    const again = mint(ctx.dir);
    const second = await post(ctx.app, { ceremonyCredential: again });
    expect(second.status).toBe(409);
    expect(second.body.error).toBe('phone-already-paired');
    expect(spent(ctx.dir)).toBe(false);
  });

  it('single use: the same credential twice opens one setup', async () => {
    const ctx = setup();
    const c = mint(ctx.dir);
    expect((await post(ctx.app, { ceremonyCredential: c })).status).toBe(200);
    const twice = await post(ctx.app, { ceremonyCredential: c });
    expect(twice.status).toBe(403);
    expect(twice.body.error).toBe('ceremony-credential-refused');
  });

  it('fails closed: a wrong, missing or empty credential is refused, and a right PIN in the same request does not rescue it', async () => {
    const ctx = setup();
    mint(ctx.dir);
    for (const ceremonyCredential of ['icc1_wrong', '', null]) {
      const r = await post(ctx.app, { ceremonyCredential, pin: PIN });
      expect(r.status).toBe(403);
      expect(r.body.error).toBe('ceremony-credential-refused');
    }
    // Three wrong tries spent it.
    expect(spent(ctx.dir)).toBe(true);
    expect(ctx.listener.listening()).toBe(false);
    const none = setup();
    expect((await post(none.app, { ceremonyCredential: 'icc1_anything' })).status).toBe(403);
    // The PIN path is unchanged, for the terminal and the dashboard.
    expect((await post(none.app, { pin: PIN })).status).toBe(200);
  });

  it('never from the network: a forwarded request, another Host, or the home listener is refused, and the credential is not spent', async () => {
    const ctx = setup();
    const c = mint(ctx.dir);
    const fwd = await request(ctx.app).post('/mobile/phone-setup').set('Authorization', 'Bearer tok-1').set('Host', LOCAL_HOST).set('X-Forwarded-For', '203.0.113.9').send({ ceremonyCredential: c });
    expect(fwd.status).toBe(403);
    expect(fwd.body.error).toBe('at-the-computer-only');
    for (const host of ['localhost:4321', '127.0.0.1:9999', 'agent.example.com', 'wintest-desktop-1.local:24321']) {
      const r = await post(ctx.app, { ceremonyCredential: c }, host);
      expect(r.status).toBe(403);
      expect(r.body.error).toBe('ceremony-credential-refused');
    }
    expect(spent(ctx.dir)).toBe(false);
    // On the home listener (open it with the PIN first) the route does not exist at all.
    expect((await post(ctx.app, { pin: PIN })).status).toBe(200);
    const port = ctx.listener.status().port!;
    const onListener = await pinnedRequest({ port, pin: ctx.listener.spkiHash()!, method: 'POST', path: '/mobile/phone-setup', body: JSON.stringify({ ceremonyCredential: c }) });
    expect(onListener.status).toBe(404);
    expect(spent(ctx.dir)).toBe(false);
  });

  it('only on the computer whose app the installer enrolled: no app, an app bound to another machine, or to no machine is refused', async () => {
    for (const app of ['none', 'elsewhere', 'no-machine', 'two'] as const) {
      const ctx = setup({ app });
      mint(ctx.dir);
      const r = await post(ctx.app, { ceremonyCredential: mint(ctx.dir) });
      expect(r.status).toBe(403);
      expect(r.body.error).toBe('no-app-on-this-computer');
      expect(spent(ctx.dir)).toBe(false);
    }
  });

  it('a credential made under another machine id is refused', async () => {
    const ctx = setup();
    const r = await post(ctx.app, { ceremonyCredential: mint(ctx.dir, 'm_other') });
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('ceremony-credential-refused');
  });

  it('only where the number is typed at the computer: with a Telegram owner it is refused, and the PIN path still works', async () => {
    const ctx = setup({ telegramOwner: true });
    const c = mint(ctx.dir);
    const r = await post(ctx.app, { ceremonyCredential: c });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('ceremony-credential-not-for-chat-owner');
    expect(spent(ctx.dir)).toBe(false);
    expect((await post(ctx.app, { pin: PIN })).status).toBe(200);
  });

  it('refusals that can be known first come before the credential is spent: pairing paused, no outside address, a fixed port', async () => {
    const paused = setup();
    const c = mint(paused.dir);
    paused.svc.devices.pairingPaused = () => true;
    expect((await post(paused.app, { ceremonyCredential: c })).status).toBe(429);
    expect(spent(paused.dir)).toBe(false);

    const away = setup();
    mint(away.dir);
    const r = await post(away.app, { ceremonyCredential: mint(away.dir), address: 'anywhere' });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('stable-address-required');
    expect(spent(away.dir)).toBe(false);

    const fixed = setup();
    const s = await post(fixed.app, { pin: PIN });
    const q = new URLSearchParams(String(s.body.link).split('#')[1]);
    const pin = q.get('k')!; const port = Number(q.get('h')!.split(':')[1]);
    const dev = makeDevice();
    expect((await pinnedRequest({ port, pin, method: 'POST', path: '/mobile/pairing-codes/redeem', body: JSON.stringify({ code: q.get('c'), deviceName: 'Phone', devicePublicKey: dev.publicKey, pinnedKeyHash: pin }) })).status).toBe(200);
    // Telegram-less, no active phone yet (it waits): a credential with another port is refused as fixed, unspent.
    const c2 = mint(fixed.dir);
    const moved = await post(fixed.app, { ceremonyCredential: c2, port: await freePort() });
    expect(moved.status).toBe(409);
    expect(moved.body).toMatchObject({ error: 'port-fixed', port });
    expect(spent(fixed.dir)).toBe(false);
  });

  it('only on the machine serving the agent (the lease holder)', async () => {
    const ctx = setup({ lease: false });
    const r = await post(ctx.app, { ceremonyCredential: mint(ctx.dir) });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('not-lease-holder');
    expect(spent(ctx.dir)).toBe(false);
  });
});

describe('identity A4: the home port the app asks for', () => {
  it('is used exactly, and the link carries it', async () => {
    const ctx = setup();
    const want = await freePort();
    const s = await post(ctx.app, { pin: PIN, port: want });
    expect(s.status).toBe(200);
    expect(s.body.address.host).toBe(`wintest-desktop-1.local:${want}`);
    const status = await request(ctx.app).get('/mobile/same-network').set('Authorization', 'Bearer tok-1');
    expect(status.body.port).toBe(want);
    expect(status.body.preferredPort).toBe(want);
  });

  it('a bad port, or a port with "anywhere", is refused before anything is spent', async () => {
    const ctx = setup();
    const c = mint(ctx.dir);
    for (const body of [{ port: 80 }, { port: 70000 }, { port: '24041' }, { port: 5060 }, { port: MAIN }, { port: 24041, address: 'anywhere' }]) {
      const r = await post(ctx.app, { ceremonyCredential: c, ...body });
      expect(r.status).toBe(422);
      expect(r.body.error).toBe('bad-port');
    }
    expect(spent(ctx.dir)).toBe(false);
    expect(ctx.listener.listening()).toBe(false);
  });

  it('never moves while a phone is paired on the home address: port-fixed names the port to use', async () => {
    const ctx = setup();
    const s = await post(ctx.app, { pin: PIN });
    const q = new URLSearchParams(String(s.body.link).split('#')[1]);
    const host = q.get('h')!; const pin = q.get('k')!;
    const port = Number(host.split(':')[1]);
    const dev = makeDevice();
    const r = await pinnedRequest({ port, pin, method: 'POST', path: '/mobile/pairing-codes/redeem', body: JSON.stringify({ code: q.get('c'), deviceName: 'Phone', devicePublicKey: dev.publicKey, pinnedKeyHash: pin }) });
    expect(r.status).toBe(200); // a waiting phone on the home address counts
    const other = await freePort();
    const moved = await post(ctx.app, { pin: PIN, port: other });
    expect(moved.status).toBe(409);
    expect(moved.body).toMatchObject({ error: 'port-fixed', port });
    expect((await post(ctx.app, { pin: PIN, port })).status).toBe(200);
  });

  it('inside WSL: a networking mode the home address cannot open on refuses before the credential is spent', async () => {
    for (const mode of ['mirrored', 'unknown', 'other'] as const) {
      const ctx = setup({ noPin: true, wslMode: mode });
      mint(ctx.dir);
      const r = await post(ctx.app, { ceremonyCredential: mint(ctx.dir), address: 'home' });
      expect(r.status, mode).toBe(409);
      expect(r.body).toMatchObject({ error: 'wsl-networking-mode', mode });
      expect(spent(ctx.dir), mode).toBe(false);
      expect(ctx.listener.listening()).toBe(false);
    }
  });

  it('inside WSL: NAT opens; mirrored opens only on the Windows app\'s word, on loopback', async () => {
    const nat = setup({ noPin: true, wslMode: 'nat' });
    expect((await post(nat.app, { ceremonyCredential: mint(nat.dir), address: 'home' })).status).toBe(200);
    expect(nat.listener.status().wslMode).toMatchObject({ mode: 'nat' });
    const mir = setup({ noPin: true, wslMode: 'mirrored' });
    const r = await post(mir.app, { ceremonyCredential: mint(mir.dir), address: 'home', windowsAppHandlesNetworkRule: true });
    expect(r.status).toBe(200);
    expect(mir.listener.status().bind).toBe('127.0.0.1');
    // A truthy value that is not exactly true is not the app's word.
    const strict = setup({ noPin: true, wslMode: 'mirrored' });
    expect((await post(strict.app, { ceremonyCredential: mint(strict.dir), address: 'home', windowsAppHandlesNetworkRule: 'yes' })).body.error).toBe('wsl-networking-mode');
  });

  it('inside WSL with the PIN: mirrored without the app\'s word is refused and nothing opens', async () => {
    const ctx = setup({ wslMode: 'mirrored' });
    const r = await post(ctx.app, { pin: PIN, address: 'home' });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('wsl-networking-mode');
    expect(ctx.listener.status().wanted).toBe(false);
  });
});
