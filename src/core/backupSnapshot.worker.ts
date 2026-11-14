/**
 * backupSnapshot.worker — the trivial `worker_threads` entry for a state
 * snapshot taken off the server's main thread. It holds no logic that can
 * drift: it reads `workerData`, runs runBackupSnapshotJob() and posts the
 * manifest back. See backupSnapshotJob.ts for why this exists.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { runBackupSnapshotJob, type BackupSnapshotJobInput } from './backupSnapshotJob.js';

function main(): void {
  if (!parentPort) return; // not run as a worker: nothing to post to
  try {
    parentPort.postMessage({ ok: true, snapshot: runBackupSnapshotJob(workerData as BackupSnapshotJobInput) });
  } catch (error) {
    parentPort.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
}

main();
