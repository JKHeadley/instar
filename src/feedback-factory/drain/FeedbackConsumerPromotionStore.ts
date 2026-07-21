import fs from 'node:fs';
import path from 'node:path';

export interface FeedbackConsumerPromotion {
  schemaVersion: 1;
  approvedBatchBound: number;
  evidenceHash: string;
  operatorDecisionId: string;
  approvedAt: string;
  revokedAt?: string;
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
    return record !== null && record.revokedAt === undefined;
  }

  promote(input: Omit<FeedbackConsumerPromotion, 'schemaVersion' | 'approvedAt' | 'revokedAt'>): FeedbackConsumerPromotion {
    if (!Number.isInteger(input.approvedBatchBound) || input.approvedBatchBound < 1 || input.approvedBatchBound > 50) throw new Error('approvedBatchBound must be 1..50');
    if (!/^[a-f0-9]{64}$/.test(input.evidenceHash)) throw new Error('evidenceHash must be sha256');
    if (!input.operatorDecisionId.trim()) throw new Error('operatorDecisionId is required');
    const row: FeedbackConsumerPromotion = { schemaVersion: 1, ...input, approvedAt: new Date().toISOString() };
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
