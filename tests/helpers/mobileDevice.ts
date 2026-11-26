/** Test helper: a phone stand-in for mobile device keys (docs/specs/mobile-device-keys.md). */
import crypto from 'node:crypto';

const N = BigInt('0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551');

/** A phone stand-in: a P-256 key whose signatures are normalized to low S, as the app does. */
export function makeDevice() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string; y: string };
  const raw = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]);
  const sign = (msg: string, highS = false) => {
    const p1363 = crypto.sign('sha256', Buffer.from(msg), { key: privateKey, dsaEncoding: 'ieee-p1363' });
    const r = BigInt('0x' + p1363.subarray(0, 32).toString('hex'));
    let s = BigInt('0x' + p1363.subarray(32).toString('hex'));
    if (s > N / 2n) s = N - s;
    if (highS) s = N - s;
    const enc = (v: bigint) => { let h = v.toString(16); if (h.length % 2) h = '0' + h; let b = Buffer.from(h, 'hex'); if (b[0]! & 0x80) b = Buffer.concat([Buffer.from([0]), b]); return Buffer.concat([Buffer.from([2, b.length]), b]); };
    const body = Buffer.concat([enc(r), enc(s)]);
    return Buffer.concat([Buffer.from([0x30, body.length]), body]).toString('base64url');
  };
  return { publicKey: raw.toString('base64url'), sign };
}

