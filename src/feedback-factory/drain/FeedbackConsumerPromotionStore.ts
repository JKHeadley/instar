import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { consumerPromotionSetHash, promotionRecordMarker } from './consumerPromotionProposal.js';

export interface FeedbackConsumerPromotion {
  schemaVersion: 1;
  approvedBatchBound: number;
  evidenceHash: string;
  operatorDecisionId: string;
  approvedAt: string;
  revokedAt?: string;
  /** The exact work ids the operator approved (proposal-set bound). Absent on records written before the proposal route. */
  approvedWorkIds?: string[];
  /** promotionRecordMarker() of the record this approval replaced; part of the evidence hash. */
  priorRecordMarker?: string;
  /** Random per-approval id, so the marker of every promotion cycle is unique. */
  recordNonce?: string;
  /** Each approved item's attempt count at approval; an item is untried under this approval while it is unchanged. */
  approvedAttempts?: Record<string, number>;
}

export class FeedbackConsumerPromotionStore {
  constructor(private readonly filePath: string) {}

  read(): FeedbackConsumerPromotion | null {
    try {
      const row = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as FeedbackConsumerPromotion;
      if (row.schemaVersion !== 1 || !Number.isInteger(row.approvedBatchBound) || row.approvedBatchBound < 1 || row.approvedBatchBound > 50) return null;
      if (!/^[a-f0-9]{64}$/.test(row.evidenceHash) || !row.operatorDecisionId || !row.approvedAt) return null;
      return row;
    } catch { return null; }
  }

  isLive(): boolean {
    const record = this.read();
    return record !== null && record.revokedAt === undefined && FeedbackConsumerPromotionStore.isProposalBound(record);
  }

  /**
   * A record is live only when it names its approved work ids and its evidence hash is
   * the proposal-set hash of exactly those ids. A record written by the old syntax-only
   * route (or an invented hash) fails this and needs a fresh, proposal-bound approval.
   */
  static isProposalBound(record: FeedbackConsumerPromotion): boolean {
    const ids = record.approvedWorkIds;
    const baselines = record.approvedAttempts;
    return Array.isArray(ids) && ids.length === record.approvedBatchBound && new Set(ids).size === ids.length
      && ids.every((id) => typeof id === 'string' && id.length > 0)
      && baselines !== undefined && baselines !== null && typeof baselines === 'object'
      && ids.every((id) => Number.isInteger(baselines[id]) && baselines[id] >= 0)
      && consumerPromotionSetHash(ids, record.priorRecordMarker ?? 'none') === record.evidenceHash;
  }

  /** Approved ids still owed priority by the live consumer (null when none are recorded). */
  approvedWorkIds(): { ids: string[]; attemptBaselines: Record<string, number>; nonce: string } | null {
    const record = this.read();
    if (!record || record.revokedAt !== undefined || !FeedbackConsumerPromotionStore.isProposalBound(record)) return null;
    const ids = [...record.approvedWorkIds!];
    const attemptBaselines: Record<string, number> = {};
    for (const id of ids) attemptBaselines[id] = record.approvedAttempts![id];
    return { ids, attemptBaselines, nonce: record.recordNonce ?? record.approvedAt };
  }

  promote(input: Omit<FeedbackConsumerPromotion, 'schemaVersion' | 'approvedAt' | 'revokedAt' | 'priorRecordMarker' | 'recordNonce'>): FeedbackConsumerPromotion {
    if (!Number.isInteger(input.approvedBatchBound) || input.approvedBatchBound < 1 || input.approvedBatchBound > 50) throw new Error('approvedBatchBound must be 1..50');
    if (!/^[a-f0-9]{64}$/.test(input.evidenceHash)) throw new Error('evidenceHash must be sha256');
    if (!input.operatorDecisionId.trim()) throw new Error('operatorDecisionId is required');
    const row: FeedbackConsumerPromotion = { schemaVersion: 1, ...input, ...(input.approvedWorkIds ? { priorRecordMarker: promotionRecordMarker(this.read()), recordNonce: randomUUID() } : {}), approvedAt: new Date().toISOString() };
    this.write(row);
    return row;
  }

  revoke(): FeedbackConsumerPromotion {
    const current = this.read();
    if (!current) throw new Error('consumer promotion does not exist');
    const row = { ...current, revokedAt: new Date().toISOString() };
    this.write(row);
    return row;
  }

  private write(row: FeedbackConsumerPromotion): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(row, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, this.filePath);
  }
}
