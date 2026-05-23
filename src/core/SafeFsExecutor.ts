// safe-git-allow: this file is the single funnel point for destructive fs invocations.
/**
 * SafeFsExecutor — the single funnel for destructive filesystem invocations.
 *
 * Parallel structure to SafeGitExecutor. Wraps `fs.rm`, `fs.rmSync`,
 * `fs.unlink`, `fs.unlinkSync`, `fs.rmdir`, `fs.rmdirSync` (and their
 * promises-API counterparts). Each wrapper:
 *
 *   1. Canonicalizes `target` via `realpathSync` (or nearest-existing-ancestor
 *      if the target itself doesn't exist — `assertNotInstarSourceTree`
 *      handles this internally).
 *   2. Calls `assertNotInstarSourceTree(target, operation)`. On failure,
 *      throws SourceTreeGuardError BEFORE touching disk.
 *   3. Performs the actual fs operation.
 *   4. Appends a JSON line to .instar/audit/destructive-ops.jsonl.
 *
 * See docs/specs/COMPREHENSIVE-DESTRUCTIVE-TOOL-CONTAINMENT-SPEC.md.
 */

import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import {
  assertNotInstarSourceTree,
  SourceTreeGuardError,
} from './SourceTreeGuard.js';
import { appendAuditEntry } from './SafeGitExecutor.js';

export interface SafeFsOptions {
  /** Caller label for error messages and audit log. */
  operation: string;
}

export type SafeRmOptions = fs.RmOptions & SafeFsOptions;
export type SafeRmDirOptions = fs.RmDirOptions & SafeFsOptions;

function captureCallerFrame(): string {
  const e = new Error();
  const stack = (e.stack || '').split('\n');
  return (stack[3] || stack[2] || '').trim();
}

function audit(
  fnName: string,
  operation: string,
  target: string,
  outcome: 'allowed' | 'denied',
  reason?: string,
): void {
  const entry: Record<string, unknown> = {
    timestamp: new Date().toISOString(),
    executor: 'fs',
    operation,
    verb: fnName,
    target,
    outcome,
    caller: captureCallerFrame(),
  };
  if (reason !== undefined) entry.reason = reason;
  appendAuditEntry(entry as never);
}

function canonicalizeTarget(target: string): string {
  try {
    return fs.realpathSync(path.resolve(target));
  } catch {
    return path.resolve(target);
  }
}

/**
 * Agent runtime state carve-out.
 *
 * When instar is deployed in "agent" mode the agent dir IS a checkout of the
 * instar source (same .git, same .instar-source-tree marker, same package.json
 * with name === "instar"). The guard correctly identifies this as the source
 * tree — but runtime artifacts under `.instar/` (sockets, locks, logs, audit
 * trail) are explicitly NOT source code (they are .gitignored). Destructive
 * ops on those paths are a normal part of operation, not a 2026-04-22-class
 * incident.
 *
 * This predicate returns true when `canonical` is anywhere under an `.instar/`
 * subdirectory of the source root — those are runtime state and the guard's
 * brittle-block is a false positive for them.
 *
 * The check is intentionally narrow: it requires `/.instar/` as an interior
 * path segment (not just trailing), so operations on the `.instar` directory
 * itself still go through the guard. The carve-out is for files INSIDE it.
 */
function isUnderAgentRuntimeState(canonical: string): boolean {
  const sep = path.sep;
  const marker = `${sep}.instar${sep}`;
  const idx = canonical.indexOf(marker);
  if (idx === -1) return false;
  return canonical.length > idx + marker.length;
}

function guard(target: string, operation: string, fnName: string): string {
  const canonical = canonicalizeTarget(target);
  // Carve-out: runtime state under `.instar/` is gitignored, not source code.
  // The guard's brittle-block is a false positive for these paths in
  // agent-mode deployments where the agent dir IS a checkout of the source.
  // See isUnderAgentRuntimeState() above for the precise predicate.
  if (isUnderAgentRuntimeState(canonical)) {
    audit(fnName, operation, canonical, 'allowed', 'agent-runtime-state-carveout');
    return canonical;
  }
  try {
    assertNotInstarSourceTree(canonical, operation);
  } catch (err) {
    if (err instanceof SourceTreeGuardError) {
      audit(fnName, operation, canonical, 'denied', err.message);
    }
    throw err;
  }
  return canonical;
}

// ── Public API ──────────────────────────────────────────────────────

export class SafeFsExecutor {
  /** Async fs.promises.rm wrapper. */
  static async safeRm(target: string, opts: SafeRmOptions): Promise<void> {
    const { operation, ...rmOpts } = opts;
    const canonical = guard(target, operation, 'safeRm');
    try {
      await fsp.rm(target, rmOpts);
      audit('safeRm', operation, canonical, 'allowed');
    } catch (err) {
      audit('safeRm', operation, canonical, 'denied', `rm-error: ${(err as Error).message}`);
      throw err;
    }
  }

  /** Sync fs.rmSync wrapper. */
  static safeRmSync(target: string, opts: SafeRmOptions): void {
    const { operation, ...rmOpts } = opts;
    const canonical = guard(target, operation, 'safeRmSync');
    try {
      fs.rmSync(target, rmOpts);
      audit('safeRmSync', operation, canonical, 'allowed');
    } catch (err) {
      audit('safeRmSync', operation, canonical, 'denied', `rm-error: ${(err as Error).message}`);
      throw err;
    }
  }

