import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import type { PublicationScope } from './FencedPublicationStore.js';
import { samePublicationFloor, validPublicationFloor, verifiedOrderedSuccessor,
  type OrderedPublicationDecision, type PublicationFloor, type WitnessPins } from './OrderedPublicationWitness.js';

export interface AcceptedWitnessSnapshot {
  commit: string;
  floor: PublicationFloor;
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
