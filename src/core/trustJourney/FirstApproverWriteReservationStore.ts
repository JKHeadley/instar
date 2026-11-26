import { FIRST_APPROVER_SLOT_KEY, FIRST_PHONE_NOMINATION_ID } from './firstPhoneProposal.js';
import { createHash } from 'node:crypto';
import type { DeviceRegistry, FirstApproverKeyWrite } from '../MobileDeviceKeys.js';
import type { Database, Statement } from 'better-sqlite3';

type KeyWriteResult = ReturnType<DeviceRegistry['replaceFirstApproverPresenceKey']>;

interface Reservation {
  operationId: string;
  slotKey: string;
  holderMachineId: string;
  holderEpoch: string;
  kind: 'phone-enrollment' | 'local-key-replacement';
  intentHash: string;
}

export interface FirstPhoneAcceptanceCommit {
  nominationId: string;
  proposalHash: string;
  slotKey: string;
  holderMachineId: string;
  holderEpoch: string;
}

export function firstPhoneAcceptanceReservation(commit: Readonly<FirstPhoneAcceptanceCommit>): Reservation {
  const { nominationId, proposalHash, slotKey, holderMachineId, holderEpoch } = commit;
  return {
    operationId: nominationId, slotKey, holderMachineId, holderEpoch,
    kind: 'phone-enrollment',
    intentHash: createHash('sha256').update(JSON.stringify([
      'instar.first-phone-acceptance-commit.v1', nominationId, proposalHash,
    ])).digest('hex'),
  };
}

export function firstApproverReplacementReservation(deviceId: string, write: Readonly<FirstApproverKeyWrite>): Reservation {
  const { operationId, slotKey, holderMachineId, holderEpoch } = write;
  const intentHash = createHash('sha256').update(JSON.stringify([
    'instar.first-approver-key-replacement.v1', deviceId, write.deviceKeyHash,
    write.priorPresenceKeyHash, write.newPresenceKeyHash,
  ])).digest('hex');
  return { operationId, slotKey, holderMachineId, holderEpoch, kind: 'local-key-replacement', intentHash };
}

/** Local durable reservation for both kinds of first-approver write.
 * Production must provide exclusive custody before using this store on a holder.
 */
export class FirstApproverWriteReservationStore {
  private readonly insert: Statement;
  private readonly find: Statement<[string], Reservation>;
  private readonly insertPhoneCommit: Statement;
  private readonly findPhoneCommit: Statement<[string], FirstPhoneAcceptanceCommit>;
  private readonly runReserved: (reservation: Reservation, apply: () => KeyWriteResult) => KeyWriteResult | null;

  constructor(private readonly db: Database, private readonly isCurrent: (reservation: Readonly<Reservation>) => boolean) {
    if (db.inTransaction || !this.durable()) {
      throw new Error('First-approver reservation requires a durable top-level writer');
    }
    db.exec(`
      CREATE TABLE IF NOT EXISTS first_approver_write_reservations (
        slotKey TEXT PRIMARY KEY,
        operationId TEXT NOT NULL UNIQUE,
        holderMachineId TEXT NOT NULL,
        holderEpoch TEXT NOT NULL,
        kind TEXT NOT NULL,
        intentHash TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS first_phone_acceptance_commits (
        slotKey TEXT PRIMARY KEY,
        nominationId TEXT NOT NULL UNIQUE,
        proposalHash TEXT NOT NULL,
        holderMachineId TEXT NOT NULL,
        holderEpoch TEXT NOT NULL
      )
    `);
    this.insert = db.prepare(`
      INSERT INTO first_approver_write_reservations
        (slotKey, operationId, holderMachineId, holderEpoch, kind, intentHash)
      VALUES (@slotKey, @operationId, @holderMachineId, @holderEpoch, @kind, @intentHash)
      ON CONFLICT DO NOTHING
    `);
    this.find = db.prepare('SELECT * FROM first_approver_write_reservations WHERE slotKey = ?');
    this.insertPhoneCommit = db.prepare(`
      INSERT INTO first_phone_acceptance_commits (slotKey, nominationId, proposalHash, holderMachineId, holderEpoch)
      VALUES (@slotKey, @nominationId, @proposalHash, @holderMachineId, @holderEpoch) ON CONFLICT DO NOTHING
    `);
    this.findPhoneCommit = db.prepare('SELECT * FROM first_phone_acceptance_commits WHERE nominationId = ?');
    this.runReserved = db.transaction((reservation: Reservation, apply: () => KeyWriteResult): KeyWriteResult | null => {
      if (!this.matches(reservation) || !this.isCurrent(reservation)) return null;
      return apply();
    }).immediate;
  }

