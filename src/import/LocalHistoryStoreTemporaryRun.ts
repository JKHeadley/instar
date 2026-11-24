/** Durable ownership of store publication temporaries. This is neither copy
 * consent nor a disk reservation. The caller owns current owner admission,
 * mutation permits, metadata reservation and physical/content accounting.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ChildProcess } from 'node:child_process';
import Database from 'better-sqlite3';
import { SafeFsExecutor } from '../core/SafeFsExecutor.js';
import { CHUNK_BYTES } from '../core/appMediaTypes.js';
import { acquireLocalHistoryChild, holdLocalHistoryChild, type LocalHistoryChildAdmission, type LocalHistoryCustodyHolder } from './LocalHistoryChildCustody.js';
import { privateImportDatabasePath, verifyPrivateImportDirectory } from './privateImportState.js';

const TABLE = 'local_history_store_temporary_runs';
const MAX_RUNS = 1024;
const TEMP_ROOT = '.local-history-temporary';
const WRITABLE_PHASES = new Set(['prepared', 'ready', 'applying']);
type RunState = 'registered' | 'active' | 'cleanup-pending' | 'disposed';
interface RunRow {
  runId: string; operationId: string; tag: string; generation: string; actorNonce: string;
  storeDev: number; storeIno: number; directoryDev: number; directoryIno: number;
  childPid: number | null; created: number; state: RunState;
}
interface Operation { id: string; tag: string; phase: string; deadline: number }
interface AdmissionBrand { stateDir: string; generation: string; active: boolean }
const admissions = new WeakMap<LocalHistoryChildAdmission, AdmissionBrand>();
const allocatorBrands = new WeakMap<LocalHistoryStoreTemporaryAllocator, { stateDir: string; active(): void }>();
// Successful child ownership lasts through OS process exit, even if a caller
// closes its allocator and then lingers. A one-shot worker has a finite bound.
const processHolders = new Map<string, LocalHistoryCustodyHolder>();
const MAX_PROCESS_RUNS = 4;

export class LocalHistoryStoreTemporaryRefused extends Error {
  constructor(readonly reason: 'invalid' | 'unavailable' | 'busy' | 'capacity' | 'child-alive' | 'cleanup-pending') {
    super('local-history-store-temporary-' + reason);
  }
}
function refuse(reason: LocalHistoryStoreTemporaryRefused['reason']): never { throw new LocalHistoryStoreTemporaryRefused(reason); }
const hex = (value: unknown, length: number): value is string => typeof value === 'string' && value.length === length && /^[a-f0-9]+$/.test(value);
const number = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

/** The brand records an actual successful exclusive custody takeover, never a
 * caller generation/PID assertion. Durable namespace identity lives in SQLite,
 * not in this process-local capability map. */
