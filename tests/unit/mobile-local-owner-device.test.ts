/**
 * The Mac app's first owner device on the same Mac (docs/specs/mac-app-creates-agent.md §A, §B):
 * POST /mobile/local-owner-device, the `localBinding` branch of the device authenticator, the local
 * ticket, and `instar install --app-ticket`. Acceptance 1–3.
 */
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Application, Request, Response } from 'express';
import { MobilePairingService, deviceAuthenticator } from '../../src/server/mobilePairingRoutes.js';
import { MobileDeviceKeyLedger } from '../../src/core/MobileDeviceKeyLedger.js';
import { canonicalString, DeviceRegistry } from '../../src/core/MobileDeviceKeys.js';
import { deviceKeyHashOf as signerKeyHashOfDevice, signerKeyHashOf, type MachineKeyLookup, type MachineSigner } from '../../src/core/AppRecordSignatures.js';
import { generateSigningKeyPair, sign as edSign } from '../../src/core/MachineIdentity.js';
import { LOCAL_OWNER_PATH, localOwnerProofMessage, mountLocalOwnerDeviceRoute } from '../../src/server/mobileLocalOwnerDevice.js';
import { appTicketPlan, appTicketRefusal, localOwnerTicketPath, ownMachineId, readLocalOwnerTicket, writeLocalOwnerTicket } from '../../src/core/localOwnerTicket.js';
import { appTicketCommand } from '../../src/commands/install.js';
import { makeDevice } from '../helpers/mobileDevice.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const PORT = 4071;
const HOST = `127.0.0.1:${PORT}`;
const dirs: string[] = [];
const stops: Array<() => void> = [];
afterAll(() => {
  for (const s of stops) s();
  for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/unit/mobile-local-owner-device.test.ts' });
});

function makeLedger(dir: string, machineId = 'm_alpha') {
  const kp = generateSigningKeyPair();
  const hash = signerKeyHashOf(kp.publicKey);
  const signer: MachineSigner = { machineId: () => machineId, signerKeyHash: () => hash, sign: (p) => ({ machineId, signerKeyHash: hash, sig: edSign(p, kp.privateKey) }) };
  const keyLookup: MachineKeyLookup = (m, h) => (m === machineId && h === hash ? { status: 'ok', publicKeyPem: kp.publicKey } : { status: 'unknown' });
  return new MobileDeviceKeyLedger({ stateDir: dir, signer, keyLookup });
}

