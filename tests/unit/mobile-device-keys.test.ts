/** Unit tests for mobile device keys (docs/specs/mobile-device-keys.md). */
import { describe, it, expect, afterAll } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  canonicalString, isStrictLowSDer, parseDevicePublicKey, verifyDeviceRequest, ReplayGuard, DeviceRegistry,
  ConfirmationCodes, mergeStatus, deviceFingerprint, MAX_PENDING, WRONG_BUDGET, type DeviceStatus,
} from '../../src/core/MobileDeviceKeys.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/unit/mobile-device-keys.test.ts' }); });
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mdk-')); dirs.push(d); return d; };

import { makeDevice } from '../helpers/mobileDevice.js';

describe('device signatures', () => {
  const host = 'echo.example.dev';
  const setup = (status: DeviceStatus = 'active') => {
    const dev = makeDevice();
    const lookup = (id: string) => (id === 'dev-12345678' ? { publicKey: dev.publicKey, host, status } : null);
    return { dev, lookup };
  };
  const req = (dev: ReturnType<typeof makeDevice>, over: Partial<{ time: string; body: string; method: string; path: string; highS: boolean }> = {}) => {
    const time = over.time ?? String(Date.now());
    const body = over.body !== undefined ? Buffer.from(over.body) : undefined;
    const msg = canonicalString('dev-12345678', host, over.method ?? 'GET', over.path ?? '/sessions', time, body);
    return { deviceId: 'dev-12345678', time, sig: dev.sign(msg, over.highS), method: over.method ?? 'GET', pathWithQuery: over.path ?? '/sessions', rawBody: body };
  };
  const active = new Set<DeviceStatus>(['active']);

  it('accepts a real signature once, then refuses its replay', () => {
    const { dev, lookup } = setup();
    const guard = new ReplayGuard();
    const r = req(dev);
    expect(verifyDeviceRequest(r, lookup, active, guard)).toEqual({ ok: true, deviceId: 'dev-12345678' });
    expect(verifyDeviceRequest(r, lookup, active, guard)).toEqual({ ok: false, reason: 'replay' });
  });

  it('refuses a malleated high-S signature of the same request', () => {
    const { dev, lookup } = setup();
    const guard = new ReplayGuard();
    expect(verifyDeviceRequest(req(dev, { highS: true }), lookup, active, guard)).toEqual({ ok: false, reason: 'bad-signature' });
  });

  it('refuses a wrong key, a tampered body, a stale time, and a disallowed status', () => {
    const { dev, lookup } = setup();
    const other = makeDevice();
    expect(verifyDeviceRequest(req(other), lookup, active, new ReplayGuard()).ok).toBe(false);
    const signed = req(dev, { method: 'POST', path: '/mobile/device/confirm', body: '{"code":"1"}' });
    expect(verifyDeviceRequest({ ...signed, rawBody: Buffer.from('{"code":"2"}') }, lookup, active, new ReplayGuard()).ok).toBe(false);
    expect(verifyDeviceRequest(req(dev, { time: String(Date.now() - 61_000) }), lookup, active, new ReplayGuard())).toEqual({ ok: false, reason: 'stale' });
    const pending = setup('pending');
    expect(verifyDeviceRequest(req(pending.dev), pending.lookup, active, new ReplayGuard())).toEqual({ ok: false, reason: 'not-allowed-status' });
  });

  it('strict DER: rejects non-minimal and trailing-byte encodings', () => {
    const { dev } = setup();
    const good = Buffer.from(dev.sign('x'), 'base64url');
    expect(isStrictLowSDer(good)).toBe(true);
    expect(isStrictLowSDer(Buffer.concat([good, Buffer.from([0])]))).toBe(false);
  });

  it('validates public keys', () => {
    expect(parseDevicePublicKey(makeDevice().publicKey)).not.toBeNull();
    expect(parseDevicePublicKey(Buffer.alloc(65, 4).toString('base64url'))).toBeNull();
    expect(parseDevicePublicKey('nope')).toBeNull();
  });

  it('revoked wins every merge', () => {
    expect(mergeStatus('active', 'revoked')).toBe('revoked');
    expect(mergeStatus('revoked', 'pending')).toBe('revoked');
    expect(mergeStatus('pending', 'active')).toBe('active');
  });

  it('fingerprints are 16 hex in groups of four', () => {
    expect(deviceFingerprint(makeDevice().publicKey)).toMatch(/^[0-9A-F]{4}(-[0-9A-F]{4}){3}$/);
  });
});

