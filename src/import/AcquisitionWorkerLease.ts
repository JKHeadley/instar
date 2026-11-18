import { privateAcquisitionDatabasePath } from './privateImportState.js';
import Database from 'better-sqlite3';
import { registerSqliteHandle } from '../core/SqliteRegistry.js';

/** OS-backed lease on a separate DB: it covers archive I/O and recovers automatically on process death. */
export class AcquisitionWorkerLease {
  private readonly db: Database.Database;
  private readonly unregister: () => void;
  constructor(stateDir: string) {
    this.db = new Database(privateAcquisitionDatabasePath(stateDir, 'worker-lock.sqlite')); /* state-registry: history-acquisition-local */
    try {
      this.db.pragma('busy_timeout = 0');
      this.db.exec('BEGIN IMMEDIATE');
    } catch (error) {
      this.db.close();
      throw error;
    }
    this.unregister = registerSqliteHandle(() => this.db.close());
  }
  close(): void { this.unregister(); if (this.db.open) this.db.close(); }
}
