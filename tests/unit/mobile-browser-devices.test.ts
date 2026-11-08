/**
 * Browser devices (docs/specs/dashboard-conversations-browser-device.md): the registry, the
 * activation (intent → ledger row → registry → effects), recovery, and the setup route.
 *
 * Echo's binding acceptance conditions (spec "Acceptance conditions"):
 *   1. Decline / a third wrong code raced against Approve in both orders, including the crash
 *      window between §4.2 step 10.1 and 10.3, never ends "declined but active" nor
 *      "approved but declined".
 *   2. Two concurrent setups cannot both take the last hourly slot nor both use one PIN entry;
 *      every not-delivered, no-lease, no-approval-path and stuck-`notifying` removal returns its slot.
 *   3. Recovery on ledger attach expires an approving record with no ledger row, and leaves
 *      records alone (reported once) when no ledger is attached.
 */
import { describe, it, expect, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import express from 'express';
import request from 'supertest';
import type { Request, Response } from 'express';
import { MobilePairingService, createMobilePairingRouter, deviceAuthenticator, DEVICE_ALLOWLIST } from '../../src/server/mobilePairingRoutes.js';
import { MobileDeviceKeyLedger } from '../../src/core/MobileDeviceKeyLedger.js';
import { canonicalString, DeviceRegistry, keyHashOf, type DeviceRecord } from '../../src/core/MobileDeviceKeys.js';
import { signerKeyHashOf, type MachineKeyLookup, type MachineSigner } from '../../src/core/AppRecordSignatures.js';
import { generateSigningKeyPair, sign as edSign } from '../../src/core/MachineIdentity.js';
import { enrollProofMessage, EFFECT_REPORT_AFTER } from '../../src/server/mobileBrowserDevices.js';
import { makeDevice } from '../helpers/mobileDevice.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const HOST = 'echo.example.dev';
const dirs: string[] = [];
const stops: Array<() => void> = [];
afterAll(() => {
  for (const s of stops) s();
  for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/unit/mobile-browser-devices.test.ts' });
});

function makeLedger(dir: string, machineId = 'm_alpha') {
  const kp = generateSigningKeyPair();
  const hash = signerKeyHashOf(kp.publicKey);
  const signer: MachineSigner = { machineId: () => machineId, signerKeyHash: () => hash, sign: (p) => ({ machineId, signerKeyHash: hash, sig: edSign(p, kp.privateKey) }) };
  const keyLookup: MachineKeyLookup = (m, h) => (m === machineId && h === hash ? { status: 'ok', publicKeyPem: kp.publicKey } : { status: 'unknown' });
  return { ledger: new MobileDeviceKeyLedger({ stateDir: dir, signer, keyLookup }), signer, keyLookup };
}

interface SetupOpts {
  dir?: string; ledger?: boolean; ownerDM?: (text: string, d: string, a?: string) => Promise<number | null>;
  holdsLease?: () => boolean; nativeOn?: boolean; maxSetupsPerHour?: number; maxBrowsers?: number; port?: number;
  reportDegradation?: (what: string, err: unknown) => void; telegramOwner?: boolean;
  raiseBrowserNotice?: (item: { key: string; title: string; body: string }, opts: { localOnly: boolean }) => Promise<boolean>;
  now?: () => number;
}
function service(o: SetupOpts = {}) {
  const dir = o.dir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'browser-dev-'));
  if (!o.dir) dirs.push(dir);
  const config = {
    projectName: 'echo', developmentAgent: true, port: o.port ?? 4062,
    mobilePairing: { multiRoute: { enabled: false }, browser: { maxSetupsPerHour: o.maxSetupsPerHour, maxBrowsers: o.maxBrowsers } },
  };
  const pairing = new MobilePairingService({
    config: config as never, stateDir: dir, holdsLease: o.holdsLease ?? (() => true),
    ...(o.ownerDM ? { ownerDM: o.ownerDM, telegramOwnerPresent: () => o.telegramOwner ?? true } : {}),
    ...(o.reportDegradation ? { reportDegradation: o.reportDegradation } : {}),
    ...(o.raiseBrowserNotice ? { raiseBrowserNotice: o.raiseBrowserNotice } : {}),
  }, o.now);
  pairing.nativeOn = o.nativeOn ?? true;
  stops.push(() => pairing.stop());
  const l = o.ledger === false ? null : makeLedger(dir);
  if (l) { pairing.keyLedger = l.ledger; pairing.browser.recoverOnLedgerAttach(); }
  return { dir, pairing, ledger: l?.ledger ?? null, config };
}

