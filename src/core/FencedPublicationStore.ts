import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

export type PublicationNamespace = 'needs-you' | 'machine-key-history' | 'delete' | 'mobile-ingress';
export interface PublicationScope { agentId: string; namespace: PublicationNamespace }
export interface PublicationGeneration { epoch: number; holder: string }
export interface PublicationClaim { operationKey: string; digest: string; generation: PublicationGeneration }
export type PublicationClaimResult =
  | { kind: 'claimed' | 'existing'; claim: PublicationClaim }
  | { kind: 'pending' | 'fenced' | 'conflict' | 'unavailable' };

const NAMESPACES = new Set<PublicationNamespace>(['needs-you', 'machine-key-history', 'delete', 'mobile-ingress']);
const IDENTIFIER = /^[A-Za-z0-9_.:-]{1,128}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const MAX_STAGED_PER_SCOPE = 1024;
const MAX_STAGED_BYTES = 256 * 1024;
const validScope = (scope: PublicationScope) =>
  typeof scope.agentId === 'string' && IDENTIFIER.test(scope.agentId) && NAMESPACES.has(scope.namespace);
const validGeneration = ({ epoch, holder }: PublicationGeneration) =>
  Number.isSafeInteger(epoch) && epoch > 0 && typeof holder === 'string' && IDENTIFIER.test(holder);

/**
 * Transactional storage for the shared authority receiver. The authority
 * must authenticate callers and independently validate handover proofs.
 * Opening local stores on different machines does not form a shared medium.
 */
export class FencedPublicationStore {
  private constructor(private readonly db: Database.Database) {}

  static open(filename: string): FencedPublicationStore {
    fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    const fd = fs.openSync(filename, 'a', 0o600);
    fs.closeSync(fd);
    fs.chmodSync(filename, 0o600);
    const db = new Database(filename);
    try {
      if (db.pragma('journal_mode = WAL', { simple: true }) !== 'wal') {
        throw new Error('Fenced publication storage requires WAL mode');
      }
      db.pragma('synchronous = FULL');
      db.pragma('busy_timeout = 5000');
      db.exec(`
        CREATE TABLE IF NOT EXISTS publication_generation (
          agent TEXT NOT NULL, namespace TEXT NOT NULL, epoch INTEGER NOT NULL, holder TEXT NOT NULL,
          pending_epoch INTEGER, pending_holder TEXT, candidate_digest TEXT,
          PRIMARY KEY (agent, namespace)
        );
        CREATE TABLE IF NOT EXISTS publication_stage (
          agent TEXT NOT NULL, namespace TEXT NOT NULL, operation TEXT NOT NULL,
          digest TEXT NOT NULL, payload TEXT NOT NULL,
          PRIMARY KEY (agent, namespace, operation)
        );
        CREATE TABLE IF NOT EXISTS publication_claim (
          agent TEXT NOT NULL, namespace TEXT NOT NULL, operation TEXT NOT NULL,
          digest TEXT NOT NULL, epoch INTEGER NOT NULL, holder TEXT NOT NULL,
          PRIMARY KEY (agent, namespace, operation)
        );
      `);
      return new FencedPublicationStore(db);
    } catch (error) {
      db.close();
      throw error;
    }
  }

  close(): void { this.db.close(); }

  provision(scope: PublicationScope, initial: PublicationGeneration): boolean {
    if (!validScope(scope) || !validGeneration(initial)) return false;
    return this.db.prepare(`
      INSERT OR IGNORE INTO publication_generation(agent, namespace, epoch, holder) VALUES (?, ?, ?, ?)
    `).run(scope.agentId, scope.namespace, initial.epoch, initial.holder).changes === 1;
  }

  prepareHandover(scope: PublicationScope, prior: PublicationGeneration, next: PublicationGeneration, digest: string): boolean {
    if (!validScope(scope) || !validGeneration(prior) || !validGeneration(next) || next.epoch <= prior.epoch || !DIGEST.test(digest)) return false;
    return this.db.prepare(`
      UPDATE publication_generation SET pending_epoch=?, pending_holder=?, candidate_digest=?
      WHERE agent=? AND namespace=? AND epoch=? AND holder=? AND pending_epoch IS NULL
    `).run(next.epoch, next.holder, digest, scope.agentId, scope.namespace, prior.epoch, prior.holder).changes === 1;
  }

