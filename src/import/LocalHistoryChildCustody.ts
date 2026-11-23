/** Combined preparation/apply/read admission. The parent owns a serial admission
 * transaction; parent and every admitted child hold shared SQLite read locks on
 * the current generation. Parent death cannot release a surviving child's lock.
 * A replacement needs EXCLUSIVE custody before changing generation, which also
 * invalidates any old child that starts late. No PID or elapsed-time reclaim.
 * This is resource custody, never authorization to read or mutate history.
 */
import crypto from 'node:crypto';
import path from 'node:path';
import Database from 'better-sqlite3';
import { registerSqliteHandle } from '../core/SqliteRegistry.js';
import { localHistoryUploadDirectory } from './LocalHistoryExchange.js';
import { privateImportDatabasePath, verifyPrivateImportDirectory } from './privateImportState.js';

export interface LocalHistoryCustodyToken { readonly stateDir: string; readonly generation: string }
export interface LocalHistoryCustodyHolder { active(): boolean; close(): void }
export interface LocalHistoryChildAdmission {
  readonly custody: LocalHistoryCustodyToken;
  registerChild(pid: number): Promise<void>;
  release(): void;
}
const busy = (error: unknown) => ['SQLITE_BUSY', 'SQLITE_LOCKED'].includes((error as {code?: string}).code ?? '');

/** Child must hold this BEFORE acknowledging readiness or receiving private
 * input/permits. Keep the returned holder alive until actual process exit.
 * Token fields originate only in the already-admitted parent, not an HTTP body.
 */
export function holdLocalHistoryChild(token: LocalHistoryCustodyToken): LocalHistoryCustodyHolder {
  if (!token || typeof token.stateDir !== 'string' || !token.stateDir
    || typeof token.generation !== 'string' || !/^[a-f0-9]{64}$/.test(token.generation)) throw new Error('local-history-custody-invalid');
  // Do not create/chmod a disappeared or unsafe directory during child startup.
  const directory = localHistoryUploadDirectoryForRead(token.stateDir);
  const db = new Database(privateImportDatabasePath(directory, 'child-custody.sqlite', { readOnly: true }),
    { readonly: true, fileMustExist: true, timeout: 0 }); /* state-registry: local-history-upload-local */
  let unregister: (() => void) | undefined;
  try {
    db.exec('BEGIN');
    const row = db.prepare("SELECT generation FROM custody WHERE id = 1 AND typeof(generation) = 'text' AND octet_length(generation) = 64").get() as {generation: string} | undefined;
    if (row?.generation !== token.generation) throw new Error('local-history-custody-stale');
    unregister = registerSqliteHandle(() => db.close());
    return {
      active: () => db.open && db.inTransaction,
      close() { unregister?.(); unregister = undefined; if (db.open) db.close(); },
    };
  } catch (error) { if (db.open) db.close(); throw error; }
}

function localHistoryUploadDirectoryForRead(stateDir: string): string {
  const directory = path.resolve(stateDir, 'local-history-upload');
  verifyPrivateImportDirectory(directory);
  return directory;
}

export function acquireLocalHistoryChild(stateDir: string): LocalHistoryChildAdmission | null {
  const directory = localHistoryUploadDirectory(stateDir);
  const admission = new Database(privateImportDatabasePath(directory, 'child-admission.sqlite'), { timeout: 0 }); /* state-registry: local-history-upload-local */
  let custody: Database.Database | undefined;
  let unregisterAdmission: (() => void) | undefined;
  let unregisterCustody: (() => void) | undefined;
  let handedOff = false;
  try {
    try { admission.exec('BEGIN IMMEDIATE'); }
    catch (error) { if (busy(error)) return null; throw error; }
    custody = new Database(privateImportDatabasePath(directory, 'child-custody.sqlite'), { timeout: 0 }); /* state-registry: local-history-upload-local */
    // Shared readers must block EXCLUSIVE. Refuse an unexpected WAL database;
    // never silently change the journal mode of a surviving child’s handle.
    if (custody.pragma('journal_mode', { simple: true }) !== 'delete') throw new Error('local-history-custody-journal-mode');
    custody.pragma('synchronous = FULL');
    try { custody.exec('BEGIN EXCLUSIVE'); }
    catch (error) { if (busy(error)) return null; throw error; }
    custody.exec('CREATE TABLE IF NOT EXISTS custody (id INTEGER PRIMARY KEY CHECK(id = 1), generation TEXT NOT NULL)');
    const generation = crypto.randomBytes(32).toString('hex');
    custody.prepare('INSERT INTO custody(id, generation) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET generation = excluded.generation').run(generation);
    custody.exec('COMMIT');
    // Admission remains held during this transition, so a second parent cannot
    // take the lane in the gap between generation publication and shared hold.
    custody.exec('BEGIN');
    custody.prepare('SELECT generation FROM custody WHERE id = 1').get();
    const held = custody;
    unregisterAdmission = registerSqliteHandle(() => admission.close());
    unregisterCustody = registerSqliteHandle(() => held.close());
    const token = Object.freeze({ stateDir: path.resolve(stateDir), generation });
    handedOff = true;
    return {
      custody: token,
      async registerChild(pid) {
        if (!admission.open || !admission.inTransaction || !held.open || !held.inTransaction
          || !Number.isSafeInteger(pid) || pid <= 0) throw new Error('local-history-custody-lost');
      },
      release() {
        unregisterCustody?.(); unregisterCustody = undefined;
        unregisterAdmission?.(); unregisterAdmission = undefined;
        if (held.open) held.close();
        if (admission.open) admission.close();
      },
    };
  } finally {
    if (!handedOff) {
      unregisterCustody?.(); unregisterAdmission?.();
      if (custody?.open) custody.close();
      if (admission.open) admission.close();
    }
  }
}