let sessionCounter = 0;
/** A pending browser in `awaiting` (its approval message delivered), as the Telegram path leaves it. */
function pendingBrowser(pairing: MobilePairingService, opts: { awaiting?: boolean; replaces?: { deviceId: string; keyHash: string } } = {}) {
  const dev = makeDevice();
  const c = pairing.devices.createPendingBrowser({
    browserPublicKey: dev.publicKey, host: HOST, deviceName: 'Browser', enrollmentId: `${Date.now()}-${crypto.randomUUID()}`,
    replaces: opts.replaces ?? null, session: `s${sessionCounter++}`, maxBrowsers: 1000, maxSetupsPerHour: 1000,
  });
  if (!c.ok) throw new Error(`pending: ${c.reason}`);
  if (opts.awaiting !== false) expect(pairing.devices.setSetupState(c.device.id, 'awaiting', 'notifying')).toBe(true);
  return { dev, id: c.device.id };
}

/** The two forbidden end states of acceptance condition 1. */
function assertNoContradiction(pairing: MobilePairingService, ledger: MobileDeviceKeyLedger | null, id: string) {
  const d = pairing.devices.get(id)!;
  const hasRow = !!ledger && ledger.hasActivation(d);
  // "declined but active": the registry says declined while the key is activated in the ledger (or active).
  expect(d.status === 'declined' && (hasRow || !!d.approvedAt)).toBe(false);
  // "approved but declined": an active record that carries a decline.
  expect(d.status === 'active' && !!d.declinedAt).toBe(false);
}

describe('acceptance 1 — decline and wrong codes never race an approval', () => {
  it('approve first, then the Decline tap: already approved, still active', () => {
    const { pairing, ledger } = service();
    const { id } = pendingBrowser(pairing);
    const nonce = 'n1'; pairing.declineNonces.set(nonce, id);
    expect(pairing.browser.activate(id, 'telegram-dm')).toBe('activated');
    pairing.declineNonces.set(nonce, id); // a stale button the owner taps afterwards
    expect(pairing.declineByNonce(nonce)).toBe('already-approved');
    expect(pairing.devices.get(id)!.status).toBe('active');
    assertNoContradiction(pairing, ledger, id);
  });

  it('decline first, then approve: the approval is refused and nothing reaches the ledger', () => {
    const { pairing, ledger } = service();
    const { id } = pendingBrowser(pairing);
    expect(pairing.declinePending(id)).toBe('declined');
    expect(pairing.browser.activate(id, 'telegram-dm')).toBe('not-pending');
    expect(pairing.devices.get(id)!.status).toBe('declined');
    expect(ledger!.hasActivation(pairing.devices.get(id)!)).toBe(false);
    assertNoContradiction(pairing, ledger, id);
  });

  it('the owner phone decline after an approval answers already-approved (never declined)', () => {
    const { pairing, ledger } = service();
    const { id } = pendingBrowser(pairing);
    expect(pairing.approvePending(id, 'owner-phone', { approvedBy: 'phone-1' })).toBe('approved');
    expect(pairing.declinePending(id)).toBe('already-approved');
    assertNoContradiction(pairing, ledger, id);
  });

  it('third wrong code first, then approve: declined stays declined', () => {
    const { pairing, ledger } = service();
    const { id } = pendingBrowser(pairing);
    for (const h of ['a', 'b', 'c']) pairing.devices.applyConfirm(id, { ok: false, wrongHmac: h });
    expect(pairing.devices.get(id)!.status).toBe('declined');
    expect(pairing.browser.activate(id, 'telegram-dm')).toBe('not-pending');
    assertNoContradiction(pairing, ledger, id);
  });

  it('approve first, then a third wrong code: refused without declining', () => {
    const { pairing, ledger } = service();
    const { id } = pendingBrowser(pairing);
    pairing.devices.applyConfirm(id, { ok: false, wrongHmac: 'a' });
    pairing.devices.applyConfirm(id, { ok: false, wrongHmac: 'b' });
    expect(pairing.browser.activate(id, 'telegram-dm')).toBe('activated');
    pairing.devices.applyConfirm(id, { ok: false, wrongHmac: 'c' });
    expect(pairing.devices.get(id)!.status).toBe('active');
    assertNoContradiction(pairing, ledger, id);
  });

  for (const crashAfter of ['intent', 'ledger-row'] as const) {
    it(`crash window after the ${crashAfter}: decline and a third wrong code cannot decline it, and recovery decides`, () => {
      const first = service();
      const { id } = pendingBrowser(first.pairing);
      // Step 10.1 (and 10.2) written, then the process dies before 10.3.
      expect(first.pairing.devices.setActivating(id, { approvedVia: 'telegram-dm', at: new Date().toISOString(), effects: ['notice'] })).toBe(true);
      if (crashAfter === 'ledger-row') first.ledger!.recordActivation(first.pairing.devices.get(id)!, 'telegram-dm', new Date().toISOString());
      first.pairing.stop();
      // Restart: the constructor's expiry skips the record carrying an intent.
      const second = service({ dir: first.dir, ledger: false });
      expect(second.pairing.devices.get(id)!.status).toBe('pending');
      // Before the ledger is attached, a decline and wrong codes arrive: neither declines it.
      expect(second.pairing.devices.decline(id)).toBe('already-approved');
      for (const h of ['a', 'b', 'c']) second.pairing.devices.applyConfirm(id, { ok: false, wrongHmac: h });
      expect(second.pairing.devices.get(id)!.status).toBe('pending');
      // It is not a waiting device: it cannot be approved a second time.
      expect(second.pairing.waitingPhones().some((d) => d.id === id)).toBe(false);
      expect(second.pairing.devices.setActivating(id, { approvedVia: 'owner-phone', at: new Date().toISOString(), effects: [] })).toBe(false);
      // The ledger is attached: recovery completes it (row written) or expires it (no row).
      const l = new MobileDeviceKeyLedger({ stateDir: first.dir, signer: { machineId: () => 'x', signerKeyHash: () => 'x', sign: () => { throw new Error('no signing in this test'); } } as never, keyLookup: () => ({ status: 'unknown' }) });
      second.pairing.keyLedger = l;
      second.pairing.browser.recoverOnLedgerAttach();
      const end = second.pairing.devices.get(id)!;
      expect(end.status).toBe(crashAfter === 'ledger-row' ? 'active' : 'expired');
      expect(end.activating).toBeUndefined();
      assertNoContradiction(second.pairing, l, id);
    });
  }
});