function setup(o: { multiRoute?: boolean; killSwitch?: boolean; ledger?: boolean; selfMachineId?: string | null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-owner-'));
  dirs.push(dir);
  const config = {
    projectName: 'scout', developmentAgent: true, port: PORT,
    mobilePairing: { enabled: true, multiRoute: { enabled: o.multiRoute ?? false }, ...(o.killSwitch ? { localOwnerDevice: { enabled: false } } : {}) },
  };
  const degradations: string[] = [];
  const attention: string[] = [];
  const pairing = new MobilePairingService({
    config: config as never, stateDir: dir, holdsLease: () => true,
    selfMachineId: o.selfMachineId === undefined ? 'm_alpha' : o.selfMachineId,
    reportDegradation: (what: string) => { degradations.push(what); },
    raiseAttention: (title: string) => { attention.push(title); },
  } as never);
  stops.push(() => pairing.stop());
  if (o.ledger !== false) pairing.keyLedger = makeLedger(dir);
  let handler: ((req: Request, res: Response) => void) | null = null;
  const app = { post: (p: string, h: (req: Request, res: Response) => void) => { if (p === LOCAL_OWNER_PATH) handler = h; } } as unknown as Application;
  mountLocalOwnerDeviceRoute(app, pairing, { agentName: () => 'scout' });
  const call = (body: Record<string, unknown>, extra: { host?: string; peer?: string; headers?: Record<string, string> } = {}) => {
    const req = { headers: { host: extra.host ?? HOST, ...(extra.headers ?? {}) }, socket: { remoteAddress: extra.peer ?? '127.0.0.1' }, body } as unknown as Request;
    let status = 0; let json: Record<string, unknown> = {};
    const res = { setHeader() { return this; }, status(c: number) { status = c; return this; }, json(b: Record<string, unknown>) { json = b; return this; } } as unknown as Response;
    handler!(req, res);
    return { status, json };
  };
  return { dir, pairing, call, degradations, attention };
}

function enrollBody(dev: ReturnType<typeof makeDevice>, ticket: string, host = HOST, time = Date.now()) {
  const timeMs = String(time);
  return { ticket, publicKey: dev.publicKey, timeMs, proof: dev.sign(localOwnerProofMessage(host, dev.publicKey, ticket, timeMs)), label: 'Studio' };
}

describe('POST /mobile/local-owner-device — refusals, in order', () => {
  it('off this Mac it is simply not found, and the ticket is never touched', () => {
    const e = setup();
    const ticket = writeLocalOwnerTicket(e.dir);
    const dev = makeDevice();
    expect(e.call(enrollBody(dev, 'wrong'), { peer: '203.0.113.9' }).status).toBe(404);
    expect(e.call(enrollBody(dev, 'wrong'), { headers: { 'x-forwarded-for': '1.2.3.4' } }).status).toBe(404);
    expect(e.call(enrollBody(dev, 'wrong'), { headers: { 'cf-connecting-ip': '1.2.3.4' } }).status).toBe(404);
    expect(e.call(enrollBody(dev, 'wrong'), { host: 'echo.example.dev' }).status).toBe(404);
    expect(e.call(enrollBody(dev, 'wrong'), { host: '127.0.0.1:9999' }).status).toBe(404);
    expect(readLocalOwnerTicket(e.dir)).toMatchObject({ ticket, failures: 0 });
  });

  it('no ticket, an expired ticket (deleted on read), or the kill switch: 404', () => {
    const e = setup();
    const dev = makeDevice();
    expect(e.call(enrollBody(dev, 'x')).status).toBe(404);
    writeLocalOwnerTicket(e.dir, Date.now() - 31 * 60_000);
    expect(e.call(enrollBody(dev, 'x')).status).toBe(404);
    expect(fs.existsSync(localOwnerTicketPath(e.dir))).toBe(false);
    const k = setup({ killSwitch: true });
    const t = writeLocalOwnerTicket(k.dir);
    expect(k.call(enrollBody(dev, t)).status).toBe(404);
  });

  it('three wrong tickets delete the file', () => {
    const e = setup();
    const ticket = writeLocalOwnerTicket(e.dir);
    const dev = makeDevice();
    expect(e.call(enrollBody(dev, 'nope-1')).json.error).toBe('bad-ticket');
    expect(e.call(enrollBody(dev, 'nope-2')).json.error).toBe('bad-ticket');
    expect(e.call(enrollBody(dev, 'nope-3')).json.error).toBe('bad-ticket');
    expect(fs.existsSync(localOwnerTicketPath(e.dir))).toBe(false);
    expect(e.call(enrollBody(dev, ticket)).status).toBe(404);
  });

  it('a bad or stale proof is refused', () => {
    const e = setup();
    const ticket = writeLocalOwnerTicket(e.dir);
    const dev = makeDevice(); const other = makeDevice();
    const forged = { ...enrollBody(dev, ticket), proof: other.sign(localOwnerProofMessage(HOST, dev.publicKey, ticket, String(Date.now()))) };
    expect(e.call(forged).json.error).toBe('proof-invalid');
    expect(e.call(enrollBody(dev, ticket, HOST, Date.now() - 5 * 60_000)).json.error).toBe('proof-invalid');
  });

  it('the rate limit answers 429 after five local calls', () => {
    const e = setup();
    writeLocalOwnerTicket(e.dir);
    const dev = makeDevice();
    for (let i = 0; i < 2; i++) e.call(enrollBody(dev, `w${i}`));
    writeLocalOwnerTicket(e.dir);
    for (let i = 0; i < 3; i++) e.call(enrollBody(dev, `v${i}`));
    expect(e.call(enrollBody(dev, 'x')).status).toBe(429);
  });

  it('no ledger: 503, asked only after the same-Mac check', () => {
    const e = setup({ ledger: false });
    const t = writeLocalOwnerTicket(e.dir);
    expect(e.call(enrollBody(makeDevice(), t), { peer: '203.0.113.9' }).status).toBe(404);
    expect(e.call(enrollBody(makeDevice(), t)).json.error).toBe('ledger-unavailable');
  });

  it('an existing owner phone with no role field, or an owner browser, refuses', () => {
    for (const shape of [{ publicKey: makeDevice().publicKey }, { client: 'browser', browserPublicKey: makeDevice().publicKey }]) {
      const e = setup();
      const file = path.join(e.dir, 'state', 'mobile-devices.json');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ devices: [{ id: 'phone-1', deviceName: 'iPhone', label: null, pairedAt: new Date().toISOString(), status: 'active', host: 'echo.example.dev', ...shape }] }));
      const t = writeLocalOwnerTicket(e.dir);
      expect(e.call(enrollBody(makeDevice(), t)).json.error).toBe('owner-device-exists');
      expect(fs.existsSync(localOwnerTicketPath(e.dir))).toBe(false);
    }
  });
});

