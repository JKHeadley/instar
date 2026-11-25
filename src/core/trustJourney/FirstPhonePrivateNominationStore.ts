import { createHash, randomUUID } from 'node:crypto';
import type { Database } from 'better-sqlite3';
import { matchesFirstPhonePrivateAccept } from './firstPhonePrivateAccept.js';

type MatchInput = Parameters<typeof matchesFirstPhonePrivateAccept>;
type Result =
  | { status: 'recorded' | 'already-recorded'; nominationId: string }
  | { status: 'refused' };

/** Isolated persistence for a private Accept tap and its exact nomination.
 * The caller resolves current owner, account and holder facts from authoritative sources.
 */
export class FirstPhonePrivateNominationStore {
  constructor(private readonly db: Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS first_phone_private_nominations (
        callback_hash TEXT PRIMARY KEY,
        receipt_id TEXT NOT NULL UNIQUE,
        proposal_hash TEXT NOT NULL UNIQUE,
        nomination_id TEXT NOT NULL UNIQUE
      )
    `);
  }

  record(receiptId: string, ...input: MatchInput): Result {
    if (this.db.inTransaction || typeof receiptId !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(receiptId)
      || !matchesFirstPhonePrivateAccept(...input)) return { status: 'refused' };
    const [offer] = input;
    const callbackHash = createHash('sha256').update(offer.callbackData).digest('hex');

    return this.db.transaction((): Result => {
      const existing = this.db.prepare(`
        SELECT nomination_id AS nominationId, receipt_id AS receiptId, proposal_hash AS proposalHash
        FROM first_phone_private_nominations WHERE callback_hash = ?
      `).get(callbackHash) as { nominationId: string; receiptId: string; proposalHash: string } | undefined;
      if (existing) {
        return existing.receiptId === receiptId && existing.proposalHash === offer.proposalHash
          ? { status: 'already-recorded', nominationId: existing.nominationId }
          : { status: 'refused' };
      }
      const nominationId = randomUUID();
      const inserted = this.db.prepare(`
        INSERT INTO first_phone_private_nominations (callback_hash, receipt_id, proposal_hash, nomination_id)
        VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING
      `).run(callbackHash, receiptId, offer.proposalHash, nominationId);
      return inserted.changes === 1 ? { status: 'recorded', nominationId } : { status: 'refused' };
    }).immediate();
  }
}