describe('acceptance 2 — the hourly limit and the one-record-per-session rule', () => {
  function create(reg: DeviceRegistry, session: string, maxSetupsPerHour = 1) {
    const dev = makeDevice();
    return reg.createPendingBrowser({ browserPublicKey: dev.publicKey, host: HOST, deviceName: 'B', enrollmentId: `${Date.now()}-${crypto.randomUUID()}`, session, maxBrowsers: 10, maxSetupsPerHour });
  }

  it('two setups cannot both take the last slot, and one session cannot create two records', () => {
    const { pairing } = service();
    const a = create(pairing.devices, 'sess-a');
    expect(a.ok).toBe(true);
    const b = create(pairing.devices, 'sess-b');
    expect(b).toMatchObject({ ok: false, reason: 'too-many-setups' });
    const c = create(pairing.devices, 'sess-a', 100);
    expect(c).toMatchObject({ ok: false, reason: 'session-used' });
  });

  it('every removal before approval gives its slot back, the session stays used', () => {
    const { pairing } = service();
    const a = create(pairing.devices, 'sess-a');
    if (!a.ok) throw new Error('setup');
    expect(pairing.devices.browserSetupWindow().count).toBe(1);
    expect(pairing.devices.removeIfStillSettingUp(a.device.id)).toBe(true);
    expect(pairing.devices.browserSetupWindow().count).toBe(0);
    expect(create(pairing.devices, 'sess-a', 100)).toMatchObject({ ok: false, reason: 'session-used' });
    expect(create(pairing.devices, 'sess-b').ok).toBe(true);
  });

  it('removeIfStillSettingUp never removes an awaiting, approving or active record', () => {
    const { pairing } = service();
    const { id } = pendingBrowser(pairing);
    expect(pairing.devices.removeIfStillSettingUp(id)).toBe(false);
    expect(pairing.browser.activate(id, 'telegram-dm')).toBe('activated');
    expect(pairing.devices.removeIfStillSettingUp(id)).toBe(false);
    expect(pairing.devices.get(id)!.status).toBe('active');
  });

  it('a setup stuck in notifying for over 30 s is removed by the tick, and its slot returned', () => {
    let t = Date.now();
    const { pairing } = service({ now: () => t });
    const { id } = pendingBrowser(pairing, { awaiting: false });
    pairing.browser.noteNotifying();
    pairing.browser.tick();
    expect(pairing.devices.get(id)).not.toBeNull();
    t += 31_000;
    pairing.browser.tick();
    expect(pairing.devices.get(id)).toBeNull();
    expect(pairing.devices.browserSetupWindow().count).toBe(0);
  });

  it('a setup still notifying at start-up is removed before the boot expiry, and its slot returned', () => {
    const first = service();
    const { id } = pendingBrowser(first.pairing, { awaiting: false });
    first.pairing.stop();
    const second = service({ dir: first.dir });
    expect(second.pairing.devices.get(id)).toBeNull();
    expect(second.pairing.devices.browserSetupWindow().count).toBe(0);
  });
});