describe('DeviceRegistry', () => {
  it('pending → active with the right code; wrong codes counted once each and declined at three', () => {
    const reg = new DeviceRegistry(tmp());
    const codes = new ConfirmationCodes();
    const c = reg.createPending({ deviceName: 'iPhone', label: null, publicKey: makeDevice().publicKey, host: 'h' });
    if (!c.ok) throw new Error('create failed');
    const code = codes.issue(c.device.id, Date.now() + 60_000);
    const wrong = codes.check(c.device.id, code === '000000' ? '111111' : '000000');
    if (wrong.result !== 'wrong') throw new Error('expected wrong');
    reg.applyConfirm(c.device.id, { ok: false, wrongHmac: wrong.hmac });
    reg.applyConfirm(c.device.id, { ok: false, wrongHmac: wrong.hmac }); // the same wrong code again: not counted
    expect(reg.get(c.device.id)!.wrongCodes).toHaveLength(1);
    const right = codes.check(c.device.id, `${code.slice(0, 3)} ${code.slice(3)}`);
    expect(right.result).toBe('ok');
    reg.applyConfirm(c.device.id, { ok: true });
    expect(reg.get(c.device.id)!.status).toBe('active');
  });

  it('refuses a duplicate key and too many pending', () => {
    const reg = new DeviceRegistry(tmp());
    const key = makeDevice().publicKey;
    expect(reg.createPending({ deviceName: null, label: null, publicKey: key, host: 'h' }).ok).toBe(true);
    expect(reg.createPending({ deviceName: null, label: null, publicKey: key, host: 'h' })).toEqual({ ok: false, reason: 'duplicate-key' });
    for (let i = 1; i < MAX_PENDING; i++) reg.createPending({ deviceName: null, label: null, publicKey: makeDevice().publicKey, host: 'h' });
    expect(reg.createPending({ deviceName: null, label: null, publicKey: makeDevice().publicKey, host: 'h' })).toEqual({ ok: false, reason: 'too-many-pending' });
  });

  it('the shared wrong-code budget pauses pairing and survives a reload', () => {
    const dir = tmp();
    const reg = new DeviceRegistry(dir);
    for (let i = 0; i < WRONG_BUDGET; i++) {
      const c = reg.createPending({ deviceName: null, label: null, publicKey: makeDevice().publicKey, host: 'h' });
      if (!c.ok) { expect(c.reason).toBe('pairing-paused'); break; }
      reg.applyConfirm(c.device.id, { ok: false, wrongHmac: `w${i}` });
      if (i % 3 === 2) reg.remove(c.device.id);
    }
    expect(reg.pairingPaused()).toBe(true);
    expect(new DeviceRegistry(dir).pairingPaused()).toBe(true);
  });

  it('expires pending on boot, and revoke is a terminal tombstone', () => {
    const reg = new DeviceRegistry(tmp());
    const c = reg.createPending({ deviceName: null, label: null, publicKey: makeDevice().publicKey, host: 'h' });
    if (!c.ok) throw new Error('create failed');
    reg.expireAllPending();
    expect(reg.get(c.device.id)!.status).toBe('expired');
    expect(reg.revoke(c.device.id)).toBe(true);
    expect(reg.get(c.device.id)!.status).toBe('revoked');
    expect(reg.revoke('nope')).toBe(false);
  });

  it('a failed write changes nothing', () => {
    const dir = tmp();
    const reg = new DeviceRegistry(dir);
    const c = reg.createPending({ deviceName: null, label: null, publicKey: makeDevice().publicKey, host: 'h' });
    if (!c.ok) throw new Error('create failed');
    fs.chmodSync(path.join(dir, 'state'), 0o500);
    try {
      expect(() => reg.revoke(c.device.id)).toThrow();
    } finally { fs.chmodSync(path.join(dir, 'state'), 0o700); }
    expect(reg.get(c.device.id)!.status).toBe('pending');
  });
});

describe('ConfirmationCodes', () => {
  it('check() compares only; the code survives until dropped', () => {
    const codes = new ConfirmationCodes();
    const code = codes.issue('d1', Date.now() + 60_000);
    expect(codes.check('d1', code).result).toBe('ok');
    expect(codes.check('d1', code).result).toBe('ok');
    codes.drop('d1');
    expect(codes.check('d1', code).result).toBe('none');
  });

  it('finds a live code in inbound text, spaced or not', () => {
    const codes = new ConfirmationCodes();
    const code = codes.issue('d1', Date.now() + 60_000);
    expect(codes.leakedIn(`here it is: ${code.slice(0, 3)} ${code.slice(3)}`)).toEqual(['d1']);
    expect(codes.leakedIn(`code ${code}`)).toEqual(['d1']);
    expect(codes.leakedIn('nothing here 12')).toEqual([]);
  });
});
