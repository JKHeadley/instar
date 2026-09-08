import type { OriginJson } from './CanonicalOrigin.js';

export type OriginEvidenceStatus = 'observed' | 'configured' | 'unknown' | 'not-applicable';
export interface OriginEvidence {
  value: string | null;
  status: OriginEvidenceStatus;
  sourceEventRef: string | null;
  observedAt: number | null;
  reason: string | null;
}
export interface TelegramOriginProducer {
  agentId: string;
  agentName: string;
  originMachineId: string;
  originMachineName: string;
  sessionId: string | null;
  sessionIncarnation: string | null;
  turnId: string | null;
  producerKind: 'session' | 'server-automation' | 'imported-legacy';
  producerId: string;
  harnessId: string | null;
  harnessName: string | null;
  machine: OriginEvidence;
  harness: OriginEvidence;
  model: OriginEvidence;
  authorContributors?: Array<{ model: OriginEvidence; harness: OriginEvidence }>;
  omittedAuthorContributors?: number;
}
export interface OriginDisplaySettings {
  enabled: boolean;
  machine: boolean;
  harness: boolean;
  model: boolean;
}
export interface OriginDisplaySnapshot extends OriginDisplaySettings { version: string; }
export interface OriginDestination {
  version: 1;
  transport: 'bot-api' | 'telegram-web' | 'telegram-mtproto';
  accountId: string;
  chatId: string | null;
  topicId: string | null;
  messageId: string | null;
  inlineMessageId: string | null;
  scheduledMessageId: string | null;
}
export interface TelegramOriginRecord extends TelegramOriginProducer {
  /** Custody importer attests unknown legacy authorship, not its own authorship. */
  importedByMachineId?: string;
  legacySnapshotDigest?: string;
  /** Pinned at preparation. A custody/lease move cannot silently authorize the
   * same uncertain operation on another machine. Absent on imported legacy evidence. */
  executionOwnerMachineId?: string;
  childLinks?: Array<{ childId: string; companionOf: string | null }>;
  forwardedFrom?: { chatId: string; messageIds: string[] };
  /** Original retained message origin for an edit; null means legacy/unavailable authorship. */
  revisionOf?: string | null;
  schemaVersion: 'instar-telegram-origin-v1';
  originId: string;
  operationId: string;
  deliveryId: string;
  createdAt: number;
  operationKind: string;
  destination: OriginDestination;
  contentDigest: string;
  planDigest: string;
  /** Signed execution bounds, materializations and derivation permissions. */
  admissionDigest?: string;
  display: OriginDisplaySnapshot;
  attestation: OriginAttestation | null;
}
export interface OriginAttestation {
  keyId: string;
  keyEpoch: number;
  envelopeDigest: string;
  signature: string;
  signedAt: number;
}
export interface SealedBotRequest {
  /** Protected policy input; committed by the plan, never transmitted to Telegram. */
  policy?: import('./OriginSendPolicy.js').OriginSendPolicyInput;
  /** One bounded derivation may bind reply_parameters to this accepted child. */
  companionOf?: string;
  method: string;
  accountId: string;
  destination: OriginDestination;
  contentType: 'application/json';
  body: string;
  /** Canonical parameters stay separate from byte custody; these refs are signed. */
  multipart?: { boundary: string; wireDigest: string; attachments: OriginAttachmentRef[] };
}
export interface OriginAttachmentRef {
  payloadId: string;
  field: string;
  filename: string;
  mediaType: string;
  digest: string;
  size: number;
}
export interface OriginPreparedChild {
  childId: string;
  materializationId: string;
  request: SealedBotRequest;
  requestDigest: string;
}
export type OriginSendOutcome = 'accepted' | 'known-failed' | 'outcome-unknown' | 'scheduled' | 'suppressed' | 'held' | 'partial' | 'expired-unresolved';
export interface OriginPlatformReceipt {
  transport: OriginDestination['transport'];
  accountId: string;
  chatId: string | null;
  topicId: string | null;
  messageId: string | null;
  inlineMessageId: string | null;
  scheduledMessageId: string | null;
  acceptedAt: number;
}
export interface OriginLimits {
  maxActiveOperations: number;
  maxActivePayloadBytes: number;
  maxChildren: number;
  deadlineMs: number;
  maxAttempts: number;
}
export const DEFAULT_ORIGIN_LIMITS: Readonly<OriginLimits> = Object.freeze({
  maxActiveOperations: 1000, maxActivePayloadBytes: 256 * 1024 * 1024,
  maxChildren: 100, deadlineMs: 6 * 60 * 60 * 1000, maxAttempts: 9,
});
export interface OriginConfig {
  display?: Partial<OriginDisplaySettings>;
  /** Application permission for the pre-recorded operator-hub outage notice.
   * Omitted means enabled; this never disables ordinary origin recording. */
  outageNotice?: { enabled?: boolean };
  limits?: Partial<OriginLimits>;
}
export type BotParameters = { [key: string]: OriginJson };

export class TelegramOriginHoldError extends Error {
  readonly terminalForCallerRetry = true;
  constructor(readonly reason: string, readonly operationId: string | null = null,
    readonly outcome: OriginSendOutcome = 'held') {
    super(`Telegram message held: ${reason}`);
    this.name = 'TelegramOriginHoldError';
  }
}