describe('acceptance 3 — recovery on ledger attach', () => {
  it('an approving record with no ledger row is expired', () => {
    const first = service();
    const { id } = pendingBrowser(first.pairing);
    first.pairing.devices.setActivating(id, { approvedVia: 'telegram-dm', at: new Date().toISOString(), effects: ['notice'] });
    first.pairing.stop();
    const second = service({ dir: first.dir });
    expect(second.pairing.devices.get(id)!.status).toBe('expired');
    expect(second.pairing.devices.get(id)!.activating).toBeUndefined();
  });

  it('with no ledger attached, records are left alone and it is reported once', () => {
    const first = service();
    const { id } = pendingBrowser(first.pairing);
    first.pairing.devices.setActivating(id, { approvedVia: 'telegram-dm', at: new Date().toISOString(), effects: ['notice'] });
    first.pairing.stop();
    const report = vi.fn();
    const second = service({ dir: first.dir, ledger: false, reportDegradation: report });
    second.pairing.browser.tick();
    second.pairing.browser.tick();
    second.pairing.browser.recover();
    const d = second.pairing.devices.get(id)!;
    expect(d.status).toBe('pending');
    expect(d.activating).toBeDefined();
    expect(report.mock.calls.filter(([what]) => what === 'MobilePairing.browserRecovery')).toHaveLength(1);
  });

  it('an approving record whose ledger row was written is activated, even after an older version expired it', () => {
    const first = service();
    const { id } = pendingBrowser(first.pairing);
    first.pairing.devices.setActivating(id, { approvedVia: 'telegram-dm', at: new Date().toISOString(), effects: ['notice'] });
    first.ledger!.recordActivation(first.pairing.devices.get(id)!, 'telegram-dm', new Date().toISOString());
    // An older version (which ignores `activating`) expired it in between.
    const file = path.join(first.dir, 'state', 'mobile-devices.json');
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
    raw.devices.find((d: DeviceRecord) => d.id === id).status = 'expired';
    fs.writeFileSync(file, JSON.stringify(raw));
    first.pairing.stop();
    const second = service({ dir: first.dir, ledger: false });
    second.pairing.keyLedger = first.ledger;
    second.pairing.browser.recoverOnLedgerAttach();
    expect(second.pairing.devices.get(id)!.status).toBe('active');
  });
});

describe('activation and its effects', () => {
  it('writes the ledger row with client: browser inside the signed payload, and the merged view exposes it', () => {
    const { pairing, ledger } = service();
    const { id, dev } = pendingBrowser(pairing);
    expect(pairing.browser.activate(id, 'telegram-dm')).toBe('activated');
    const row = ledger!.activationFor(id)!;
    expect(row.client).toBe('browser');
    expect(row.publicKey).toBe(dev.publicKey);
    expect(ledger!.view()!.get(`${keyHashOf(dev.publicKey)}|${id}`)?.client).toBe('browser');
  });

  it('a phone row carries no client field (byte-identical shape)', () => {
    const { pairing, ledger } = service();
    const dev = makeDevice();
    const c = pairing.devices.createPending({ deviceName: 'iPhone', label: null, publicKey: dev.publicKey, host: HOST });
    if (!c.ok) throw new Error('pending');
    const row = ledger!.recordActivation(c.device, 'telegram-dm', new Date().toISOString())!;
    expect(Object.keys(row)).not.toContain('client');
  });

  it('the notice is retried with backoff, reported once after 24 attempts, and falls back to the local list exactly once', async () => {
    let t = Date.now();
    const calls: Array<{ localOnly: boolean }> = [];
    const report = vi.fn();
    const { pairing } = service({ now: () => t, reportDegradation: report, raiseBrowserNotice: async (_i, o) => { calls.push(o); return o.localOnly; } });
    const { id } = pendingBrowser(pairing);
    expect(pairing.browser.activate(id, 'telegram-dm')).toBe('activated');
    for (let i = 0; i < 40; i++) {
      await pairing.browser.runEffects(id);
      t += 61 * 60_000;
    }
    const effects = pairing.devices.get(id)!.effects!;
    expect(effects).toHaveLength(1);
    expect(effects[0]!.attempts).toBeGreaterThanOrEqual(EFFECT_REPORT_AFTER);
    expect(effects[0]!.fallbackRaisedAt).toBeDefined();
    expect(calls.filter((c) => c.localOnly)).toHaveLength(1);
    expect(report.mock.calls.filter(([what]) => what === 'MobilePairing.browserEffects')).toHaveLength(1);
  });

  it('a revoked record with unfinished effects is never pruned', () => {
    const { pairing } = service({ raiseBrowserNotice: async () => false });
    const { id } = pendingBrowser(pairing);
    pairing.browser.activate(id, 'telegram-dm');
    pairing.devices.revoke(id);
    for (let i = 0; i < 205; i++) {
      const p = pendingBrowser(pairing); pairing.devices.revoke(p.id);
    }
    expect(pairing.devices.get(id)).not.toBeNull();
  });
});

