import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { SafeFsExecutor } from '../core/SafeFsExecutor.js';
import { verifyPrivateImportDirectory } from './privateImportState.js';
import { MAX_ZIP_BYTES, ZipRefused } from './safeZip.js';

/** Identifies the bytes actually read by the parser. Only the receipt survives the request. */
export interface ArchiveReceipt { size: number; mtimeMs: number; sha256: string }

export class ArchiveSourceChanged extends Error {}
const snapshotName = /^([1-9][0-9]*)-[a-f0-9]{32}\.zip$/;
const activeCopies = new Set<string>();

function isLive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (err) { return (err as NodeJS.ErrnoException).code !== 'ESRCH'; }
}

function removeCopy(file: string): void {
  SafeFsExecutor.safeUnlinkSync(file, { operation: 'imported-history temporary archive cleanup' });
}

/** Short-lived private snapshots. Callers parse a completed copy and never reopen the user's path. */
export class ArchiveStaging {
  private readonly directory: string;

  constructor(stateDir: string) {
    this.directory = path.join(stateDir, 'import-preview-staging');
  }

  /** After a process crash only its own disposable files can remain. Leave live peers' copies alone. */
  recover(): void {
    try { verifyPrivateImportDirectory(this.directory); }
    catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
    for (const entry of fs.readdirSync(this.directory, { withFileTypes: true })) {
      const match = snapshotName.exec(entry.name);
      if (!match || !entry.isFile()) continue;
      const file = path.join(this.directory, entry.name);
      const pid = Number(match[1]);
      if (activeCopies.has(file) || (pid !== process.pid && isLive(pid))) continue;
      try { removeCopy(file); }
      catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err; }
    }
  }

  async withSnapshot<T>(sourcePath: string, read: (file: string, receipt: ArchiveReceipt) => Promise<T>): Promise<T> {
    // O_NONBLOCK avoids waiting on a FIFO substituted between the caller's check and the open.
    const link = await fs.promises.lstat(sourcePath);
    if (!link.isFile()) throw new ArchiveSourceChanged('The selected archive is not a regular file.');
    const source = await fs.promises.open(sourcePath,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
      const before = await source.stat();
      if (!before.isFile() || before.dev !== link.dev || before.ino !== link.ino) {
        throw new ArchiveSourceChanged('The selected archive changed before it could be opened.');
      }
      if (before.size > MAX_ZIP_BYTES) throw new ZipRefused('This export is larger than the 2 GB limit.');
      await fs.promises.mkdir(this.directory, { recursive: true, mode: 0o700 });
      verifyPrivateImportDirectory(this.directory);
      const file = path.join(this.directory, process.pid + '-' + crypto.randomBytes(16).toString('hex') + '.zip');
      activeCopies.add(file);
      let output: fs.promises.FileHandle | undefined;
      try {
        let size = 0;
        const digest = crypto.createHash('sha256');
        const countAndHash = new Transform({
          transform(chunk: Buffer, _encoding, next) {
            size += chunk.length;
            if (size > before.size || size > MAX_ZIP_BYTES) { next(new ArchiveSourceChanged('The archive grew during the copy.')); return; }
            digest.update(chunk);
            next(null, chunk);
          },
        });
        output = await fs.promises.open(file, 'wx', 0o600);
        await pipeline(source.createReadStream(), countAndHash, output.createWriteStream());
        // Windows read-only also prevents disposal. Its ACLs come from the private state directory.
        if (process.platform !== 'win32') await fs.promises.chmod(file, 0o400);
        if (size !== before.size) throw new ArchiveSourceChanged('The archive changed during the copy.');
        return await read(file, { size, mtimeMs: before.mtimeMs, sha256: digest.digest('hex') });
      } finally {
        try { await output?.close(); } finally {
          activeCopies.delete(file);
          if (output) removeCopy(file);
        }
      }
    } finally { await source.close(); }
  }
}

const jobIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const partialName = /^part-([1-9][0-9]*)-[0-9a-f]{32}$/;
const activeWrites = new Map<string, AbortController>();
const PART_TIMEOUT_MS = 60 * 60 * 1000;

/** Jobs own these files until the owner confirms or cancels, or the durable deadline expires.
 * Only the worker supplies job IDs, after authenticating the owner, conversation and machine.
 * No caller-controlled path or incoming filename is used here.
 */
export class AcquisitionArchives {
  private readonly root: string;
  private readonly snapshots: ArchiveStaging;
  constructor(stateDir: string, private readonly byteLimit: number = MAX_ZIP_BYTES) {
    if (!Number.isSafeInteger(byteLimit) || byteLimit <= 0 || byteLimit > MAX_ZIP_BYTES) throw new RangeError('Invalid archive byte limit.');
    this.root = path.resolve(stateDir, 'history-acquisition-archives');
    this.snapshots = new ArchiveStaging(stateDir);
  }

  private jobDirectory(jobId: string): string {
    if (!jobIdPattern.test(jobId)) throw new Error('Invalid acquisition job ID.');
    return path.join(this.root, jobId);
  }

  private existingDirectory(jobId: string): string {
    const dir = this.jobDirectory(jobId);
    verifyPrivateImportDirectory(this.root);
    verifyPrivateImportDirectory(dir);
    return dir;
  }

  /** A true answer means we have a regular local file to inspect; verified bytes come from readSnapshot. */
  hasArchive(jobId: string): boolean {
    try {
      if (!fs.lstatSync(path.join(this.existingDirectory(jobId), 'archive.zip')).isFile()) {
        throw new Error('Unsafe staged archive.');
      }
      return true;
    }
    catch (err) { if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false; throw err; }
  }

