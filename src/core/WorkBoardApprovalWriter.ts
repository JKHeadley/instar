import { createHash } from 'node:crypto';

export interface WorkBoardWriterProof {
  epoch: string;
  ownerGeneration: string;
  ownerPersonKey: string;
  writerIncarnation: string;
}

export interface WorkBoardApprovalVersion {
  cardId: string;
  cardRevision: string;
  policyRevision: string;
  visibleTextHash: string;
  materialHash: string;
  titleHash: string;
}

export interface WorkBoardApprovalRequest {
  readonly proof: Readonly<WorkBoardWriterProof>;
  readonly version: Readonly<WorkBoardApprovalVersion>;
  readonly source: 'console' | 'phone' | 'bulk' | 'slip';
  readonly decisionId: string;
}

export interface WorkBoardApprovalEvent {
  readonly eventId: string;
  readonly request: WorkBoardApprovalRequest;
}

export type WorkBoardApprovalResult =
  | { status: 'applied' | 'already-approved'; winner: WorkBoardApprovalEvent }
  | { status: 'changed' | 'unavailable' | 'unresolved' };

export type WorkBoardApprovalLookup =
  | { status: 'missing' | 'unknown' }
  | { status: 'durable'; event: WorkBoardApprovalEvent };

export interface WorkBoardApprovalWriterPorts {
  currentWriter: () => WorkBoardWriterProof | null;
  currentEligibleVersion: (cardId: string) => WorkBoardApprovalVersion | null;
  // Missing requires proof that neither a committed event nor a reservation exists.
  readEvent: (eventId: string) => WorkBoardApprovalLookup;
  // Append rechecks writer proof and version and reserves the generation synchronously.
  // Readers and pickup cannot see
  // the event until the journal confirms the exact sequence is durable.
  append: (event: WorkBoardApprovalEvent) => number | null;
  awaitDurable: (sequence: number) => Promise<void>;
}

export function sameProof(first: WorkBoardWriterProof, second: WorkBoardWriterProof | null): boolean {
  return second !== null && first.epoch === second.epoch
    && first.ownerGeneration === second.ownerGeneration
    && first.ownerPersonKey === second.ownerPersonKey
    && first.writerIncarnation === second.writerIncarnation;
}

export function sameVersion(first: WorkBoardApprovalVersion, second: WorkBoardApprovalVersion | null): boolean {
  return second !== null && first.cardId === second.cardId
    && first.cardRevision === second.cardRevision
    && first.policyRevision === second.policyRevision
    && first.visibleTextHash === second.visibleTextHash
    && first.materialHash === second.materialHash && first.titleHash === second.titleHash;
}

export function approvalEventId({ proof, version }: WorkBoardApprovalRequest): string {
  const input = [proof.epoch, proof.ownerGeneration, proof.ownerPersonKey, proof.writerIncarnation,
    version.cardId, version.cardRevision, version.policyRevision, version.visibleTextHash, version.materialHash, version.titleHash];
  const generation = createHash('sha256').update(JSON.stringify(input)).digest('hex');
  return `wc:${version.cardId}:approve:${generation}`;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function bindingPart(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 200
    && !/[\u0000-\u001f\u007f]/.test(value);
}

export function decodeWorkBoardApprovalEvent(data: Record<string, unknown>): WorkBoardApprovalEvent | null {
  if (data.recordType !== 'tap' || data.action !== 'approve' || data.op !== 'put') return null;
  const input = record(data.approvalBinding);
  const proof = record(input?.proof);
  const version = record(input?.version);
  if (!input || !proof || !version) return null;

  const { epoch, ownerGeneration, ownerPersonKey, writerIncarnation } = proof;
  const { cardId, cardRevision, policyRevision, visibleTextHash, materialHash, titleHash } = version;
  const { source, decisionId } = input;
  if (!bindingPart(epoch) || !bindingPart(ownerGeneration) || !bindingPart(ownerPersonKey) || !bindingPart(writerIncarnation)
    || !bindingPart(cardRevision) || !bindingPart(policyRevision) || !bindingPart(decisionId)
    || typeof cardId !== 'string' || !/^wc_[a-f0-9]{16}$/.test(cardId) || data.cardId !== cardId
    || typeof visibleTextHash !== 'string' || !/^[a-f0-9]{64}$/.test(visibleTextHash)
    || typeof materialHash !== 'string' || !/^[a-f0-9]{64}$/.test(materialHash) || data.materialHash !== materialHash
    || typeof titleHash !== 'string' || !/^[a-f0-9]{64}$/.test(titleHash) || data.titleHash !== titleHash
    || (source !== 'console' && source !== 'phone' && source !== 'bulk' && source !== 'slip')) return null;

  const actor = record(data.by);
  const expectedProof = source === 'console' || source === 'bulk' ? 'pin' : 'presence';
  if (actor?.kind !== 'person' || actor.personKey !== ownerPersonKey || actor.proof !== expectedProof) return null;

  const request: WorkBoardApprovalRequest = {
    proof: { epoch, ownerGeneration, ownerPersonKey, writerIncarnation },
    version: { cardId, cardRevision, policyRevision, visibleTextHash, materialHash, titleHash },
    source,
    decisionId,
  };
  const eventId = approvalEventId(request);
  return data.recordKey === eventId ? { eventId, request } : null;
}

export class WorkBoardApprovalWriter {
  private readonly pending = new Map<string, Promise<void>>();

  constructor(private readonly ports: WorkBoardApprovalWriterPorts) {}

  async approve(input: WorkBoardApprovalRequest): Promise<WorkBoardApprovalResult> {
    const request = Object.freeze({
      proof: Object.freeze({ ...input.proof }),
      version: Object.freeze({ ...input.version }),
      source: input.source,
      decisionId: input.decisionId,
    });
    if (!sameProof(request.proof, this.ports.currentWriter())) return { status: 'unavailable' };
    const eventId = approvalEventId(request);
    const pending = this.pending.get(eventId);
    if (pending) {
      await pending;
      return this.receipt(eventId, request);
    }
    const existing = this.ports.readEvent(eventId);
    if (existing.status !== 'missing') return this.receipt(eventId, request);
    if (!sameVersion(request.version, this.ports.currentEligibleVersion(request.version.cardId))) {
      return { status: 'changed' };
    }

    const sequence = this.ports.append(Object.freeze({ eventId, request }));
    if (sequence === null) return this.receipt(eventId, request);
    const durable = this.ports.awaitDurable(sequence).catch(() => {
      // A timeout is ambiguous. Only exact journal readback can resolve it.
    });
    this.pending.set(eventId, durable);
    try {
      await durable;
      return this.receipt(eventId, request);
    } finally {
      this.pending.delete(eventId);
    }
  }

  private receipt(eventId: string, request: WorkBoardApprovalRequest): WorkBoardApprovalResult {
    if (!sameProof(request.proof, this.ports.currentWriter())) return { status: 'unavailable' };
    const receipt = this.ports.readEvent(eventId);
    if (receipt.status !== 'durable' || receipt.event.eventId !== eventId
      || !sameProof(request.proof, receipt.event.request.proof)
      || !sameVersion(request.version, receipt.event.request.version)) {
      return { status: 'unresolved' };
    }
    const winner = receipt.event;
    return {
      status: winner.request.source === request.source && winner.request.decisionId === request.decisionId
        ? 'applied' : 'already-approved',
      winner,
    };
  }
}
