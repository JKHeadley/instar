/**
 * MESH-SELF-HEAL G1 — the serve-progress watermark (MESH-SELF-HEAL-SPEC §3.1).
 *
 * `serveProgressedMonoMs` is the THIRD liveness signal — stamped when a fetched
 * update is dispatched/served/durably-enqueued (proves end-to-end progress, closes
 * the "fetched-and-dropped" gap, finding Adv-F4). It CANNOT share the lifeline's
 * `lifeline-poll-active.json` (that record is the lifeline PROCESS's, atomically
 * rewritten on every poll-state change with no serve field — a second-process write
 * would clobber it). So it lives in its OWN single-writer record `state/serve-progress.json`,
 * written by the dispatch seam and read cross-process by the relinquish evaluator
 * (round-2 Int2-D / round-3 Les3-F1 — net-new, deliberately-acknowledged plumbing).
 *
 * THE LOAD-BEARING SAFETY: a **boot-epoch fence** (round-4 Adv4-B). Because this is a
 * persisted file (one process can't read another's memory), a stamp written by a
 * PRIOR incarnation must NEVER read as fresh after a crash/restart — else a
 * crash-stale stamp would mask a non-serving new process (re-creating the zombie).
 * The record carries a `bootId`; the reader discards any stamp whose `bootId` ≠ the
 * current incarnation (a boot-epoch fence — NOT a raw monotonic compare, which
 * across incarnations would be an invalid cross-domain subtraction). Within ONE
 * incarnation the monotonic stamps share a clock domain, so the freshness compare is
 * valid. The field is a single machine-global monotonic-MAX watermark (NOT per-topic
 * state) — concurrent dispatch-seam writers are benign because it only ever advances
 * (round-4 Adv4-A).
 *
 * Threat model + write posture mirror `pollIntent.ts`: local same-uid IPC, atomic
 * tmp+rename so the reader never sees a torn record.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const SERVE_PROGRESS_FILE = 'serve-progress.json';

export interface ServeProgressRecord {
  /** Monotonic stamp (writer's monotonic clock) at the last served/enqueued update. */
  serveProgressedMonoMs: number;
  /** Writer process incarnation marker — the boot-epoch fence. */
  bootId: string;
  /** Writer pid (parity with pollIntent; diagnostics only). */
  serverPid: number;
  /** Wall-clock of the write (diagnostics; freshness uses the monotonic stamp). */
  ts: number;
}

export function serveProgressPath(stateDir: string): string {
  return join(stateDir, SERVE_PROGRESS_FILE);
}

export function readServeProgress(stateDir: string): ServeProgressRecord | null {
  const p = serveProgressPath(stateDir);
  if (!existsSync(p)) return null;
  try {
    const rec = JSON.parse(readFileSync(p, 'utf8')) as ServeProgressRecord;
    if (
      typeof rec?.serveProgressedMonoMs !== 'number' ||
      typeof rec?.bootId !== 'string' ||
      typeof rec?.ts !== 'number'
    ) return null;
    return rec;
  } catch {
    // @silent-fallback-ok — a corrupt/unreadable serve-progress record reads as
    // "no progress yet" (null → serveProgressFresh false), the SAFE direction: a
    // holder that cannot read its own serve watermark is treated as possibly-non-
    // serving (a relinquish candidate), NEVER masked as healthy. A DegradationReporter
    // event per failed read of a best-effort liveness file would be noise.
    return null;
  }
}

/**
 * Stamp serve progress. Monotonic-MAX: only ever advances — a write with a
 * `monoMs` not greater than the current record's (SAME incarnation) is dropped, so
 * concurrent dispatch-seam writers never regress the watermark. A record from a
 * different `bootId` is always overwritten (a new incarnation starts its own clock
 * domain; the prior stamp must not survive as fresh — the boot-epoch fence).
 */
export function writeServeProgress(
  stateDir: string,
  args: { bootId: string; serverPid: number; monoMs: number },
): void {
  const { bootId, serverPid, monoMs } = args;
  const existing = readServeProgress(stateDir);
  if (existing && existing.bootId === bootId && existing.serveProgressedMonoMs >= monoMs) {
    return; // monotonic-MAX within the same incarnation — never regress
  }
  const p = serveProgressPath(stateDir);
  const tmp = `${p}.tmp.${process.pid}`;
  writeFileSync(
    tmp,
    JSON.stringify({ serveProgressedMonoMs: monoMs, bootId, serverPid, ts: Date.now() } satisfies ServeProgressRecord),
    'utf8',
  );
  renameSync(tmp, p);
}

/**
 * Is serve progress FRESH (the relinquish evaluator's read)? Boot-epoch-fenced:
 * a stamp from a different incarnation (`bootId` mismatch) is treated as "no
 * progress yet" (false) — so a crash-stale on-disk stamp can never mask a
 * non-serving new process. Within the current incarnation the monotonic compare is
 * a valid same-clock-domain subtraction. `currentBootId` + `currentMonoMs` are
 * injected (the reader's own incarnation + monotonic now) so this is pure + testable.
 */
export function serveProgressFresh(
  stateDir: string,
  currentBootId: string,
  currentMonoMs: number,
  thresholdMs: number,
): boolean {
  const rec = readServeProgress(stateDir);
  if (!rec) return false;
  if (rec.bootId !== currentBootId) return false; // boot-epoch fence
  return currentMonoMs - rec.serveProgressedMonoMs < thresholdMs;
}
