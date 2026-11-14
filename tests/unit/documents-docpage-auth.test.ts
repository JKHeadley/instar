/** The instar-docpage-v1 signing domain (spec §3.6): one document, one op, one request, device key only. */
import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { docpageString, verifyDocpage, type DocpageRequest } from '../../src/documents/docpageAuth.js';

const DOC = '66666666-6666-4666-8666-666666666666';
function device() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string; y: string };
  const raw = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]).toString('base64url');
  return { raw, privateKey };
}
// Sign and normalise to low-S, as the app's Secure Enclave signer does.
const N = BigInt('0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551');
function lowS(der: Buffer): Buffer {
  const rLen = der[3]; const r = der.subarray(4, 4 + rLen); const sLen = der[5 + rLen]; let s = BigInt('0x' + der.subarray(6 + rLen, 6 + rLen + sLen).toString('hex'));
  if (s > N / 2n) s = N - s;
  let sHex = s.toString(16); if (sHex.length % 2) sHex = '0' + sHex; let sb = Buffer.from(sHex, 'hex'); if (sb[0] & 0x80) sb = Buffer.concat([Buffer.from([0]), sb]);
  const body = Buffer.concat([Buffer.from([2, r.length]), r, Buffer.from([2, sb.length]), sb]);
  return Buffer.concat([Buffer.from([0x30, body.length]), body]);
}
function signed(d: ReturnType<typeof device>, over: Partial<DocpageRequest> = {}, payload: Record<string, unknown> = { docId: DOC, commentKey: 'mara:' + crypto.randomUUID() }): DocpageRequest {
  const base = { deviceId: 'dev1', host: 'echo.example.dev', docId: DOC, op: 'resolve', requestId: `${Date.now()}-${crypto.randomUUID()}`, timeMs: String(Date.now()), payload };
  const msg = docpageString(base.deviceId, base.host, base.docId, 'resolve', base.requestId, base.timeMs, payload);
  const sig = lowS(crypto.sign('sha256', Buffer.from(msg), { key: d.privateKey, dsaEncoding: 'der' }));
  return { ...base, sigB64url: sig.toString('base64url'), ...over };
}
const own = (h: string) => h === 'echo.example.dev';

describe('docpage signatures', () => {
  it('accepts a correct request once and refuses its replay', () => {
    const d = device(); const seen = new Set<string>();
    const r = signed(d);
    expect(verifyDocpage(r, d.raw, own, seen)).toMatchObject({ ok: true, op: 'resolve' });
    expect(verifyDocpage(r, d.raw, own, seen)).toEqual({ ok: false, reason: 'replay' });
  });
  it('refuses another document, a changed payload, a foreign host, a stale time and another key', () => {
    const d = device(); const other = device();
    expect(verifyDocpage({ ...signed(d), docId: crypto.randomUUID() }, d.raw, own, new Set())).toEqual({ ok: false, reason: 'doc-mismatch' });
    const r = signed(d);
    expect(verifyDocpage({ ...r, payload: { ...(r.payload as object), commentKey: 'zed:' + crypto.randomUUID() } }, d.raw, own, new Set())).toEqual({ ok: false, reason: 'bad-signature' });
    expect(verifyDocpage({ ...signed(d), host: 'evil.example' }, d.raw, own, new Set())).toEqual({ ok: false, reason: 'host-not-own' });
    expect(verifyDocpage(signed(d), d.raw, own, new Set(), Date.now() + 120_000)).toEqual({ ok: false, reason: 'stale' });
    expect(verifyDocpage(signed(d), other.raw, own, new Set())).toEqual({ ok: false, reason: 'bad-signature' });
  });
  it('refuses unknown ops and payloads with missing or extra fields', () => {
    const d = device();
    expect(verifyDocpage({ ...signed(d), op: 'grant' }, d.raw, own, new Set())).toEqual({ ok: false, reason: 'bad-op' });
    expect(verifyDocpage(signed(d, {}, { docId: DOC, commentKey: 'x', extra: 1 }), d.raw, own, new Set())).toEqual({ ok: false, reason: 'bad-payload' });
  });
});
