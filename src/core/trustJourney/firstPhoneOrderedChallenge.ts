import { createHash } from 'node:crypto';
import { FIRST_APPROVER_SLOT_KEY, FIRST_PHONE_NOMINATION_ID } from './firstPhoneProposal.js';

export interface FirstPhoneOrderedChallenge {
  attemptId: string;
  nonce: string;
  holderMachineId: string;
  holderEpoch: string;
  holderIncarnation: string;
  ownerId: string;
  ownerGeneration: string;
  accountAcceptanceId: string;
  accountAcceptanceGeneration: string;
  policyRevision: string;
  origin: string;
  deviceId: string;
  deviceKeyHash: string;
  presenceKeyHash: string;
  nominationId: string;
  proposalHash: string;
  disclosureHash: string;
  slotKey: string;
}

export const FIRST_PHONE_FACE_ID_ASSURANCE = 'face-id-current-set-v1';

export type FirstPhoneFaceIdChallenge = Omit<FirstPhoneOrderedChallenge, 'presenceKeyHash'> & {
  faceIdKeyHash: string;
  faceIdKeyGeneration: string;
  localAssurance: typeof FIRST_PHONE_FACE_ID_ASSURANCE;
};

const token = /^[A-Za-z0-9_.:-]{1,160}$/;
const digest = /^[a-f0-9]{64}$/;
const decimal = /^(0|[1-9][0-9]{0,159})$/;

function matches(value: unknown, pattern: RegExp): boolean {
  return typeof value === 'string' && pattern.test(value);
}

function canonicalOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    const fixtureLoopback = url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    return url.origin === origin && (url.protocol === 'https:' || fixtureLoopback);
  } catch {
    return false;
  }
}

function canonicalNonce(value: unknown): boolean {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value)) return false;
  const bytes = Buffer.from(value, 'base64url');
  return bytes.length === 32 && bytes.toString('base64url') === value;
}

function canonicalFaceIdOrigin(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 2048 && value.startsWith('https://') && canonicalOrigin(value);
}

function encodeChallenge(challenge: Readonly<FirstPhoneOrderedChallenge>, domain: string, suffix: readonly string[]):
    { challengeKey: string; challengeDigest: string; bytes: Buffer } | null {
  const c = Object.freeze({ ...challenge });
  if (typeof c.origin !== 'string' || c.origin.length > 2048) return null;
  if (!matches(c.attemptId, FIRST_PHONE_NOMINATION_ID) || !matches(c.nominationId, FIRST_PHONE_NOMINATION_ID)
    || !canonicalNonce(c.nonce) || !canonicalOrigin(c.origin)
    || !matches(c.slotKey, FIRST_APPROVER_SLOT_KEY)
    || ![c.holderMachineId, c.holderEpoch, c.holderIncarnation, c.ownerId, c.ownerGeneration,
      c.accountAcceptanceId, c.accountAcceptanceGeneration, c.policyRevision, c.deviceId].every(value => matches(value, token))
    || ![c.deviceKeyHash, c.presenceKeyHash, c.proposalHash, c.disclosureHash].every(value => matches(value, digest))) return null;
  const bytes = Buffer.from(JSON.stringify([
    domain, c.attemptId, c.nonce, c.holderMachineId, c.holderEpoch,
    c.holderIncarnation, c.ownerId, c.ownerGeneration, c.accountAcceptanceId, c.accountAcceptanceGeneration,
    c.policyRevision, c.origin, c.deviceId, c.deviceKeyHash, c.presenceKeyHash, c.nominationId, c.proposalHash,
    c.disclosureHash, c.slotKey, ...suffix,
  ]), 'utf8');
  const challengeKey = createHash('sha256').update(JSON.stringify([
    'instar.first-phone-approver.attempt.v2', c.origin, c.attemptId,
  ])).digest('hex');
  return { challengeKey, challengeDigest: createHash('sha256').update(bytes).digest('hex'), bytes };
}

/** Consume and cancel address the same attempt key and carry the exact challenge digest. */
export function encodeFirstPhoneOrderedChallenge(challenge: Readonly<FirstPhoneOrderedChallenge>) {
  return encodeChallenge(challenge, 'instar.first-phone-approver.presence.v2', []);
}

export function encodeFirstPhoneFaceIdChallenge(challenge: Readonly<FirstPhoneFaceIdChallenge>) {
  const c = { ...challenge };
  if (!matches(c.holderEpoch, decimal)
    || typeof c.faceIdKeyGeneration !== 'string' || !/^[1-9][0-9]{0,159}$/.test(c.faceIdKeyGeneration)
    || c.localAssurance !== FIRST_PHONE_FACE_ID_ASSURANCE
    || !canonicalFaceIdOrigin(c.origin)) return null;
  return encodeChallenge({ ...c, presenceKeyHash: c.faceIdKeyHash }, 'instar.first-phone-approver.face-id.v2',
    [c.faceIdKeyGeneration, c.localAssurance]);
}

export type FirstPhoneFaceIdRegistration = Pick<FirstPhoneFaceIdChallenge,
  'nonce' | 'holderMachineId' | 'holderEpoch' | 'holderIncarnation' | 'ownerId' | 'ownerGeneration' |
  'policyRevision' | 'origin' | 'deviceId' | 'deviceKeyHash' | 'faceIdKeyHash' | 'localAssurance'> & {
  registrationId: string;
  expectedFaceIdKeyGeneration: string;
};

export function encodeFirstPhoneFaceIdRegistration(registration: Readonly<FirstPhoneFaceIdRegistration>): Buffer | null {
  const r = { ...registration };
  if (!matches(r.registrationId, FIRST_PHONE_NOMINATION_ID) || !canonicalNonce(r.nonce)
    || !canonicalFaceIdOrigin(r.origin) || !matches(r.holderEpoch, decimal)
    || !matches(r.expectedFaceIdKeyGeneration, decimal) || r.localAssurance !== FIRST_PHONE_FACE_ID_ASSURANCE
    || ![r.holderMachineId, r.holderIncarnation, r.ownerId, r.ownerGeneration, r.policyRevision, r.deviceId].every(value => matches(value, token))
    || ![r.deviceKeyHash, r.faceIdKeyHash].every(value => matches(value, digest))) return null;
  return Buffer.from(JSON.stringify([
    'instar.first-phone-approver.face-id-registration.v1', r.registrationId, r.nonce,
    r.holderMachineId, r.holderEpoch, r.holderIncarnation, r.ownerId, r.ownerGeneration, r.policyRevision,
    r.origin, r.deviceId, r.deviceKeyHash, r.faceIdKeyHash, r.expectedFaceIdKeyGeneration, r.localAssurance,
  ]), 'utf8');
}
