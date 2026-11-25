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
    if (db.inTransaction) throw new Error('Nomination store requires a top-level schema transaction');
    db.transaction(() => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS first_phone_private_nominations (
          callback_hash TEXT PRIMARY KEY,
          receipt_id TEXT NOT NULL UNIQUE,
          proposal_hash TEXT NOT NULL UNIQUE,
          nomination_id TEXT NOT NULL UNIQUE,
          first_acceptance_key TEXT
        )
      `);
      const columns = db.prepare('PRAGMA table_info(first_phone_private_nominations)').all() as Array<{ name: string }>;
      if (!columns.some(({ name }) => name === 'first_acceptance_key')) {
        db.exec('ALTER TABLE first_phone_private_nominations ADD COLUMN first_acceptance_key TEXT');
      }
    }).immediate();
  }

  /** Stored binding for final validation. A nomination row alone conveys no device authority. */
  binding(nominationId: string): { proposalHash: string; firstAcceptanceKey: string } | null {
    if (this.db.inTransaction) return null;
    const row = this.db.prepare(`
      SELECT proposal_hash AS proposalHash, first_acceptance_key AS firstAcceptanceKey
      FROM first_phone_private_nominations WHERE nomination_id = ? AND first_acceptance_key IS NOT NULL
    `).get(nominationId) as { proposalHash: string; firstAcceptanceKey: string } | undefined;
    return row ?? null;
  }

  record(receiptId: string, ...input: MatchInput): Result {
    if (this.db.inTransaction || typeof receiptId !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(receiptId)
      || !matchesFirstPhonePrivateAccept(...input)) return { status: 'refused' };
    const [offer] = input;
    const callbackHash = createHash('sha256').update(offer.callbackData).digest('hex');

    return this.db.transaction((): Result => {
      const existing = this.db.prepare(`
        SELECT nomination_id AS nominationId, receipt_id AS receiptId, proposal_hash AS proposalHash,
          first_acceptance_key AS firstAcceptanceKey
        FROM first_phone_private_nominations WHERE callback_hash = ?
      `).get(callbackHash) as {
        nominationId: string; receiptId: string; proposalHash: string; firstAcceptanceKey: string | null;
      } | undefined;
      if (existing) {
        return existing.receiptId === receiptId && existing.proposalHash === offer.proposalHash
          && existing.firstAcceptanceKey === offer.firstAcceptanceKey
          ? { status: 'already-recorded', nominationId: existing.nominationId }
          : { status: 'refused' };
      }
      const nominationId = randomUUID();
      const inserted = this.db.prepare(`
        INSERT INTO first_phone_private_nominations
          (callback_hash, receipt_id, proposal_hash, nomination_id, first_acceptance_key)
        VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING
      `).run(callbackHash, receiptId, offer.proposalHash, nominationId, offer.firstAcceptanceKey);
      return inserted.changes === 1 ? { status: 'recorded', nominationId } : { status: 'refused' };
    }).immediate();
  }
}
