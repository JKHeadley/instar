import { createHash, verify } from 'node:crypto';
import { isStrictLowSDer, keyHashOf, parseDevicePublicKey } from '../MobileDeviceKeys.js';
import { encodeFirstPhoneOrderedChallenge, type FirstPhoneOrderedChallenge } from './firstPhoneOrderedChallenge.js';

type AttemptIdentity = Readonly<{ challengeKey: string; challengeDigest: string }>;
type Request = AttemptIdentity & { operationId: string } & (
  | { kind: 'cancel' }
  | { kind: 'consume'; presenceSignature: string }
);
export type FirstPhoneOrderedOutcome = AttemptIdentity & Readonly<{
  operationId: string;
  decision: 'canceled' | 'accepted';
  requestDigest: string;
}>;

/** Apply inside the shared authority's serialized compare-and-swap.
 * The caller supplies the verified current challenge and key, and owns the empty-slot comparison.
 */
export function decideFirstPhoneOrderedAttempt(
  current: Readonly<{ challenge: Readonly<FirstPhoneOrderedChallenge>; presencePublicKey: string }>,
  request: Readonly<Request>,
  existing: FirstPhoneOrderedOutcome | null,
): FirstPhoneOrderedOutcome | null {
  const encoded = encodeFirstPhoneOrderedChallenge(current.challenge);
  if (!encoded || encoded.challengeKey !== request.challengeKey || encoded.challengeDigest !== request.challengeDigest
    || typeof request.operationId !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(request.operationId)
    || (request.kind !== 'cancel' && request.kind !== 'consume')) return null;

  let signatureDigest: string | null = null;
  if (request.kind === 'consume') {
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
    'instar.first-phone-approver.decision.v2', request.kind, request.operationId,
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
