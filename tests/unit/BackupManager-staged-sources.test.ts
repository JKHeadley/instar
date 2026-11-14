/**
 * BackupManager — point-in-time staging for a snapshot copied off the main thread.
 *
 * The synchronous snapshot kept a database and its write-ahead log consistent
 * by blocking the whole process for the copy. The off-thread snapshot keeps
 * that only for what stageSqliteFiles() captures, so these tests pin both
 * sides: what is staged, and that the snapshot really uses the staged moment.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { BackupManager, isPointInTimeFile } from '../../src/core/BackupManager.js';
import { runBackupSnapshotJob } from '../../src/core/backupSnapshotJob.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

let stateDir: string;
const write = (rel: string, body: string): void => {
  const target = path.join(stateDir, rel);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, body);
};
const STORE = 'state/feedback-factory/store';

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-backup-staged-'));
  write('AGENT.md', 'agent');
  write(`${STORE}/feedback-drain.db`, 'db@t0');
  write(`${STORE}/feedback-drain.db-wal`, 'wal@t0');
  write(`${STORE}/feedback-drain.db-shm`, 'shm@t0');
  write(`${STORE}/feedback-drain-checkpoint.json`, '{"at":"t0"}');
  write(`${STORE}/feedback.jsonl`, 'rows@t0');
  write(`${STORE}/nested/deeper/other.db`, 'nested@t0');
  write('class-reviews.db', 'reviews@t0');
  write('class-reviews.db-wal', 'reviews-wal@t0');
});
afterEach(() => {
  SafeFsExecutor.safeRmSync(stateDir, { recursive: true, force: true, operation: 'tests/unit/BackupManager-staged-sources.test.ts:cleanup' });
});

describe('isPointInTimeFile', () => {
  it('names databases, their logs and the drain checkpoint record, and nothing else', () => {
    for (const yes of ['a.db', 'x/a.db-wal', 'a.db-shm', 'a.db-journal', 'b.sqlite', 'b.sqlite3-wal', 'store/feedback-drain-checkpoint.json']) {
      expect(isPointInTimeFile(yes), yes).toBe(true);
    }
    for (const no of ['a.json', 'feedback.jsonl', 'db', 'a.db.bak', 'a.dbx', 'checkpoint.json']) {
      expect(isPointInTimeFile(no), no).toBe(false);
    }
  });
});

describe('BackupManager.stageSqliteFiles', () => {
  it('stages every database file in the included set, at any depth, and only those', () => {
    const manager = new BackupManager(stateDir);
    const staged = manager.stageSqliteFiles();
    expect(Object.keys(staged.sources).sort()).toEqual([
      'class-reviews.db',
      'class-reviews.db-wal',
      `${STORE}/feedback-drain-checkpoint.json`,
      `${STORE}/feedback-drain.db`,
      `${STORE}/feedback-drain.db-shm`,
      `${STORE}/feedback-drain.db-wal`,
      `${STORE}/nested/deeper/other.db`,
    ]);
    expect(fs.readFileSync(staged.sources[`${STORE}/feedback-drain.db`], 'utf8')).toBe('db@t0');
    expect(path.dirname(staged.dir)).toBe(path.join(path.resolve(stateDir), 'backups'));
  });

  it('never stages a file the deny layers exclude', () => {
    write(`${STORE}/judgment-provenance/rows.db`, 'machine-local');
    write('secrets/vault.db', 'secret');
    const manager = new BackupManager(stateDir, { includeFiles: ['secrets/'] });
    const keys = Object.keys(manager.stageSqliteFiles().sources);
    expect(keys.some((key) => key.includes('judgment-provenance'))).toBe(false);
    expect(keys.some((key) => key.startsWith('secrets'))).toBe(false);
  });

  it('is not listed as a snapshot and is not pruned as one', () => {
    const manager = new BackupManager(stateDir, { maxSnapshots: 1 });
    const staged = manager.stageSqliteFiles();
    manager.createSnapshot('manual');
    manager.createSnapshot('manual');
    expect(manager.listSnapshots()).toHaveLength(1);
    expect(fs.existsSync(staged.dir)).toBe(true);
  });
});

describe('createSnapshot with staged sources', () => {
  it('copies the staged moment, not what the live file became afterwards', () => {
    const manager = new BackupManager(stateDir);
    const staged = manager.stageSqliteFiles();
    // The server keeps writing while the worker copies.
    write(`${STORE}/feedback-drain.db`, 'db@t1-longer');
    write(`${STORE}/feedback-drain.db-wal`, 'wal@t1-longer');
    write(`${STORE}/feedback.jsonl`, 'rows@t1');
    const snapshot = manager.createSnapshot('feedback-hourly', { stagedSources: staged.sources });
    const read = (rel: string): string => fs.readFileSync(path.join(manager.getSnapshotPath(snapshot.id), rel), 'utf8');
    expect(read(`${STORE}/feedback-drain.db`)).toBe('db@t0');
    expect(read(`${STORE}/feedback-drain.db-wal`)).toBe('wal@t0');
    expect(read(`${STORE}/feedback-drain-checkpoint.json`)).toBe('{"at":"t0"}');
    // A file with no point-in-time need is read live.
    expect(read(`${STORE}/feedback.jsonl`)).toBe('rows@t1');
    // The manifest counts the bytes that were actually copied.
    const expectedBytes = snapshot.files.reduce((sum, rel) => sum + fs.statSync(path.join(manager.getSnapshotPath(snapshot.id), rel)).size, 0);
    expect(snapshot.totalBytes).toBe(expectedBytes);
    expect(new Set(snapshot.files).size).toBe(snapshot.files.length);
  });

  it('keeps a staged log whose live original went away before the copy', () => {
    const manager = new BackupManager(stateDir);
    const staged = manager.stageSqliteFiles();
    SafeFsExecutor.safeUnlinkSync(path.join(stateDir, `${STORE}/feedback-drain.db-wal`), { operation: 'tests/unit/BackupManager-staged-sources.test.ts:fixture' });
    SafeFsExecutor.safeUnlinkSync(path.join(stateDir, 'class-reviews.db-wal'), { operation: 'tests/unit/BackupManager-staged-sources.test.ts:fixture' });
    const snapshot = manager.createSnapshot('feedback-hourly', { stagedSources: staged.sources });
    const dir = manager.getSnapshotPath(snapshot.id);
    expect(fs.readFileSync(path.join(dir, `${STORE}/feedback-drain.db-wal`), 'utf8')).toBe('wal@t0');
    expect(fs.readFileSync(path.join(dir, 'class-reviews.db-wal'), 'utf8')).toBe('reviews-wal@t0');
    expect(snapshot.files).toContain(`${STORE}/feedback-drain.db-wal`);
  });

  it('does not let a staged entry carry a denied path into the snapshot', () => {
    const manager = new BackupManager(stateDir);
    const staged = manager.stageSqliteFiles();
    const smuggled = path.join(staged.dir, 'smuggled');
    fs.writeFileSync(smuggled, 'machine-local');
    const snapshot = manager.createSnapshot('manual', {
      stagedSources: { ...staged.sources, 'state/judgment-provenance/rows.db': smuggled, 'config.json': smuggled },
    });
    expect(snapshot.files.some((rel) => rel.includes('judgment-provenance') || rel === 'config.json')).toBe(false);
  });

  it('produces the same file list as an unstaged snapshot', () => {
    const manager = new BackupManager(stateDir);
    const plain = manager.createSnapshot('manual');
    const staged = manager.stageSqliteFiles();
    const viaStaging = manager.createSnapshot('manual', { stagedSources: staged.sources });
    expect([...viaStaging.files].sort()).toEqual([...plain.files].sort());
    expect(viaStaging.totalBytes).toBe(plain.totalBytes);
  });
});

describe('with staging in force, a point-in-time file is never read live', () => {
  const snapshotDirs = (): string[] => fs.readdirSync(path.join(stateDir, 'backups')).filter((name) => /^\d{4}-/.test(name));

  it('leaves out a log that appeared after staging, instead of pairing it with the older database', () => {
    SafeFsExecutor.safeUnlinkSync(path.join(stateDir, 'class-reviews.db-wal'), { operation: 'tests/unit/BackupManager-staged-sources.test.ts:fixture' });
    const manager = new BackupManager(stateDir);
    const staged = manager.stageSqliteFiles();
    // The server reopens the database and writes after staging.
    write('class-reviews.db-wal', 'frames-from-a-later-moment');
    write(`${STORE}/late.db`, 'created-after-staging');
    const snapshot = manager.createSnapshot('feedback-hourly', { stagedSources: staged.sources });
    expect(snapshot.files).toContain('class-reviews.db');
    expect(snapshot.files).not.toContain('class-reviews.db-wal');
    expect(snapshot.files).not.toContain(`${STORE}/late.db`);
    expect(fs.existsSync(path.join(manager.getSnapshotPath(snapshot.id), 'class-reviews.db-wal'))).toBe(false);
    // Without staging the same files are copied as before.
    expect(manager.createSnapshot('manual').files).toContain('class-reviews.db-wal');
  });

  it('uses the staged copy every time when two include entries cover the same file', () => {
    const manager = new BackupManager(stateDir, { includeFiles: [`${STORE}/feedback-drain.db`] });
    const staged = manager.stageSqliteFiles();
    write(`${STORE}/feedback-drain.db`, 'db@t1-longer');
    const snapshot = manager.createSnapshot('feedback-hourly', { stagedSources: staged.sources });
    expect(fs.readFileSync(path.join(manager.getSnapshotPath(snapshot.id), `${STORE}/feedback-drain.db`), 'utf8')).toBe('db@t0');
  });

  it('fails, and leaves no half-made snapshot, when a staged copy is gone', () => {
    const manager = new BackupManager(stateDir);
    const staged = manager.stageSqliteFiles();
    SafeFsExecutor.safeUnlinkSync(staged.sources[`${STORE}/feedback-drain.db`], { operation: 'tests/unit/BackupManager-staged-sources.test.ts:fixture' });
    expect(() => manager.createSnapshot('feedback-hourly', { stagedSources: staged.sources })).toThrow(/staged copy/);
    expect(snapshotDirs()).toEqual([]);
    expect(manager.listSnapshots()).toEqual([]);
  });

  it('ignores a staged entry that staging could not have produced', () => {
    const manager = new BackupManager(stateDir);
    const staged = manager.stageSqliteFiles();
    const inside = path.join(staged.dir, 'extra');
    fs.writeFileSync(inside, 'x');
    const outside = path.join(stateDir, 'AGENT.md');
    const snapshot = manager.createSnapshot('manual', {
      stagedSources: {
        ...staged.sources,
        '../../escaped.db': inside,            // would write outside the snapshot
        '/tmp/absolute.db': inside,            // absolute key
        'state/./odd.db': inside,              // not a normalized key
        'notes.txt': inside,                   // not a point-in-time file
        'state/elsewhere.db': outside,         // copy not inside a staging directory
      },
    });
    const dir = manager.getSnapshotPath(snapshot.id);
    expect(snapshot.files.some((rel) => rel.includes('..') || path.isAbsolute(rel))).toBe(false);
    for (const rel of ['notes.txt', 'state/elsewhere.db', 'state/odd.db']) expect(snapshot.files).not.toContain(rel);
    expect(fs.existsSync(path.join(path.dirname(dir), '..', 'escaped.db'))).toBe(false);
    expect(fs.existsSync(path.join(stateDir, 'escaped.db'))).toBe(false);
  });
});

describe('snapshot directories that never got a manifest', () => {
  it('a snapshot that throws removes its own directory', () => {
    const manager = new BackupManager(stateDir);
    const staged = manager.stageSqliteFiles();
    const bad = path.join(staged.dir, 'a-directory');
    fs.mkdirSync(bad);
    expect(() => manager.createSnapshot('manual', { stagedSources: { 'class-reviews.db': bad } })).toThrow();
    expect(fs.readdirSync(path.join(stateDir, 'backups')).filter((name) => /^\d{4}-/.test(name))).toEqual([]);
  });

  it('sweeps one left by a killed copy once it is a day old, and never a recent one or a real snapshot', () => {
    const manager = new BackupManager(stateDir);
    const real = manager.createSnapshot('manual');
    const backups = path.join(stateDir, 'backups');
    const oldDir = path.join(backups, '2026-01-01T000000Z');
    const recentDir = path.join(backups, '2026-01-02T000000Z');
    for (const dir of [oldDir, recentDir]) { fs.mkdirSync(dir); fs.writeFileSync(path.join(dir, 'AGENT.md'), 'partial'); }
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    fs.utimesSync(oldDir, twoDaysAgo, twoDaysAgo);
    fs.utimesSync(manager.getSnapshotPath(real.id), twoDaysAgo, twoDaysAgo);
    expect(manager.sweepAbandonedSnapshots()).toBe(1);
    expect(fs.existsSync(oldDir)).toBe(false);
    expect(fs.existsSync(recentDir)).toBe(true);
    expect(manager.listSnapshots().map((row) => row.id)).toEqual([real.id]);
  });

  it('a complete snapshot survives a failure in the housekeeping after it', () => {
    const manager = new BackupManager(stateDir);
    vi.spyOn(manager, 'pruneSnapshots').mockImplementation(() => { throw new Error('prune failed'); });
    expect(() => manager.createSnapshot('manual')).toThrow('prune failed');
    vi.restoreAllMocks();
    expect(manager.listSnapshots()).toHaveLength(1);
  });

  it('does not stage a directory that merely has a database-like name', () => {
    fs.mkdirSync(path.join(stateDir, 'class-reviews.db-archive.db'));
    const manager = new BackupManager(stateDir);
    expect(Object.keys(manager.stageSqliteFiles().sources)).not.toContain('class-reviews.db-archive.db');
  });

  it('two snapshots in the same second get two directories', () => {
    const manager = new BackupManager(stateDir);
    const ids = [manager.createSnapshot('manual').id, manager.createSnapshot('manual').id, manager.createSnapshot('manual').id];
    expect(new Set(ids).size).toBe(3);
  });
});

describe('files that go away while the off-thread copy runs', () => {
  afterEach(() => { vi.restoreAllMocks(); });
  const removeOnFirstLstat = (victim: string): void => {
    const real = fs.lstatSync.bind(fs);
    let done = false;
    vi.spyOn(fs, 'lstatSync').mockImplementation(((target: fs.PathLike, ...rest: unknown[]) => {
      if (!done && fs.existsSync(victim)) {
        done = true;
        SafeFsExecutor.safeUnlinkSync(victim, { operation: 'tests/unit/BackupManager-staged-sources.test.ts:fixture' });
      }
      return (real as (...args: unknown[]) => fs.Stats)(target, ...rest);
    }) as typeof fs.lstatSync);
  };

  it('with staging in force, a file removed after it was listed is left out and the snapshot still completes', () => {
    write(`${STORE}/a-rotating.jsonl`, 'rows');
    const manager = new BackupManager(stateDir);
    const staged = manager.stageSqliteFiles();
    removeOnFirstLstat(path.join(stateDir, `${STORE}/a-rotating.jsonl`));
    const snapshot = manager.createSnapshot('feedback-hourly', { stagedSources: staged.sources });
    expect(snapshot.files).not.toContain(`${STORE}/a-rotating.jsonl`);
    expect(snapshot.files).toContain(`${STORE}/feedback.jsonl`);
    // The manifest lists only what is really in the snapshot.
    for (const rel of snapshot.files) expect(fs.existsSync(path.join(manager.getSnapshotPath(snapshot.id), rel)), rel).toBe(true);
  });

  it('without staging, the same disappearance still fails the snapshot, as it always did', () => {
    write(`${STORE}/a-rotating.jsonl`, 'rows');
    const manager = new BackupManager(stateDir);
    removeOnFirstLstat(path.join(stateDir, `${STORE}/a-rotating.jsonl`));
    expect(() => manager.createSnapshot('manual')).toThrow(/ENOENT/);
    expect(manager.listSnapshots()).toEqual([]);
  });
});

describe('staging cleanup', () => {
  it('runBackupSnapshotJob removes its staging directory, also when the snapshot throws', () => {
    const manager = new BackupManager(stateDir);
    const ok = manager.stageSqliteFiles();
    const snapshot = runBackupSnapshotJob({ stateDir, trigger: 'feedback-hourly', staged: ok });
    expect(snapshot.trigger).toBe('feedback-hourly');
    expect(fs.existsSync(ok.dir)).toBe(false);
    expect(manager.listSnapshots().map((row) => row.id)).toContain(snapshot.id);

    const failing = manager.stageSqliteFiles();
    // A staged path that is a directory makes the copy throw.
    const bad = path.join(failing.dir, 'not-a-file');
    fs.mkdirSync(bad);
    expect(() => runBackupSnapshotJob({ stateDir, trigger: 'feedback-hourly', staged: { dir: failing.dir, sources: { 'class-reviews.db': bad } } })).toThrow();
    expect(fs.existsSync(failing.dir)).toBe(false);
  });

  it('sweeps staging a crashed run left behind and leaves a fresh one alone', () => {
    const manager = new BackupManager(stateDir);
    const old = manager.stageSqliteFiles();
    const fresh = manager.stageSqliteFiles();
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    fs.utimesSync(old.dir, twoHoursAgo, twoHoursAgo);
    expect(manager.sweepStaleStaging()).toBe(1);
    expect(fs.existsSync(old.dir)).toBe(false);
    expect(fs.existsSync(fresh.dir)).toBe(true);
  });

  it('removeStaging refuses anything that is not one of its staging directories', () => {
    const manager = new BackupManager(stateDir);
    const snapshot = manager.createSnapshot('manual');
    manager.removeStaging(manager.getSnapshotPath(snapshot.id));
    manager.removeStaging(stateDir);
    manager.removeStaging(path.join(stateDir, '.staging-elsewhere'));
    expect(fs.existsSync(manager.getSnapshotPath(snapshot.id))).toBe(true);
    expect(fs.existsSync(path.join(stateDir, 'AGENT.md'))).toBe(true);
  });
});
