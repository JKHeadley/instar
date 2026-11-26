import { createHash } from 'node:crypto';
import type { Database, Statement } from 'better-sqlite3';
import { FIRST_PHONE_PRIVATE_CALLBACK, type FirstPhonePrivateOffer } from './firstPhonePrivateAccept.js';

export interface StoredFirstPhoneOffer {
  offer: Omit<FirstPhonePrivateOffer, 'callbackData'>;
  deviceId: string;
  holderMachineId: string;
}

const digest = /^[a-f0-9]{64}$/;

/** Immutable records of acknowledged private disclosures, indexed by callback digest. */
export class FirstPhonePrivateOfferStore {
  private readonly insert: Statement;
  private readonly find: Statement<[string], StoredFirstPhoneOffer['offer'] & {
    deviceId: string; holderMachineId: string;
  }>;

  constructor(private readonly db: Database) {
    if (db.inTransaction) throw new Error('First-phone offer store requires a top-level schema transaction');
    db.exec(`
      CREATE TABLE IF NOT EXISTS first_phone_private_offers (
        callback_hash TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL,
        disclosure_message_id INTEGER NOT NULL,
        proposal_hash TEXT NOT NULL,
        account_acceptance_id TEXT NOT NULL,
        holder_epoch TEXT NOT NULL,
        holder_machine_id TEXT NOT NULL,
        first_acceptance_key TEXT NOT NULL,
        device_id TEXT NOT NULL,
        issued_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        UNIQUE (chat_id, disclosure_message_id)
      )
    `);
    this.insert = db.prepare(`
      INSERT INTO first_phone_private_offers (
        callback_hash, chat_id, disclosure_message_id, proposal_hash, account_acceptance_id,
        holder_epoch, holder_machine_id, first_acceptance_key, device_id, issued_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING
    `);
    this.find = db.prepare(`
      SELECT chat_id AS chatId, disclosure_message_id AS disclosureMessageId, proposal_hash AS proposalHash,
        account_acceptance_id AS accountAcceptanceId, holder_epoch AS holderEpoch,
        holder_machine_id AS holderMachineId, first_acceptance_key AS firstAcceptanceKey, device_id AS deviceId,
        issued_at AS issuedAt, expires_at AS expiresAt
      FROM first_phone_private_offers WHERE callback_hash = ?
    `);
  }

  saveAcknowledged(callbackData: string, { offer, deviceId, holderMachineId }: StoredFirstPhoneOffer): boolean {
    if (this.db.inTransaction || !FIRST_PHONE_PRIVATE_CALLBACK.test(callbackData)
      || !/^[1-9][0-9]*$/.test(offer.chatId) || !Number.isSafeInteger(offer.disclosureMessageId)
      || offer.disclosureMessageId <= 0 || !digest.test(offer.proposalHash) || !offer.accountAcceptanceId
      || !offer.holderEpoch || !offer.firstAcceptanceKey || !deviceId || !holderMachineId
      || !Number.isSafeInteger(offer.issuedAt) || !Number.isSafeInteger(offer.expiresAt)
      || offer.issuedAt <= 0 || offer.expiresAt <= offer.issuedAt) return false;

    return this.insert.run(
      createHash('sha256').update(callbackData).digest('hex'), offer.chatId, offer.disclosureMessageId,
      offer.proposalHash, offer.accountAcceptanceId, offer.holderEpoch, holderMachineId,
      offer.firstAcceptanceKey, deviceId, offer.issuedAt, offer.expiresAt,
    ).changes === 1;
  }

  lookup(callbackHash: string): StoredFirstPhoneOffer | null {
    if (this.db.inTransaction || !digest.test(callbackHash)) return null;
    const row = this.find.get(callbackHash);
    if (!row) return null;
    const { deviceId, holderMachineId, ...offer } = row;
    return { offer, deviceId, holderMachineId };
  }
}
