/** Durable monotonic witness for the signed pool certificate registry.
 * This replica cannot authorize a fixed decision by itself. */
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { Database as SqliteDatabase } from 'better-sqlite3';
import { registerSqliteHandle } from '../core/SqliteRegistry.js';
import { fixedRegistryDigest, verifyFixedRegistrySnapshot,
  type FixedCertificateRegistrySnapshot } from './JobFixedCertificateRegistry.js';
import type { MachineKeyLookup } from '../core/AppRecordSignatures.js';

export class JobFixedRegistryReplica {
  private readonly db: SqliteDatabase;
  private unregister?: () => void;

  constructor(stateDir: string) {
    const dir = path.join(stateDir, 'ledger');
    fs.mkdirSync(dir, { recursive: true });
    this.db = new Database(path.join(dir, 'job-fixed-registry-replica.db'));
    this.unregister = registerSqliteHandle(() => { try { this.db.close(); } catch { /* already closed */ } });
    try {
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('synchronous = FULL');
      this.db.pragma('busy_timeout = 5000');
      this.db.exec(`CREATE TABLE IF NOT EXISTS registry_witness (
        singleton INTEGER PRIMARY KEY CHECK(singleton=1),
        epoch INTEGER NOT NULL, digest TEXT NOT NULL, snapshot_json TEXT NOT NULL
      )`);
    } catch (error) { this.close(); throw error; }
  }

  close(): void {
    this.unregister?.();
    this.unregister = undefined;
    if (this.db.open) this.db.close();
  }

  latestEpoch(): number {
    const row = this.db.prepare('SELECT epoch FROM registry_witness WHERE singleton=1').get() as { epoch: number } | undefined;
    return row?.epoch ?? 0;
  }

  /** Accepted only from the pinned writer. A conflict at one epoch is sticky refusal. */
  accept(snapshot: FixedCertificateRegistrySnapshot, input: {
    pinnedAuthorityMachineId: string; keyLookup: MachineKeyLookup; now: number;
  }): boolean {
    return this.db.transaction(() => {
      const prior = this.db.prepare('SELECT epoch,digest FROM registry_witness WHERE singleton=1')
        .get() as { epoch: number; digest: string } | undefined;
      const verified = verifyFixedRegistrySnapshot(snapshot, { ...input,
        minimumEpoch: prior?.epoch ?? 0 });
      if (!verified) return false;
      const digest = fixedRegistryDigest(snapshot);
      if (prior && prior.epoch === snapshot.epoch) return prior.digest === digest;
      this.db.prepare(`INSERT INTO registry_witness(singleton,epoch,digest,snapshot_json) VALUES(1,?,?,?)
        ON CONFLICT(singleton) DO UPDATE SET epoch=excluded.epoch,digest=excluded.digest,snapshot_json=excluded.snapshot_json`)
        .run(snapshot.epoch, digest, JSON.stringify(snapshot));
      return true;
    })();
  }

  /** Diagnostic copy only. It cannot feed `resolveFixed` without a fresh writer read. */
  diagnosticSnapshot(): FixedCertificateRegistrySnapshot | null {
    const row = this.db.prepare('SELECT snapshot_json FROM registry_witness WHERE singleton=1')
      .get() as { snapshot_json: string } | undefined;
    return row ? JSON.parse(row.snapshot_json) as FixedCertificateRegistrySnapshot : null;
  }
}
