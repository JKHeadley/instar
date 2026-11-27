import { createHash, createPublicKey, verify } from 'node:crypto';
import { isStrictLowSDer } from '../MobileDeviceKeys.js';

export const FACE_ID_CURRENT_SET_ASSURANCE = 'face-id-current-set-v1';

/** Verify possession of the exact registered P-256 key. Eligibility is checked by the caller. */
export function verifyDedicatedSignature(bytes: Buffer, expectedKeyHash: string, publicKeySpkiDerBase64: string, signatureBase64url: string): boolean {
  if (typeof publicKeySpkiDerBase64 !== 'string' || publicKeySpkiDerBase64.length !== 124
    || typeof signatureBase64url !== 'string' || !/^[A-Za-z0-9_-]{8,100}$/.test(signatureBase64url)) return false;

  const der = Buffer.from(publicKeySpkiDerBase64, 'base64');
  if (der.length !== 91 || der.toString('base64') !== publicKeySpkiDerBase64
    || createHash('sha256').update(der).digest('hex') !== expectedKeyHash) return false;
  const signature = Buffer.from(signatureBase64url, 'base64url');
  if (signature.toString('base64url') !== signatureBase64url || !isStrictLowSDer(signature)) return false;

  try {
    const key = createPublicKey({ key: der, type: 'spki', format: 'der' });
    return key.asymmetricKeyType === 'ec' && key.asymmetricKeyDetails?.namedCurve === 'prime256v1'
      && key.export({ type: 'spki', format: 'der' }).equals(der) && verify('sha256', bytes, key, signature);
  } catch {
    return false;
  }
}
