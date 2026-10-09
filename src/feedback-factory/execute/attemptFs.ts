/**
 * Attempt directory removal (docs/specs/feedback-triage-and-execution.md §4 step 3: "Both clones
 * are removed by the executor through SafeFsExecutor when the attempt ends").
 *
 * Attempt clones are copies of the instar source, which SourceTreeGuard protects. The executor
 * therefore first MOVES the tree into its own trash directory under the agent's runtime state
 * (`.instar/state/...`, the guard's documented runtime-state carve-out) and only then deletes it
 * through SafeFsExecutor — so the guard is never weakened and the delete stays audited.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { SafeFsExecutor } from '../../core/SafeFsExecutor.js';

/** Remove `target` (a directory or file the executor created). Missing targets are a no-op. */
export function removeAttemptTree(target: string, trashRoot: string, operation: string): void {
  let exists = false;
  try { fs.lstatSync(target); exists = true; } catch { exists = false; } // @silent-fallback-ok: an already-absent tree needs no removal
  if (!exists) return;
  fs.mkdirSync(trashRoot, { recursive: true, mode: 0o700 });
  const parked = path.join(trashRoot, `${path.basename(target)}-${randomUUID()}`);
  fs.renameSync(target, parked);
  SafeFsExecutor.safeRmSync(parked, { recursive: true, force: true, operation });
}

/** Empty the trash directory (leftovers from a crash between move and delete). Bounded. */
export function sweepTrash(trashRoot: string, operation: string, limit = 20): number {
  let names: string[] = [];
  try { names = fs.readdirSync(trashRoot); } catch { return 0; } // @silent-fallback-ok: no trash directory yet
  let removed = 0;
  for (const name of names.slice(0, limit)) {
    try { SafeFsExecutor.safeRmSync(path.join(trashRoot, name), { recursive: true, force: true, operation }); removed++; } catch { /* @silent-fallback-ok: retried on the next sweep */ }
  }
  return removed;
}
