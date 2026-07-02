/**
 * handbackLatch — the U4.4 operator-flip latch marker (R-r2-5: "the human
 * always wins", with a MECHANICAL attribution definition).
 *
 * The latch is WRITTEN BY the explicit flip action itself — the PIN-gated
 * captain-flip lever / the manual playbook's POST step — NEVER inferred from a
 * transfer's origin. A lease move WITHOUT the marker is just a lease move (the
 * reconciler may hand it back); a move WITH the marker holds the reconciler
 * fully inert until `suppressedUntil` (default 24h; clearable early).
 *
 * Machine-local by design (the latch suppresses THIS holder's reconciler);
 * the marker is inert data under rollback.
 */

import fs from 'node:fs';
import path from 'node:path';
import { SafeFsExecutor } from './SafeFsExecutor.js';

export interface HandbackLatchRecord {
  suppressedUntil: string; // ISO
  reason?: string;
  writtenAt: string; // ISO
}

function latchPath(stateDir: string): string {
  return path.join(stateDir, 'state', 'handback-operator-latch.json');
}

/** Read the latch. Returns the suppressed-until epoch-ms, or null when absent /
 *  malformed / expired-file-still-present (an expired latch reads as none). */
export function readHandbackLatchUntilMs(stateDir: string, nowMs: number = Date.now()): number | null {
  try {
    const raw = fs.readFileSync(latchPath(stateDir), 'utf-8');
    const obj = JSON.parse(raw) as HandbackLatchRecord;
    const until = Date.parse(obj?.suppressedUntil ?? '');
    if (!Number.isFinite(until)) return null;
    return until > nowMs ? until : null;
  } catch {
    // @silent-fallback-ok — absent/malformed marker = no latch; the reconciler's
    // other bounds (hysteresis, episode cap, churn breaker) still apply.
    return null;
  }
}

/** Read the full record (for status surfaces). Null when absent/malformed. */
export function readHandbackLatchRecord(stateDir: string): HandbackLatchRecord | null {
  try {
    const raw = fs.readFileSync(latchPath(stateDir), 'utf-8');
    const obj = JSON.parse(raw) as HandbackLatchRecord;
    if (typeof obj?.suppressedUntil !== 'string') return null;
    return obj;
  } catch {
    return null; // @silent-fallback-ok — status-surface read; absent/malformed marker reads as no latch record
  }
}

/** Write the latch (called BY the flip action — route/playbook POST step). */
export function writeHandbackLatch(stateDir: string, latchMs: number, reason?: string, nowMs: number = Date.now()): HandbackLatchRecord {
  const record: HandbackLatchRecord = {
    suppressedUntil: new Date(nowMs + Math.max(0, latchMs)).toISOString(),
    ...(reason ? { reason } : {}),
    writtenAt: new Date(nowMs).toISOString(),
  };
  const p = latchPath(stateDir);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(record, null, 2));
  fs.renameSync(tmp, p);
  return record;
}

/** Clear the latch early (re-flip / config edit path). */
export function clearHandbackLatch(stateDir: string): void {
  try {
    SafeFsExecutor.safeUnlinkSync(latchPath(stateDir), { operation: 'handback-latch-clear' });
  } catch {
    // absent = already clear (idempotent)
  }
}