  reserve(input: Readonly<Reservation>): boolean {
    const reservation = Object.freeze({ ...input });
    if (this.db.inTransaction || !this.durable() || !/^[A-Za-z0-9_-]{16,128}$/.test(reservation.operationId)
      || !FIRST_APPROVER_SLOT_KEY.test(reservation.slotKey)
      || !reservation.holderMachineId || !reservation.holderEpoch
      || !['phone-enrollment', 'local-key-replacement'].includes(reservation.kind)
      || !/^[a-f0-9]{64}$/.test(reservation.intentHash)) return false;
    return this.db.transaction(() => {
      if (!this.isCurrent(reservation)) return false;
      return this.insert.run(reservation).changes === 1 || this.matches(reservation);
    }).immediate();
  }

  /** Keep local replacement and local slot contenders serialized during the synchronous effect.
   * An ambiguous effect leaves the reservation in place for explicit recovery.
   */
  applyLocalKeyReplacement(
    registry: Pick<DeviceRegistry, 'replaceFirstApproverPresenceKey'>,
    deviceId: string,
    newKey: string,
    input: Readonly<FirstApproverKeyWrite>,
  ): KeyWriteResult | null {
    if (this.db.inTransaction) return null;
    const write = Object.freeze({ ...input });
    const reservation = Object.freeze(firstApproverReplacementReservation(deviceId, write));
    return this.runReserved(reservation, () => registry.replaceFirstApproverPresenceKey(deviceId, newKey, write));
  }

  /** Record exact phone acceptance intent under the shared slot transaction.
   * Only the trust journal can turn this checkpoint into effective device acceptance.
   */
  commitPhoneAcceptanceIntent(input: Readonly<FirstPhoneAcceptanceCommit>): boolean {
    const commit = Object.freeze({ ...input });
    if (this.db.inTransaction || !this.durable() || !FIRST_PHONE_NOMINATION_ID.test(commit.nominationId)
      || !/^[a-f0-9]{64}$/.test(commit.proposalHash)) return false;
    const reservation = Object.freeze(firstPhoneAcceptanceReservation(commit));
    return this.db.transaction(() => {
      if (!this.matches(reservation) || !this.isCurrent(reservation)) return false;
      if (this.insertPhoneCommit.run(commit).changes === 1) return true;
      const existing = this.findPhoneCommit.get(commit.nominationId);
      return !!existing && existing.slotKey === commit.slotKey && existing.proposalHash === commit.proposalHash
        && existing.holderMachineId === commit.holderMachineId && existing.holderEpoch === commit.holderEpoch;
    }).immediate();
  }

  phoneAcceptanceIntent(nominationId: string): FirstPhoneAcceptanceCommit | null {
    return this.db.inTransaction || !FIRST_PHONE_NOMINATION_ID.test(nominationId)
      ? null : this.findPhoneCommit.get(nominationId) ?? null;
  }

  private durable(): boolean {
    const journal = String(this.db.pragma('journal_mode', { simple: true })).toLowerCase();
    return !this.db.memory && !this.db.readonly && !['off', 'memory'].includes(journal)
      && Number(this.db.pragma('synchronous', { simple: true })) >= 2;
  }

  private matches(reservation: Reservation): boolean {
    const stored = this.find.get(reservation.slotKey);
    return !!stored && stored.operationId === reservation.operationId
      && stored.holderMachineId === reservation.holderMachineId && stored.holderEpoch === reservation.holderEpoch
      && stored.kind === reservation.kind && stored.intentHash === reservation.intentHash;
  }
}
