/**
 * RuntimeRelocator — the transactional move that relocates an agent's `.instar`
 * runtime out of a TCC-protected folder into the runtime root launchd can reach.
 *
 * Spec: docs/specs/macos26-launchd-tcc-runtime-relocation.md (Scope A).
 *
 * MECHANISM REFINEMENT (tracked deviation from the converged spec text):
 * The converged spec described "build the new root in `<root>.partial-<pid>`,
 * verify, atomic rename, write sentinel last." That framing assumed a COPY into
 * `.partial`. During implementation a cleaner, strictly-safer mechanism for the
 * common case (same APFS volume — verified `df` shows ~/Documents and ~/Library
 * share /dev/disk3s5) emerged: a single whole-directory `rename()` of the entire
 * `.instar` tree into the runtime root. This is instant, atomic at the directory
 * level, moves the hundreds-of-MB `shadow-install/` for free (resolving the
 * "don't copy shadow-install" requirement), and removes the partial-copy /
 * dual-live-copy class entirely — there is only ever ONE copy of the tree, it
 * just lives at a new path. Rollback is the inverse rename. The `.partial`
 * copy+verify path is retained ONLY for the cross-volume fallback (rename across
 * volumes is not atomic / not allowed), where copy is unavoidable.
 *
 * This module performs ONLY the move + symlink + sentinel. It does NOT rewrite
 * the launchd plist (that's the caller's job, via setup.ts) and it does NOT
 * decide whether to relocate (the migrator's detection gate + EPERM probe do).
 * Keeping the fs mechanics isolated here makes them unit-testable with temp dirs.
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  RELOCATE_SENTINEL,
  RELOCATE_SCHEMA_VERSION,
  projectDirHash,
  type RelocateRecord,
} from './InstarRuntimeRoot.js';

export interface RelocateOptions {
  projectDir: string;
  projectName: string;
  /** Target runtime root (absolute). Computed by computeRuntimeRoot at first
   *  relocation. */
  runtimeRoot: string;
  /** Injectable for tests. */
  log?: (msg: string) => void;
}

export interface RelocateResult {
  ok: boolean;
  /** Set when ok=false. */
  error?: string;
  record?: RelocateRecord;
}

/** Are two paths on the same filesystem device? Used to choose the atomic-rename
 *  fast path vs the cross-volume copy fallback. */
export function sameVolume(a: string, b: string): boolean {
  try {
    // Compare the nearest existing ancestor of each (the targets may not exist yet).
    const devA = fs.statSync(nearestExisting(a)).dev;
    const devB = fs.statSync(nearestExisting(b)).dev;
    return devA === devB;
  } catch {
    return false;
  }
}

function nearestExisting(p: string): string {
  let dir = path.resolve(p);
  while (dir !== path.dirname(dir)) {
    if (fs.existsSync(dir)) return dir;
    dir = path.dirname(dir);
  }
  return dir;
}

/** Remove any orphaned `<root>.partial-*` dirs from a crashed prior attempt
 *  (convergence NEW-H2 retryability). Best-effort. */
export function sweepStalePartials(runtimeRoot: string): void {
  const parent = path.dirname(runtimeRoot);
  const base = path.basename(runtimeRoot);
  let entries: string[] = [];
  try { entries = fs.readdirSync(parent); } catch { return; }
  for (const e of entries) {
    if (e.startsWith(`${base}.partial-`)) {
      try { fs.rmSync(path.join(parent, e), { recursive: true, force: true }); } catch { /* best effort */ }
    }
  }
}

/**
 * Verify a runtime root is a usable agent home: the node symlink resolves +
 * executes, config.json parses. (The shadow-install entrypoint check is the
 * caller's concern — it needs a node binary to exec; here we keep it to the
 * cheap structural checks so the relocator stays pure-fs + one optional probe.)
 */
export function verifyRuntimeRoot(runtimeRoot: string, runNodeProbe?: (nodePath: string) => boolean): { ok: boolean; reason?: string } {
  const configPath = path.join(runtimeRoot, 'config.json');
  if (!fs.existsSync(configPath)) return { ok: false, reason: 'config.json missing in new root' };
  try { JSON.parse(fs.readFileSync(configPath, 'utf-8')); }
  catch { return { ok: false, reason: 'config.json does not parse in new root' }; }

  const nodeSymlink = path.join(runtimeRoot, 'bin', 'node');
  if (fs.existsSync(nodeSymlink) && runNodeProbe) {
    if (!runNodeProbe(nodeSymlink)) return { ok: false, reason: 'node symlink in new root cannot execute' };
  }
  return { ok: true };
}