  /** Publish a completed, bounded archive once. A retry or competing process cannot replace it. */
  async stage(jobId: string, bytes: Readable, signal?: AbortSignal): Promise<Pick<ArchiveReceipt, 'size' | 'sha256'>> {
    try { return await this.writeArchive(jobId, bytes, signal); }
    catch (err) { bytes.destroy(); throw err; }
  }

  private async writeArchive(jobId: string, bytes: Readable, signal?: AbortSignal): Promise<Pick<ArchiveReceipt, 'size' | 'sha256'>> {
    const dir = this.jobDirectory(jobId);
    signal?.throwIfAborted();
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
    verifyPrivateImportDirectory(this.root);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    verifyPrivateImportDirectory(dir);
    if (activeWrites.has(dir) || this.hasArchive(jobId)) throw new Error('archive-already-staged-or-staging');

    const partial = path.join(dir, 'part-' + process.pid + '-' + crypto.randomBytes(16).toString('hex'));
    let output: fs.promises.FileHandle | undefined;
    const controller = new AbortController();
    activeWrites.set(dir, controller);
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    const timeout = setTimeout(abort, PART_TIMEOUT_MS);
    timeout.unref();
    let size = 0;
    const digest = crypto.createHash('sha256');
    const limit = this.byteLimit;
    try {
      const count = new Transform({
        transform(chunk: Buffer, _encoding, next) {
          size += chunk.length;
          if (size > limit) { next(new ZipRefused('The downloaded archive exceeds the import size limit.')); return; }
          digest.update(chunk);
          next(null, chunk);
        },
      });
      output = await fs.promises.open(partial, 'wx', 0o600);
      await pipeline(bytes, count, output.createWriteStream(), { signal: controller.signal });
      controller.signal.throwIfAborted();
      if (size === 0) throw new ZipRefused('The downloaded archive is empty.');
      const completed = await fs.promises.open(partial, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        if (process.platform !== 'win32') await completed.chmod(0o400);
        await completed.sync();
      } finally { await completed.close(); }
      controller.signal.throwIfAborted();
      // link is exclusive creation; same-filesystem rename would overwrite an earlier winner.
      fs.linkSync(partial, path.join(dir, 'archive.zip'));
      // Flush both the published name and its newly created parent entries before acknowledging it.
      if (process.platform !== 'win32') {
        for (const directory of [dir, this.root, path.dirname(this.root)]) {
          const handle = await fs.promises.open(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
          try { await handle.sync(); } finally { await handle.close(); }
        }
      }
      controller.signal.throwIfAborted();
      return { sha256: digest.digest('hex'), size };
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
      try { await output?.close(); } finally {
        activeWrites.delete(dir);
        if (output) this.removeOwnedFile(partial);
        if (controller.signal.aborted) this.removeEmptyDirectory(dir);
      }
    }
  }

  async readSnapshot<T>(jobId: string, read: (privatePath: string, receipt: ArchiveReceipt) => Promise<T>): Promise<T> {
    return this.snapshots.withSnapshot(path.join(this.existingDirectory(jobId), 'archive.zip'), read);
  }

  async digest(jobId: string): Promise<string> {
    return this.readSnapshot(jobId, async (_file, receipt) => receipt.sha256);
  }

  /** Removes recognized regular files only. A foreign entry keeps its directory intact. */
  discard(jobId: string): void {
    const dir = this.jobDirectory(jobId);
    const writer = activeWrites.get(dir);
    writer?.abort();
    try { this.existingDirectory(jobId); }
    catch (err) { if ((err as NodeJS.ErrnoException).code === 'ENOENT') return; throw err; }
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isFile() && (entry.name === 'archive.zip' || partialName.test(entry.name))) {
        this.removeOwnedFile(path.join(dir, entry.name));
      }
    }
    // A pending open may still create its partial. The writer removes it after closing.
    if (!writer) this.removeEmptyDirectory(dir);
  }

  private removeEmptyDirectory(dir: string): void {
    try {
      if (!fs.readdirSync(dir).length) SafeFsExecutor.safeRmdirSync(dir, { operation: 'completed import acquisition cleanup' });
    } catch (error) {
      if (!['ENOTEMPTY', 'ENOENT', 'EEXIST'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
    }
  }

  /** Ask the durable job store which archives survive a restart. An unknown DB state must throw. */
  recover(keepJob: (jobId: string) => boolean): void {
    this.snapshots.recover();
    try { verifyPrivateImportDirectory(this.root); }
    catch (err) { if ((err as NodeJS.ErrnoException).code === 'ENOENT') return; throw err; }
    for (const entry of fs.readdirSync(this.root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !jobIdPattern.test(entry.name)) continue;
      if (!keepJob(entry.name)) { this.discard(entry.name); continue; }
      const dir = this.existingDirectory(entry.name);
      for (const file of fs.readdirSync(dir, { withFileTypes: true })) {
        const match = partialName.exec(file.name);
        if (!file.isFile() || !match) continue;
        const pid = Number(match[1]);
        if (pid === process.pid ? activeWrites.has(dir) : isLive(pid)) continue;
        this.removeOwnedFile(path.join(dir, file.name));
      }
    }
  }

  private removeOwnedFile(file: string): void {
    try {
      if (fs.lstatSync(file).isFile()) removeCopy(file);
    } catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err; }
  }
}