  /** Called after verification of the exact candidate and predecessor seal. */
  activateHandover(scope: PublicationScope, prior: PublicationGeneration, next: PublicationGeneration, digest: string): boolean {
    if (!validScope(scope) || !validGeneration(prior) || !validGeneration(next) || next.epoch <= prior.epoch || !DIGEST.test(digest)) return false;
    return this.db.prepare(`
      UPDATE publication_generation SET epoch=pending_epoch, holder=pending_holder,
        pending_epoch=NULL, pending_holder=NULL, candidate_digest=NULL
      WHERE agent=? AND namespace=? AND epoch=? AND holder=?
        AND pending_epoch=? AND pending_holder=? AND candidate_digest=?
    `).run(scope.agentId, scope.namespace, prior.epoch, prior.holder, next.epoch, next.holder, digest).changes === 1;
  }

  /** Durable ingress custody. A pending handover does not prevent staging. */
  stage(scope: PublicationScope, operation: string, digest: string, payload: string):
    'staged' | 'existing' | 'conflict' | 'unavailable' {
    if (!validScope(scope) || !/^[A-Za-z0-9_.:-]{1,256}$/.test(operation) ||
        !DIGEST.test(digest) || Buffer.byteLength(payload) > MAX_STAGED_BYTES) return 'conflict';
    return this.db.transaction(() => {
      const provisioned = this.db.prepare(`
        SELECT 1 FROM publication_generation WHERE agent=? AND namespace=?
      `).get(scope.agentId, scope.namespace);
      if (!provisioned) return 'unavailable';
      const previous = this.getStage(scope, operation);
      if (previous) return previous.digest === digest ? 'existing' : 'conflict';
      const count = this.db.prepare(`
        SELECT COUNT(*) FROM publication_stage WHERE agent=? AND namespace=?
      `).pluck().get(scope.agentId, scope.namespace) as number;
      if (count >= MAX_STAGED_PER_SCOPE) return 'unavailable';
      this.db.prepare(`
        INSERT INTO publication_stage(agent, namespace, operation, digest, payload) VALUES (?, ?, ?, ?, ?)
      `).run(scope.agentId, scope.namespace, operation, digest, payload);
      return 'staged';
    }).immediate();
  }

  getStage(scope: PublicationScope, operation: string): { digest: string; payload: string } | null {
    const row = this.db.prepare(`
      SELECT digest, payload FROM publication_stage WHERE agent=? AND namespace=? AND operation=?
    `).get(scope.agentId, scope.namespace, operation) as { digest: string; payload: string } | undefined;
    return row ?? null;
  }

  claim(scope: PublicationScope, generation: PublicationGeneration, operationKey: string, digest: string): PublicationClaimResult {
    if (!validScope(scope) || !validGeneration(generation) ||
        typeof operationKey !== 'string' || !/^[A-Za-z0-9_.:-]{1,256}$/.test(operationKey) ||
        typeof digest !== 'string' || !DIGEST.test(digest)) return { kind: 'conflict' };
    return this.db.transaction((): PublicationClaimResult => {
      const row = this.db.prepare(`
        SELECT epoch, holder, pending_epoch AS pendingEpoch FROM publication_generation WHERE agent=? AND namespace=?
      `).get(scope.agentId, scope.namespace) as { epoch: number; holder: string; pendingEpoch: number | null } | undefined;
      if (!row) return { kind: 'unavailable' };
      if (row.pendingEpoch !== null) return { kind: 'pending' };
      if (row.epoch !== generation.epoch || row.holder !== generation.holder) return { kind: 'fenced' };
      const prior = this.getClaim(scope, operationKey);
      if (prior) return prior.digest === digest ? { kind: 'existing', claim: prior } : { kind: 'conflict' };
      this.db.prepare(`
        INSERT INTO publication_claim(agent, namespace, operation, digest, epoch, holder) VALUES (?, ?, ?, ?, ?, ?)
      `).run(scope.agentId, scope.namespace, operationKey, digest, generation.epoch, generation.holder);
      return { kind: 'claimed', claim: { operationKey, digest, generation: { ...generation } } };
    }).immediate();
  }

  /** Historical evidence only. A receipt cannot authorize another dispatch. */
  getClaim(scope: PublicationScope, operationKey: string): PublicationClaim | null {
    const row = this.db.prepare(`
      SELECT digest, epoch, holder FROM publication_claim WHERE agent=? AND namespace=? AND operation=?
    `).get(scope.agentId, scope.namespace, operationKey) as { digest: string; epoch: number; holder: string } | undefined;
    return row ? { operationKey, digest: row.digest, generation: { epoch: row.epoch, holder: row.holder } } : null;
  }
}
