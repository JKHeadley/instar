import type { Database } from 'better-sqlite3';
import {
  PAIRED_COORDINATION_KIND, pairedCoordinationGrantDigest,
  type Grant, type GrantChange, type OperatorBinding, type PinApproval,
} from './pairedCoordinationPolicy.js';

/** The protected owner writer owns the database and the current-owner snapshot. */
export function createPairedCoordinationGrantStore(db: Database, readOwner: () => OperatorBinding | null) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS paired_coordination_grant (
      operator TEXT PRIMARY KEY, owner_revision TEXT NOT NULL, revision INTEGER NOT NULL, state TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS paired_coordination_pin_used (
      id TEXT PRIMARY KEY
    );
  `);

  function readStoredGrant(operatorId: string): Grant | null {
    const row = db.prepare(`SELECT operator AS operatorId, owner_revision AS ownerRevision, revision, state
      FROM paired_coordination_grant WHERE operator = ?`).get(operatorId) as Omit<Grant, 'scope'> | undefined;
    return row ? { ...row, scope: PAIRED_COORDINATION_KIND } : null;
  }

  const commit = db.transaction((change: GrantChange, proof: PinApproval): boolean => {
    const owner = readOwner();
    if (!owner || owner.operatorId !== change.operatorId || owner.ownerRevision !== change.ownerRevision
      || proof.operatorId !== owner.operatorId || proof.requestDigest !== pairedCoordinationGrantDigest(change)
      || !proof.authorizationId || !Number.isSafeInteger(change.expectedRevision)
      || change.expectedRevision < 0 || change.expectedRevision === Number.MAX_SAFE_INTEGER
      || (change.action !== 'allow' && change.action !== 'revoke')) return false;
    const prior = readStoredGrant(owner.operatorId);
    if ((prior?.revision ?? 0) !== change.expectedRevision) return false;
    if (db.prepare('INSERT OR IGNORE INTO paired_coordination_pin_used VALUES (?)').run(proof.authorizationId).changes !== 1) return false;
    db.prepare(`INSERT INTO paired_coordination_grant VALUES (?, ?, ?, ?)
      ON CONFLICT(operator) DO UPDATE SET owner_revision = excluded.owner_revision,
        revision = excluded.revision, state = excluded.state`).run(
      owner.operatorId, owner.ownerRevision, change.expectedRevision + 1, change.action === 'allow' ? 'allowed' : 'revoked',
    );
    return true;
  });

  return {
    readGrant: (operatorId: string) => db.inTransaction ? null : readStoredGrant(operatorId),
    commitGrantChange: (change: GrantChange, approval: PinApproval) =>
      !db.inTransaction && commit.immediate(change, approval),
  };
}
