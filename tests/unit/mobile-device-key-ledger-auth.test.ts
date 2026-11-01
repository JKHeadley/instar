/**
 * A ledger revocation takes effect at once (docs/specs/mobile-native-conversations.md §4.6):
 * device authentication refuses a device whose pairing has a revocation row in the device-key
 * ledger even while the registry still says active (the registry write after the ledger row
 * failed). The check reads an in-memory index loaded at construction and updated on append.
 */
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Request, Response } from 'express';
import { MobilePairingService, deviceAuthenticator } from '../../src/server/mobilePairingRoutes.js';
import { MobileDeviceKeyLedger } from '../../src/core/MobileDeviceKeyLedger.js';
import { canonicalString } from '../../src/core/MobileDeviceKeys.js';
import { deviceKeyHashOf, signerKeyHashOf, type MachineKeyLookup, type MachineSigner } from '../../src/core/AppRecordSignatures.js';
import { generateSigningKeyPair, sign as edSign } from '../../src/core/MachineIdentity.js';
import { makeDevice } from '../helpers/mobileDevice.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const HOST = 'echo.example.dev';
const dirs: string[] = [];
const stops: Array<() => void> = [];
afterAll(() => {
  for (const s of stops) s();
  for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/unit/mobile-device-key-ledger-auth.test.ts' });
});

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dkl-auth-'));
  dirs.push(dir);
  const kp = generateSigningKeyPair();
  const hash = signerKeyHashOf(kp.publicKey);
  const signer: MachineSigner = { machineId: () => 'm_alpha', signerKeyHash: () => hash, sign: (p) => ({ machineId: 'm_alpha', signerKeyHash: hash, sig: edSign(p, kp.privateKey) }) };
  const keyLookup: MachineKeyLookup = (m, h) => (m === 'm_alpha' && h === hash ? { status: 'ok', publicKeyPem: kp.publicKey } : { status: 'unknown' });
  const pairing = new MobilePairingService({ config: { projectName: 'echo', developmentAgent: true } as never, stateDir: dir, holdsLease: () => true });
  stops.push(() => pairing.stop());
  const ledger = new MobileDeviceKeyLedger({ stateDir: dir, signer, keyLookup });
  pairing.keyLedger = ledger;
  const dev = makeDevice();
  const c = pairing.devices.createPending({ deviceName: 'iPhone', label: null, publicKey: dev.publicKey, host: HOST });
  if (!c.ok) throw new Error('pending');
  pairing.devices.applyConfirm(c.device.id, { ok: true });
  return { dir, pairing, ledger, dev, deviceId: c.device.id, signer, keyLookup };
}

let tick = 0;
function authenticate(e: ReturnType<typeof setup>): { verdict: string; status: number | null } {
  const p = '/mobile/devices';
  const time = String(Date.now() + (tick++ % 1000));
  const sig = e.dev.sign(canonicalString(e.deviceId, HOST, 'GET', p, time, undefined));
  const req = { headers: { 'x-instar-device': e.deviceId, 'x-instar-device-time': time, 'x-instar-device-sig': sig }, method: 'GET', path: p, originalUrl: p } as unknown as Request;
  let status: number | null = null;
  const res = { status(c: number) { status = c; return this; }, json() { return this; } } as unknown as Response;
  return { verdict: deviceAuthenticator(e.pairing)(req, res), status };
}

describe('device authentication honours a ledger revocation on its own', () => {
  it('a revocation row with the registry still active is refused at once', () => {
    const e = setup();
    expect(authenticate(e).verdict).toBe('ok');
    e.ledger.recordRevocation(e.pairing.devices.get(e.deviceId)!, new Date().toISOString()); // … the registry write then fails
    expect(e.pairing.devices.get(e.deviceId)!.status).toBe('active');
    expect(e.ledger.isRevoked(deviceKeyHashOf(e.dev.publicKey), e.deviceId)).toBe(true);
    expect(authenticate(e)).toEqual({ verdict: 'refused', status: 401 });
  });

  it('the in-memory index is loaded from disk on construction (a restart before reconciliation)', () => {
    const e = setup();
    e.ledger.recordRevocation(e.pairing.devices.get(e.deviceId)!, new Date().toISOString());
    e.pairing.keyLedger = new MobileDeviceKeyLedger({ stateDir: e.dir, signer: e.signer, keyLookup: e.keyLookup });
    expect(authenticate(e)).toEqual({ verdict: 'refused', status: 401 });
  });

  it('a revocation for another pairing of the same key does not refuse this one', () => {
    const e = setup();
    e.ledger.recordRevocation({ id: 'another-pairing-01', publicKey: e.dev.publicKey }, new Date().toISOString());
    expect(authenticate(e).verdict).toBe('ok');
  });

  it('a revocation row received by replication takes effect at once too', () => {
    const e = setup();
    // A second machine-local ledger (same signer) writes the row; this ledger ingests it.
    const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dkl-auth-peer-'));
    dirs.push(otherDir);
    const other = new MobileDeviceKeyLedger({ stateDir: otherDir, signer: e.signer, keyLookup: e.keyLookup });
    const row = other.recordRevocation(e.pairing.devices.get(e.deviceId)!, new Date().toISOString())!;
    expect(e.ledger.ingestReplicated(row)).toBe('accepted');
    expect(authenticate(e)).toEqual({ verdict: 'refused', status: 401 });
  });
});
