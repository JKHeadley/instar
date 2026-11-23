import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { AcquisitionArchives, ArchiveStaging } from '../../src/import/archiveStaging.js';
import { AcquisitionWorkerLease } from '../../src/import/AcquisitionWorkerLease.js';
import { ImportedHistoryStore } from '../../src/import/ImportedHistoryStore.js';
import { HistoryAcquisitionStore } from '../../src/import/HistoryAcquisition.js';
import { MAX_ZIP_BYTES } from '../../src/import/safeZip.js';

describe('private import preview copies', () => {
  let dir: string, source: string, staging: ArchiveStaging;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-preview-'));
    source = path.join(dir, 'export.zip');
    fs.writeFileSync(source, 'reviewed');
    staging = new ArchiveStaging(dir);
  });
  afterEach(() => SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/import-archive-staging.test.ts' }));

  it('creates private acquisition databases and refuses a shared or linked root', () => {
    const state = path.join(dir, 'owned');
    const lease = new AcquisitionWorkerLease(state);
    const jobs = new HistoryAcquisitionStore(state);
    try {
      const root = path.join(state, 'history-acquisition');
      expect(fs.statSync(root).mode & 0o777).toBe(0o700);
      for (const name of fs.readdirSync(root)) expect(fs.statSync(path.join(root, name)).mode & 0o077).toBe(0);
    } finally { jobs.close(); lease.close(); }
    const linked = path.join(dir, 'linked');
    fs.mkdirSync(linked);
    fs.symlinkSync(path.join(state, 'history-acquisition'), path.join(linked, 'history-acquisition'));
    expect(() => new HistoryAcquisitionStore(linked)).toThrow(/not private/);
    expect(() => new AcquisitionWorkerLease(linked)).toThrow(/not private/);
    const permissive = path.join(dir, 'permissive');
    const bad = path.join(permissive, 'history-acquisition');
    fs.mkdirSync(bad, { recursive: true });
    fs.chmodSync(bad, 0o755);
    expect(() => new HistoryAcquisitionStore(permissive)).toThrow(/not private/);
    expect(() => new AcquisitionWorkerLease(permissive)).toThrow(/not private/);
    expect(fs.readdirSync(bad)).toEqual([]);
  });

  it('refuses a redirected history destination before creating any children or taking its writer lock', async () => {
    const foreign = path.join(dir, 'foreign');
    fs.mkdirSync(foreign, { mode: 0o700 });
    fs.symlinkSync(foreign, path.join(dir, 'imported-history'));
    expect(() => new ImportedHistoryStore(dir)).toThrow(/not private/);
    expect(fs.readdirSync(foreign)).toEqual([]);
    const store = new ImportedHistoryStore(path.join(dir, 'owned'));
    fs.symlinkSync(source, path.join(store.dir, 'write-lock.sqlite'));
    await expect(store.withWriter(async () => 'unexpected')).rejects.toThrow(/private local file/);
    expect(fs.readFileSync(source, 'utf8')).toBe('reviewed');
  });

  it('rejects linked database files and sidecars before SQLite opens them', () => {
    const root = path.join(dir, 'history-acquisition');
    fs.mkdirSync(root, { mode: 0o700 });
    fs.linkSync(source, path.join(root, 'jobs.sqlite'));
    fs.symlinkSync(source, path.join(root, 'worker-lock.sqlite-journal'));
    expect(() => new HistoryAcquisitionStore(dir)).toThrow(/private local file/);
    expect(() => new AcquisitionWorkerLease(dir)).toThrow(/private local file/);
    expect(fs.readFileSync(source, 'utf8')).toBe('reviewed');
  });

  it('parses only the bytes it hashed and clears them even after a parser error', async () => {
    let copy: string | undefined;
    await expect(staging.withSnapshot(source, async (file, receipt) => {
      copy = file;
      expect(path.dirname(file)).toBe(path.join(dir, 'import-preview-staging'));
      expect(fs.statSync(file).mode & 0o077).toBe(0);
      expect(fs.statSync(path.dirname(file)).mode & 0o077).toBe(0);
      fs.writeFileSync(source, 'changed!');
      new ArchiveStaging(dir).recover();
      expect(fs.readFileSync(file, 'utf8')).toBe('reviewed');
      expect(receipt.sha256).toBe(crypto.createHash('sha256').update('reviewed').digest('hex'));
      throw Error('parser refused');
    })).rejects.toThrow('parser refused');
    expect(fs.existsSync(copy!)).toBe(false);
    expect(fs.readFileSync(source, 'utf8')).toBe('changed!');
  });

  it('refuses a symlink and an oversized sparse source before running the parser', async () => {
    const link = path.join(dir, 'link.zip');
    fs.symlinkSync(source, link);
    const unexpected = async () => { throw Error('parser should never be called'); };
    await expect(staging.withSnapshot(link, unexpected)).rejects.toThrow(/regular file/);
    fs.truncateSync(source, MAX_ZIP_BYTES + 1);
    await expect(staging.withSnapshot(source, unexpected)).rejects.toThrow(/2 GB/);
  });

  it('retains the completed download through restart and refuses a duplicate or foreign job path', async () => {
    const storage = new AcquisitionArchives(dir);
    const job = crypto.randomUUID();
    const receipt = await storage.stage(job, Readable.from([Buffer.from('original')]));
    const afterRestart = new AcquisitionArchives(dir);
    afterRestart.recover(id => id === job);
    expect(afterRestart.hasArchive(job)).toBe(true);
    expect(await afterRestart.digest(job)).toBe(receipt.sha256);
    const duplicate = Readable.from(['replacement']);
    await expect(afterRestart.stage(job, duplicate)).rejects.toThrow(/already-staged/);
    expect(duplicate.destroyed).toBe(true);
    expect(await afterRestart.readSnapshot(job, async (file) => fs.readFileSync(file, 'utf8'))).toBe('original');
    expect(() => storage.discard('../escape')).toThrow(/Invalid/);
    afterRestart.recover(() => false);
    expect(afterRestart.hasArchive(job)).toBe(false);
  });

  it('never publishes an oversize, interrupted or cancelled stream', async () => {
    const storage = new AcquisitionArchives(dir, 8);
    const job = crypto.randomUUID();
    await expect(storage.stage(job, Readable.from([Buffer.alloc(9)]))).rejects.toThrow(/limit/);
    expect(storage.hasArchive(job)).toBe(false);
    const proc = new PassThrough();
    const stage = storage.stage(job, proc);
    proc.write(Buffer.from('partial'));
    storage.discard(job);
    await expect(stage).rejects.toThrow();
    expect(storage.hasArchive(job)).toBe(false);
    expect(fs.existsSync(path.join(dir, 'history-acquisition-archives', job))).toBe(false);
    const after = new AcquisitionArchives(dir, 8);
    after.recover(() => false);
    expect(fs.readdirSync(path.join(dir, 'history-acquisition-archives'))).toEqual([]);
  });

  it('refuses a symlinked job directory and preserves unrelated entries during cleanup', async () => {
    const storage = new AcquisitionArchives(dir);
    const job = crypto.randomUUID();
    const archiveDir = path.join(dir, 'history-acquisition-archives');
    fs.mkdirSync(archiveDir, { mode: 0o700 });
    const jobDir = path.join(archiveDir, job);
    fs.symlinkSync(dir, jobDir, 'dir');
    await expect(storage.stage(job, Readable.from(['data']))).rejects.toThrow(/private/);
    expect(fs.existsSync(path.join(dir, 'archive.zip'))).toBe(false);
    const valid = crypto.randomUUID();
    await storage.stage(valid, Readable.from(['data']));
    const extra = path.join(archiveDir, valid, 'foreign.txt');
    fs.writeFileSync(extra, 'keep');
    storage.discard(valid);
    expect(fs.readFileSync(extra, 'utf8')).toBe('keep');
  });

  it('reclaims abandoned snapshots and leaves unrelated files and linked targets alone', () => {
    const scratch = path.join(dir, 'import-preview-staging');
    fs.mkdirSync(scratch, { mode: 0o700 });
    const stale = path.join(scratch, process.pid + '-' + '1'.repeat(32) + '.zip');
    fs.writeFileSync(stale, 'abandoned');
    const unrelated = path.join(scratch, 'keep.zip');
    fs.writeFileSync(unrelated, 'keep');
    fs.symlinkSync(source, path.join(scratch, process.pid + '-' + '2'.repeat(32) + '.zip'));
    new AcquisitionArchives(dir).recover(() => false);
    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.readFileSync(unrelated, 'utf8')).toBe('keep');
    expect(fs.readFileSync(source, 'utf8')).toBe('reviewed');
  });
});
