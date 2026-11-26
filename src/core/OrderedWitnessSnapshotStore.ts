import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { canonicalJson } from './appMediaTypes.js';
import {
  firstPhoneSlotDecisionPayload, firstPhoneSlotOperationKey, firstPhoneSlotSuccessor, validFirstPhoneSlot,
  type FirstPhoneSlotDecision, type FirstPhoneSlotState,
} from './FirstPhoneSlotDecision.js';
import type { PublicationScope } from './FencedPublicationStore.js';
import { samePublicationFloor, validPublicationFloor, verifiedOrderedSuccessor,
  type OrderedPublicationDecision, type PublicationFloor, type WitnessPins } from './OrderedPublicationWitness.js';

export interface AcceptedWitnessSnapshot {
  commit: string;
  floor: PublicationFloor;
}

interface FirstPhoneSlotReceipt {
  decision: FirstPhoneSlotDecision;
  commit: string;
  floor: PublicationFloor;
  decisionDigest: string;
}

const validCommit = (commit: string) => /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit);

/**
 * Durable witness-side projection. Only the trusted acceptance adapter should
 * call its write methods. A recorded snapshot cannot authorize publication.
 */
export class OrderedWitnessSnapshotStore {
  private constructor(private readonly db: Database.Database) {}

  static open(filename: string): OrderedWitnessSnapshotStore {
    fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    fs.closeSync(fs.openSync(filename, 'a', 0o600));
    fs.chmodSync(filename, 0o600);
    const db = new Database(filename);
    try {
      if (db.pragma('journal_mode = WAL', { simple: true }) !== 'wal') {
        throw new Error('Ordered witness snapshot storage requires WAL mode');
      }
      db.pragma('synchronous = FULL');
      db.pragma('busy_timeout = 5000');
      db.exec(`
        CREATE TABLE IF NOT EXISTS ordered_witness_snapshot (
          agent TEXT NOT NULL, namespace TEXT NOT NULL, commit_oid TEXT NOT NULL, floor TEXT NOT NULL,
          PRIMARY KEY (agent, namespace)
        );
        CREATE TABLE IF NOT EXISTS ordered_witness_operation (
          agent TEXT NOT NULL, namespace TEXT NOT NULL, operation TEXT NOT NULL,
          payload_digest TEXT NOT NULL, commit_oid TEXT NOT NULL,
          PRIMARY KEY (agent, namespace, operation)
        );
        CREATE TABLE IF NOT EXISTS ordered_witness_candidate (
          agent TEXT NOT NULL, namespace TEXT NOT NULL, commit_oid TEXT NOT NULL,
          operation TEXT NOT NULL, payload_digest TEXT NOT NULL, bytes BLOB NOT NULL,
          PRIMARY KEY (agent, namespace, commit_oid)
        );
        CREATE TABLE IF NOT EXISTS first_phone_slot (
          agent TEXT NOT NULL, slot TEXT NOT NULL, state TEXT NOT NULL, PRIMARY KEY (agent, slot)
        );
        CREATE TABLE IF NOT EXISTS first_phone_slot_receipt (
          agent TEXT NOT NULL, operation TEXT NOT NULL, receipt TEXT NOT NULL, PRIMARY KEY (agent, operation)
        )
      `);
      return new OrderedWitnessSnapshotStore(db);
    } catch (error) {
      db.close();
      throw error;
    }
  }

  close(): void { this.db.close(); }

  read(scope: PublicationScope): AcceptedWitnessSnapshot | null {
    const row = this.db.prepare(`
      SELECT commit_oid AS commitOid, floor FROM ordered_witness_snapshot WHERE agent=? AND namespace=?
    `).get(scope.agentId, scope.namespace) as { commitOid: string; floor: string } | undefined;
    return row ? { commit: row.commitOid, floor: JSON.parse(row.floor) as PublicationFloor } : null;
  }

  stageCandidate(scope: PublicationScope, commit: string, operation: string, payload: Buffer):
    'staged' | 'existing' | 'conflict' {
    if (!validCommit(commit) || !/^[A-Za-z0-9_.:-]{1,256}$/.test(operation) ||
        payload.length === 0 || payload.length > 256 * 1024) return 'conflict';
    const digest = createHash('sha256').update(payload).digest('hex');
    return this.db.transaction(() => {
      const saved = this.db.prepare(`
        SELECT operation, payload_digest AS digest, bytes FROM ordered_witness_candidate
        WHERE agent=? AND namespace=? AND commit_oid=?
      `).get(scope.agentId, scope.namespace, commit) as { operation: string; digest: string; bytes: Buffer } | undefined;
      if (saved) return saved.operation === operation && saved.digest === digest && saved.bytes.equals(payload)
        ? 'existing' : 'conflict';
      this.db.prepare('INSERT INTO ordered_witness_candidate VALUES (?, ?, ?, ?, ?, ?)')
        .run(scope.agentId, scope.namespace, commit, operation, digest, payload);
      return 'staged';
    }).immediate();
  }

