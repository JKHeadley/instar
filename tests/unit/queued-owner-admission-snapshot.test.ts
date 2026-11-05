import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import type { Request, Response as ExpressResponse } from 'express';
import { MobilePairingService, deviceAuthenticator } from '../../src/server/mobilePairingRoutes.js';
import { mobileOwnerDeviceAdmission, revalidateQueuedOwnerAdmissionSnapshot,
  type QueuedOwnerAdmissionSnapshot } from '../../src/server/mobileOwnerDeviceAdmission.js';
import { MachineIdentityManager } from '../../src/core/MachineIdentity.js';
import { loadMachineSigner, identityKeyLookup, deviceKeyHashOf } from '../../src/core/AppRecordSignatures.js';
import { MobileDeviceKeyLedger } from '../../src/core/MobileDeviceKeyLedger.js';
import { canonicalString } from '../../src/core/MobileDeviceKeys.js';
import type { PersonProfile } from '../../src/core/MobilePeople.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { makeDevice } from '../helpers/mobileDevice.js';

class Reply extends EventEmitter {
  code = 200; payload: any; headersSent = false; writableEnded = false; writableFinished = false;
  status(n: number) { this.code = n; return this; }
  json(body: unknown) { this.payload = body; this.headersSent = this.writableEnded = this.writableFinished = true; return this; }
}
const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