// ── The authenticator (§4.4, §4.5) ──
function signedReq(e: { pairing: MobilePairingService }, dev: ReturnType<typeof makeDevice>, id: string, method: string, p: string, host: string, extra: Record<string, string> = {}, peer = '203.0.113.9') {
  const time = String(Date.now());
  const sig = dev.sign(canonicalString(id, host, method, p, time, undefined));
  const req = { headers: { host, 'x-instar-device': id, 'x-instar-device-time': time, 'x-instar-device-sig': sig, ...extra }, method, path: p, originalUrl: p, socket: { remoteAddress: peer }, secure: false } as unknown as Request;
  let status: number | null = null; let body: unknown = null;
  const res = { status(c: number) { status = c; return this; }, json(b: unknown) { body = b; return this; } } as unknown as Response;
  return { verdict: deviceAuthenticator(e.pairing)(req, res), status, body, req };
}

describe('the authenticator for browser devices', () => {
  function activeBrowser(e: ReturnType<typeof service>, host = HOST) {
    const dev = makeDevice();
    const c = e.pairing.devices.createPendingBrowser({ browserPublicKey: dev.publicKey, host, deviceName: 'B', enrollmentId: `${Date.now()}-${crypto.randomUUID()}`, session: `s${sessionCounter++}`, maxBrowsers: 10, maxSetupsPerHour: 100 });
    if (!c.ok) throw new Error('setup');
    e.pairing.devices.setSetupState(c.device.id, 'awaiting', 'notifying');
    expect(e.pairing.browser.activate(c.device.id, 'telegram-dm')).toBe('activated');
    return { dev, id: c.device.id };
  }

  it('a browser is refused on every rule not named for it, and accepted on a named one', () => {
    const e = service();
    const { dev, id } = activeBrowser(e);
    expect(signedReq(e, dev, id, 'GET', '/mobile/conversations', HOST).verdict).toBe('ok');
    const closed = DEVICE_ALLOWLIST.filter((r) => !r.browser);
    expect(closed.length).toBeGreaterThan(20);
    for (const p of ['/sessions', '/attention', '/mobile/devices', '/mobile/pairing-requests', '/mobile/secrets', '/mobile/jobs']) {
      const r = signedReq(e, dev, id, 'GET', p, HOST);
      expect([r.verdict, r.status, (r.body as { error?: string })?.error]).toEqual(['refused', 403, 'browser-device-not-allowed']);
    }
  });

  it('a browser may revoke only itself', async () => {
    const e = service();
    const a = activeBrowser(e);
    const b = activeBrowser(e);
    // The route itself (the authenticator already admitted browser A on this path).
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { (req as unknown as { instarPrincipal: unknown }).instarPrincipal = { kind: 'device', deviceId: a.id }; next(); });
    app.use(createMobilePairingRouter(e.pairing, e.pairing.deps));
    const other = await request(app).post(`/mobile/devices/${b.id}/revoke`).send({});
    expect([other.status, other.body.error]).toEqual([403, 'own-device-only']);
    const self = await request(app).post(`/mobile/devices/${a.id}/revoke`).send({});
    expect(self.body.revoked).toBe(true);
    expect(e.pairing.devices.get(b.id)!.status).toBe('active');
  });

  it('switch off: every browser request is refused 403 browser-devices-off', () => {
    const e = service();
    const { dev, id } = activeBrowser(e);
    (e.config.mobilePairing as { browser: { enabled?: boolean } }).browser.enabled = false;
    const r = signedReq(e, dev, id, 'GET', '/mobile/conversations', HOST);
    expect([r.status, (r.body as { error?: string }).error]).toEqual([403, 'browser-devices-off']);
  });

  it('the loopback rule: exact host, loopback peer, no forwarding header', () => {
    const e = service();
    const host = 'localhost:4062';
    const { dev, id } = activeBrowser(e, host);
    expect(signedReq(e, dev, id, 'GET', '/mobile/conversations', host, {}, '127.0.0.1').verdict).toBe('ok');
    expect(signedReq(e, dev, id, 'GET', '/mobile/conversations', host, {}, '203.0.113.9').status).toBe(401);
    for (const h of ['x-forwarded-for', 'forwarded', 'cf-connecting-ip', 'cdn-loop', 'tailscale-user-login', 'x-real-ip', 'true-client-ip']) {
      expect(signedReq(e, dev, id, 'GET', '/mobile/conversations', host, { [h]: 'x' }, '127.0.0.1').status).toBe(401);
    }
    expect(signedReq(e, dev, id, 'GET', '/mobile/conversations', '127.0.0.1:4062', {}, '127.0.0.1').status).toBe(401);
  });

  it('marks the request as a browser (for the 💻 wording) and writes lastSeenAt at most once a minute', () => {
    const e = service();
    const { dev, id } = activeBrowser(e);
    const r = signedReq(e, dev, id, 'GET', '/mobile/conversations', HOST);
    expect((r.req as unknown as { instarDeviceClient?: string }).instarDeviceClient).toBe('browser');
    const first = e.pairing.devices.get(id)!.lastSeenAt;
    expect(first).toBeDefined();
    signedReq(e, dev, id, 'GET', '/mobile/conversations', HOST);
    expect(e.pairing.devices.get(id)!.lastSeenAt).toBe(first);
  });

  it('a 401 names the answering machine', () => {
    const e = service();
    const { dev, id } = activeBrowser(e);
    const r = signedReq(e, dev, id, 'GET', '/mobile/conversations', 'other.example.dev', {}, '203.0.113.9');
    // Multi-route off: the stored host is used, so a wrong-host signature fails as a bad signature.
    expect(r.status).toBe(401);
    expect(r.body).toHaveProperty('machineId');
  });
});