describe('POST /mobile/local-owner-device — enrolling', () => {
  it('creates one active owner computer bound to this Mac, with a ledger row, and deletes the ticket', () => {
    const e = setup();
    const t = writeLocalOwnerTicket(e.dir);
    const dev = makeDevice();
    const r = e.call(enrollBody(dev, t));
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ host: HOST, agentName: 'scout' });
    const fresh = new DeviceRegistry(e.dir).get(String(r.json.deviceId))!;
    expect(fresh).toMatchObject({ status: 'active', deviceKind: 'computer', host: HOST, approvedVia: 'local-install', localBinding: { machineId: 'm_alpha' } });
    expect(fresh.role).toBeUndefined();
    expect(e.pairing.keyLedger!.hasActivation(fresh)).toBe(true);
    expect(fs.existsSync(localOwnerTicketPath(e.dir))).toBe(false);
  });

  it('a lost success is recovered: the same key with a fresh ticket gets the same device', () => {
    const e = setup();
    const dev = makeDevice();
    const first = e.call(enrollBody(dev, writeLocalOwnerTicket(e.dir)));
    const again = e.call(enrollBody(dev, writeLocalOwnerTicket(e.dir)));
    expect(again.status).toBe(200);
    expect(again.json.deviceId).toBe(first.json.deviceId);
    expect(new DeviceRegistry(e.dir).list().filter((d) => d.status === 'active')).toHaveLength(1);
  });

  it('a different key after enrollment is refused: one owner only', () => {
    const e = setup();
    e.call(enrollBody(makeDevice(), writeLocalOwnerTicket(e.dir)));
    expect(e.call(enrollBody(makeDevice(), writeLocalOwnerTicket(e.dir))).json.error).toBe('owner-device-exists');
  });

  it('replace: a ticket naming this Mac\'s earlier app device revokes it and enrolls the new key', () => {
    const e = setup();
    const old = makeDevice();
    const first = e.call(enrollBody(old, writeLocalOwnerTicket(e.dir)));
    const oldId = String(first.json.deviceId);
    const fresh = makeDevice();
    const r = e.call(enrollBody(fresh, writeLocalOwnerTicket(e.dir, Date.now(), [oldId])));
    expect(r.status).toBe(200);
    expect(r.json.replaced).toEqual([oldId]);
    const reg = new DeviceRegistry(e.dir);
    expect(reg.get(oldId)!.status).toBe('revoked');
    expect(reg.get(String(r.json.deviceId))).toMatchObject({ status: 'active', localBinding: { machineId: 'm_alpha' } });
    expect(e.pairing.keyLedger!.keyRevoked(signerKeyHashOfDevice(old.publicKey))).toBe(true);
    // The old key can never come back.
    expect(e.call(enrollBody(old, writeLocalOwnerTicket(e.dir))).json.error).toBe('device-revoked');
    // The person is told.
    expect(e.attention).toEqual(["This Mac's Instar app was connected again"]);
  });

  it('replace never revokes the owner for a key that then cannot be enrolled', () => {
    const e = setup();
    const first = e.call(enrollBody(makeDevice(), writeLocalOwnerTicket(e.dir)));
    const oldId = String(first.json.deviceId);
    const held = makeDevice();
    // The new key is already in the ledger (e.g. once used and revoked elsewhere): refused, owner intact.
    e.pairing.keyLedger!.recordActivation({ id: 'elsewhere', publicKey: held.publicKey, host: HOST } as never, 'local-install', new Date().toISOString());
    expect(e.call(enrollBody(held, writeLocalOwnerTicket(e.dir, Date.now(), [oldId]))).json.error).toBe('duplicate-key');
    expect(new DeviceRegistry(e.dir).get(oldId)!.status).toBe('active');
    expect(e.attention).toEqual([]);
  });

  it('replace on a server that does not know its machine refuses in plain words', () => {
    const e = setup({ selfMachineId: null });
    const first = e.call(enrollBody(makeDevice(), writeLocalOwnerTicket(e.dir)));
    const r = e.call(enrollBody(makeDevice(), writeLocalOwnerTicket(e.dir, Date.now(), [String(first.json.deviceId)])));
    expect(r.json.error).toBe('machine-identity-missing');
    expect(new DeviceRegistry(e.dir).get(String(first.json.deviceId))!.status).toBe('active');
  });

  it('a single-Mac agent (no multi-machine coordinator) binds and replaces using its own machine identity file', () => {
    const e = setup({ selfMachineId: null });
    fs.mkdirSync(path.join(e.dir, 'machine'), { recursive: true });
    fs.writeFileSync(path.join(e.dir, 'machine', 'identity.json'), JSON.stringify({ machineId: 'm_disk' }));
    const old = makeDevice();
    const first = e.call(enrollBody(old, writeLocalOwnerTicket(e.dir)));
    const oldId = String(first.json.deviceId);
    expect(new DeviceRegistry(e.dir).get(oldId)).toMatchObject({ localBinding: { machineId: 'm_disk' } });
    // The install command plans from the same file, so its plan and the server agree.
    const fresh = makeDevice();
    expect(appTicketPlan(e.dir, fresh.publicKey, { replace: true, machineId: ownMachineId(e.dir) })).toEqual({ replaces: [oldId] });
    const r = e.call(enrollBody(fresh, writeLocalOwnerTicket(e.dir, Date.now(), [oldId])));
    expect(r.status).toBe(200);
    expect(r.json.replaced).toEqual([oldId]);
    expect(new DeviceRegistry(e.dir).get(oldId)!.status).toBe('revoked');
  });

  it('a replace whose enrollment failed after the revoke recovers with a fresh ticket and the same key', () => {
    const e = setup();
    const first = e.call(enrollBody(makeDevice(), writeLocalOwnerTicket(e.dir)));
    const oldId = String(first.json.deviceId);
    // Simulate the crash: the old owner was revoked, the new key never enrolled.
    e.pairing.keyLedger!.recordRevocation(new DeviceRegistry(e.dir).get(oldId)!, new Date().toISOString());
    new DeviceRegistry(e.dir).revoke(oldId);
    const fresh = makeDevice();
    const r = e.call(enrollBody(fresh, writeLocalOwnerTicket(e.dir)));
    expect(r.status).toBe(200);
  });

  it('replace refuses when the active owner is not named, or is bound to another machine', () => {
    const e = setup();
    e.call(enrollBody(makeDevice(), writeLocalOwnerTicket(e.dir)));
    expect(e.call(enrollBody(makeDevice(), writeLocalOwnerTicket(e.dir, Date.now(), ['someone-else']))).json.error).toBe('owner-device-exists');
    const other = setup({ selfMachineId: 'm_beta' });
    // An owner bound to m_alpha cannot be replaced by a server that is m_beta.
    const reg = new DeviceRegistry(other.dir);
    const dev = makeDevice();
    reg.createActiveLocalOwner({ id: 'alpha-dev', publicKey: dev.publicKey, host: HOST, label: null, machineId: 'm_alpha', approvedAt: new Date().toISOString() });
    expect(other.call(enrollBody(makeDevice(), writeLocalOwnerTicket(other.dir, Date.now(), ['alpha-dev']))).json.error).toBe('owner-device-exists');
    expect(reg.get('alpha-dev')!.status).toBe('active');
  });

  it('a crash after the ledger row: the retry rebuilds the record from the row', () => {
    const e = setup();
    const dev = makeDevice();
    e.pairing.keyLedger!.recordActivation({ id: 'dev-lost', publicKey: dev.publicKey, host: HOST } as never, 'local-install', new Date().toISOString());
    const r = e.call(enrollBody(dev, writeLocalOwnerTicket(e.dir)));
    expect(r.status).toBe(200);
    expect(r.json.deviceId).toBe('dev-lost');
    expect(new DeviceRegistry(e.dir).get('dev-lost')).toMatchObject({ status: 'active', localBinding: { machineId: 'm_alpha' } });
  });

  it('a damaged registry answers 503 and is left byte-for-byte unchanged', () => {
    const e = setup();
    const file = path.join(e.dir, 'state', 'mobile-devices.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{"devices": [ this is not json');
    const before = fs.readFileSync(file);
    expect(e.call(enrollBody(makeDevice(), writeLocalOwnerTicket(e.dir))).json.error).toBe('registry-unreadable');
    expect(fs.readFileSync(file).equals(before)).toBe(true);
  });

  it('a key with a ledger revocation is refused even when the registry says active', () => {
    const e = setup();
    const dev = makeDevice();
    const r = e.call(enrollBody(dev, writeLocalOwnerTicket(e.dir)));
    const d = new DeviceRegistry(e.dir).get(String(r.json.deviceId))!;
    e.pairing.keyLedger!.recordRevocation(d, new Date().toISOString());
    expect(e.call(enrollBody(dev, writeLocalOwnerTicket(e.dir))).json.error).toBe('device-revoked');
  });
});

