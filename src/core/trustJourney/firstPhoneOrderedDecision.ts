import { createHash, verify } from 'node:crypto';
import { isStrictLowSDer, keyHashOf, parseDevicePublicKey } from '../MobileDeviceKeys.js';
import { verifyFirstPhoneFaceIdProof } from './firstPhoneFaceIdProof.js';
import {
  encodeFirstPhoneFaceIdChallenge, encodeFirstPhoneOrderedChallenge,
  type FirstPhoneFaceIdChallenge, type FirstPhoneOrderedChallenge,
} from './firstPhoneOrderedChallenge.js';

type AttemptIdentity = Readonly<{ challengeKey: string; challengeDigest: string }>;
type Request = AttemptIdentity & { operationId: string } & (
  | { kind: 'cancel' }
  | { kind: 'consume'; presenceSignature: string }
  | { kind: 'consume-face-id'; faceIdSignature: string; localAssurance: string }
);
export type FirstPhoneOrderedOutcome = AttemptIdentity & Readonly<{
  operationId: string;
  decision: 'canceled' | 'accepted';
  requestDigest: string;
}>;

type CurrentAttempt =
  | { challenge: Readonly<FirstPhoneOrderedChallenge>; presencePublicKey: string }
  | { challenge: Readonly<FirstPhoneFaceIdChallenge>; faceIdPublicKeySpkiDerBase64: string; faceIdEligible: boolean };

/** Apply inside the shared authority's serialized compare-and-swap.
 * The caller supplies the verified current challenge and key, and owns the empty-slot comparison.
 */
export function decideFirstPhoneOrderedAttempt(
  current: Readonly<CurrentAttempt>,
  request: Readonly<Request>,
  existing: FirstPhoneOrderedOutcome | null,
): FirstPhoneOrderedOutcome | null {
  if ('faceIdPublicKeySpkiDerBase64' in current
    ? ('presencePublicKey' in current || 'presenceKeyHash' in current.challenge)
    : ('faceIdKeyHash' in current.challenge || 'faceIdKeyGeneration' in current.challenge || 'localAssurance' in current.challenge)) return null;
  const encoded = 'faceIdPublicKeySpkiDerBase64' in current
    ? encodeFirstPhoneFaceIdChallenge(current.challenge)
    : encodeFirstPhoneOrderedChallenge(current.challenge);
  if (!encoded || encoded.challengeKey !== request.challengeKey || encoded.challengeDigest !== request.challengeDigest
    || typeof request.operationId !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(request.operationId)
    || (request.kind !== 'cancel' && request.kind !== 'consume' && request.kind !== 'consume-face-id')) return null;

  let signatureDigest: string | null = null;
  if (request.kind === 'consume-face-id') {
    if (!('faceIdPublicKeySpkiDerBase64' in current) || (!existing && current.faceIdEligible !== true)
      || !verifyFirstPhoneFaceIdProof(current.challenge, current.faceIdPublicKeySpkiDerBase64, request)) return null;
    signatureDigest = createHash('sha256').update(Buffer.from(request.faceIdSignature, 'base64url')).digest('hex');
  } else if (request.kind === 'consume') {
    if (!('presencePublicKey' in current)) return null;
    const text = request.presenceSignature;
    if (typeof text !== 'string' || !/^[A-Za-z0-9_-]{8,100}$/.test(text)
      || typeof current.presencePublicKey !== 'string' || current.presencePublicKey.length > 128
      || keyHashOf(current.presencePublicKey) !== current.challenge.presenceKeyHash) return null;
    const signature = Buffer.from(text, 'base64url');
    const publicKey = parseDevicePublicKey(current.presencePublicKey);
    if (!publicKey || signature.toString('base64url') !== text || !isStrictLowSDer(signature)
      || !verify('sha256', encoded.bytes, publicKey, signature)) return null;
    signatureDigest = createHash('sha256').update(signature).digest('hex');
  }

  const requestDigest = createHash('sha256').update(JSON.stringify([
    'instar.first-phone-approver.decision.v2', request.kind === 'cancel' ? 'cancel' : 'consume', request.operationId,
    encoded.challengeKey, encoded.challengeDigest, signatureDigest,
  ])).digest('hex');
  if (existing) {
    return existing.challengeKey === encoded.challengeKey && existing.challengeDigest === encoded.challengeDigest
      && existing.operationId === request.operationId && existing.requestDigest === requestDigest
      && existing.decision === (request.kind === 'cancel' ? 'canceled' : 'accepted') ? existing : null;
  }
  return {
    challengeKey: encoded.challengeKey, challengeDigest: encoded.challengeDigest, operationId: request.operationId,
    requestDigest, decision: request.kind === 'cancel' ? 'canceled' : 'accepted',
  };
}
