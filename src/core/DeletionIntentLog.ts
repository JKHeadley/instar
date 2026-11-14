/**
 * DeletionIntentLog — the durable "this record was deliberately deleted" note a store's
 * own delete method writes, so a deletion made in ANY process (the `instar knowledge` /
 * `instar relationship` CLIs included) can replicate as a tombstone.
 *
 * Spec: docs/specs/statesync-writer-agnostic-reconciler.md §4 step 4.
 *
 * Why it exists: the replicated-store reconciler reads store files from disk, and a row
 * that disappeared from disk is NOT evidence of deletion — a lost update (two CLI
 * processes rewriting one file) or a stale whole-file save looks identical. So the
 * reconciler never infers a deletion from absence; it tombstones only what a delete
 * method recorded here.
 *
 * Shape: two lines per deletion, appended to
 * `<stateDir>/state/reconcile/intents/<store>.jsonl` (under `state/`, which the default
 * `.gitignore` ignores and git-sync never carries):
 *   { recordKey, deletedAt, phase: 'pending' }            — before the row is removed
 *   { recordKey, deletedAt, hlcFloor, phase: 'done' }     — after the removal is durable
 * Only a `done` line can produce a tombstone. `hlcFloor` is this machine's replication
 * HLC as persisted when `done` is written: the server's clock persists atomically on every
 * advance, so every own put issued before the removal compares ≤ it and every later put
 * compares greater — an ordering with no wall-clock comparison. No identity is stored:
 * `recordKey` is the same pseudonymous key the tombstone itself replicates.
 *
 * Every function here is best-effort for WRITERS: a failure is returned, never thrown,
 * because a local delete must never fail on replication bookkeeping.
 */

import fs from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { HlcTimestamp } from './HybridLogicalClock.js';

export interface DeletionIntentLine {
  recordKey: string;
  deletedAt: string;
  phase: 'pending' | 'done';
  /** Present on `done` lines: the persisted replication HLC after the removal, or null. */
  hlcFloor?: HlcTimestamp | null;
}

/** The pointer file the server writes at boot naming its live replication clock file. */
export function clockPointerPath(stateDir: string): string {
  return path.join(stateDir, 'state', 'reconcile', 'clock-file.json');
}

export function intentLogPath(stateDir: string, store: string): string {
  return path.join(stateDir, 'state', 'reconcile', 'intents', `${store}.jsonl`);
}

/**
 * Write the clock pointer (server side, at boot). Atomic temp+rename. A machine whose
 * identity changed keeps an abandoned clock file beside the live one; the pointer is how a
 * deleting process finds the live one.
 */
export function writeClockPointer(stateDir: string, clockFile: string): void {
  const p = clockPointerPath(stateDir);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify({ path: clockFile }));
  fs.renameSync(tmp, p);
}

/**
 * Read this machine's persisted replication HLC through the pointer. Null when the pointer
 * or the clock file is missing, unreadable or malformed (journal dark ⇒ nothing was
 * replicated; or corrupt) — never throws.
 */
export function readPersistedClock(stateDir: string): HlcTimestamp | null {
  try {
    const ptr = JSON.parse(fs.readFileSync(clockPointerPath(stateDir), 'utf-8')) as { path?: unknown };
    if (typeof ptr?.path !== 'string' || ptr.path.length === 0) return null;
    const hlc = JSON.parse(fs.readFileSync(ptr.path, 'utf-8')) as Partial<HlcTimestamp>;
    if (
      typeof hlc?.physical !== 'number' || !Number.isFinite(hlc.physical) ||
      typeof hlc.logical !== 'number' || !Number.isFinite(hlc.logical) ||
      typeof hlc.node !== 'string'
    ) {
      return null;
    }
    return { physical: hlc.physical, logical: hlc.logical, node: hlc.node };
  } catch { /* @silent-fallback-ok: a missing/corrupt clock means the deletion carries no floor and never fires — the safe direction; the reconciler counts it (intentNoClock). */
    return null;
  }
}

function appendLine(stateDir: string, store: string, line: DeletionIntentLine): boolean {
  try {
    const p = intentLogPath(stateDir, store);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.appendFileSync(p, JSON.stringify(line) + '\n');
    return true;
  } catch (e) { /* @silent-fallback-ok: a local delete must never fail on replication bookkeeping; this one deletion then does not replicate (today's CLI behaviour) and the failure is logged. */
    console.warn(`[deletion-intent] could not record a ${line.phase} deletion intent for ${store}: ${(e as Error)?.message}`);
    return false;
  }
}

/** Phase 1 — call BEFORE removing the row. Returns false (never throws) on failure. */
export function recordDeletionPending(stateDir: string, store: string, recordKey: string, deletedAt: string): boolean {
  return appendLine(stateDir, store, { recordKey, deletedAt, phase: 'pending' });
}

/** Phase 2 — call AFTER the removal is durable. Reads the clock floor now. */
export function recordDeletionDone(stateDir: string, store: string, recordKey: string, deletedAt: string): boolean {
  return appendLine(stateDir, store, { recordKey, deletedAt, phase: 'done', hlcFloor: readPersistedClock(stateDir) });
}

export interface DeletionIntentScan {
  /** The newest line per recordKey (file order). */
  newest: Map<string, DeletionIntentLine>;
  /** Pending lines with no matching later `done` for the same (recordKey, deletedAt). */
  pendingOnly: DeletionIntentLine[];
  bytes: number;
}

/**
 * Read an intent log with a chunked reader (yields between chunks). Missing file ⇒ empty.
 * An unparseable line is skipped: a missing intent can only withhold a tombstone.
 */
export async function readDeletionIntents(stateDir: string, store: string): Promise<DeletionIntentScan> {
  const p = intentLogPath(stateDir, store);
  const newest = new Map<string, DeletionIntentLine>();
  const pending = new Map<string, DeletionIntentLine>();
  let bytes = 0;
  let fd: number | null = null;
  try {
    fd = fs.openSync(p, 'r');
  } catch { /* @silent-fallback-ok: no intent log yet = no deletions recorded. */
    return { newest, pendingOnly: [], bytes: 0 };
  }
  const visit = (raw: string) => {
    if (!raw) return;
    let line: DeletionIntentLine;
    try {
      line = JSON.parse(raw) as DeletionIntentLine;
    } catch { /* @silent-fallback-ok: a torn/garbled line withholds at most one tombstone. */
      return;
    }
    if (typeof line?.recordKey !== 'string' || typeof line.deletedAt !== 'string') return;
    if (line.phase !== 'pending' && line.phase !== 'done') return;
    newest.set(line.recordKey, line);
    const opKey = `${line.recordKey}\u0000${line.deletedAt}`;
    if (line.phase === 'pending') pending.set(opKey, line);
    else pending.delete(opKey);
  };
  try {
    const buf = Buffer.alloc(64 * 1024);
    const decoder = new StringDecoder('utf8');
    let carry = '';
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (n <= 0) break;
      bytes += n;
      carry += decoder.write(buf.subarray(0, n));
      let nl: number;
      while ((nl = carry.indexOf('\n')) >= 0) {
        visit(carry.slice(0, nl));
        carry = carry.slice(nl + 1);
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    visit(carry + decoder.end());
  } finally {
    try { fs.closeSync(fd); } catch { /* @silent-fallback-ok: closing a read descriptor is best-effort. */ }
  }
  return { newest, pendingOnly: [...pending.values()], bytes };
}