function signedReq(pairing: MobilePairingService, dev: ReturnType<typeof makeDevice>, id: string, opts: { host?: string; peer?: string; headers?: Record<string, string> } = {}) {
  const p = '/mobile/conversation-graph/roots';
  const host = opts.host ?? HOST;
  const time = String(Date.now());
  const sig = dev.sign(canonicalString(id, host, 'GET', p, time, undefined));
  const req = { headers: { host, 'x-instar-device': id, 'x-instar-device-time': time, 'x-instar-device-sig': sig, ...(opts.headers ?? {}) }, method: 'GET', path: p, originalUrl: p, socket: { remoteAddress: opts.peer ?? '127.0.0.1' }, secure: false } as unknown as Request;
  let status: number | null = null;
  const res = { status(c: number) { status = c; return this; }, json() { return this; } } as unknown as Response;
  return { verdict: deviceAuthenticator(pairing)(req, res), status };
}

describe('signed requests from a localBinding device', () => {
  for (const multiRoute of [false, true]) {
    it(`multi-route ${multiRoute ? 'on' : 'off'}: accepted only from this Mac, at its exact Host`, () => {
      const e = setup({ multiRoute });
      const dev = makeDevice();
      const id = String(e.call(enrollBody(dev, writeLocalOwnerTicket(e.dir))).json.deviceId);
      expect(signedReq(e.pairing, dev, id).verdict).toBe('ok');
      expect(signedReq(e.pairing, dev, id, { peer: '203.0.113.9' }).verdict).toBe('refused');
      // Through a tunnel: loopback peer plus a forwarding header — refused, never checked against the stored host.
      expect(signedReq(e.pairing, dev, id, { headers: { 'x-forwarded-for': '203.0.113.9' } }).verdict).toBe('refused');
      expect(signedReq(e.pairing, dev, id, { host: `localhost:${PORT}` }).verdict).toBe('refused');
    });
  }

  it('a record bound to another machine id is refused here', () => {
    const e = setup({ selfMachineId: 'm_alpha' });
    const dev = makeDevice();
    const id = String(e.call(enrollBody(dev, writeLocalOwnerTicket(e.dir))).json.deviceId);
    const file = path.join(e.dir, 'state', 'mobile-devices.json');
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
    raw.devices[0].localBinding = { machineId: 'm_other' };
    fs.writeFileSync(file, JSON.stringify(raw));
    expect(signedReq(e.pairing, dev, id).verdict).toBe('refused');
  });
});

