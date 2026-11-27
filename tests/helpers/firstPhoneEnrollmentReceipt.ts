import { randomUUID } from 'node:crypto';
import type { Database } from 'better-sqlite3';

/** Test-only durable authority. The fixture owns the SQLite database and all input evidence. */
export function firstPhoneEnrollmentReceipt(db: Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS first_phone_enrollment_receipts (
      slot TEXT PRIMARY KEY,
      nomination_id TEXT NOT NULL UNIQUE,
      proposal_hash TEXT NOT NULL,
      device_id TEXT NOT NULL,
      acceptance_id TEXT NOT NULL UNIQUE
    )
  `);
  const lookup = db.prepare(`
    SELECT nomination_id AS nominationId, proposal_hash AS proposalHash,
      device_id AS deviceId, acceptance_id AS acceptanceId, slot
    FROM first_phone_enrollment_receipts WHERE nomination_id = ?
  `);
  const insert = db.prepare(`
    INSERT INTO first_phone_enrollment_receipts (slot, nomination_id, proposal_hash, device_id, acceptance_id)
    VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING
  `);
  type Receipt = { nominationId: string; proposalHash: string; deviceId: string; acceptanceId: string };
  function receipt(nominationId: string, proposalHash: string, deviceId: string, slot: string): Receipt | null {
    if (db.inTransaction) return null;
    const row = lookup.get(nominationId) as (Receipt & { slot: string }) | undefined;
    if (row?.proposalHash !== proposalHash || row.deviceId !== deviceId || row.slot !== slot) return null;
    return { nominationId, proposalHash, deviceId, acceptanceId: row.acceptanceId };
  }
  const write = db.transaction((slot: string, nominationId: string, proposalHash: string, deviceId: string) => {
    return insert.run(slot, nominationId, proposalHash, deviceId, randomUUID()).changes === 1;
  });
  return {
    receipt,
    claim(slot: string, nominationId: string, proposalHash: string, deviceId: string): Receipt | null {
      if (db.inTransaction) return null;
      write.immediate(slot, nominationId, proposalHash, deviceId);
      return receipt(nominationId, proposalHash, deviceId, slot);
    },
  };
}
