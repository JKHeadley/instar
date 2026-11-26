/** Content-only bounds for the fixed local-source claim transaction. This is
 * not owner authority, consent, a disk reservation or filesystem-block accounting.
 * Audited better-sqlite3 12.8.0 / SQLite3.51.3 pager evidence is in the component doc. */
import fs from 'node:fs';
import type Database from 'better-sqlite3';

const AUDITED_SQLITE = '3.51.3';
const MAX_SECTOR_BYTES = 65_536; // Audited pager MAX_SECTOR_SIZE clamp, not an estimate.
const SCHEMA_HEADROOM_PAGES = 8; // Initial resource estimate; the native page cap is authoritative.
export interface LocalHistoryClaimBudget {
  readonly pageSize: number;
  readonly maxPageCount: number;
  readonly initialBytes: number;
  readonly databaseGrowthBytes: number;
  readonly journalBytes: number;
  readonly contentBytes: number;
}
function policy(): never { throw new Error('local-source-budget-policy'); }
function integer(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return policy();
  return value;
}

/** Inspect before ANY SQLite open: WAL headers can create sidecars during open. */
export function inspectLocalClaimBudgetSource(file: string): number {
  for (const suffix of ['-journal', '-wal', '-shm']) {
    try { fs.lstatSync(file + suffix); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    throw new Error('local-source-budget-recovery-required');
  }
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || !process.getuid || stat.uid !== process.getuid()
      || (stat.mode & 0o077) !== 0 || !Number.isSafeInteger(stat.size)) return policy();
    if (!stat.size) return 0;
    const header = Buffer.alloc(100);
    if (fs.readSync(fd, header, 0, header.length, 0) !== header.length
      || header.subarray(0, 16).toString('binary') !== 'SQLite format 3\0') return policy();
    if (header[18] === 2 || header[19] === 2) throw new Error('local-source-budget-recovery-required');
    if (header[18] !== 1 || header[19] !== 1) return policy();
    const encoded = header.readUInt16BE(16), pageSize = encoded === 1 ? 65_536 : encoded;
    if (pageSize < 512 || pageSize > 65_536 || (pageSize & (pageSize - 1)) !== 0 || stat.size % pageSize !== 0) return policy();
    const after = fs.fstatSync(fd);
    if (after.dev !== stat.dev || after.ino !== stat.ino || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) return policy();
    return stat.size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw error;
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}

function auditedConnection(db: Database.Database, memory: boolean): void {
  if ((db.prepare('SELECT sqlite_version() AS version').get() as {version: string}).version !== AUDITED_SQLITE) return policy();
  const mode = db.pragma('journal_mode', { simple: true });
  if (mode !== 'delete' && !(memory && db.name === ':memory:' && mode === 'memory')) return policy();
  if (db.pragma('auto_vacuum', { simple: true }) !== 0) return policy();
  const databases = db.pragma('database_list') as Array<{name: string; file: string}>;
  if (databases.some(row => row.name !== 'main' && !(row.name === 'temp' && row.file === ''))) return policy();
}

export function planLocalClaimBudget(db: Database.Database, initialBytes: number, rowBytes: number, pageAllowance?: number): LocalHistoryClaimBudget {
  auditedConnection(db, true);
  const pageSize = integer(db.pragma('page_size', { simple: true })), pages = integer(db.pragma('page_count', { simple: true }));
  integer(initialBytes); integer(rowBytes);
  if (pageSize < 512 || pageSize > 65_536 || (pageSize & (pageSize - 1)) !== 0 || pages * pageSize !== initialBytes) return policy();
  const maxPageCount = integer(pageAllowance ?? pages + Math.ceil(rowBytes / pageSize) + SCHEMA_HEADROOM_PAGES);
  if (maxPageCount < Math.max(1, pages)) return policy();
  const maximum = integer(maxPageCount * pageSize), databaseGrowthBytes = integer(maximum - initialBytes);
  const journalBytes = integer(maxPageCount * (pageSize + 8) + 2 * MAX_SECTOR_BYTES);
  const contentBytes = integer(databaseGrowthBytes + journalBytes);
  return Object.freeze({ pageSize, maxPageCount, initialBytes, databaseGrowthBytes, journalBytes, contentBytes });
}

/** Run before schema creation or INSERT, on the fixed default Unix-VFS connection.
 * No extensions, file-control changes, ATTACH, savepoints or arbitrary SQL are used. */
export function enforceLocalClaimBudget(db: Database.Database, budget: LocalHistoryClaimBudget): void {
  auditedConnection(db, false);
  if (db.pragma('page_size', { simple: true }) !== budget.pageSize) return policy();
  db.pragma('cache_spill = OFF'); db.pragma('temp_store = MEMORY'); db.pragma('synchronous = FULL');
  if (db.pragma('cache_spill', { simple: true }) !== 0 || db.pragma('temp_store', { simple: true }) !== 2
    || db.pragma('synchronous', { simple: true }) !== 2) return policy();
  const effective = integer(db.pragma('max_page_count = ' + budget.maxPageCount, { simple: true }));
  if (!effective || effective > budget.maxPageCount || effective < integer(db.pragma('page_count', { simple: true }))) return policy();
}