// ── The setup route (§4.2) ──
describe('POST /mobile/browser-devices', () => {
  async function server(o: SetupOpts & { sessions?: Set<string> }) {
    const srv = http.createServer();
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    const port = (srv.address() as { port: number }).port;
    const e = service({ ...o, port });
    const sessions = o.sessions ?? new Set(['pin-1', 'pin-2', 'pin-3']);
    const app = express();
    app.use(express.json());
    app.use(createMobilePairingRouter(e.pairing, e.pairing.deps, { config: e.config, verifyDashboardOperatorSession: (t: string | undefined) => !!t && sessions.has(t) } as never));
    srv.on('request', app);
    stops.push(() => srv.close());
    return { ...e, port, srv, host: `localhost:${port}` };
  }
  function body(host: string, dev = makeDevice(), enrollmentId = `${Date.now()}-${crypto.randomUUID()}`) {
    const timeMs = String(Date.now());
    return { dev, payload: { publicKey: dev.publicKey, enrollmentId, timeMs, deviceName: 'Test browser', proof: dev.sign(enrollProofMessage(host, dev.publicKey, enrollmentId, timeMs)) } };
  }
  const post = (s: { srv: http.Server; host: string }, payload: unknown, session = 'pin-1', extra: Record<string, string> = {}) => {
    let r = request(s.srv).post('/mobile/browser-devices').set('Host', s.host).set('X-Instar-Operator-Session', session);
    for (const [k, v] of Object.entries(extra)) r = r.set(k, v);
    return r.send(payload as object);
  };

  it('no Telegram owner: the PIN session approves (dashboard-pin) and the browser is active', async () => {
    const s = await server({});
    const { payload } = body(s.host);
    const r = await post(s, payload);
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ status: 'active', approval: 'dashboard', host: s.host });
    expect(s.ledger!.activationFor(r.body.deviceId)).toMatchObject({ approvedVia: 'dashboard-pin', client: 'browser' });
  });

  it('a forwarding header or a non-own Host is refused not-secure-address before anything else', async () => {
    const s = await server({});
    const { payload } = body(s.host);
    expect((await post(s, payload, 'pin-1', { 'X-Forwarded-For': '1.2.3.4' })).body.error).toBe('not-secure-address');
    expect((await request(s.srv).post('/mobile/browser-devices').set('Host', 'evil.example').send(payload)).body.error).toBe('not-secure-address');
  });

  it('a bad proof is refused; a missing session is refused; a retry costs nothing', async () => {
    const s = await server({});
    const { payload } = body(s.host);
    expect((await post(s, { ...payload, proof: payload.proof.slice(0, -4) + 'AAAA' })).body.error).toBe('browser-proof-invalid');
    expect((await post(s, payload, 'not-a-session')).body.error).toBe('operator-session-required');
    const ok = await post(s, payload);
    expect(ok.status).toBe(201);
    // The same request again (a lost response): answered from the record, no new session needed.
    const again = await post(s, payload, 'not-a-session');
    expect(again.status).toBe(200);
    expect(again.body.deviceId).toBe(ok.body.deviceId);
  });

  it('two concurrent setups with the last hourly slot: exactly one is created', async () => {
    const s = await server({ maxSetupsPerHour: 1 });
    const [a, b] = await Promise.all([post(s, body(s.host).payload, 'pin-1'), post(s, body(s.host).payload, 'pin-2')]);
    expect([a.status, b.status].sort()).toEqual([201, 429]);
    expect([a.body.error, b.body.error]).toContain('too-many-setups');
  });

  it('two concurrent setups with one PIN entry: exactly one is created', async () => {
    const s = await server({});
    const [a, b] = await Promise.all([post(s, body(s.host).payload, 'pin-1'), post(s, body(s.host).payload, 'pin-1')]);
    expect([a.status, b.status].sort()).toEqual([201, 403]);
  });

  it('Telegram owner: the approval message is sent, only Telegram or an owner phone approves, never the PIN', async () => {
    const sent: string[] = [];
    const s = await server({ ownerDM: async (t) => { sent.push(t); return 7; } });
    const { payload } = body(s.host);
    const r = await post(s, payload);
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ status: 'pending', approval: 'telegram' });
    expect(sent[0]).toContain('A browser is asking to use your conversations with echo');
    expect(s.pairing.devices.get(r.body.deviceId)!.setupState).toBe('awaiting');
    expect(s.ledger!.activationFor(r.body.deviceId)).toBeNull();
  });

  it('not delivered, no lease, and no approval path each remove the setup and return its slot', async () => {
    for (const o of [
      { ownerDM: async () => null },
      { ownerDM: async () => 7, holdsLease: () => false },
      { nativeOn: false },
    ] as SetupOpts[]) {
      const s = await server({ ...o, maxSetupsPerHour: 1 });
      const r = await post(s, body(s.host).payload);
      expect(r.status).toBe(409);
      expect(r.body.error).toBe('approval-unavailable');
      expect(s.pairing.devices.list().filter((d) => d.client === 'browser')).toHaveLength(0);
      expect(s.pairing.devices.browserSetupWindow().count).toBe(0);
    }
  });

  it('switch off answers 503 for setup and status', async () => {
    const s = await server({});
    (s.config.mobilePairing as { browser: { enabled?: boolean } }).browser.enabled = false;
    expect((await post(s, body(s.host).payload)).status).toBe(503);
    expect((await request(s.srv).get('/mobile/browser-devices/status').set('Host', s.host)).status).toBe(503);
  });

  it('status: precedence revoked > registry > elsewhere > not-found', async () => {
    const s = await server({});
    const { payload, dev } = body(s.host);
    const r = await post(s, payload);
    const kh = keyHashOf(dev.publicKey);
    const status = async () => (await request(s.srv).get(`/mobile/browser-devices/status?keyHash=${kh}`).set('Host', s.host)).body.key;
    expect(await status()).toMatchObject({ state: 'active' });
    s.ledger!.recordRevocation({ id: r.body.deviceId, publicKey: dev.publicKey }, new Date().toISOString());
    // The registry still says active; the ledger revocation wins.
    expect(s.pairing.devices.get(r.body.deviceId)!.status).toBe('active');
    expect(await status()).toMatchObject({ state: 'revoked' });
    expect((await request(s.srv).get(`/mobile/browser-devices/status?keyHash=${'0'.repeat(64)}`).set('Host', s.host)).body.key).toMatchObject({ state: 'not-found' });
  });
});

