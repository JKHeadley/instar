import { createHash, createPublicKey, verify } from 'node:crypto';
import { isStrictLowSDer } from '../MobileDeviceKeys.js';
import {
  encodeFirstPhoneFaceIdChallenge,
  encodeFirstPhoneFaceIdRegistration,
  FIRST_PHONE_FACE_ID_ASSURANCE,
  type FirstPhoneFaceIdChallenge,
  type FirstPhoneFaceIdRegistration,
} from './firstPhoneOrderedChallenge.js';

interface FaceIdProof {
  challengeKey: string;
  challengeDigest: string;
  localAssurance: string;
  faceIdSignature: string;
}

/** Verify the dedicated proof against a key supplied by the verified device record. */
export function verifyFirstPhoneFaceIdProof(
  challenge: Readonly<FirstPhoneFaceIdChallenge>,
  publicKeySpkiDerBase64: string,
  proof: Readonly<FaceIdProof>,
): boolean {
  const c = { ...challenge };
  const encoded = encodeFirstPhoneFaceIdChallenge(c);
  if (!encoded || proof.challengeKey !== encoded.challengeKey || proof.challengeDigest !== encoded.challengeDigest
    || proof.localAssurance !== FIRST_PHONE_FACE_ID_ASSURANCE) return false;
  return verifyDedicatedSignature(encoded.bytes, c.faceIdKeyHash, publicKeySpkiDerBase64, proof.faceIdSignature);
}

export function verifyFirstPhoneFaceIdRegistration(
  registration: Readonly<FirstPhoneFaceIdRegistration>,
  publicKeySpkiDerBase64: string,
  proof: Readonly<{ registrationId: string; localAssurance: string; faceIdSignature: string }>,
): boolean {
  const r = { ...registration };
  const bytes = encodeFirstPhoneFaceIdRegistration(r);
  return !!bytes && proof.registrationId === r.registrationId && proof.localAssurance === FIRST_PHONE_FACE_ID_ASSURANCE
    && verifyDedicatedSignature(bytes, r.faceIdKeyHash, publicKeySpkiDerBase64, proof.faceIdSignature);
}

function verifyDedicatedSignature(bytes: Buffer, expectedKeyHash: string, publicKeySpkiDerBase64: string, signatureBase64url: string): boolean {
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
