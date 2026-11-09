/**
 * browser-device.js (dashboard-conversations-browser-device.md §4.1, §4.6, Tests: "Unit"): signatures
 * made with Node's WebCrypto through the console module are accepted by the server's own
 * verifyDeviceRequest (1,000 of them, all strict low-S DER), the setup proof and replaces texts
 * have the exact formats, the clock offset is applied, and the key is deleted only on a definite answer.
 */
import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import { verifyDeviceRequest, ReplayGuard, isStrictLowSDer, parseDevicePublicKey, deviceFingerprint, canonicalString as serverCanonical } from '../../src/core/MobileDeviceKeys.js';
import { deviceKeyHashOf } from '../../src/core/AppRecordSignatures.js';
import * as bd from '../../dashboard/console/browser-device.js';

const ACTIVE = new Set(['active'] as const);

async function device() {
  const { keyPair, publicKey } = await bd.generateDeviceKey();
  return { keyPair, publicKey, record: { deviceId: 'dev-browser-0001', host: 'echo.example.dev', machineId: 'm1' } };
}

describe('browser-device signing', () => {
  it('produces keys the server parses, with the server\'s key hash and fingerprint', async () => {
    const { publicKey, keyPair } = await device();
    expect(parseDevicePublicKey(publicKey)).not.toBeNull();
    expect(await bd.keyHashOf(publicKey)).toBe(deviceKeyHashOf(publicKey));
    expect(await bd.fingerprintOf(publicKey)).toBe(deviceFingerprint(publicKey));
    expect(keyPair.privateKey.extractable).toBe(false);
  });

  it('1,000 signed requests are all accepted by verifyDeviceRequest and all low-S', async () => {
    const { keyPair, publicKey, record } = await device();
    const replay = new ReplayGuard();
    const lookup = () => ({ publicKey, host: record.host, status: 'active' as const });
    let lowS = 0;
    for (let i = 0; i < 1000; i++) {
      const body = i % 2 ? JSON.stringify({ text: `hello ${i}`, requestId: bd.newRequestId(Date.now()) }) : undefined;
      const method = body ? 'POST' : 'GET';
      const path = body ? `/mobile/chat/app/app:abc` : `/mobile/conversations?scope=pool&n=${i}`;
      const timeMs = Date.now();
      const h = await bd.signRequest({ record, privateKey: keyPair.privateKey, method, path, body, timeMs });
      if (isStrictLowSDer(Buffer.from(h['X-Instar-Device-Sig'], 'base64url'))) lowS++;
      const v = verifyDeviceRequest({ deviceId: h['X-Instar-Device'], time: h['X-Instar-Device-Time'], sig: h['X-Instar-Device-Sig'], method, pathWithQuery: path, rawBody: body ? Buffer.from(body) : undefined }, lookup, ACTIVE, replay, timeMs);
      expect(v.ok, `request ${i}`).toBe(true);
    }
    expect(lowS).toBe(1000);
  }, 60_000);

  it('a high-S signature is converted to its low-S form', () => {
    const n = BigInt('0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551');
    const raw = new Uint8Array(64);
    raw[31] = 5; // r = 5
    const highS = n - 7n;
    raw.set(Buffer.from(highS.toString(16).padStart(64, '0'), 'hex'), 32);
    const der = bd.rawSigToLowSDer(raw);
    expect(isStrictLowSDer(Buffer.from(der))).toBe(true);
    expect(Buffer.from(der).toString('hex')).toBe('3006020105020107');
  });

  it('DER keeps a leading zero when the top bit is set, and drops leading zero bytes', () => {
    const raw = new Uint8Array(64);
    raw[0] = 0x80; raw[1] = 1; // r with top bit set → 33-byte INTEGER
    raw[63] = 1; // s = 1, 31 leading zero bytes dropped
    const der = Buffer.from(bd.rawSigToLowSDer(raw));
    expect(isStrictLowSDer(der)).toBe(true);
    expect(der[3]).toBe(33);
  });

  it('the canonical string is the server\'s, byte for byte', async () => {
    const body = '{"a":1}';
    const bodyHash = crypto.createHash('sha256').update(body).digest('hex');
    const mine = bd.canonicalString({ deviceId: 'd1', host: 'Echo.Example.DEV', method: 'post', pathWithQuery: '/x?y=1', timeMs: '1700000000000', bodyHash });
    expect(mine).toBe(serverCanonical('d1', 'Echo.Example.DEV', 'post', '/x?y=1', '1700000000000', Buffer.from(body)));
  });

  it('setup proof and replaces texts have the exact formats, and verify', async () => {
    const { keyPair, publicKey } = await device();
    const proofText = bd.enrollText({ host: 'localhost:4040', publicKey, enrollmentId: 'E', timeMs: 123 });
    expect(proofText).toBe(`instar-browser-enroll-v1\nlocalhost:4040\n${publicKey}\nE\n123`);
    expect(bd.replaceText({ oldDeviceId: 'old', newPublicKey: 'NEW', host: 'h', enrollmentId: 'E2' })).toBe('instar-browser-replace-v1\nold\nNEW\nh\nE2');
    const sig = Buffer.from(await bd.signText(keyPair.privateKey, proofText), 'base64url');
    expect(isStrictLowSDer(sig)).toBe(true);
    expect(crypto.verify('sha256', Buffer.from(proofText), { key: parseDevicePublicKey(publicKey)!, dsaEncoding: 'der' }, sig)).toBe(true);
  });

  it('requestIds have the server format and carry corrected time', () => {
    const id = bd.newRequestId(1_700_000_000_123);
    expect(id).toMatch(/^(\d{13})-([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/);
    expect(bd.requestIdTime(id)).toBe(1_700_000_000_123);
  });
});

describe('clock', () => {
  it('applies the server offset and reports skew over two minutes', () => {
    let t = 1_000_000;
    const c = bd.createClock(() => t);
    c.observe(1_000_000 + 5 * 60_000, t - 100, t + 100);
    expect(c.offsetMs()).toBe(5 * 60_000);
    expect(c.now()).toBe(t + 5 * 60_000);
    expect(c.skewMinutes()).toBe(5);
    c.observe(t + 60_000, t, t);
    expect(c.skewMinutes()).toBe(0);
    c.observe('nonsense', t, t);
    expect(c.offsetMs()).toBe(60_000);
  });
});

describe('the key is deleted only on a definite answer (§4.6)', () => {
  const rec = { machineId: 'm1' };
  const ans = (state: string, machineId = 'm1', extra = {}) => ({ machineId, key: { state, ...extra } });
  it('revoked from any machine deletes', () => {
    expect(bd.keyDecision(ans('revoked', 'm2'), rec).action).toBe('delete');
  });
  it('declined / expired / not-found delete only from the key\'s own machine', () => {
    for (const s of ['declined', 'expired', 'not-found']) {
      expect(bd.keyDecision(ans(s, 'm1'), rec).action).toBe('delete');
      expect(bd.keyDecision(ans(s, 'm2'), rec).action).toBe('keep');
    }
  });
  it('elsewhere, active, pending, unknown and garbage keep the key', () => {
    expect(bd.keyDecision(ans('elsewhere', 'm2', { machineId: 'm1', nickname: 'Studio' }), rec)).toMatchObject({ action: 'keep', show: 'elsewhere', nickname: 'Studio' });
    expect(bd.keyDecision(ans('active', 'm1', { reason: 'stale-time' }), rec)).toMatchObject({ action: 'keep', show: 'refused', reason: 'stale-time' });
    expect(bd.keyDecision(ans('pending'), rec).action).toBe('keep');
    expect(bd.keyDecision(ans('unknown'), rec).action).toBe('keep');
    expect(bd.keyDecision(null, rec).action).toBe('keep');
    expect(bd.keyDecision({ machineId: 'm1' }, rec).action).toBe('keep');
  });
  it('names a stale clock in words', () => {
    expect(bd.refusalWords('stale-time', 7)).toContain('clock is 7 minutes off');
  });
});

describe('where the key may be used', () => {
  it('only under /dashboard/console/', () => {
    expect(bd.consolePathAllowed('/dashboard/console/')).toBe(true);
    expect(bd.consolePathAllowed('/dashboard/preview/x/')).toBe(false);
    expect(bd.consolePathAllowed('/view/abc')).toBe(false);
  });
  it('a secure context is https or localhost', () => {
    expect(bd.secureContextOk({ protocol: 'https:', hostname: 'a.b' }, false)).toBe(true);
    expect(bd.secureContextOk({ protocol: 'http:', hostname: 'localhost' }, false)).toBe(true);
    expect(bd.secureContextOk({ protocol: 'http:', hostname: '192.168.1.5' }, false)).toBe(false);
  });
});