/**
 * Relocate `<projectDir>/.instar` to `runtimeRoot`, transactionally.
 *
 * CALLER CONTRACT: only invoke from a CONSENTED context (the migrator's EPERM
 * probe must have confirmed the source `.instar/config.json` is readable). This
 * function will read/move the source tree, which EPERMs in a launchd-spawned
 * TCC-blind context — the migrator must not reach here in that case.
 *
 * Sequence (same-volume fast path):
 *   1. sweep stale `.partial-*`
 *   2. ensure runtime-root parent exists; refuse if runtimeRoot already exists
 *      and is non-empty (avoid clobbering another agent / a prior good root)
 *   3. atomic `rename(<projectDir>/.instar, runtimeRoot)`  ← the whole tree moves
 *   4. verify the new root; on failure rename back (rollback) and return error
 *   5. recreate `<projectDir>/.instar` as a symlink → runtimeRoot
 *   6. write `relocate.json` (completed:true) LAST, into runtimeRoot
 *
 * Cross-volume fallback: copy the tree into `<root>.partial-<pid>`, verify,
 * rename `.partial`→root, remove original `.instar`, symlink. (Not implemented
 * inline yet — cross-volume is the rare defensive case per OQ4; this throws a
 * typed error so the migrator can surface `relocate-needs-network`.)
 */
export function relocateRuntime(opts: RelocateOptions, runNodeProbe?: (nodePath: string) => boolean): RelocateResult {
  const log = opts.log ?? (() => {});
  const sourceInstar = path.join(opts.projectDir, '.instar');
  const { runtimeRoot } = opts;

  if (!fs.existsSync(sourceInstar)) {
    return { ok: false, error: `source .instar does not exist at ${sourceInstar}` };
  }
  // If .instar is already a symlink, the agent is (or was) relocated — caller's
  // idempotency short-circuit should have caught this; refuse to double-move.
  if (fs.lstatSync(sourceInstar).isSymbolicLink()) {
    return { ok: false, error: '.instar is already a symlink (already relocated)' };
  }

  sweepStalePartials(runtimeRoot);

  if (fs.existsSync(runtimeRoot)) {
    const entries = (() => { try { return fs.readdirSync(runtimeRoot); } catch { return ['?']; } })();
    if (entries.length > 0) {
      return { ok: false, error: `runtime root already exists and is non-empty: ${runtimeRoot}` };
    }
    // Empty dir from a prior aborted attempt — remove so rename can take the path.
    try { fs.rmdirSync(runtimeRoot); } catch { /* ignore */ }
  }

  fs.mkdirSync(path.dirname(runtimeRoot), { recursive: true });

  if (!sameVolume(sourceInstar, runtimeRoot)) {
    // Cross-volume: rename() would EXDEV. Defensive-only path (OQ4).
    return {
      ok: false,
      error: `cross-volume relocation (${sourceInstar} → ${runtimeRoot}) requires the copy path (relocate-needs-network); not attempted on the same-volume fast path`,
    };
  }

  // ── Step 3: the atomic whole-tree move ──────────────────────────────────
  try {
    fs.renameSync(sourceInstar, runtimeRoot);
    log(`relocated tree ${sourceInstar} → ${runtimeRoot} (atomic rename)`);
  } catch (err) {
    return { ok: false, error: `rename failed: ${(err as Error).message}` };
  }

  // ── Step 4: verify; rollback on failure ─────────────────────────────────
  const verdict = verifyRuntimeRoot(runtimeRoot, runNodeProbe);
  if (!verdict.ok) {
    // Rollback: move it back so .instar is genuinely restored.
    try {
      fs.renameSync(runtimeRoot, sourceInstar);
      log(`rollback: restored ${sourceInstar} (verify failed: ${verdict.reason})`);
    } catch (err) {
      // Worst case: the tree is at runtimeRoot but .instar is gone. Surface loudly.
      return {
        ok: false,
        error: `verify failed (${verdict.reason}) AND rollback failed (${(err as Error).message}) — tree is at ${runtimeRoot}, .instar missing; run 'instar relocate' to repair`,
      };
    }
    return { ok: false, error: `verify failed: ${verdict.reason}` };
  }

  // ── Step 5: recreate .instar as a symlink → runtimeRoot ─────────────────
  try {
    fs.symlinkSync(runtimeRoot, sourceInstar);
    log(`symlinked ${sourceInstar} → ${runtimeRoot}`);
  } catch (err) {
    // Rollback the move so we don't leave the agent with no .instar at all.
    try { fs.renameSync(runtimeRoot, sourceInstar); } catch { /* best effort */ }
    return { ok: false, error: `symlink creation failed: ${(err as Error).message}` };
  }

  // ── Step 6: write relocate.json LAST, in the runtime root ───────────────
  const record: RelocateRecord = {
    schemaVersion: RELOCATE_SCHEMA_VERSION,
    completed: true,
    runtimeRoot,
    projectDir: opts.projectDir,
    projectDirHash: projectDirHash(opts.projectDir),
    projectName: opts.projectName,
    relocatedAt: new Date().toISOString(),
  };
  try {
    const sentinelPath = path.join(runtimeRoot, RELOCATE_SENTINEL);
    const tmp = `${sentinelPath}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(record, null, 2));
    fs.renameSync(tmp, sentinelPath); // atomic sentinel write
    log(`wrote completion sentinel ${sentinelPath}`);
  } catch (err) {
    // The move + symlink succeeded; only the sentinel failed. The agent is
    // functional but a re-run won't short-circuit. Surface, don't rollback
    // (rolling back a working relocation is riskier than a missing sentinel).
    return { ok: false, error: `relocation succeeded but sentinel write failed: ${(err as Error).message}`, record };
  }

  return { ok: true, record };
}
