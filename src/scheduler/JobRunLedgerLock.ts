import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import lockfile from 'proper-lockfile';

const STALE_MS = 30_000;
const sleeper = new Int32Array(new SharedArrayBuffer(4));

/** Both appenders and startup replacement lock the same stable sibling path. */
export function withJobRunLedgerLock<T>(file: string, waitMs: number, operation: () => T): T {
  const target = path.join(fs.realpathSync(path.dirname(file)), path.basename(file));
  const deadline = performance.now() + waitMs;
  let release: () => void;
  for (;;) {
    try {
      // The ledger inode is replaceable and may not exist on the first write.
      release = lockfile.lockSync(target, { realpath: false, stale: STALE_MS });
      break;
    } catch (error) {
      const remaining = deadline - performance.now();
      if ((error as NodeJS.ErrnoException).code !== 'ELOCKED' || remaining <= 0) throw error;
      Atomics.wait(sleeper, 0, 0, Math.min(20, remaining));
    }
  }
  try {
    return operation();
  } finally {
    release();
  }
}

/** A writer can wait through a crash-stale lock. Startup compaction can simply skip contention. */
export const JOB_RUN_LEDGER_WRITE_WAIT_MS = STALE_MS + 5000;