  /** Async fs.promises.unlink wrapper. */
  static async safeUnlink(target: string, opts: SafeFsOptions): Promise<void> {
    const canonical = guard(target, opts.operation, 'safeUnlink');
    try {
      await fsp.unlink(target);
      audit('safeUnlink', opts.operation, canonical, 'allowed');
    } catch (err) {
      audit('safeUnlink', opts.operation, canonical, 'denied', `unlink-error: ${(err as Error).message}`);
      throw err;
    }
  }

  /** Sync fs.unlinkSync wrapper. */
  static safeUnlinkSync(target: string, opts: SafeFsOptions): void {
    const canonical = guard(target, opts.operation, 'safeUnlinkSync');
    try {
      fs.unlinkSync(target);
      audit('safeUnlinkSync', opts.operation, canonical, 'allowed');
    } catch (err) {
      audit('safeUnlinkSync', opts.operation, canonical, 'denied', `unlink-error: ${(err as Error).message}`);
      throw err;
    }
  }

  /** Async fs.promises.rmdir wrapper. */
  static async safeRmdir(target: string, opts: SafeRmDirOptions): Promise<void> {
    const { operation, ...rmOpts } = opts;
    const canonical = guard(target, operation, 'safeRmdir');
    try {
      await fsp.rmdir(target, rmOpts);
      audit('safeRmdir', operation, canonical, 'allowed');
    } catch (err) {
      audit('safeRmdir', operation, canonical, 'denied', `rmdir-error: ${(err as Error).message}`);
      throw err;
    }
  }

  /** Sync fs.rmdirSync wrapper. */
  static safeRmdirSync(target: string, opts: SafeRmDirOptions): void {
    const { operation, ...rmOpts } = opts;
    const canonical = guard(target, operation, 'safeRmdirSync');
    try {
      fs.rmdirSync(target, rmOpts);
      audit('safeRmdirSync', operation, canonical, 'allowed');
    } catch (err) {
      audit('safeRmdirSync', operation, canonical, 'denied', `rmdir-error: ${(err as Error).message}`);
      throw err;
    }
  }

  // ── Atomic write ────────────────────────────────────────────────────
  //
  // Crash-safe file writes for file-backed state. The failure these prevent:
  // a direct `fs.writeFileSync` truncates the target THEN writes; if the
  // process crashes (or the disk fills) mid-write, the file is left
  // truncated or partially written — and for append-only event logs / JSON
  // state, that means silent data loss when the next reader hits a parse
  // error and falls back to an empty skeleton.
  //
  // The pattern: write to a sibling temp file in the SAME directory (so the
  // rename stays on one filesystem and is therefore atomic per POSIX),
  // fsync the data to durable storage, then rename over the target. A crash
  // at any point leaves EITHER the old file intact OR the fully-written new
  // file — never a half-written one.
  //
  // Cherry-picked into Instar 2026-05-23 from the GSD-Instar integration
  // spike (gsd-executor Rule 2 finding: file-backed state lacked atomic
  // writes). Not a destructive op, so it does not go through the
  // source-tree guard — but it lives here as the natural home for safe-fs
  // primitives and shares the audit trail.

  /**
   * Atomically write a string to `target`. Writes to a temp sibling, fsyncs,
   * then renames over the target. Creates parent directories if missing.
   */
  static atomicWriteFileSync(target: string, data: string | Uint8Array, opts?: { operation?: string; mode?: number }): void {
    const operation = opts?.operation ?? 'atomicWriteFileSync';
    const resolved = path.resolve(target);
    const dir = path.dirname(resolved);
    // Ensure parent dir exists (matches the convenience of writeFileSync callers
    // who often forget mkdir).
    fs.mkdirSync(dir, { recursive: true });
    // Temp file in the SAME directory so rename is atomic (same filesystem).
    const tmp = path.join(dir, `.${path.basename(resolved)}.${process.pid}.${Date.now()}.tmp`);
    let fd: number | undefined;
    try {
      fd = fs.openSync(tmp, 'w', opts?.mode ?? 0o644);
      fs.writeSync(fd, data as never);
      fs.fsyncSync(fd);   // flush data to durable storage before rename
      fs.closeSync(fd);
      fd = undefined;
      fs.renameSync(tmp, resolved);  // atomic replace
      audit('atomicWriteFileSync', operation, resolved, 'allowed');
    } catch (err) {
      // Best-effort cleanup of the temp file; never mask the original error.
      try { if (fd !== undefined) fs.closeSync(fd); } catch { /* ignore */ }
      try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { /* ignore */ }
      audit('atomicWriteFileSync', operation, resolved, 'denied', `write-error: ${(err as Error).message}`);
      throw err;
    }
  }

  /**
   * Atomically write `value` as pretty-printed JSON to `target`.
   * Convenience wrapper around atomicWriteFileSync — the common case for
   * Instar's `.instar/state/*.json` files.
   */
  static atomicWriteJsonSync(target: string, value: unknown, opts?: { operation?: string; mode?: number; indent?: number }): void {
    const json = JSON.stringify(value, null, opts?.indent ?? 2);
    this.atomicWriteFileSync(target, json, { operation: opts?.operation ?? 'atomicWriteJsonSync', mode: opts?.mode });
  }
}

// Re-export the guard error so call-site catch blocks don't have to import
// from two modules.
export { SourceTreeGuardError };
