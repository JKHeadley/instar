/**
 * AgentMdAtomicSave — race-safe two-rename commit for agentmd job edits.
 *
 * Per INSTAR-JOBS-AS-AGENTMD spec §Design Principles "Override = fork;
 * race-safe two-rename commit":
 *
 *   The save sequence is md-first, manifest-last:
 *     1. Write `<file>.md.new` (staged body).
 *     2. Write `<schedule>.json.new` (staged manifest).
 *     3. rename(<file>.md.new → <file>.md)          ← rename A
 *     4. rename(<schedule>.json.new → <schedule>.json)  ← rename B
 *
 * SIGKILL between rename A and rename B leaves a consistent state: the
 * new body is on disk paired with the OLD manifest. The loader handles
 * this gracefully — it loads the new body and the old manifest's
 * schedule, which is a strictly-progressed state.
 *
 * SIGKILL before rename A is also consistent: the old body + old
 * manifest are intact; the `.new` staged files are orphaned and the next
 * boot's reconcile() can either reapply or discard them.
 *
 * Re-applying a half-committed save is idempotent because each rename is
 * atomic at the filesystem level and overwrites any pre-existing target.
 *
 * This module is the canonical save helper for both Dashboard edits and
 * future CLI edit commands. It is NOT yet wired into a UI consumer — the
 * Phase 4 Dashboard UI rewrite is the consumer. Shipping the helper
 * separately so the spec's atomicity guarantee has a tested
 * implementation regardless of when the UI lands.
 */

import fs from 'node:fs';
import path from 'node:path';
import { SafeFsExecutor } from '../core/SafeFsExecutor.js';

export interface AtomicSaveInput {
  /** Final on-disk path of the .md body (e.g., `.instar/jobs/user/<slug>.md`). */
  mdPath: string;
  /** Final on-disk path of the per-slug manifest (e.g.,
   *  `.instar/jobs/schedule/<slug>.json`). */
  manifestPath: string;
  /** Bytes to write to mdPath. Caller is responsible for any normalization. */
  mdBody: string;
  /** Object to JSON-serialize into manifestPath. */
  manifest: Record<string, unknown>;
}

export interface AtomicSaveResult {
  ok: true;
  mdWritten: string;
  manifestWritten: string;
}

export interface AtomicSaveFailure {
  ok: false;
  stage: 'stage-md' | 'stage-manifest' | 'commit-md' | 'commit-manifest';
  reason: string;
  partial: {
    mdNewExists: boolean;
    manifestNewExists: boolean;
    mdCommitted: boolean;
    manifestCommitted: boolean;
  };
}

/**
 * Two-rename atomic save. Writes the body first, then the manifest. Each
 * write goes to a `.new` sibling, then renames atomically over the final
 * path. On failure at any stage, returns a structured `AtomicSaveFailure`
 * the caller can use to drive recovery / Issues-card surface.
 *
 * Implementation notes:
 *   - We DO NOT delete the staged `.new` files on failure — leaving them
 *     in place gives reconcile() something to reason about. The next
 *     successful save will overwrite them.
 *   - `fs.renameSync` is atomic on POSIX filesystems for paths on the
 *     same filesystem (always the case here — both live under .instar/).
 *   - `fs.writeFileSync` with `flag: 'w'` truncates; we use it
 *     deliberately so a half-written `.new` on retry is replaced.
 */
export function atomicSaveAgentMdJob(input: AtomicSaveInput): AtomicSaveResult | AtomicSaveFailure {
  const { mdPath, manifestPath, mdBody, manifest } = input;
  const mdNew = mdPath + '.new';
  const manifestNew = manifestPath + '.new';
  const partial = {
    mdNewExists: false,
    manifestNewExists: false,
    mdCommitted: false,
    manifestCommitted: false,
  };

  // Stage 1: ensure both parent directories exist.
  try {
    fs.mkdirSync(path.dirname(mdPath), { recursive: true });
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  } catch (err) {
    return {
      ok: false,
      stage: 'stage-md',
      reason: `Failed to create parent directories: ${err instanceof Error ? err.message : String(err)}`,
      partial,
    };
  }

  // Stage 2: write the body to its .new sibling.
  try {
    fs.writeFileSync(mdNew, mdBody, { encoding: 'utf-8', flag: 'w' });
    partial.mdNewExists = true;
  } catch (err) {
    return {
      ok: false,
      stage: 'stage-md',
      reason: `Failed to stage md body: ${err instanceof Error ? err.message : String(err)}`,
      partial,
    };
  }

  // Stage 3: write the manifest to its .new sibling.
  try {
    fs.writeFileSync(manifestNew, JSON.stringify(manifest, null, 2) + '\n', { encoding: 'utf-8', flag: 'w' });
    partial.manifestNewExists = true;
  } catch (err) {
    return {
      ok: false,
      stage: 'stage-manifest',
      reason: `Failed to stage manifest: ${err instanceof Error ? err.message : String(err)}`,
      partial,
    };
  }

  // Stage 4 (rename A): commit md-first. After this, the body is durable.
  try {
    fs.renameSync(mdNew, mdPath);
    partial.mdCommitted = true;
    partial.mdNewExists = false;
  } catch (err) {
    return {
      ok: false,
      stage: 'commit-md',
      reason: `Failed to commit md body: ${err instanceof Error ? err.message : String(err)}`,
      partial,
    };
  }

  // Stage 5 (rename B): commit manifest-last. SIGKILL between renames A
  // and B leaves the new body + old manifest, which is a consistent
  // strictly-progressed state.
  try {
    fs.renameSync(manifestNew, manifestPath);
    partial.manifestCommitted = true;
    partial.manifestNewExists = false;
  } catch (err) {
    return {
      ok: false,
      stage: 'commit-manifest',
      reason: `Failed to commit manifest: ${err instanceof Error ? err.message : String(err)}`,
      partial,
    };
  }

  return { ok: true, mdWritten: mdPath, manifestWritten: manifestPath };
}

/**
 * Discover any `.new` staged files left over from a crashed save. Used by
 * reconcile() to surface "interrupted save" Issues-card rows.
 */
export function listStagedNewFiles(jobsRootDir: string): string[] {
  const staged: string[] = [];
  walk(jobsRootDir, (file) => {
    if (file.endsWith('.md.new') || file.endsWith('.json.new')) {
      staged.push(file);
    }
  });
  return staged;
}

function walk(dir: string, visit: (file: string) => void): void {
  if (!fs.existsSync(dir)) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, visit);
    else if (e.isFile()) visit(p);
  }
}

/**
 * Clean up an orphaned `.new` file. Used by reconcile() when the operator
 * chooses "Discard staged changes" in the Issues-card UI. Routes through
 * SafeFsExecutor per the destructive-tool funnel.
 */
export function discardStagedFile(stagedPath: string): void {
  SafeFsExecutor.safeUnlinkSync(stagedPath, { operation: 'AgentMdAtomicSave discard staged .new file' });
}
