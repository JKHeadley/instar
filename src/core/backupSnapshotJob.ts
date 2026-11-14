/**
 * backupSnapshotJob — a state snapshot whose bulk copy runs OFF the server's
 * main thread.
 *
 * Why: BackupManager.createSnapshot() is synchronous. On the development agent
 * the hourly feedback checkpoint copies about 400 MB in about 1,200 files and
 * then deletes the oldest snapshot. On a quiet disk that is about a second; on
 * a disk busy with a test run it took over a minute, the server answered no
 * health check for that minute, and its supervisor killed it together with the
 * test run in progress (2026-11-13 01:35 PST, logs/server-freeze).
 *
 * Shape: the caller's thread stages the few files that must come from one
 * moment (BackupManager.stageSqliteFiles), then a worker thread copies
 * everything else, writes the manifest, prunes, and removes the staging
 * directory. The worker entry (backupSnapshot.worker.ts) holds no logic.
 */
import { Worker } from 'node:worker_threads';
import { BackupManager, type StagedBackupSources } from './BackupManager.js';
import type { BackupConfig, BackupSnapshot } from './types.js';

export interface BackupSnapshotJobInput {
  stateDir: string;
  config?: Partial<BackupConfig>;
  trigger: BackupSnapshot['trigger'];
  staged: StagedBackupSources;
}

/** The whole off-thread half. Pure and synchronous, so a test can run it in-process. */
export function runBackupSnapshotJob(input: BackupSnapshotJobInput): BackupSnapshot {
  const manager = new BackupManager(input.stateDir, input.config);
  try {
    return manager.createSnapshot(input.trigger, { stagedSources: input.staged.sources });
  } finally {
    manager.removeStaging(input.staged.dir);
    manager.sweepStaleStaging();
  }
}

export interface BackupSnapshotWorkerOptions {
  stateDir: string;
  config?: Partial<BackupConfig>;
  trigger: BackupSnapshot['trigger'];
  /** Test seam: where the compiled worker entry lives. */
  workerUrl?: URL;
}

function workerEnv(): NodeJS.ProcessEnv {
  // The copy needs no credential, so the worker is given none (the allowlist of
  // the store-snapshot build worker, plus where destructive-fs audit lines go).
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'HOME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR', 'SystemRoot', 'TEMP', 'TMP', 'INSTAR_AUDIT_LOG_DIR', 'INSTAR_AUDIT_LOG_DISABLED']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return env;
}

/**
 * Stage on this thread, then snapshot in a worker. Resolves with the manifest.
 * Rejects when staging or the worker's snapshot fails; the staging directory is
 * removed either way. There is deliberately no timer that kills a slow worker:
 * a killed copy leaves a snapshot directory with no manifest, and slowness is
 * exactly the condition this exists to survive. The caller keeps one job in
 * flight and reports a long-running one.
 */
export function createBackupSnapshotInWorker(options: BackupSnapshotWorkerOptions): Promise<BackupSnapshot> {
  const manager = new BackupManager(options.stateDir, options.config);
  const staged = manager.stageSqliteFiles();
  const input: BackupSnapshotJobInput = { stateDir: options.stateDir, config: options.config, trigger: options.trigger, staged };
  return new Promise<BackupSnapshot>((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(options.workerUrl ?? new URL('./backupSnapshot.worker.js', import.meta.url), { workerData: input, env: workerEnv() });
    } catch (error) {
      manager.removeStaging(staged.dir);
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    let settled = false;
    const settle = (error: Error | null, snapshot?: BackupSnapshot): void => {
      if (settled) return;
      settled = true;
      if (error) { manager.removeStaging(staged.dir); reject(error); } else resolve(snapshot!);
    };
    worker.once('message', (message: { ok: boolean; snapshot?: BackupSnapshot; error?: string }) => {
      if (message.ok && message.snapshot) settle(null, message.snapshot);
      else settle(new Error(`backup snapshot worker failed: ${message.error ?? 'no snapshot returned'}`));
    });
    worker.once('error', (error) => settle(error instanceof Error ? error : new Error(String(error))));
    worker.once('exit', (code) => settle(new Error(`backup snapshot worker exited (code ${code}) before reporting a snapshot`)));
  });
}
