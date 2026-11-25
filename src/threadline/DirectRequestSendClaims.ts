import type { Database } from 'better-sqlite3';
import { directRequestSendBinding, type ExactDirectRequestSend } from './directRequestSendBinding.js';

import { exactDirectTelegramPollingSend } from './directTelegramSendEvidence.js';
import { TelegramSendEvidenceStore } from './TelegramSendEvidenceStore.js';

interface Claim {
  binding: string;
  deliveryId: string;
}

type ClaimResult =
  | { status: 'reserved' | 'already-reserved'; deliveryId: string }
  | { status: 'refused' };

/** Stores one reservation per verified owner message on the current writer.
 * Only a new reservation permits an attempt. Existing reservations require
 * transport receipt reconciliation, including when the original outcome is unknown.
 */
export class DirectRequestSendClaims {
  constructor(private readonly db: Database) {
    new TelegramSendEvidenceStore(db);
    db.exec(`
      CREATE TABLE IF NOT EXISTS direct_request_send_claims (
        agent_id TEXT NOT NULL,
        owner_key TEXT NOT NULL,
        owner_message_ref TEXT NOT NULL,
        binding TEXT NOT NULL,
        delivery_id TEXT NOT NULL UNIQUE,
        PRIMARY KEY (agent_id, owner_key, owner_message_ref)
      )
    `);
  }

  reserve(
    send: ExactDirectRequestSend,
    polling: { raw: unknown; botAccountId: number; ownerId: number },
    now = Date.now(),
  ): ClaimResult {
    const proof = exactDirectTelegramPollingSend(polling.raw, polling.botAccountId, polling.ownerId);
    if (!proof || proof.ownerMessageRef !== send.ownerMessageRef || proof.ownerEvidenceDigest !== send.ownerEvidenceDigest
      || proof.recipientFingerprint !== send.recipientFingerprint || proof.message !== send.message) return { status: 'refused' };
    const binding = directRequestSendBinding(send);
    if (this.db.inTransaction || !binding || !Number.isSafeInteger(now) || now < 0) return { status: 'refused' };
    const ownerMessage = [send.agentId, send.ownerKey, send.ownerMessageRef];
    return this.db.transaction((): ClaimResult => {
      const evidence = this.db.prepare(`
        SELECT 1 FROM telegram_send_evidence WHERE reference = ? AND digest = ? AND conflicted = 0
      `).get(proof.ownerMessageRef, proof.ownerEvidenceDigest);
      if (!evidence) return { status: 'refused' };
      const existing = this.db.prepare(`
        SELECT binding, delivery_id AS deliveryId FROM direct_request_send_claims
        WHERE agent_id = ? AND owner_key = ? AND owner_message_ref = ?
      `).get(...ownerMessage) as Claim | undefined;
      if (existing) {
        return existing.binding === binding && existing.deliveryId === send.deliveryId
          ? { status: 'already-reserved', deliveryId: existing.deliveryId }
          : { status: 'refused' };
      }
      if (now >= send.expiresAt) return { status: 'refused' };
      const inserted = this.db.prepare(`
        INSERT INTO direct_request_send_claims
          (agent_id, owner_key, owner_message_ref, binding, delivery_id)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (delivery_id) DO NOTHING
      `).run(...ownerMessage, binding, send.deliveryId);
      return inserted.changes === 1
        ? { status: 'reserved', deliveryId: send.deliveryId }
        : { status: 'refused' };
    }).immediate();
  }
}