export function acquireLocalHistoryStoreTemporaryAdmission(stateDir: string): LocalHistoryChildAdmission | null {
  const actual = acquireLocalHistoryChild(stateDir);
  if (!actual) return null;
  const brand = { stateDir: path.resolve(actual.custody.stateDir), generation: actual.custody.generation, active: true };
  const wrapped: LocalHistoryChildAdmission = {
    custody: actual.custody,
    registerChild: pid => actual.registerChild(pid),
    release() { brand.active = false; actual.release(); },
  };
  admissions.set(wrapped, brand);
  return Object.freeze(wrapped);
}
function admission(value: LocalHistoryChildAdmission): AdmissionBrand {
  const brand = admissions.get(value);
  if (!brand?.active) refuse('invalid');
  return brand;
}
function jobsPath(stateDir: string): string {
  return privateImportDatabasePath(path.resolve(stateDir, 'local-history-upload'), 'jobs.sqlite', { readOnly: true });
}
function parentDatabase(db: Database.Database, stateDir?: string): string {
  if (!(db instanceof Database) || !db.open || db.readonly || db.inTransaction) refuse('invalid');
  const name = path.resolve(db.name);
  const inferred = path.dirname(path.dirname(name));
  if (path.basename(name) !== 'jobs.sqlite' || path.basename(path.dirname(name)) !== 'local-history-upload'
    || (stateDir !== undefined && path.resolve(stateDir) !== inferred) || jobsPath(inferred) !== name
    || db.pragma('journal_mode', { simple: true }) !== 'delete') refuse('invalid');
  return inferred;
}
function generation(stateDir: string): string {
  const directory = path.resolve(stateDir, 'local-history-upload');
  const file = privateImportDatabasePath(directory, 'child-custody.sqlite', { readOnly: true });
  const db = new Database(file, { readonly: true, fileMustExist: true, timeout: 0 }); /* state-registry: local-history-upload-local */
  try {
    db.pragma('query_only = ON');
    if (db.pragma('journal_mode', { simple: true }) !== 'delete') refuse('unavailable');
    const row = db.prepare('SELECT generation FROM custody WHERE id = 1').get() as {generation: string} | undefined;
    if (!row || !hex(row.generation, 64)) refuse('unavailable');
    return row.generation;
  } finally { db.close(); }
}
function current(value: LocalHistoryChildAdmission): AdmissionBrand {
  const brand = admission(value);
  if (generation(brand.stateDir) !== brand.generation) refuse('unavailable');
  return brand;
}
function transaction<T>(db: Database.Database, work: () => T): T {
  try {
    db.exec('BEGIN IMMEDIATE');
    try { const value = work(); db.exec('COMMIT'); return value; }
    catch (error) { if (db.inTransaction) db.exec('ROLLBACK'); throw error; }
  } catch (error) {
    if (error instanceof LocalHistoryStoreTemporaryRefused) throw error;
    if (['SQLITE_BUSY', 'SQLITE_LOCKED'].includes((error as {code?: string}).code ?? '')) refuse('busy');
    return refuse('unavailable');
  }
}

/** Derive the ledger tag from the live, branded parent admission. */
export function localHistoryCopyRunTag(lease: LocalHistoryChildAdmission, stateDir: string, operationId: string): string {
  const brand = current(lease);
  if (brand.stateDir !== path.resolve(stateDir) || !hex(operationId, 32)) refuse('invalid');
  return 'r-' + brand.generation + '-' + operationId;
}

/** Called by the real staging constructor on its actual jobs connection. */
export function initializeLocalHistoryStoreTemporaryRuns(db: Database.Database): void {
  parentDatabase(db);
  db.exec(`CREATE TABLE IF NOT EXISTS ${TABLE} (
    runId TEXT PRIMARY KEY NOT NULL CHECK(length(runId) = 32 AND runId NOT GLOB '*[^0-9a-f]*'),
    operationId TEXT NOT NULL CHECK(length(operationId) = 32 AND operationId NOT GLOB '*[^0-9a-f]*'),
    tag TEXT NOT NULL,
    generation TEXT NOT NULL CHECK(length(generation) = 64 AND generation NOT GLOB '*[^0-9a-f]*'),
    actorNonce TEXT NOT NULL CHECK(length(actorNonce) = 64 AND actorNonce NOT GLOB '*[^0-9a-f]*'),
    storeDev INTEGER NOT NULL CHECK(storeDev >= 0), storeIno INTEGER NOT NULL CHECK(storeIno >= 0),
    directoryDev INTEGER NOT NULL CHECK(directoryDev >= 0), directoryIno INTEGER NOT NULL CHECK(directoryIno >= 0),
    childPid INTEGER CHECK(childPid IS NULL OR childPid > 0),
    created INTEGER NOT NULL CHECK(created >= 0),
    state TEXT NOT NULL CHECK(state IN ('registered','active','cleanup-pending','disposed')),
    CHECK(tag = 'r-' || generation || '-' || operationId)
  ) STRICT`);
  validateTemporaryRunSchema(db);
}
function validateTemporaryRunSchema(db: Database.Database): void {
  const columns = db.prepare(`PRAGMA table_info(${TABLE})`).all() as Array<{name: string; type: string; pk: number; notnull: number; dflt_value: unknown}>;
  const expected = ['runId','operationId','tag','generation','actorNonce','storeDev','storeIno','directoryDev','directoryIno','childPid','created','state'];
  const table = db.prepare('SELECT strict FROM pragma_table_list WHERE name = ?').get(TABLE) as {strict: number} | undefined;
  if (columns.length !== expected.length || columns.some((column, index) => column.name !== expected[index]
    || column.pk !== (index === 0 ? 1 : 0) || column.notnull !== (column.name === 'childPid' ? 0 : 1) || column.dflt_value !== null
    || column.type !== (['storeDev','storeIno','directoryDev','directoryIno','childPid','created'].includes(column.name) ? 'INTEGER' : 'TEXT'))
    || table?.strict !== 1) refuse('unavailable');
}
function existingTemporaryRunRegistry(db: Database.Database): boolean {
  const entry = db.prepare('SELECT type FROM sqlite_schema WHERE name = ?').get(TABLE) as { type: string } | undefined;
  if (!entry) return false;
  if (entry.type !== 'table') refuse('unavailable');
  validateTemporaryRunSchema(db);
  return true;
}