describe('instar install --app-ticket', () => {
  function finishedInstall(agentDir: string) {
    return { version: 1, installId: 'i', startedAt: '', updatedAt: '', status: 'complete', cursor: 'done', answers: { forApp: true }, completed: {}, appEnroll: { agentDir, port: PORT } } as never;
  }

  it('writes a fresh ticket for a finished app install, and refuses once another key enrolled', () => {
    const e = setup();
    const agentDir = path.dirname(e.dir);
    const stateDir = path.join(agentDir, '.instar');
    fs.mkdirSync(stateDir, { recursive: true });
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'app-ticket-'));
    dirs.push(tmp);
    const agent = path.join(tmp, 'scout');
    const agentState = path.join(agent, '.instar');
    fs.mkdirSync(agentState, { recursive: true });
    const dev = makeDevice(); const other = makeDevice();
    expect(appTicketCommand(finishedInstall(agent), dev.publicKey)).toBe('complete');
    expect(readLocalOwnerTicket(agentState)).not.toBeNull();
    expect(appTicketCommand(null, dev.publicKey)).toBe('failed');
    expect(appTicketCommand(finishedInstall(agent), undefined)).toBe('needs-answers');
    const ledger = makeLedger(agentState);
    ledger.recordActivation({ id: 'd1', publicKey: dev.publicKey, host: HOST } as never, 'local-install', new Date().toISOString());
    expect(appTicketRefusal(agentState, dev.publicKey)).toBeNull();
    expect(appTicketRefusal(agentState, other.publicKey)).toMatch(/Another app/);
  });

  it('--replace-app-key: allowed only for this machine\'s own app device; the ticket names it', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'app-ticket-'));
    dirs.push(tmp);
    const agent = path.join(tmp, 'scout');
    const agentState = path.join(agent, '.instar');
    fs.mkdirSync(path.join(agentState, 'machine'), { recursive: true });
    fs.writeFileSync(path.join(agentState, 'machine', 'identity.json'), JSON.stringify({ machineId: 'm_alpha' }));
    const old = makeDevice(); const fresh = makeDevice();
    makeLedger(agentState).recordActivation({ id: 'd-old', publicKey: old.publicKey, host: HOST } as never, 'local-install', new Date().toISOString());
    new DeviceRegistry(agentState).createActiveLocalOwner({ id: 'd-old', publicKey: old.publicKey, host: HOST, label: null, machineId: 'm_alpha', approvedAt: new Date().toISOString() });
    // Without the flag: refused, with the hint.
    expect(appTicketRefusal(agentState, fresh.publicKey)).toMatch(/--replace-app-key/);
    expect(appTicketCommand(finishedInstall(agent), fresh.publicKey)).toBe('failed');
    // With it, on the same machine: a ticket naming the old device.
    expect(appTicketCommand(finishedInstall(agent), fresh.publicKey, true)).toBe('complete');
    expect(readLocalOwnerTicket(agentState)!.replaces).toEqual(['d-old']);
    // Another machine's identity: refused.
    expect(appTicketPlan(agentState, fresh.publicKey, { replace: true, machineId: 'm_beta' })).toMatchObject({ refusal: expect.stringMatching(/Another computer/) });
    expect(appTicketPlan(agentState, fresh.publicKey, { replace: true, machineId: null })).toMatchObject({ refusal: expect.stringMatching(/identity could not be read/) });
  });

  it('--replace-app-key never replaces an interrupted enrollment another machine signed', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'app-ticket-'));
    dirs.push(tmp);
    const stateDir = path.join(tmp, '.instar');
    fs.mkdirSync(stateDir, { recursive: true });
    makeLedger(stateDir, 'm_beta').recordActivation({ id: 'd-x', publicKey: makeDevice().publicKey, host: HOST } as never, 'local-install', new Date().toISOString());
    expect(appTicketPlan(stateDir, makeDevice().publicKey, { replace: true, machineId: 'm_alpha' })).toMatchObject({ refusal: expect.stringMatching(/Another computer/) });
    expect(appTicketPlan(stateDir, makeDevice().publicKey, { replace: true, machineId: 'm_beta' })).toEqual({ replaces: ['d-x'] });
  });

  it('refuses when an owner device the app did not create is active', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'app-ticket-'));
    dirs.push(tmp);
    const stateDir = path.join(tmp, '.instar');
    fs.mkdirSync(path.join(stateDir, 'state'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'state', 'mobile-devices.json'), JSON.stringify({ devices: [{ id: 'p', status: 'active', publicKey: makeDevice().publicKey }] }));
    expect(appTicketRefusal(stateDir, makeDevice().publicKey)).toMatch(/already has an owner device/);
  });
});