// ── Route level: a signed confirm against the Decline tap, both orders (acceptance 1, second-pass review) ──
describe('acceptance 1 through the real routes', () => {
  async function telegramBrowser(order: 'decline-first' | 'confirm-first') {
    const dms: string[] = [];
    const e = service({ ownerDM: async (t) => { dms.push(t); return 7; } });
    const app = express();
    app.use(express.json({ verify: (req, _res, buf) => { (req as unknown as { rawBody: Buffer }).rawBody = buf; } }));
    app.use((req, res, next) => { if (deviceAuthenticator(e.pairing)(req, res) === 'refused') return; next(); });
    app.use(createMobilePairingRouter(e.pairing, e.pairing.deps));
    const { dev, id } = pendingBrowser(e.pairing, { awaiting: false });
    expect(await e.pairing.sendBrowserApproval(e.pairing.devices.get(id)!)).toBe(true);
    e.pairing.devices.setSetupState(id, 'awaiting', 'notifying');
    const code = /is ([A-Z]+-\d{4})\./.exec(dms[0]!)![1]!;
    const nonce = [...e.pairing.declineNonces.entries()].find(([, v]) => v === id)![0];
    const confirm = () => {
      const p = '/mobile/device/confirm';
      const raw = Buffer.from(JSON.stringify({ code }));
      const time = String(Date.now());
      return request(app).post(p).set('Host', HOST).set('Content-Type', 'application/json')
        .set('X-Instar-Device', id).set('X-Instar-Device-Time', time).set('X-Instar-Device-Sig', dev.sign(canonicalString(id, HOST, 'POST', p, time, raw)))
        .send(raw.toString());
    };
    if (order === 'decline-first') {
      expect(e.pairing.declineByNonce(nonce)).toBe('declined');
      const r = await confirm();
      expect(r.status).toBeGreaterThanOrEqual(400);
    } else {
      expect((await confirm()).body.status).toBe('active');
      e.pairing.declineNonces.set(nonce, id);
      expect(e.pairing.declineByNonce(nonce)).toBe('already-approved');
    }
    return e;
  }
  for (const order of ['decline-first', 'confirm-first'] as const) {
    it(`${order}: never declined-but-active nor approved-but-declined`, async () => {
      const e = await telegramBrowser(order);
      const d = e.pairing.devices.list().find((x) => x.client === 'browser')!;
      expect(d.status).toBe(order === 'decline-first' ? 'declined' : 'active');
      assertNoContradiction(e.pairing, e.ledger, d.id);
    });
  }
});

