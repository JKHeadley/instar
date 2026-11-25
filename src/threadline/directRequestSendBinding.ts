import { createHash } from 'node:crypto';

const opaque = /^[A-Za-z0-9_.:-]{1,200}$/;
const fingerprint = /^[a-f0-9]{32}$/;
const digest = /^[a-f0-9]{64}$/;

export interface ExactDirectRequestSend {
  agentId: string;
  ownerKey: string;
  authorityEpoch: string;
  ownerMessageRef: string;
  ownerEvidenceDigest: string;
  senderFingerprint: string;
  recipientFingerprint: string;
  threadId: string;
  inReplyTo: string | null;
  deliveryId: string;
  message: string;
  attachments: readonly [];
  expiresAt: number;
}

/** Canonical exact-send binding shared by the future admission and durable receipt.
 * Its caller resolves the owner message and pairing independently. A digest is not authority. */
export function directRequestSendBinding(input: ExactDirectRequestSend): string | null {
  const matches = (pattern: RegExp, value: unknown) => typeof value === 'string' && pattern.test(value);
  const { agentId, ownerKey, authorityEpoch, ownerMessageRef, ownerEvidenceDigest, senderFingerprint, recipientFingerprint,
    threadId, inReplyTo, deliveryId, message, attachments, expiresAt } = input;
  if (![agentId, ownerKey, authorityEpoch, ownerMessageRef, threadId, deliveryId].every((v) => matches(opaque, v))
    || !matches(digest, ownerEvidenceDigest) || !matches(fingerprint, senderFingerprint) || !matches(fingerprint, recipientFingerprint)
    || (inReplyTo !== null && !matches(opaque, inReplyTo)) || typeof message !== 'string' || !message
    || !Number.isSafeInteger(expiresAt) || expiresAt <= 0 || !Array.isArray(attachments) || attachments.length !== 0) return null;
  const messageBytes = Buffer.from(message, 'utf8');
  if (messageBytes.toString('utf8') !== message) return null;
  const messageHash = createHash('sha256').update(messageBytes).digest('hex');
  return createHash('sha256').update(JSON.stringify([
    'instar-threadline-direct-request-v1', agentId, ownerKey, authorityEpoch, ownerMessageRef, ownerEvidenceDigest,
    senderFingerprint, recipientFingerprint, threadId, inReplyTo, deliveryId, messageHash, expiresAt,
  ]), 'utf8').digest('hex');
}