export function validateLocalHistoryTemporaryRunInventory(db: Database.Database): void {
  parentDatabase(db);
  if (!existingTemporaryRunRegistry(db)) return;
  const selected = db.prepare(`SELECT runId FROM ${TABLE} LIMIT ?`).all(MAX_RUNS + 1) as Array<{ runId: string }>;
  if (selected.length > MAX_RUNS) refuse('capacity');
  for (const entry of selected) row(db, entry.runId);
}

/** The ledger retains a tag while any typed namespace remains unresolved. */
export function hasUnsettledLocalHistoryTemporaryRun(db: Database.Database, tag: string): boolean {
  const stateDir = parentDatabase(db);
  if (!existingTemporaryRunRegistry(db)) return false;
  const selected = db.prepare(`SELECT runId FROM ${TABLE} WHERE tag = ? LIMIT ?`).all(tag, MAX_RUNS + 1) as Array<{ runId: string }>;
  if (selected.length > MAX_RUNS) refuse('capacity');
  return selected.some(entry => {
    const value = row(db, entry.runId);
    if (value.tag !== tag) refuse('unavailable');
    if (value.state !== 'disposed') return true;
    return !temporaryNamespaceIsAbsent(stateDir, value);
  });
}

function operation(db: Database.Database, operationId: string, expectedTag?: string, writable = true): Operation {
  if (!hex(operationId, 32)) refuse('invalid');
  const row = db.prepare('SELECT id,tag,phase,deadline FROM upload_operations WHERE id = ?').get(operationId) as Operation | undefined;
  if (!row || row.id !== operationId || typeof row.tag !== 'string' || !/^r-[a-f0-9]{64}-[a-f0-9]{32}$/.test(row.tag)
    || !row.tag.endsWith('-' + operationId) || (expectedTag !== undefined && row.tag !== expectedTag)
    || typeof row.phase !== 'string' || !number(row.deadline)) refuse('unavailable');
  if (writable && (!WRITABLE_PHASES.has(row.phase) || Date.now() >= row.deadline)) refuse('unavailable');
  return row;
}
function row(db: Database.Database, runId: string): RunRow {
  if (!hex(runId, 32)) refuse('invalid');
  const value = db.prepare(`SELECT * FROM ${TABLE} WHERE runId = ?`).get(runId) as RunRow | undefined;
  if (!value || !hex(value.operationId, 32) || !hex(value.generation, 64) || !hex(value.actorNonce, 64)
    || value.tag !== 'r-' + value.generation + '-' + value.operationId
    || !['storeDev','storeIno','directoryDev','directoryIno','created'].every(name => number(value[name as keyof RunRow]))
    || !(value.childPid === null || (number(value.childPid) && value.childPid > 0))
    || !['registered','active','cleanup-pending','disposed'].includes(value.state)) refuse('unavailable');
  return value;
}
function privateDirectory(file: string): fs.Stats {
  verifyPrivateImportDirectory(file);
  const info = fs.lstatSync(file);
  if (!number(info.dev) || !number(info.ino)) refuse('unavailable');
  return info;
}
function paths(stateDir: string, runId: string) {
  const store = path.resolve(stateDir, 'imported-history');
  const root = path.join(store, TEMP_ROOT);
  return { store, root, directory: path.join(root, runId) };
}
function checkDirectory(stateDir: string, value: RunRow, pinnedRoot?: fs.Stats): ReturnType<typeof paths> {
  const names = paths(stateDir, value.runId);
  const store = privateDirectory(names.store), root = privateDirectory(names.root), directory = privateDirectory(names.directory);
  if (store.dev !== value.storeDev || store.ino !== value.storeIno || root.dev !== store.dev
    || (pinnedRoot && (pinnedRoot.dev !== root.dev || pinnedRoot.ino !== root.ino))
    || directory.dev !== value.directoryDev || directory.ino !== value.directoryIno || directory.dev !== store.dev) refuse('unavailable');
  return names;
}
function temporaryNamespaceIsAbsent(stateDir: string, value: RunRow, pinnedRoot?: fs.Stats): boolean {
  const names = paths(stateDir, value.runId);
  const checkRoot = () => {
    const store = privateDirectory(names.store), root = privateDirectory(names.root);
    if (store.dev !== value.storeDev || store.ino !== value.storeIno || root.dev !== store.dev) refuse('unavailable');
    return root;
  };
  const before = checkRoot();
  if (pinnedRoot && (pinnedRoot.dev !== before.dev || pinnedRoot.ino !== before.ino)) refuse('unavailable');
  try { fs.lstatSync(names.directory); return false; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const after = checkRoot();
  if (after.dev !== before.dev || after.ino !== before.ino) refuse('unavailable');
  return true;
}

function boundedNames(directory: string): string[] {
  const opened = fs.opendirSync(directory), names: string[] = [];
  try {
    let entry: fs.Dirent | null;
    while ((entry = opened.readSync()) !== null) {
      if (names.length >= MAX_RUNS) refuse('capacity');
      names.push(entry.name);
    }
    return names;
  } finally { opened.closeSync(); }
}
export interface LocalHistoryStoreTemporaryToken {
  readonly stateDir: string; readonly runId: string; readonly operationId: string;
  readonly generation: string; readonly actorNonce: string;
}
export interface LocalHistoryStoreTemporaryParentRun {
  readonly runId: string;
  registerChild(child: ChildProcess): Promise<Readonly<LocalHistoryStoreTemporaryToken>>;
  cleanupAfterChild(): void;
}

export function registerLocalHistoryStoreTemporaryRun(db: Database.Database, lease: LocalHistoryChildAdmission,
  selected: { operationId: string }): LocalHistoryStoreTemporaryParentRun {
  const brand = current(lease), stateDir = parentDatabase(db, brand.stateDir);
  const operationId = selected?.operationId;
  if (!hex(operationId, 32)) refuse('invalid');
  const runId = crypto.randomBytes(16).toString('hex'), actorNonce = crypto.randomBytes(32).toString('hex');
  transaction(db, () => {
    const count = (db.prepare(`SELECT COUNT(*) AS count FROM ${TABLE}`).get() as {count: number}).count;
    if (!number(count) || count >= MAX_RUNS) refuse('capacity');
    const actual = operation(db, operationId, 'r-' + brand.generation + '-' + operationId);
    const names = paths(stateDir, runId);
    fs.mkdirSync(names.store, { recursive: true, mode: 0o700 });
    const store = privateDirectory(names.store);
    try { fs.mkdirSync(names.root, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    if (privateDirectory(names.root).dev !== store.dev) refuse('unavailable');
    if (boundedNames(names.root).length >= MAX_RUNS) refuse('capacity');
    fs.mkdirSync(names.directory, { mode: 0o700 });
    const directory = privateDirectory(names.directory);
    if (directory.dev !== store.dev) refuse('unavailable');
    const fd = fs.openSync(names.root, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    // Only an empty directory exists until this trusted row is durable. A crash
    // before commit cannot leave private payload from an unregistered allocator.
    db.prepare(`INSERT INTO ${TABLE}(runId,operationId,tag,generation,actorNonce,storeDev,storeIno,directoryDev,directoryIno,childPid,created,state)
      VALUES(?,?,?,?,?,?,?,?,?,NULL,?,'registered')`).run(runId, actual.id, actual.tag, brand.generation, actorNonce,
        store.dev, store.ino, directory.dev, directory.ino, Date.now());
  });
  let bound: ChildProcess | undefined, exited = false, closed = false;
  return {
    runId,
    async registerChild(child) {
      current(lease); parentDatabase(db, stateDir);
      if (bound || !(child instanceof ChildProcess) || !number(child.pid) || child.pid <= 0
        || typeof child.spawnfile !== 'string' || !child.spawnfile || child.exitCode !== null || child.signalCode !== null) refuse('invalid');
      bound = child;
      child.once('exit', () => { exited = true; });
      child.once('close', () => { closed = true; });
      await lease.registerChild(child.pid);
      current(lease);
      transaction(db, () => {
        const value = row(db, runId);
        if (value.state !== 'registered' || value.childPid !== null || exited || closed
          || value.generation !== brand.generation || value.actorNonce !== actorNonce || value.operationId !== operationId) refuse('invalid');
        operation(db, value.operationId, value.tag); checkDirectory(stateDir, value);
        db.prepare(`UPDATE ${TABLE} SET childPid = ?, state = 'active' WHERE runId = ?`).run(child.pid, runId);
      });
      return Object.freeze({ stateDir, runId, operationId, generation: brand.generation, actorNonce });
    },
    cleanupAfterChild() {
      current(lease); parentDatabase(db, stateDir);
      if (!bound || !closed) refuse('child-alive');
      const value = row(db, runId);
      if (value.generation !== brand.generation || value.actorNonce !== actorNonce || value.operationId !== operationId
        || (value.childPid !== bound.pid && !(value.state === 'registered' && value.childPid === null))) refuse('invalid');
      cleanup(db, stateDir, value);
    },
  };
}
function cleanup(db: Database.Database, stateDir: string, value: RunRow): void {
  if (value.state === 'disposed') return;
  operation(db, value.operationId, value.tag, false);
  try {
    const names = checkDirectory(stateDir, value), files = boundedNames(names.directory);
    // Validate the whole flat namespace before removing anything. A subdirectory
    // or symlink is preserved as unknown residue; no recursive deletion exists.
    for (const name of files) {
      const info = fs.lstatSync(path.join(names.directory, name));
      if (!info.isFile() || info.dev !== value.directoryDev || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) refuse('cleanup-pending');
    }
    db.prepare(`UPDATE ${TABLE} SET state = 'cleanup-pending' WHERE runId = ?`).run(value.runId);
    for (const name of files) {
      checkDirectory(stateDir, value);
      // Unlink only this registered temporary name. Published hardlinks outside
      // this directory are deliberately neither traversed nor removed.
      SafeFsExecutor.safeUnlinkSync(path.join(names.directory, name), { operation: 'dispose registered local-history store temporary name' });
    }
    const beforeRemoval = privateDirectory(names.root);
    const rootFd = fs.openSync(names.root, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    try {
      const pinned = fs.fstatSync(rootFd);
      if (!pinned.isDirectory() || pinned.dev !== beforeRemoval.dev || pinned.ino !== beforeRemoval.ino) refuse('cleanup-pending');
      checkDirectory(stateDir, value, pinned);
      SafeFsExecutor.safeRmdirSync(names.directory, { operation: 'dispose registered local-history store temporary namespace' });
      fs.fsyncSync(rootFd);
      if (!temporaryNamespaceIsAbsent(stateDir, value, pinned)) refuse('cleanup-pending');
    } finally { fs.closeSync(rootFd); }
    db.prepare(`UPDATE ${TABLE} SET state = 'disposed' WHERE runId = ?`).run(value.runId);
  } catch {
    try { db.prepare(`UPDATE ${TABLE} SET state = 'cleanup-pending' WHERE runId = ?`).run(value.runId); } catch { /* durable non-disposed record remains charged by caller */ }
    refuse('cleanup-pending');
  }
}

/** Only a real exclusive takeover produced by the wrapper can retire old-G
 * namespaces. Current-G entries require their registered ChildProcess proof. */
export function recoverLocalHistoryStoreTemporaryRuns(db: Database.Database, lease: LocalHistoryChildAdmission): { disposed: number; pending: number } {
  const brand = current(lease), stateDir = parentDatabase(db, brand.stateDir);
  const rows = db.prepare(`SELECT runId FROM ${TABLE} LIMIT ?`).all(MAX_RUNS + 1) as {runId: string}[];
  if (rows.length > MAX_RUNS) refuse('capacity');
  let disposed = 0, pending = 0;
  for (const selected of rows) {
    const value = row(db, selected.runId);
    if (value.generation === brand.generation || value.state === 'disposed') continue;
    try { cleanup(db, stateDir, value); disposed++; } catch { pending++; }
  }
  return { disposed, pending };
}

export interface LocalHistoryStoreTemporaryAllocation {
  readonly temporaryArtifact: string;
  write(data: Buffer | string): void;
  publish(): void;
  close(): void;
}
export interface LocalHistoryStoreTemporaryAllocator {
  allocate(destination: string, publication: 'replace' | 'first'): LocalHistoryStoreTemporaryAllocation;
  close(): void;
}
/** A planned store must receive the real active child allocator for its exact
 * state directory. A structural lookalike or closed allocator is not a permit. */
export function assertLocalHistoryStoreTemporaryAllocator(value: unknown, expectedStateDir?: string): asserts value is LocalHistoryStoreTemporaryAllocator {
  if (!value || typeof value !== 'object') refuse('invalid');
  const brand = allocatorBrands.get(value as LocalHistoryStoreTemporaryAllocator);
  if (!brand || (expectedStateDir !== undefined && path.resolve(expectedStateDir) !== brand.stateDir)) refuse('invalid');
  brand.active();
}
function readableJobs(stateDir: string): Database.Database {
  const file = jobsPath(stateDir), header = Buffer.alloc(20);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    if (fs.readSync(fd, header, 0, header.length, 0) !== header.length || header.toString('ascii', 0, 16) !== 'SQLite format 3\0'
      || header[18] !== 1 || header[19] !== 1) refuse('unavailable');
  } finally { fs.closeSync(fd); }
  // Do not invite read-only SQLite to recover a hot journal or create WAL
  // metadata. A concurrently journalled parent update is simply unavailable.
  try { if (fs.lstatSync(file + '-journal').size !== 0) refuse('busy'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const db = new Database(file, { readonly: true, fileMustExist: true, timeout: 0 }); /* state-registry: local-history-upload-local */
  try { db.pragma('query_only = ON'); if (db.pragma('journal_mode', { simple: true }) !== 'delete') refuse('unavailable'); return db; }
  catch (error) { db.close(); throw error; }
}

/** Token fields only select an already trusted typed row. Actual process.pid,
 * current custody, live operation and exact nonce/inode must all agree. */
export function openLocalHistoryStoreTemporaryRun(input: LocalHistoryStoreTemporaryToken): LocalHistoryStoreTemporaryAllocator {
  if (!input || typeof input.stateDir !== 'string' || !hex(input.runId, 32) || !hex(input.operationId, 32)
    || !hex(input.generation, 64) || !hex(input.actorNonce, 64)) refuse('invalid');
  const token = Object.freeze({ stateDir: path.resolve(input.stateDir), runId: input.runId, operationId: input.operationId,
    generation: input.generation, actorNonce: input.actorNonce });
  const holderKey = token.stateDir + ':' + token.generation + ':' + token.runId;
  if (processHolders.size >= MAX_PROCESS_RUNS || processHolders.has(holderKey)) refuse('busy');
  const holder = holdLocalHistoryChild({ stateDir: token.stateDir, generation: token.generation });
  let db: Database.Database;
  try { db = readableJobs(token.stateDir); } catch (error) { holder.close(); throw error; }
  let closed = false;
  const allocations = new Set<LocalHistoryStoreTemporaryAllocation>();
  const active = (): RunRow => {
    try {
      if (closed || !db.open || !holder.active()) refuse('unavailable');
      const value = row(db, token.runId);
      if (value.state !== 'active' || value.operationId !== token.operationId || value.generation !== token.generation
        || value.actorNonce !== token.actorNonce || value.childPid !== process.pid) refuse('unavailable');
      operation(db, value.operationId, value.tag); checkDirectory(token.stateDir, value);
      return value;
    } catch (error) {
      if (error instanceof LocalHistoryStoreTemporaryRefused) throw error;
      if (['SQLITE_BUSY', 'SQLITE_LOCKED'].includes((error as {code?: string}).code ?? '')) refuse('busy');
      return refuse('unavailable');
    }
  };
  try { active(); } catch (error) { db.close(); holder.close(); throw error; }
  processHolders.set(holderKey, holder);
  const allocator: LocalHistoryStoreTemporaryAllocator = {
    allocate(destination, publication) {
      const value = active(), names = checkDirectory(token.stateDir, value);
      if (allocations.size >= 8) refuse('busy');
      if (boundedNames(names.directory).length >= MAX_RUNS) refuse('capacity');
      const target = path.resolve(destination);
      const attachment = path.dirname(target) === path.join(names.store, 'attachments') && path.basename(target).length === 36
        && /^[a-f0-9]{32}\.txt$/.test(path.basename(target));
      const manifest = target === path.join(names.store, 'manifest.json');
      if ((publication === 'replace' && !manifest) || (publication === 'first' && !attachment)
        || !['replace', 'first'].includes(publication)) refuse('invalid');
      if (privateDirectory(path.dirname(target)).dev !== value.directoryDev) refuse('unavailable');
      const temp = path.join(names.directory, crypto.randomBytes(16).toString('hex') + '.tmp');
      let fd: number | undefined = fs.openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
      let initial: fs.Stats;
      try {
        initial = fs.fstatSync(fd);
        if (!initial.isFile() || initial.dev !== value.directoryDev || initial.uid !== process.getuid?.() || initial.nlink !== 1 || (initial.mode & 0o077) !== 0) refuse('unavailable');
      } catch { try { fs.closeSync(fd); } catch { /* process-lifetime custody remains held */ } return refuse('unavailable'); }
      let published = false;
      const check = () => {
        active();
        const info = fd === undefined ? fs.lstatSync(temp) : fs.fstatSync(fd);
        if (!info.isFile() || info.dev !== initial.dev || info.ino !== initial.ino || info.uid !== initial.uid || (info.mode & 0o077) !== 0) refuse('unavailable');
      };
      const close = () => { if (fd !== undefined) { const owned = fd; fd = undefined; fs.closeSync(owned); } };
      const allocation: LocalHistoryStoreTemporaryAllocation = {
        temporaryArtifact: token.runId + '/' + path.basename(temp),
        write(data) {
          if (published || fd === undefined || !(typeof data === 'string' || Buffer.isBuffer(data))) refuse('invalid');
          const bytes = typeof data === 'string' ? Buffer.from(data) : data;
          try {
            for (let start = 0; start < bytes.length; start += CHUNK_BYTES) {
              check();
              const end = Math.min(start + CHUNK_BYTES, bytes.length);
              let offset = start;
              while (offset < end) {
                const wrote = fs.writeSync(fd, bytes, offset, end - offset);
                if (wrote <= 0) refuse('unavailable');
                offset += wrote;
              }
              check();
            }
          } finally { if (typeof data === 'string') bytes.fill(0); }
        },
        publish() {
          if (published || fd === undefined) refuse('invalid');
          check(); fs.fsyncSync(fd); close(); check();
          if (privateDirectory(path.dirname(target)).dev !== value.directoryDev) refuse('unavailable');
          try {
            const existing = fs.lstatSync(target);
            if (!existing.isFile() || existing.dev !== value.directoryDev || existing.uid !== process.getuid?.()
              || (existing.mode & 0o077) !== 0 || existing.nlink !== 1) refuse('unavailable');
          } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
          if (publication === 'replace') fs.renameSync(temp, target);
          else {
            fs.linkSync(temp, target);
            try { SafeFsExecutor.safeUnlinkSync(temp, { operation: 'retire published local-history attachment temporary name' }); }
            catch { refuse('cleanup-pending'); }
          }
          published = true;
        },
        close() { close(); allocations.delete(allocation); },
      };
      allocations.add(allocation);
      return allocation;
    },
    close() {
      if (closed) return;
      closed = true;
      let failed = false;
      for (const allocation of [...allocations]) { try { allocation.close(); } catch { failed = true; } }
      try { db.close(); } catch { failed = true; }
      // No holder.close(): processHolders keeps the actual shared lock until
      // this worker really exits. The OS is the final liveness authority.
      if (failed) refuse('unavailable');
    },
  };
  allocatorBrands.set(allocator, { stateDir: token.stateDir, active: () => { active(); } });
  return allocator;
}
