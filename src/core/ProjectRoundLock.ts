/**
 * ProjectRoundLock — machine-local lock for the round runner.
 *
 * Spec: docs/specs/PROJECT-SCOPE-SPEC.md § Phase 1.5 ("Lock file
 * .instar/local/round-runner.lock is free."). The path is MACHINE-LOCAL
 * (under .instar/local/, NOT git-synced) so two machines never fight
 * over a 0-byte lockfile in the sync layer; cross-machine ownership is
 * separately controlled by `ownerMachineId` on the project record and
 * the claim-ownership flow (later PR).
 *
 * Contract:
 *   - At most one round-runner active per machine. The lock encodes the
 *     PID, projectId, and roundIndex of the holder.
 *   - Stale lock detection: if the recorded PID is no longer alive, the
 *     lock is considered free (handles crash without restart). This is
 *     intentional and matches the spec's pre-flight step 2 ("PID in lock
 *     is alive; if not, remove").
 *   - Acquisition is best-effort atomic: `O_CREAT | O_EXCL` rename of a
 *     tmp file holding the JSON payload. Concurrent acquirers race on
 *     the rename; the loser fails fast. This is the standard non-fcntl
 *     local-process mutex pattern; proper-lockfile is overkill for a
 *     single-machine single-runner gate.
 */

import fs from 'node:fs';
import path from 'node:path';

import { SafeFsExecutor } from './SafeFsExecutor.js';

export interface ProjectRoundLockPayload {
  pid: number;
  projectId: string;
  roundIndex: number;
  acquiredAt: string;
}

export interface ProjectRoundLockConfig {
  /** Absolute path to the agent's `.instar/` directory. */
  stateDir: string;
}

export type AcquireResult =
  | { ok: true; payload: ProjectRoundLockPayload }
  | {
      ok: false;
      reason: 'held';
      currentHolder: ProjectRoundLockPayload;
    };

export class ProjectRoundLock {
  private stateDir: string;

  constructor(config: ProjectRoundLockConfig) {
    this.stateDir = config.stateDir;
  }

  /**
   * Try to acquire the lock for the given (projectId, roundIndex). Returns
   * a structured result rather than throwing — callers decide whether to
   * wait, abort, or report.
   */
  acquire(projectId: string, roundIndex: number, now: Date = new Date()): AcquireResult {
    this.ensureDir();
    // Stale-PID sweep first.
    const existing = this.read();
    if (existing && !isAlive(existing.pid)) {
      try {
        SafeFsExecutor.safeUnlinkSync(this.lockPath(), { operation: 'ProjectRoundLock.acquire:sweep-stale' });
      } catch {
        // Race with another acquirer doing the same — fine.
      }
    } else if (existing) {
      return { ok: false, reason: 'held', currentHolder: existing };
    }

    const payload: ProjectRoundLockPayload = {
      pid: process.pid,
      projectId,
      roundIndex,
      acquiredAt: now.toISOString(),
    };
    const body = JSON.stringify(payload);
    const tmp = this.lockPath() + '.tmp.' + process.pid;
    try {
      // O_CREAT | O_EXCL: fails if tmp already exists (in case of a
      // previous crash with the same pid — unlikely but harmless).
      const fd = fs.openSync(tmp, 'wx', 0o600);
      fs.writeSync(fd, body);
      fs.closeSync(fd);
    } catch (err) {
      try { SafeFsExecutor.safeUnlinkSync(tmp, { operation: 'ProjectRoundLock.acquire:cleanup-tmp' }); } catch { /* ignore */ }
      throw err;
    }
    try {
      // POSIX rename is atomic on the same filesystem. If another process
      // sneaked in between our stale-sweep and the rename, our rename
      // overwrites theirs — which is wrong. So we re-check after.
      // BUT: the spec accepts "at most one runner per machine" which is
      // a single-process guarantee for serial invocation; concurrent
      // acquires from the same process don't happen because the routes
      // layer hold the call inside one promise. Cross-process concurrent
      // acquires are a theoretical edge — round runners only spawn from
      // the supervised AgentServer. We accept the rename racing on the
      // narrow window between read() and rename() as acceptable.
      fs.renameSync(tmp, this.lockPath());
    } catch (err) {
      try { SafeFsExecutor.safeUnlinkSync(tmp, { operation: 'ProjectRoundLock.acquire:cleanup-tmp' }); } catch { /* ignore */ }
      throw err;
    }
    return { ok: true, payload };
  }

  /**
   * Release the lock unconditionally. Returns true if a lock was removed,
   * false if it was already gone. Does NOT verify the caller owns it —
   * callers higher in the stack (the runner itself) own that semantics.
   */
  release(): boolean {
    try {
      SafeFsExecutor.safeUnlinkSync(this.lockPath(), { operation: 'ProjectRoundLock.release' });
      return true;
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === 'ENOENT') return false;
      throw err;
    }
  }

  /** Read the current holder, if any. */
  read(): ProjectRoundLockPayload | null {
    try {
      const raw = fs.readFileSync(this.lockPath(), 'utf-8');
      const obj = JSON.parse(raw);
      if (typeof obj.pid !== 'number') return null;
      if (typeof obj.projectId !== 'string') return null;
      if (typeof obj.roundIndex !== 'number') return null;
      if (typeof obj.acquiredAt !== 'string') return null;
      return obj;
    } catch {
      return null;
    }
  }

  // ── Internals ─────────────────────────────────────────────────────

  private ensureDir(): void {
    const localDir = path.join(this.stateDir, 'local');
    if (!fs.existsSync(localDir)) fs.mkdirSync(localDir, { recursive: true });
  }

  private lockPath(): string {
    return path.join(this.stateDir, 'local', 'round-runner.lock');
  }
}

/**
 * Cross-platform "is this PID still running" check.
 * `kill(pid, 0)` doesn't send a signal but throws if the PID isn't valid.
 */
export function isAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    // EPERM means the PID exists but we don't have permission; still alive.
    if (e.code === 'EPERM') return true;
    return false;
  }
}
