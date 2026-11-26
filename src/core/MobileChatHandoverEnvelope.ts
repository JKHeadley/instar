import type { MediaMessageEvent, MessageEvent } from './AppConversationStore.js';
import {
  verifyMachineSignature,
  verifyRecordedOrigin,
  type MachineKeyLookup,
  type MachineSignature,
  type MachineSigner,
} from './AppRecordSignatures.js';
import { canonicalJson, signedFileHashParts, type AttachmentProjection } from './appMediaTypes.js';
import { derivedEventId } from './appConversationText.js';
import { payloadHash as mobilePayloadHash, requestIdTime } from './MobileChatRequests.js';

export interface MobileChatHandoverIntent {
  deviceId: string;
  requestId: string;
  payloadHash: string;
  topicId: number;
  event: MessageEvent | MediaMessageEvent;
}

export interface MobileChatHandoverEnvelope extends MobileChatHandoverIntent {
  admission: MachineSignature;
}

function canonicalIntent(intent: MobileChatHandoverIntent): string {
  return `instar-mobile-chat-handover-v1\n${canonicalJson({
    deviceId: intent.deviceId, requestId: intent.requestId, payloadHash: intent.payloadHash,
    topicId: intent.topicId, event: intent.event,
  })}`;
}

function exactIdentity(intent: MobileChatHandoverIntent): boolean {
  const { deviceId, requestId, topicId, payloadHash, event } = intent;
  if (!deviceId || requestIdTime(requestId) === null || !/^[0-9a-f]{64}$/.test(payloadHash) ||
      !Number.isSafeInteger(topicId) || topicId <= 0 ||
      (event.kind !== 'message' && event.kind !== 'media-message') ||
      event.conversationKey !== `telegram:${topicId}` || event.role !== 'operator' ||
      event.origin?.deviceId !== deviceId || !event.receipt) return false;
  if (event.origin.bodyB64) {
    try {
      const signedBody = JSON.parse(Buffer.from(event.origin.bodyB64, 'base64').toString('utf8')) as {
        requestId?: unknown; text?: unknown; attachments?: AttachmentProjection[];
      };
      if (signedBody?.requestId !== requestId) return false;
      const text = typeof signedBody.text === 'string' ? signedBody.text.trim() : '';
      if (event.kind === 'media-message' && !Array.isArray(signedBody.attachments)) return false;
      const hashedText = event.kind === 'media-message'
        ? ['\u0000media', text, ...signedFileHashParts(signedBody.attachments!)].join('\n')
        : text;
      if (mobilePayloadHash(topicId, hashedText) !== payloadHash) return false;
    } catch {
      return false; // @silent-fallback-ok — a malformed signed body is unusable
    }
  }
  const seed = `${deviceId}\u0000${requestId}\u0000${payloadHash}`;
  return event.eventId === derivedEventId('op', seed) && event.messageId === derivedEventId('msg', seed);
}

/** Called only by authenticated ingress, after committing the signed event. */
export function signMobileChatHandover(
  intent: MobileChatHandoverIntent, signer: MachineSigner,
): MobileChatHandoverEnvelope | null {
  if (!exactIdentity(intent) || intent.event.receipt?.machineId !== signer.machineId()) return null;
  return { ...intent, admission: signer.sign(canonicalIntent(intent)) };
}

/** Verifies stored custody evidence. Live device authorization and holder claim are separate. */
export function verifyMobileChatHandover(
  envelope: MobileChatHandoverEnvelope,
  ledger: Parameters<typeof verifyRecordedOrigin>[1],
  machineKey: MachineKeyLookup,
): boolean {
  if (!envelope?.event || !envelope.admission) return false;
  try {
    const { event, admission } = envelope;
    const at = Date.parse(event.receivedAt ?? '');
    if (!exactIdentity(envelope) || !Number.isFinite(at) ||
        admission.machineId !== event.receipt?.machineId ||
        verifyMachineSignature(machineKey, admission, canonicalIntent(envelope), at) !== 'ok') return false;
    const verdict = verifyRecordedOrigin({
      conversationKey: event.conversationKey,
      text: event.text,
      receivedAt: event.receivedAt,
      origin: event.origin,
      receipt: event.receipt,
      ...(event.kind === 'media-message' ? { attachments: event.attachments } : {}),
    }, ledger, machineKey);
    return verdict === 'verified' || verdict === 'redacted';
  } catch {
    return false; // @silent-fallback-ok — malformed inbound proof confers no custody authority
  }
}