describe('second-pass review fixes', () => {
  it('a revoked record loses its activation intent, so recovery stops working on it', () => {
    const { pairing } = service();
    const { id } = pendingBrowser(pairing);
    pairing.devices.setActivating(id, { approvedVia: 'telegram-dm', at: new Date().toISOString(), effects: [] });
    pairing.devices.revoke(id);
    expect(pairing.devices.get(id)!.activating).toBeUndefined();
    expect(pairing.devices.browserWork().some((d) => d.id === id)).toBe(false);
  });

  it('setup is refused before anything is charged when this machine has no device-key ledger', async () => {
    const srv = http.createServer();
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    const port = (srv.address() as { port: number }).port;
    const e = service({ ledger: false, port });
    const app = express();
    app.use(express.json());
    app.use(createMobilePairingRouter(e.pairing, e.pairing.deps, { config: e.config, verifyDashboardOperatorSession: () => true } as never));
    srv.on('request', app);
    stops.push(() => srv.close());
    const host = `localhost:${port}`;
    const dev = makeDevice();
    const enrollmentId = `${Date.now()}-${crypto.randomUUID()}`;
    const timeMs = String(Date.now());
    const r = await request(srv).post('/mobile/browser-devices').set('Host', host).set('X-Instar-Operator-Session', 'x')
      .send({ publicKey: dev.publicKey, enrollmentId, timeMs, proof: dev.sign(enrollProofMessage(host, dev.publicKey, enrollmentId, timeMs)) });
    expect([r.status, r.body.error]).toEqual([503, 'ledger-unavailable']);
    expect(e.pairing.devices.browserSetupWindow().count).toBe(0);
  });

  it('a leaked code does not tell the owner "cancelled" for a record an approval already claimed', () => {
    const dms: string[] = [];
    const { pairing } = service({ ownerDM: async (t) => { dms.push(t); return 1; } });
    const { id } = pendingBrowser(pairing);
    const code = pairing.confirm.issue(id, Date.now() + 60_000, 'word');
    pairing.devices.setActivating(id, { approvedVia: 'telegram-dm', at: new Date().toISOString(), effects: [] });
    pairing.scanInbound(`here is ${code}`);
    expect(dms.some((t) => t.includes('cancelled'))).toBe(false);
    expect(pairing.devices.get(id)!.status).toBe('pending');
  });
});

describe('acceptance 2 — the synchronous block is guarded statically', () => {
  it('no await between the step-4 retry check and the record write in the setup route', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../../src/server/mobileBrowserDevices.ts'), 'utf-8');
    const start = src.indexOf('Steps 4 to 8 run in one synchronous step');
    const end = src.indexOf('svc.devices.createPendingBrowser(', start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const code = src.slice(src.lastIndexOf('\n', start) + 1, end).split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
    expect(/\bawait\b/.test(code)).toBe(false);
  });
});
