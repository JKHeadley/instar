import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import type { Request, Response as ExpressResponse } from 'express';
import { MobilePairingService, deviceAuthenticator } from '../../src/server/mobilePairingRoutes.js';
import { mobileOwnerDeviceAdmission } from '../../src/server/mobileOwnerDeviceAdmission.js';
import { MachineIdentityManager } from '../../src/core/MachineIdentity.js';
import { loadMachineSigner, identityKeyLookup, deviceKeyHashOf } from '../../src/core/AppRecordSignatures.js';
import { MobileDeviceKeyLedger } from '../../src/core/MobileDeviceKeyLedger.js';
import { canonicalString } from '../../src/core/MobileDeviceKeys.js';
import type { PersonProfile } from '../../src/core/MobilePeople.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { makeDevice } from '../helpers/mobileDevice.js';

class Reply extends EventEmitter {
  code = 200; payload: any; destroyed = false; headersSent = false; writableEnded = false; writableFinished = false;
  destroy() { this.destroyed = true; this.emit('close'); return this; }
  status(n: number) { this.code = n; return this; }
  json(body: unknown) { this.payload = body; this.headersSent = this.writableEnded = this.writableFinished = true; this.emit('finish'); return this; }
}
const reply = () => new Reply();
const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); vi.restoreAllMocks(); });

async function admitted(named = false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-owner-unit-'));
  await new MachineIdentityManager(dir).generateIdentity({ name: 'admission fixture' });
  let profile: PersonProfile | null = { id: 'owner', name: 'Owner', telegramUserId: 123 };
  const config = { projectName: 'unit', projectDir: dir, stateDir: dir, developmentAgent: true, authToken: 'fixture-token',
    mobilePairing: { multiRoute: { enabled: false } }, threadline: { ownerName: 'Owner' } } as any;
  const pairing = new MobilePairingService({ config, stateDir: dir, holdsLease: () => true,
    telegramOwnerId: () => 123, people: () => ({ getUser: () => profile }) });
  pairing.nativeOn = true;
  pairing.keyLedger = new MobileDeviceKeyLedger({ stateDir: dir, signer: loadMachineSigner(dir)!, keyLookup: identityKeyLookup(dir) });
  cleanups.push(() => { pairing.stop(); SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/mobile-owner-device-admission.test.ts' }); });
  const key = makeDevice();
  const pending = pairing.devices.createPending({ publicKey: key.publicKey, deviceName: 'owner', label: null,
    host: 'phone.example.dev', ...(named ? { userId: 'owner' } : {}) });
  if (!pending.ok) throw new Error('device fixture');
  const id = pending.device.id;
  pairing.devices.applyConfirm(id, { ok: true });
  const route = '/mobile/chat/slack/-7/messages?machine=remote';
  const time = String(Date.now());
  const req = { method: 'GET', path: route.split('?')[0], originalUrl: route, query: { machine: 'remote' },
    headers: { 'x-instar-device': id, 'x-instar-device-time': time,
      'x-instar-device-sig': key.sign(canonicalString(id, 'phone.example.dev', 'GET', route, time)) } } as unknown as Request;
  expect(deviceAuthenticator(pairing)(req, reply() as unknown as ExpressResponse)).toBe('ok');
  const mutateDevice = (change: (d: any) => void) => {
    const value = JSON.parse(fs.readFileSync(pairing.devices.file, 'utf8'));
    change(value.devices.find((d: any) => d.id === id));
    fs.writeFileSync(pairing.devices.file, JSON.stringify(value));
  };
  return { req, pairing, config, id, mutateDevice, setProfile: (p: PersonProfile | null) => { profile = p; } };
}

describe('fresh owner admission', () => {
  it('retains legacy unnamed owners, but rejects bearer/notify and an MSP role', async () => {
    const a = await admitted();
    expect(mobileOwnerDeviceAdmission(a.pairing, a.req)?.deviceId ?? null).toBe(a.id);
    for (const kind of ['token', 'device-notify']) {
      const r = { ...a.req, instarPrincipal: { kind, deviceId: a.id } } as any;
      expect(mobileOwnerDeviceAdmission(a.pairing, r)).toBeNull();
    }
    a.pairing.devices.setPerson(a.id, { userId: 'msp', role: 'msp' });
    expect(mobileOwnerDeviceAdmission(a.pairing, a.req)?.deviceId ?? null).toBeNull();
  });
  it('binds the initial check to the authenticated key, not a later registry snapshot', async () => {
    const a = await admitted();
    a.mutateDevice(d => { d.publicKey = makeDevice().publicKey; });
    expect(mobileOwnerDeviceAdmission(a.pairing, a.req)?.deviceId ?? null).toBeNull();
  });
  it.each(['removed', 'demoted'])('requires a named owner still to qualify: %s', async change => {
    const a = await admitted(true);
    expect(mobileOwnerDeviceAdmission(a.pairing, a.req)?.deviceId ?? null).toBe(a.id);
    a.setProfile(change === 'removed' ? null : { id: 'owner', name: 'Former owner', telegramUserId: 456 });
    expect(mobileOwnerDeviceAdmission(a.pairing, a.req)?.deviceId ?? null).toBeNull();
  });
});


describe('retained admission rereads current authority', () => {
  it('exports immutable authenticated identity for other private-read consumers', async () => {
    const a = await admitted();
    const captured = mobileOwnerDeviceAdmission(a.pairing, a.req)!;
    expect(captured.identity).toEqual({ keyHash: deviceKeyHashOf(a.pairing.devices.get(a.id)!.publicKey!),
      userId: null, role: 'owner' });
    expect(Object.isFrozen(captured)).toBe(true);
    expect(Object.isFrozen(captured.identity)).toBe(true);
    const hash = captured.identity.keyHash;
    a.mutateDevice(d => { d.publicKey = makeDevice().publicKey; });
    expect(captured.identity.keyHash).toBe(hash);
    expect(captured.isCurrent()).toBe(false);
  });

  it.each(['revoked', 'key', 'person', 'pairing', 'native', 'boot', 'missing-ledger', 'ledger'])('refuses a changed %s', async change => {
    const a = await admitted();
    const captured = mobileOwnerDeviceAdmission(a.pairing, a.req)!;
    expect(captured.isCurrent()).toBe(true);
    if (change === 'missing-ledger') a.pairing.keyLedger = null;
    if (change === 'ledger') a.pairing.keyLedger!.recordRevocation(a.pairing.devices.get(a.id)!, new Date().toISOString());
    if (change === 'revoked') a.pairing.devices.revoke(a.id);
    if (change === 'key') a.mutateDevice(d => { d.publicKey = makeDevice().publicKey; });
    if (change === 'person') a.mutateDevice(d => { d.userId = 'owner'; });
    if (change === 'pairing') a.config.mobilePairing.enabled = false;
    if (change === 'native') a.config.mobilePairing.native = { enabled: false };
    if (change === 'boot') a.pairing.nativeOn = false;
    expect(captured.isCurrent()).toBe(false);
  });
  it('does not accept a fabricated device principal without signature admission', async () => {
    const a = await admitted();
    const req = { instarPrincipal: { kind: 'device', deviceId: a.id } } as unknown as Request;
    expect(mobileOwnerDeviceAdmission(a.pairing, req)).toBeNull();
  });
  it('retains a named owner admission only while its profile qualifies', async () => {
    const a = await admitted(true);
    const captured = mobileOwnerDeviceAdmission(a.pairing, a.req)!;
    expect(captured.isCurrent()).toBe(true);
    a.setProfile(null);
    expect(captured.isCurrent()).toBe(false);
  });
});