  /** Read only the original candidate named by an exact historical acceptance. */
  recoverAcceptedCandidate(scope: PublicationScope, operation: string, expectedPayloadDigest: string): Buffer | null {
    const receipt = this.readOperation(scope, operation);
    if (!receipt || receipt.payloadDigest !== expectedPayloadDigest) return null;
    return this.readExactCandidate(scope, receipt.commit, operation, expectedPayloadDigest);
  }

  private readExactCandidate(scope: PublicationScope, commit: string, operation: string, expectedPayloadDigest: string): Buffer | null {
    const row = this.db.prepare(`
      SELECT bytes FROM ordered_witness_candidate
      WHERE agent=? AND namespace=? AND commit_oid=? AND operation=? AND payload_digest=?
    `).get(scope.agentId, scope.namespace, commit, operation, expectedPayloadDigest) as { bytes: Buffer } | undefined;
    return row && createHash('sha256').update(row.bytes).digest('hex') === expectedPayloadDigest ? row.bytes : null;
  }

  readOperation(scope: PublicationScope, operationKey: string): { payloadDigest: string; commit: string } | null {
    const row = this.db.prepare(`
      SELECT payload_digest AS payloadDigest, commit_oid AS commitOid FROM ordered_witness_operation
      WHERE agent=? AND namespace=? AND operation=?
    `).get(scope.agentId, scope.namespace, operationKey) as { payloadDigest: string; commitOid: string } | undefined;
    return row ? { payloadDigest: row.payloadDigest, commit: row.commitOid } : null;
  }

  /** The trusted adapter supplies the independently observed commit for the exact decision. */
  acceptOrderedDecision(
    expected: AcceptedWitnessSnapshot, commit: string, decision: OrderedPublicationDecision,
    payload: string, signature: Buffer, pins: WitnessPins,
  ): 'recorded' | 'existing' | 'conflict' | 'mismatch' {
    return this.db.transaction(() => {
      if (decision.namespace === 'machine-key-history' && this.db.prepare(
        'SELECT 1 FROM first_phone_slot WHERE agent=? LIMIT 1',
      ).get(decision.agentId)) return 'mismatch';
      return this.recordOrderedDecision(expected, commit, decision, payload, signature, pins);
    }).immediate();
  }

  private recordOrderedDecision(
    expected: AcceptedWitnessSnapshot, commit: string, decision: OrderedPublicationDecision,
    payload: string, signature: Buffer, pins: WitnessPins,
  ): 'recorded' | 'existing' | 'conflict' | 'mismatch' {
    const floor = verifiedOrderedSuccessor(expected.floor, decision, payload, signature, pins);
    if (!floor) return 'mismatch';
    return this.db.transaction(() => {
      const prior = this.readOperation(floor, decision.operationKey);
      if (prior) return prior.payloadDigest === decision.payloadDigest && prior.commit === commit ? 'existing' : 'conflict';
      if (this.recordAccepted(expected, { commit, floor }) !== 'recorded') return 'mismatch';
      this.db.prepare(`
        INSERT INTO ordered_witness_operation VALUES (?, ?, ?, ?, ?)
      `).run(floor.agentId, floor.namespace, decision.operationKey, decision.payloadDigest, commit);
      return 'recorded';
    }).immediate();
  }

  provisionFirstPhoneSlot(agentId: string, slot: FirstPhoneSlotState): boolean {
    if (!validFirstPhoneSlot(slot) || slot.reservedBy !== null) return false;
    return this.db.prepare('INSERT OR IGNORE INTO first_phone_slot VALUES (?, ?, ?)')
      .run(agentId, slot.slotKey, canonicalJson(slot)).changes === 1;
  }

  readFirstPhoneSlot(agentId: string, slotKey: string): FirstPhoneSlotState | null {
    const row = this.db.prepare('SELECT state FROM first_phone_slot WHERE agent=? AND slot=?')
      .pluck().get(agentId, slotKey) as string | undefined;
    return row ? JSON.parse(row) as FirstPhoneSlotState : null;
  }

