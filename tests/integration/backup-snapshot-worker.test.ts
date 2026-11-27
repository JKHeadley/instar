/**
 * Tier 2 (integration) — the state snapshot taken off the main thread, run
 * against the REAL compiled worker in dist/ (built by the integration
 * globalSetup). Source-only lanes that do not build dist skip this suite, the
 * same way cartographer-eventloop-worker does.
 *
 * What a unit test cannot show:
 *   - the production worker path resolves (`new URL('./backupSnapshot.worker.js',
 *     import.meta.url)`) and returns a real manifest;
 *   - timers on the main thread fire while the copy is in progress (and do
 *     not for the synchronous snapshot, measured the same way);
 *   - a worker that cannot start rejects and leaves no staging behind.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

type JobMod = typeof import('../../src/core/backupSnapshotJob.js');
type ManagerMod = typeof import('../../src/core/BackupManager.js');
const DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist', 'core');
const DIST_BUILT = fs.existsSync(path.join(DIST, 'backupSnapshot.worker.js')) && fs.existsSync(path.join(DIST, 'backupSnapshotJob.js'));
let createBackupSnapshotInWorker: JobMod['createBackupSnapshotInWorker'];
let BackupManager: ManagerMod['BackupManager'];

beforeAll(async () => {
  if (!DIST_BUILT) return;
  createBackupSnapshotInWorker = ((await import(/* @vite-ignore */ path.join(DIST, 'backupSnapshotJob.js'))) as JobMod).createBackupSnapshotInWorker;
  BackupManager = ((await import(/* @vite-ignore */ path.join(DIST, 'BackupManager.js'))) as ManagerMod).BackupManager;
});

let stateDir: string;
const STORE = 'state/feedback-factory/store';
const write = (rel: string, body: string | Buffer): void => {
  const target = path.join(stateDir, rel);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, body);
};
const stagingLeft = (): string[] => {
  const dir = path.join(stateDir, 'backups');
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((name) => name.startsWith('.staging-')) : [];
};

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-backup-worker-'));
  write('AGENT.md', 'agent');
  write(`${STORE}/feedback-drain.db`, 'db@t0');
  write(`${STORE}/feedback-drain.db-wal`, 'wal@t0');
  write(`${STORE}/feedback-drain-checkpoint.json`, '{"at":"t0"}');
});
afterEach(() => {
  SafeFsExecutor.safeRmSync(stateDir, { recursive: true, force: true, operation: 'tests/integration/backup-snapshot-worker.test.ts:cleanup' });
});

describe.skipIf(!DIST_BUILT)('createBackupSnapshotInWorker (compiled worker)', () => {
  it('returns a listed, restorable snapshot holding the staged moment, and removes its staging', async () => {
    const pending = createBackupSnapshotInWorker({ stateDir, trigger: 'feedback-hourly' });
    // Staging already happened synchronously; this write lands after it.
    write(`${STORE}/feedback-drain.db`, 'db@t1-after-staging');
    const snapshot = await pending;
    const manager = new BackupManager(stateDir);
    expect(snapshot.trigger).toBe('feedback-hourly');
    expect(manager.listSnapshots().map((row) => row.id)).toEqual([snapshot.id]);
    const dir = manager.getSnapshotPath(snapshot.id);
    expect(fs.readFileSync(path.join(dir, `${STORE}/feedback-drain.db`), 'utf8')).toBe('db@t0');
    expect(fs.readFileSync(path.join(dir, `${STORE}/feedback-drain.db-wal`), 'utf8')).toBe('wal@t0');
    expect(fs.readFileSync(path.join(dir, 'AGENT.md'), 'utf8')).toBe('agent');
    expect(stagingLeft()).toEqual([]);
    // The manifest passes the restore path's integrity check.
    write('AGENT.md', 'changed');
    manager.restoreSnapshot(snapshot.id);
    expect(fs.readFileSync(path.join(stateDir, 'AGENT.md'), 'utf8')).toBe('agent');
  });

  it('keeps the main thread turning while the copy is in progress', async () => {
    const block = Buffer.alloc(1024 * 1024, 7);
    for (let index = 0; index < 200; index++) write(`relationships/blob-${index}.bin`, block);
    const backups = path.join(stateDir, 'backups');
    // A timer on the main thread that fires while a snapshot directory exists
    // with no manifest yet has run DURING the copy. A synchronous snapshot
    // holds the loop from the directory's creation to its manifest, so this
    // count is zero for it whatever the disk speed.
    let ticksDuringCopy = 0;
    const sampler = setInterval(() => {
      let names: string[] = [];
      try { names = fs.readdirSync(backups); } catch { /* not created yet */ }
      if (names.some((name) => /^\d{4}-/.test(name) && !fs.existsSync(path.join(backups, name, 'manifest.json')))) ticksDuringCopy++;
    }, 2);
    try {
      const snapshot = await createBackupSnapshotInWorker({ stateDir, trigger: 'feedback-hourly' });
      expect(snapshot.totalBytes).toBeGreaterThan(200 * 1024 * 1024);
    } finally {
      clearInterval(sampler);
    }
    expect(ticksDuringCopy).toBeGreaterThan(0);

    // The control: the same measurement around the synchronous snapshot sees nothing.
    let ticksDuringSyncCopy = 0;
    const before = new Set(fs.readdirSync(backups));
    const control = setInterval(() => {
      if (fs.readdirSync(backups).some((name) => !before.has(name) && !fs.existsSync(path.join(backups, name, 'manifest.json')))) ticksDuringSyncCopy++;
    }, 2);
    try {
      await new Promise((resolve) => setTimeout(resolve, 10));
      new BackupManager(stateDir).createSnapshot('manual');
      await new Promise((resolve) => setTimeout(resolve, 10));
    } finally {
      clearInterval(control);
    }
    expect(ticksDuringSyncCopy).toBe(0);
  }, 120_000);

  it('rejects and leaves no staging when the worker cannot start', async () => {
    const missing = pathToFileURL(path.join(stateDir, 'no-such-worker.js'));
    await expect(createBackupSnapshotInWorker({ stateDir, trigger: 'feedback-hourly', workerUrl: missing })).rejects.toThrow();
    expect(stagingLeft()).toEqual([]);
    expect(new BackupManager(stateDir).listSnapshots()).toEqual([]);
  });
});
