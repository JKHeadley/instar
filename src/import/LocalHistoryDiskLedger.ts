/** Private importer allocations. Every file is generated here; no client paths,
 * borrowed descriptors or asynchronous open-file callbacks are accepted. Each
 * bounded read/write closes its descriptor under the same SQLite transaction,
 * so disposal can quiesce all these writers without PID guessing. This ledger
 * does not grant owner access, child custody, preview or copy permission.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import { registerSqliteHandle } from '../core/SqliteRegistry.js';
import { mediaDiskFloorBytes, UPLOAD_TTL_MS } from '../core/AppMediaStore.js';
import { CHUNK_BYTES } from '../core/appMediaTypes.js';
import { SafeFsExecutor } from '../core/SafeFsExecutor.js';
import type { LocalHistoryChildAdmission } from './LocalHistoryChildCustody.js';
import { localHistoryCopyRunTag } from './LocalHistoryStoreTemporaryRun.js';
import { pinLocalHistoryCopyVolume, type LocalHistoryDirectoryIdentity } from './LocalHistoryCopyVolume.js';
import { localHistoryUploadDirectory } from './LocalHistoryExchange.js';
import { privateImportDatabasePath, verifyPrivateImportDirectory } from './privateImportState.js';

const METADATA_WORK_BYTES = 64 * 1024;
const MAX_RECORDS = 1024;
const copyReservationScopes = new WeakMap<LocalHistoryChildAdmission, Set<string>>();
export interface LocalHistoryDiskMeasurement { total: number; free: number }
export interface LocalHistoryDiskAllocation {
  id: string; operation: string; planned: number; written: number;
  state: 'active' | 'sealed' | 'cleanup-pending' | 'disposed';
}
interface Row extends LocalHistoryDiskAllocation { dev: number | null; ino: number | null }
function amount(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('local-history-disk-amount');
}
function validId(id: string): void {
  if (typeof id !== 'string' || !/^[a-f0-9]{32}$/.test(id)) throw new Error('local-history-disk-allocation-unavailable');
}

export class LocalHistoryDiskLedger {
  private readonly copyVolumePins = new WeakSet<ReturnType<typeof pinLocalHistoryCopyVolume>>();
  private readonly stateDir: string;
  private readonly directory: string;
  private readonly blocks: string;
  private readonly device: number;
  private readonly directoryIdentities: ReadonlyMap<string, LocalHistoryDirectoryIdentity>;
  private readonly db: Database.Database;
  private readonly unregister: () => void;
  private readonly recordCapacity: number;
  private readonly disk: () => LocalHistoryDiskMeasurement;

  constructor(stateDir: string, options: { disk?: () => LocalHistoryDiskMeasurement; recordCapacity?: number } = {}) {
    this.recordCapacity = options.recordCapacity ?? MAX_RECORDS;
    if (!Number.isSafeInteger(this.recordCapacity) || this.recordCapacity < 1 || this.recordCapacity > MAX_RECORDS) throw new Error('local-history-disk-policy');
    this.stateDir = path.resolve(stateDir);
    this.directory = localHistoryUploadDirectory(this.stateDir);
    const uploadIdentity = fs.lstatSync(this.directory, { bigint: true });
    this.device = Number(uploadIdentity.dev);
    this.disk = options.disk ?? (() => {
      const stat = fs.statfsSync(this.directory);
      return { total: stat.blocks * stat.bsize, free: stat.bavail * stat.bsize };
    });
    this.measurement();
    this.blocks = path.join(this.directory, 'blocks');
    fs.mkdirSync(this.blocks, { mode: 0o700, recursive: true });
    verifyPrivateImportDirectory(this.blocks);
    const blockIdentity = fs.lstatSync(this.blocks, { bigint: true });
    this.directoryIdentities = new Map([
      [path.resolve(this.directory), uploadIdentity],
      [path.resolve(this.blocks), blockIdentity],
    ]);
    if (blockIdentity.dev !== uploadIdentity.dev) throw new Error('local-history-disk-volume');
    this.db = new Database(privateImportDatabasePath(this.directory, 'disk-ledger.sqlite'), { timeout: 0 }); /* state-registry: local-history-upload-local */
    try {
      const existing = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'allocations'").get();
      // This dormant component has no deployed migration contract. Refuse an
      // earlier unversioned ledger intact rather than discovering its older
      // state constraint only after accepting a new upload.
      if (existing && this.db.pragma('user_version', { simple: true }) !== 1) throw new Error('local-history-disk-schema');
      this.db.pragma('journal_mode = DELETE');
      this.db.pragma('synchronous = FULL');
      this.db.exec('BEGIN IMMEDIATE');
      try {
        this.db.exec(`CREATE TABLE IF NOT EXISTS allocations (
          id TEXT PRIMARY KEY NOT NULL, operation TEXT NOT NULL,
          planned INTEGER NOT NULL, written INTEGER NOT NULL,
          state TEXT NOT NULL, dev INTEGER, ino INTEGER, disposedAt INTEGER,
          CHECK(typeof(planned) = 'integer' AND planned >= 0 AND planned <= 9007199254740991),
          CHECK(typeof(written) = 'integer' AND written >= 0 AND written <= planned),
          CHECK(state IN ('active','sealed','cleanup-pending','disposed'))
        )`);
        if (!existing) this.db.pragma('user_version = 1');
        this.db.exec('COMMIT');
      } catch (error) { if (this.db.inTransaction) this.db.exec('ROLLBACK'); throw error; }
      this.unregister = registerSqliteHandle(() => this.db.close());
    } catch (error) { this.db.close(); throw error; }
  }

  close(): void { this.unregister(); if (this.db.open) this.db.close(); }

  /** Keep the ledger's original directories and existing copy destinations on
   * one device. The future admission owner holds this pin through worker exit. */
  pinCopyVolume(destinationDirectories: readonly string[]) {
    if (!this.db.open || !destinationDirectories.length) throw new Error('local-history-disk-volume');
    const pin = pinLocalHistoryCopyVolume(this.directory, [this.blocks, ...destinationDirectories], this.directoryIdentities);
    this.copyVolumePins.add(pin);
    return pin;
  }

  private measurement(): LocalHistoryDiskMeasurement {
    const disk = this.disk();
    if (!disk || !Number.isSafeInteger(disk.total) || disk.total <= 0
      || !Number.isSafeInteger(disk.free) || disk.free < 0 || disk.free > disk.total) throw new Error('local-history-disk-unavailable');
    return disk;
  }
  private checkCapacity(outstanding: number, extra: number): void {
    amount(outstanding); amount(extra);
    const disk = this.measurement();
    if (disk.free - mediaDiskFloorBytes(disk.total) - METADATA_WORK_BYTES - outstanding < extra) {
      throw new Error('local-history-disk-capacity');
    }
  }
  private transaction<T>(run: () => T): T {
    try {
      this.db.exec('BEGIN IMMEDIATE');
      try { this.validateLedger(); const value = run(); this.db.exec('COMMIT'); return value; }
      catch (error) { if (this.db.inTransaction) this.db.exec('ROLLBACK'); throw error; }
    } catch (error) {
      if (['SQLITE_BUSY', 'SQLITE_LOCKED'].includes((error as {code?: string}).code ?? '')) throw new Error('local-history-disk-busy');
      if (error instanceof Error && error.message.startsWith('local-history-disk-')) throw error;
      throw new Error('local-history-disk-unavailable');
    }
  }
  private validateLedger(): void {
    const count = (this.db.prepare('SELECT COUNT(*) AS count FROM allocations').get() as {count: number}).count;
    if (!Number.isSafeInteger(count) || count > MAX_RECORDS) throw new Error('local-history-disk-unavailable');
    const invalid = this.db.prepare(`SELECT 1 FROM allocations WHERE COALESCE((
      typeof(id) = 'text' AND octet_length(id) = 32 AND id NOT GLOB '*[^0-9a-f]*'
      AND typeof(operation) = 'text' AND octet_length(operation) BETWEEN 1 AND 128
      AND typeof(planned) = 'integer' AND planned BETWEEN 0 AND 9007199254740991
      AND typeof(written) = 'integer' AND written BETWEEN 0 AND planned
      AND typeof(state) = 'text' AND state IN ('active','sealed','cleanup-pending','disposed')
      AND (state != 'disposed' OR (planned = 0 AND written = 0))
      AND ((state = 'disposed' AND typeof(disposedAt) = 'integer' AND disposedAt >= 0) OR (state != 'disposed' AND disposedAt IS NULL))
      AND ((dev IS NULL AND ino IS NULL) OR (typeof(dev) = 'integer' AND typeof(ino) = 'integer'
        AND dev BETWEEN 0 AND 9007199254740991 AND ino BETWEEN 0 AND 9007199254740991))
    ), 0) = 0 LIMIT 1`).get();
    if (invalid) throw new Error('local-history-disk-unavailable');
  }

  private outstanding(): number {
    const { bytes } = this.db.prepare("SELECT COALESCE(SUM(planned - written), 0) AS bytes FROM allocations WHERE state != 'disposed'").get() as {bytes: number};
    amount(bytes); return bytes;
  }
  private row(id: string, active = false): Row {
    validId(id);
    const row = this.db.prepare('SELECT id, operation, planned, written, state, dev, ino FROM allocations WHERE id = ?').get(id) as Row | undefined;
    if (!row || (active && row.state !== 'active')) throw new Error('local-history-disk-allocation-unavailable');
    amount(row.planned); amount(row.written);
    if (row.written > row.planned || !['active', 'sealed', 'cleanup-pending', 'disposed'].includes(row.state)) throw new Error('local-history-disk-unavailable');
    return row;
  }
  private file(id: string): string { validId(id); return path.join(this.blocks, id); }
  private validate(stat: fs.Stats, row: Row, allowUnrecorded = false): void {
    if (!stat.isFile() || stat.nlink !== 1 || stat.dev !== this.device
      || (process.getuid && stat.uid !== process.getuid()) || (stat.mode & 0o077) !== 0
      || !Number.isSafeInteger(stat.size) || stat.size > row.planned
      || (!allowUnrecorded && (stat.dev !== row.dev || stat.ino !== row.ino))) throw new Error('local-history-disk-file-invalid');
  }

  /** Reserve declared unwritten bytes durably BEFORE creating a private file.
   * Retained records, including disposed tombstones, have bounded admission.
   */
  create(operation: string, bytes: number): string {
    return this.createAllocation(operation, bytes);
  }

  private createAllocation(operation: string, bytes: number, revalidate?: () => void): string {
    amount(bytes);
    if (typeof operation !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(operation)) throw new Error('local-history-disk-operation');
    const id = crypto.randomBytes(16).toString('hex');
    this.transaction(() => {
      const count = (this.db.prepare('SELECT COUNT(*) AS count FROM allocations').get() as {count: number}).count;
      if (count >= this.recordCapacity) throw new Error('local-history-disk-record-capacity');
      revalidate?.();
      this.checkCapacity(this.outstanding(), bytes);
      revalidate?.();
      this.db.prepare("INSERT INTO allocations(id,operation,planned,written,state) VALUES(?,?,?,0,'active')").run(id, operation, bytes);
    });
    try {
      this.transaction(() => {
        const row = this.row(id, true);
        revalidate?.();
        const fd = fs.openSync(this.file(id), fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600);
        try {
          const stat = fs.fstatSync(fd); this.validate(stat, row, true);
          revalidate?.();
          this.db.prepare('UPDATE allocations SET dev = ?, ino = ? WHERE id = ?').run(stat.dev, stat.ino, id);
        } finally { fs.closeSync(fd); }
      });
      return id;
    } catch {
      // The durable row remains charged if creating or recording the file fails.
      throw new Error('local-history-disk-create-interrupted');
    }
  }

  grow(id: string, bytes: number): void {
    amount(bytes);
    this.transaction(() => {
      const row = this.row(id, true); const next = row.planned + bytes; amount(next);
      this.checkCapacity(this.outstanding(), bytes);
      this.db.prepare('UPDATE allocations SET planned = ? WHERE id = ?').run(next, id);
    });
  }
  /** Bind a new empty allocation to one live parent and operation.
   * The caller owns recovery and releases the charge after actual worker exit. */
  createCopyRunReservation(lease: LocalHistoryChildAdmission, operationId: string,
    pin: ReturnType<typeof pinLocalHistoryCopyVolume>, bootstrapBytes: number, ceiling: number) {
    amount(bootstrapBytes); amount(ceiling);
    if (!bootstrapBytes || bootstrapBytes > ceiling || !this.copyVolumePins.has(pin)) {
      throw new Error('local-history-disk-copy-reservation');
    }
    const operation = localHistoryCopyRunTag(lease, this.stateDir, operationId);
    const revalidate = () => {
      pin.revalidate();
      if (localHistoryCopyRunTag(lease, this.stateDir, operationId) !== operation) {
        throw new Error('local-history-disk-copy-reservation');
      }
    };
    revalidate();
    let scopes = copyReservationScopes.get(lease);
    if (!scopes) { scopes = new Set(); copyReservationScopes.set(lease, scopes); }
    if (scopes.has(operation) || scopes.size >= MAX_RECORDS) throw new Error('local-history-disk-copy-reservation');
    scopes.add(operation);
    let allocationId: string;
    try {
      allocationId = this.createAllocation(operation, bootstrapBytes, revalidate);
    } catch (error) {
      // Only the explicit capacity refusals precede allocation unambiguously.
      if (error instanceof Error && ['local-history-disk-capacity', 'local-history-disk-record-capacity'].includes(error.message)) {
        scopes.delete(operation);
      }
      throw error;
    }
    return Object.freeze({
      allocationId,
      grow: (bytes: number) => this.growCopyRunReservation(operation, allocationId, revalidate, bytes, ceiling),
      releaseAfterSettlement: () => this.disposeAllocation(allocationId, row => {
        revalidate();
        if (row.operation !== operation || row.written !== 0) throw new Error('local-history-disk-copy-reservation');
        if (row.state !== 'disposed') {
          const stat = fs.lstatSync(this.file(allocationId));
          this.validate(stat, row);
          if (stat.size !== 0) throw new Error('local-history-disk-copy-reservation');
        }
      }),
    });
  }

  private growCopyRunReservation(operation: string, allocationId: string, revalidate: () => void,
    bytes: number, ceiling: number): void {
    amount(bytes);
    if (!bytes) throw new Error('local-history-disk-copy-reservation');
    this.transaction(() => {
      const row = this.row(allocationId, true);
      const planned = row.planned + bytes;
      amount(planned);
      if (row.operation !== operation || row.written !== 0 || planned > ceiling) {
        throw new Error('local-history-disk-copy-reservation');
      }
      const checkIdentity = () => {
        revalidate();
        const stat = fs.lstatSync(this.file(allocationId));
        this.validate(stat, row);
        if (stat.size !== 0) throw new Error('local-history-disk-copy-reservation');
      };
      checkIdentity();
      this.checkCapacity(this.outstanding(), bytes);
      checkIdentity();
      this.db.prepare('UPDATE allocations SET planned = ? WHERE id = ?').run(planned, allocationId);
    });
  }

  /** Bounded recovery inventory for the service's already-bound operation. */
  list(operation: string): LocalHistoryDiskAllocation[] {
    if (typeof operation !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(operation)) throw new Error('local-history-disk-operation');
    return this.transaction(() => this.db.prepare('SELECT id, operation, planned, written, state FROM allocations WHERE operation = ? LIMIT ?').all(operation, MAX_RECORDS) as LocalHistoryDiskAllocation[]);
  }

  inspect(id: string): LocalHistoryDiskAllocation {
    return this.transaction(() => { const {dev: _dev, ino: _ino, ...row} = this.row(id); return row; });
  }
  /** Internal bounded recovery inventory. This is not an owner-facing listing
   * or proof that an allocation's former process/child has exited. */
  inventory(): LocalHistoryDiskAllocation[] {
    return this.transaction(() => this.db.prepare('SELECT id, operation, planned, written, state FROM allocations LIMIT ?').all(MAX_RECORDS) as LocalHistoryDiskAllocation[]);
  }

  /** A bounded synchronous block holds the ledger until the fd closes. A short
   * write is debited only for bytes actually present. Failure retains all other
   * commitments. A crash before debit leaves a conservative charge until the
   * next explicit reconcile, never an unaccounted write.
   */
  write(id: string, bytes: Buffer): void {
    if (!Buffer.isBuffer(bytes) || bytes.length > CHUNK_BYTES) throw new Error('local-history-disk-block-capacity');
    let failed = false;
    this.transaction(() => {
      const row = this.row(id, true);
      if (bytes.length > row.planned - row.written) throw new Error('local-history-disk-plan-exceeded');
      this.checkCapacity(this.outstanding(), 0);
      const fd = fs.openSync(this.file(id), fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      try {
        const before = fs.fstatSync(fd); this.validate(before, row);
        if (before.size !== row.written) throw new Error('local-history-disk-reconcile-required');
        let offset = 0;
        try {
          while (offset < bytes.length) {
            const count = fs.writeSync(fd, bytes, offset, bytes.length - offset, row.written + offset);
            if (count <= 0) throw new Error('short-write');
            offset += count;
          }
          fs.fsyncSync(fd);
        } catch { failed = true; }
        const after = fs.fstatSync(fd); this.validate(after, row);
        this.db.prepare('UPDATE allocations SET written = ? WHERE id = ?').run(after.size, id);
      } finally { fs.closeSync(fd); }
    });
    if (failed) throw new Error('local-history-disk-write-interrupted');
  }

  /** Accounting reconciliation only, not a content/hash or authorization proof.
   * No helper writer can retain an fd outside the serial ledger transaction.
   */
  reconcile(id: string): void {
    this.transaction(() => {
      const row = this.row(id, true);
      const stat = fs.lstatSync(this.file(id));
      this.validate(stat, row, row.dev === null && row.ino === null && stat.size === 0);
      this.db.prepare('UPDATE allocations SET written = ?, dev = ?, ino = ? WHERE id = ?').run(stat.size, stat.dev, stat.ino, id);
    });
  }
  /** Publish raw bytes as immutable through this ledger before preparation. */
  seal(id: string): void {
    this.transaction(() => {
      const row = this.row(id, true);
      const fd = fs.openSync(this.file(id), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      try {
        const stat = fs.fstatSync(fd); this.validate(stat, row);
        if (stat.size !== row.written || row.written !== row.planned) throw new Error('local-history-disk-plan-incomplete');
        this.db.prepare("UPDATE allocations SET state = 'sealed' WHERE id = ?").run(id);
      } finally { fs.closeSync(fd); }
    });
  }

  read(id: string, offset: number, length: number): Buffer {
    amount(offset); amount(length);
    if (length > CHUNK_BYTES) throw new Error('local-history-disk-block-capacity');
    return this.transaction(() => {
      const row = this.row(id);
      if (!['active', 'sealed'].includes(row.state)) throw new Error('local-history-disk-allocation-unavailable');
      const fd = fs.openSync(this.file(id), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      try {
        const stat = fs.fstatSync(fd); this.validate(stat, row);
        if (stat.size !== row.written) throw new Error('local-history-disk-reconcile-required');
        const buffer = Buffer.alloc(Math.min(length, Math.max(0, stat.size - offset)));
        try {
          let received = 0;
          while (received < buffer.length) {
            let count: number;
            try { count = fs.readSync(fd, buffer, received, buffer.length - received, offset + received); }
            catch (error) { if ((error as NodeJS.ErrnoException).code === 'EINTR') continue; throw error; }
            if (count <= 0) throw new Error('short-read');
            received += count;
          }
          const after = fs.fstatSync(fd); this.validate(after, row);
          if (after.size !== row.written) throw new Error('changed-read');
          return buffer;
        }
        catch { buffer.fill(0); throw new Error('local-history-disk-read'); }
      } finally { fs.closeSync(fd); }
    });
  }

  dispose(id: string): void {
    this.disposeAllocation(id);
  }

  private disposeAllocation(id: string, validateReservation?: (row: Row) => void): void {
    this.transaction(() => {
      const row = this.row(id);
      validateReservation?.(row);
      if (row.state !== 'disposed') this.db.prepare("UPDATE allocations SET state = 'cleanup-pending' WHERE id = ?").run(id);
    });
    try {
      this.transaction(() => {
        const row = this.row(id);
        validateReservation?.(row);
        if (row.state === 'disposed') return;
        try {
          const stat = fs.lstatSync(this.file(id));
          this.validate(stat, row, row.dev === null && row.ino === null && stat.size === 0);
          SafeFsExecutor.safeUnlinkSync(this.file(id), { operation: 'dispose owned local history disk block' });
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        this.db.prepare("UPDATE allocations SET planned = 0, written = 0, state = 'disposed', disposedAt = ? WHERE id = ?").run(Date.now(), id);
      });
    } catch { throw new Error('local-history-disk-cleanup-pending'); }
  }
}
