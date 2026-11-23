/** One process-held exchange slot per private state directory. Acquire before
 * allocating a private request or response. The callback owns transport abort,
 * buffer clearing and response disposal, and must await all of them before it
 * resolves. This slot never grants owner permission, upload or mutation rights.
 * It is independent of the combined child slot and durable disk reservations.
 */
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { registerSqliteHandle } from '../core/SqliteRegistry.js';
import { privateImportDatabasePath, verifyPrivateImportDirectory } from './privateImportState.js';

export type LocalHistoryExchangeResult<T> = { accepted: false } | { accepted: true; value: T };

export function localHistoryUploadDirectory(stateDir: string): string {
  if (process.platform === 'win32' || !process.getuid) throw new Error('local-history-private-storage-unavailable');
  const directory = path.resolve(stateDir, 'local-history-upload');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  verifyPrivateImportDirectory(directory);
  return directory;
}

/** The OS releases the exchange lock after process death: that process can no
 * longer own request/response buffers. No TTL or "parent looks idle" reclaim
 * is used. Parser/apply children must hold their separate durable admission.
 */
export async function withLocalHistoryExchange<T>(
  stateDir: string,
  untilDisposed: () => Promise<T>,
): Promise<LocalHistoryExchangeResult<T>> {
  const directory = localHistoryUploadDirectory(stateDir);
  const db = new Database(privateImportDatabasePath(directory, 'exchange-lock.sqlite'), { timeout: 0 }); /* state-registry: local-history-upload-local */
  let unregister: (() => void) | undefined;
  try {
    try { db.exec('BEGIN IMMEDIATE'); }
    catch (err) {
      if (['SQLITE_BUSY', 'SQLITE_LOCKED'].includes((err as { code?: string }).code ?? '')) return { accepted: false };
      throw err;
    }
    unregister = registerSqliteHandle(() => db.close());
    return { accepted: true, value: await untilDisposed() };
  } finally {
    unregister?.();
    if (db.open) db.close();
  }
}