/** A real signature admission, then the snapshot root would have sealed from it. */
async function queued(named = false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'queued-owner-snapshot-'));
  await new MachineIdentityManager(dir).generateIdentity({ name: 'snapshot fixture' });
  let profile: PersonProfile | null = { id: 'owner', name: 'Owner', telegramUserId: 123 };
  const config = { projectName: 'unit', projectDir: dir, stateDir: dir, developmentAgent: true, authToken: 'fixture-token',
    mobilePairing: { multiRoute: { enabled: false } }, threadline: { ownerName: 'Owner' } } as any;
  const pairing = new MobilePairingService({ config, stateDir: dir, holdsLease: () => true,
    telegramOwnerId: () => 123, people: () => ({ getUser: () => profile }) });
  pairing.nativeOn = true;
  pairing.keyLedger = new MobileDeviceKeyLedger({ stateDir: dir, signer: loadMachineSigner(dir)!, keyLookup: identityKeyLookup(dir) });
  cleanups.push(() => { pairing.stop(); SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/queued-owner-admission-snapshot.test.ts' }); });
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
  expect(deviceAuthenticator(pairing)(req, new Reply() as unknown as ExpressResponse)).toBe('ok');
  const live = mobileOwnerDeviceAdmission(pairing, req)!;
  expect(live).not.toBeNull();
  // What survives a restart: plain JSON of the original admission, no Request.
  const snapshot = JSON.parse(JSON.stringify({ deviceId: live.deviceId, identity: live.identity })) as QueuedOwnerAdmissionSnapshot;
  const mutateDevice = (change: (d: any) => void) => {
    const value = JSON.parse(fs.readFileSync(pairing.devices.file, 'utf8'));
    change(value.devices.find((d: any) => d.id === id));
    fs.writeFileSync(pairing.devices.file, JSON.stringify(value));
  };
  return { pairing, config, id, req, live, snapshot, mutateDevice, setProfile: (p: PersonProfile | null) => { profile = p; } };
}

type Fixture = Awaited<ReturnType<typeof queued>>;
const check = (a: Fixture, s: unknown = a.snapshot) => revalidateQueuedOwnerAdmissionSnapshot(a.pairing, s as QueuedOwnerAdmissionSnapshot);

describe('revalidateQueuedOwnerAdmissionSnapshot: accepts a still-current owner', () => {
  it.each([false, true])('named=%s: passes with no Request, from a JSON round-trip', async named => {
    const a = await queued(named);
    expect(a.snapshot.identity).toEqual({ keyHash: deviceKeyHashOf(a.pairing.devices.get(a.id)!.publicKey!),
      userId: named ? 'owner' : null, role: 'owner' });
    expect(check(a)).toEqual({ ok: true });
    expect(Object.isFrozen(check(a))).toBe(true);
  });
  it('is a pure read: repeated calls change no state', async () => {
    const a = await queued(true);
    const before = fs.readFileSync(a.pairing.devices.file, 'utf8');
    for (let i = 0; i < 3; i++) expect(check(a).ok).toBe(true);
    expect(fs.readFileSync(a.pairing.devices.file, 'utf8')).toBe(before);
  });
});

// Every gate: passes before the change (other side of the boundary), refuses after it,
// and the live helper's isCurrent() agrees, so the two cannot drift.
const changes: Array<[string, boolean, string, (a: Fixture) => void]> = [
  ['device revoked', false, 'device-inactive', a => a.pairing.devices.revoke(a.id)],
  ['key revoked in the signed ledger', false, 'key-revoked', a => a.pairing.keyLedger!.recordRevocation(a.pairing.devices.get(a.id)!, new Date().toISOString())],
  ['key rotated', false, 'key-changed', a => a.mutateDevice(d => { d.publicKey = makeDevice().publicKey; })],
  ['device deleted', false, 'device-missing', a => a.mutateDevice(d => { d.id = 'gone'; })],
  ['person demoted to msp', false, 'person-changed', a => a.pairing.devices.setPerson(a.id, { userId: 'msp', role: 'msp' })],
  ['device re-assigned to a person', false, 'person-changed', a => a.mutateDevice(d => { d.userId = 'owner'; })],
  ['named owner profile deleted', true, 'profile-not-owner', a => a.setProfile(null)],
  ['named owner profile stale (no longer the owner)', true, 'profile-not-owner', a => a.setProfile({ id: 'owner', name: 'Former owner', telegramUserId: 456 })],
  ['pairing disabled', false, 'pairing-off', a => { a.config.mobilePairing.enabled = false; }],
  ['native disabled in config', false, 'native-off', a => { a.config.mobilePairing.native = { enabled: false }; }],
  ['native off since boot', false, 'native-off', a => { a.pairing.nativeOn = false; }],
  ['key ledger not loaded', false, 'key-ledger-missing', a => { a.pairing.keyLedger = null; }],
  ['store unreadable', false, 'unreadable', a => { a.pairing.devices.get = () => { throw new Error('disk'); }; }],
];

describe('revalidateQueuedOwnerAdmissionSnapshot: refuses on every current-state change', () => {
  it.each(changes)('%s', async (_name, named, reason, change) => {
    const a = await queued(named);
    expect(check(a)).toEqual({ ok: true });
    expect(a.live.isCurrent()).toBe(true);
    change(a);
    expect(check(a)).toEqual({ ok: false, reason });
    expect(a.live.isCurrent()).toBe(false);
  });
});

describe('revalidateQueuedOwnerAdmissionSnapshot: refuses a snapshot it cannot trust', () => {
  it('wrong role in the snapshot', async () => {
    const a = await queued();
    expect(check(a, { ...a.snapshot, identity: { ...a.snapshot.identity, role: 'msp' } })).toEqual({ ok: false, reason: 'not-owner-role' });
  });
  it.each([
    ['null', null], ['no identity', { deviceId: 'x' }], ['empty deviceId', 'deviceId'], ['empty keyHash', 'keyHash'],
    ['numeric userId', 'userId'], ['empty userId', 'emptyUser'], ['throwing getter', 'getter'],
  ])('malformed: %s', async (_name, shape) => {
    const a = await queued();
    const s: any = typeof shape === 'string' ? { deviceId: a.snapshot.deviceId, identity: { ...a.snapshot.identity } } : shape;
    if (shape === 'deviceId') s.deviceId = '';
    if (shape === 'keyHash') s.identity.keyHash = '';
    if (shape === 'userId') s.identity.userId = 7;
    if (shape === 'emptyUser') s.identity.userId = '';
    if (shape === 'getter') Object.defineProperty(s, 'identity', { get() { throw new Error('boom'); } });
    expect(check(a, s)).toEqual({ ok: false, reason: 'malformed-snapshot' });
  });
  it('a snapshot naming a different key for this device (unverified provenance) refuses', async () => {
    const a = await queued();
    const forged = { deviceId: a.id, identity: { ...a.snapshot.identity, keyHash: deviceKeyHashOf(makeDevice().publicKey) } };
    expect(check(a, forged)).toEqual({ ok: false, reason: 'key-changed' });
  });
  it('a snapshot claiming a named owner for an unnamed device refuses', async () => {
    const a = await queued();
    expect(check(a, { deviceId: a.id, identity: { ...a.snapshot.identity, userId: 'owner' } })).toEqual({ ok: false, reason: 'person-changed' });
  });
  it('a snapshot for an unknown device refuses', async () => {
    const a = await queued();
    expect(check(a, { ...a.snapshot, deviceId: 'never-paired' })).toEqual({ ok: false, reason: 'device-missing' });
  });
  it('reads the snapshot once: a getter that changes after validation cannot swap the device', async () => {
    const a = await queued();
    let reads = 0;
    const s = { identity: a.snapshot.identity, get deviceId() { reads++; return reads === 1 ? a.id : 'other'; } };
    expect(check(a, s)).toEqual({ ok: true });
    expect(reads).toBe(1);
  });
});

describe('live helper keeps its route-time person check', () => {
  it.each([['a different user', 'someone-else'], ['an undefined userId', undefined]])('refuses when the signed request resolved %s', async (_n, userId) => {
    const a = await queued();
    expect(mobileOwnerDeviceAdmission(a.pairing, a.req)).not.toBeNull();
    (a.req as any).instarDevicePerson = { ...(a.req as any).instarDevicePerson, userId };
    expect(mobileOwnerDeviceAdmission(a.pairing, a.req)).toBeNull();
    // The queued path has no route-time person; only the snapshot's own identity counts.
    expect(check(a)).toEqual({ ok: true });
  });
});

describe('one authority: both entry points run the same shared policy', () => {
  const src = fs.readFileSync(new URL('../../src/server/mobileOwnerDeviceAdmission.ts', import.meta.url), 'utf8');
  const body = (name: string) => {
    const start = src.indexOf(`export function ${name}(`);
    expect(start).toBeGreaterThanOrEqual(0);
    const next = src.indexOf('\nexport ', start + 1);
    return src.slice(start, next < 0 ? undefined : next);
  };
  it('the live helper and the queued validator both delegate to ownerAdmissionRefusal', () => {
    expect(src.match(/function ownerAdmissionRefusal\(/g)).toHaveLength(1);
    expect(body('mobileOwnerDeviceAdmission')).toMatch(/ownerAdmissionRefusal\(pairing, deviceId, admitted, person\) === null/);
    expect(body('revalidateQueuedOwnerAdmissionSnapshot')).toMatch(/ownerAdmissionRefusal\(pairing, deviceId,/);
  });
  it('each current-state gate is read in exactly one place, so a copy cannot drift', () => {
    for (const gate of ['pairing.enabled()', 'isMobileNativeEnabled(', 'pairing.nativeOn', 'pairing.keyLedger.isRevoked(',
      'deviceKeyHashOf(', 'pairing.devices.get(', 'pairing.personOfDevice(', 'isOwnerProfile(']) {
      expect(src.split(gate).length - 1, gate).toBe(1);
    }
    expect(body('mobileOwnerDeviceAdmission')).not.toMatch(/isRevoked|personOfDevice|isOwnerProfile|devices\.get/);
    expect(body('revalidateQueuedOwnerAdmissionSnapshot')).not.toMatch(/isRevoked|personOfDevice|isOwnerProfile|devices\.get/);
  });
});