  readFirstPhoneReceipt(agentId: string, decision: FirstPhoneSlotDecision): FirstPhoneSlotReceipt | null {
    const operation = firstPhoneSlotOperationKey(decision);
    const row = this.db.prepare('SELECT receipt FROM first_phone_slot_receipt WHERE agent=? AND operation=?')
      .pluck().get(agentId, operation) as string | undefined;
    if (!row) return null;
    const receipt = JSON.parse(row) as FirstPhoneSlotReceipt;
    return firstPhoneSlotDecisionPayload(receipt.decision) === firstPhoneSlotDecisionPayload(decision) ? receipt : null;
  }

  /** Record verified acceptance and the exact slot transition in one transaction. */
  acceptFirstPhoneSlotDecision(
    expected: AcceptedWitnessSnapshot, commit: string, decision: OrderedPublicationDecision,
    slotDecision: FirstPhoneSlotDecision, signature: Buffer, pins: WitnessPins,
  ): 'recorded' | 'existing' | 'conflict' | 'mismatch' {
    const next = firstPhoneSlotSuccessor(slotDecision);
    if (!next || decision.namespace !== 'machine-key-history' ||
        decision.operationKey !== firstPhoneSlotOperationKey(slotDecision)) return 'mismatch';
    const payload = firstPhoneSlotDecisionPayload(slotDecision);
    const floor = verifiedOrderedSuccessor(expected.floor, decision, payload, signature, pins);
    if (!floor) return 'mismatch';

    return this.db.transaction(() => {
      if (this.readOperation(floor, decision.operationKey)) {
        const receipt = this.readFirstPhoneReceipt(floor.agentId, slotDecision);
        return receipt?.commit === commit ? 'existing' : 'conflict';
      }
      const current = this.readFirstPhoneSlot(floor.agentId, next.slotKey);
      if (!current || canonicalJson(current) !== canonicalJson(slotDecision.prior)) return 'conflict';
      if (!this.readExactCandidate(floor, commit, decision.operationKey, decision.payloadDigest)?.equals(Buffer.from(payload))) {
        return 'mismatch';
      }
      const accepted = this.recordOrderedDecision(expected, commit, decision, payload, signature, pins);
      if (accepted !== 'recorded') return accepted;
      this.db.prepare('UPDATE first_phone_slot SET state=? WHERE agent=? AND slot=?')
        .run(canonicalJson(next), floor.agentId, next.slotKey);
      this.db.prepare('INSERT INTO first_phone_slot_receipt VALUES (?, ?, ?)')
        .run(floor.agentId, decision.operationKey, canonicalJson({
          decision: slotDecision, commit, floor, decisionDigest: floor.head,
        }));
      return 'recorded';
    }).immediate();
  }

  /** Install a trusted genesis exactly once for this witness custody. */
  provision(snapshot: AcceptedWitnessSnapshot): boolean {
    const { commit, floor } = snapshot;
    if (!validCommit(commit) || !validPublicationFloor(floor) || floor.position !== 0) return false;
    return this.db.prepare(`
      INSERT OR IGNORE INTO ordered_witness_snapshot VALUES (?, ?, ?, ?)
    `).run(floor.agentId, floor.namespace, commit, JSON.stringify(floor)).changes === 1;
  }

  /** Persist an already independently verified accepted pair against its exact predecessor. */
  recordAccepted(expected: AcceptedWitnessSnapshot, next: AcceptedWitnessSnapshot):
    'recorded' | 'existing' | 'mismatch' {
    const prior = expected.floor;
    const floor = next.floor;
    if (!validCommit(next.commit) || !validPublicationFloor(floor) || !validPublicationFloor(prior) ||
        next.commit === expected.commit ||
        prior.agentId !== floor.agentId || prior.namespace !== floor.namespace ||
        floor.epoch < prior.epoch ||
        floor.witnessGeneration < prior.witnessGeneration || floor.position < prior.position ||
        samePublicationFloor(floor, prior)) return 'mismatch';

    return this.db.transaction(() => {
      const current = this.read(prior);
      if (current?.commit === next.commit && samePublicationFloor(current.floor, floor)) return 'existing';
      if (!current || current.commit !== expected.commit || !samePublicationFloor(current.floor, prior)) return 'mismatch';
      this.db.prepare(`
        UPDATE ordered_witness_snapshot SET commit_oid=?, floor=? WHERE agent=? AND namespace=?
      `).run(next.commit, JSON.stringify(floor), prior.agentId, prior.namespace);
      return 'recorded';
    }).immediate();
  }
}
