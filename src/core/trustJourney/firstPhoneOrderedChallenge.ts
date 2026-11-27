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

const token = /^[A-Za-z0-9_.:-]{1,160}$/;
const digest = /^[a-f0-9]{64}$/;

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

/** Consume and cancel address the same attempt key and carry the exact challenge digest. */
export function encodeFirstPhoneOrderedChallenge(challenge: Readonly<FirstPhoneOrderedChallenge>):
    { challengeKey: string; challengeDigest: string; bytes: Buffer } | null {
  const c = Object.freeze({ ...challenge });
  if (typeof c.nonce !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(c.nonce)
    || typeof c.origin !== 'string' || c.origin.length > 2048) return null;
  const nonce = Buffer.from(c.nonce, 'base64url');
  if (!matches(c.attemptId, FIRST_PHONE_NOMINATION_ID) || !matches(c.nominationId, FIRST_PHONE_NOMINATION_ID)
    || nonce.length !== 32 || nonce.toString('base64url') !== c.nonce || !canonicalOrigin(c.origin)
    || !matches(c.slotKey, FIRST_APPROVER_SLOT_KEY)
    || ![c.holderMachineId, c.holderEpoch, c.holderIncarnation, c.ownerId, c.ownerGeneration,
      c.accountAcceptanceId, c.accountAcceptanceGeneration, c.policyRevision, c.deviceId].every(value => matches(value, token))
    || ![c.deviceKeyHash, c.presenceKeyHash, c.proposalHash, c.disclosureHash].every(value => matches(value, digest))) return null;
  const bytes = Buffer.from(JSON.stringify([
    'instar.first-phone-approver.presence.v2', c.attemptId, c.nonce, c.holderMachineId, c.holderEpoch,
    c.holderIncarnation, c.ownerId, c.ownerGeneration, c.accountAcceptanceId, c.accountAcceptanceGeneration,
    c.policyRevision, c.origin, c.deviceId, c.deviceKeyHash, c.presenceKeyHash, c.nominationId, c.proposalHash,
    c.disclosureHash, c.slotKey,
  ]), 'utf8');
  const challengeKey = createHash('sha256').update(JSON.stringify([
    'instar.first-phone-approver.attempt.v2', c.origin, c.attemptId,
  ])).digest('hex');
  return { challengeKey, challengeDigest: createHash('sha256').update(bytes).digest('hex'), bytes };
}
