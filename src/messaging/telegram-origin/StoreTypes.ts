/** Storage wire contract. Only the origin service may supply verified envelopes/plans.
 * No transport credentials, signing keys or session preparation tokens cross this port.
 */
export interface StoredOriginInput {
  originId: string;
  machineId: string;
  createdAt: number;
  /** Exact canonical JSON of the signed origin envelope, validated by the service. */
  envelopeJson: string;
  envelopeDigest: string;
  harnessId?: string;
  evidenceStatus?: 'observed' | 'configured' | 'unknown' | 'not-applicable';
}

export interface StoredMaterializationInput {
  materializationId: string;
  /** Exact Bot API body bytes as UTF-8, or canonical Web RPC method/arguments. */
  requestJson: string;
  requestDigest: string;
  /** ASP dispatch deadline, when applicable. */
  dispatchDeadline?: number;
}

export interface StoredChildInput {
  childId: string;
  deliveryId: string;
  destinationJson: string;
  canonicalContentDigest: string;
  materializations: StoredMaterializationInput[];
  allowedDerivations?: Array<'signature-renewal' | 'companion-receipt'>;
}

export interface OriginAdmission {
  record: StoredOriginInput;
  operationId: string;
  preparedAt: number;
  deadlineAt: number;
  maxAttempts: number;
  /** Includes immutable attachment/payload references outside the sealed request. */
  payloadBytes: number;
  children: StoredChildInput[];
  /** Bytes live only in queue custody, never the retained audit envelope. */
  payloads?: StoredPayloadInput[];
}
export interface StoredPayloadInput { payloadId: string; digest: string; size: number; data: Uint8Array; }

export interface OriginStoreOptions {
  stateDir: string;
  agentId: string;
  requestTimeoutMs?: number;
  /** Conservative aggregate structured-clone budget before worker enqueue. */
  maxPendingBytes?: number;
  maxOperations?: number;
  maxPayloadBytes?: number;
  maxChildren?: number;
  maxNoticeReservations?: number;
  maxNoticeBytes?: number;
  /** Alternate separately writable evidence directory; never an execution owner. */
  spoolDir?: string;
}

export type ChildOutcome = 'accepted' | 'known-failed' | 'scheduled' | 'outcome-unknown' | 'suppressed';
export interface ClaimInput {
  childId: string;
  materializationId: string;
  ownerBootId: string;
  leaseMs: number;
  now?: number;
}
export interface ClaimFence {
  childId: string;
  claimToken: string;
}
export interface ClaimedChild extends ClaimFence {
  operationId: string;
  originId: string;
  deliveryId: string;
  ownerBootId: string;
  materialization: StoredMaterializationInput;
  destinationJson: string;
  attemptId: string;
  attemptNumber: number;
  deadlineAt: number;
}
export type ClaimResult = { status: 'claimed'; child: ClaimedChild } | {
  status: 'unavailable'; reason: 'missing' | 'not-ready' | 'stale-materialization' | 'expired' | 'attempt-budget' | 'signature-expired';
};
export interface OutcomeInput extends ClaimFence {
  outcome: ChildOutcome;
  /** Receipt validator supplies the full platform namespace, never merely prose. */
  receiptJson?: string;
  reason?: string;
  /** Retry only a definitive known-failed result; same original budget/deadline. */
  nextAttemptAt?: number;
  now?: number;
}
export interface DerivedMaterializationInput {
  childId: string;
  expectedGeneration: number;
  kind: 'signature-renewal' | 'companion-receipt';
  canonicalContentDigest: string;
  destinationJson: string;
  inputDigest: string;
  materialization: StoredMaterializationInput;
}
export interface NoticeReservationInput {
  admission: OriginAdmission;
  ownerBootId: string;
  generation: string;
  alertDestinationId: string;
}
/** Storage receipt, not a callable egress capability; notifier privately mints that. */
export interface NoticeReservation extends ClaimFence {
  ownerBootId: string;
  generation: string;
  alertDestinationId: string;
  materializations: StoredMaterializationInput[];
}
export interface OriginAcceptanceVerification {
  envelopeDigest: string;
  verifierMachineId: string;
  keyId: string;
  keyEpoch: number;
  keyFingerprint: string;
  verifiedAt: number;
  keyStatusAtAcceptance: 'active';
}
export interface OriginAuditRecord {
  /** Automatic recovery starts, separate from actual transport attempts. */
  recovery?: { attempts: number; nextAttemptAt: number };
  acceptanceVerification?: OriginAcceptanceVerification;
  diagnostic?: { state: string; reason: string; createdAt: number; resolvedAt: number | null; diagnosis: string | null };
  sequence: number;
  record: StoredOriginInput;
  operation: { operationId: string; preparedAt: number; deadlineAt: number; maxAttempts: number; state: string } | null;
  children: Array<{ childId: string; deliveryId: string; destinationJson: string; generation: number; state: string; attempts: number }>;
  attempts: Array<{ attemptId: string; childId: string; materializationId: string; ownerBootId: string; deliveryMachineId: string | null; phase: string; outcome: string | null; receiptJson: string | null; createdAt: number; resolvedAt: number | null; reason?: string | null; nextAttemptAt?: number | null }>;
}
export interface OriginListQuery {
  cursor?: string;
  limit?: number;
  machineId?: string;
  originId?: string;
  transport?: string;
  accountId?: string;
  chatId?: string;
  topicId?: string;
  messageId?: string;
}
export interface OriginListPage {
  records: OriginAuditRecord[];
  cursor: string | null;
  upperSequence: number;
  coverage: 'complete';
}
export interface OriginMetrics {
  sampledAt: number;
  coverage: 'complete';
  stale: false;
  /** Keys include operation:prepared, child:accepted, attempt:dispatched, etc. */
  counts: Record<string, number>;
}
export interface ArchiveResult { archived: number; archiveId: string | null; digest: string | null }
export interface EvidenceReceipt { originId: string; digest: string; inserted: boolean; sink: 'primary' | 'spool' }
export interface AdmissionResult { operationId: string; originId: string; inserted: boolean }
export interface StoredChild {
  childId: string;
  operationId: string;
  originId: string;
  deliveryId: string;
  destinationJson: string;
  canonicalContentDigest: string;
  generation: number;
  state: string;
  attempts: number;
  materializations: StoredMaterializationInput[];
}
export type OutcomeWriteResult = { recorded: true } | { recorded: false; reason: 'stale-fence' | 'not-dispatched' | 'receipt-required' | 'invalid-transition' };
