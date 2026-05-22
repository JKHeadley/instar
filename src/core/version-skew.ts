/**
 * Version-skew detection + lifeline-restart signal coordination.
 *
 * The signal file `state/lifeline-restart-requested.json` is written by THREE
 * independent channels (no single-point-of-failure):
 *
 *   1. AutoUpdater.requestRestart — when an apply crosses major.minor.
 *   2. Server /internal/telegram-forward 426 handler — direct evidence of skew.
 *   3. PostUpdateMigrator — one-time bootstrap nudge for currently-stuck lifelines.
 *
 * The signal is consumed by THREE independent readers:
 *
 *   1. TelegramLifeline tick loop — calls initiateRestart('plannedUpgrade').
 *   2. ServerSupervisor poll — force-restarts the lifeline if its tick hasn't
 *      acted within 60s of the signal write.
 *   3. (Future) v3 Remediator probe — absorbs both channels.
 *
 * Spec: docs/specs/auto-updater-lifeline-coordination.md
 */

import fs from 'node:fs';
import path from 'node:path';
import { SafeFsExecutor } from './SafeFsExecutor.js';

export interface LifelineRestartSignal {
  requestedAt: string;
  requestedBy: 'auto-updater' | 'server-426' | 'post-update-migrator-bootstrap';
  reason: string;
  previousVersion: string;
  targetVersion: string;
  expiresAt: string;
}

const SIGNAL_RELPATH = path.join('state', 'lifeline-restart-requested.json');

/**
 * Predicate: does going from `prev` to `next` cross a major.minor boundary?
 *
 * Examples:
 *   crossesBreaking('1.1.0', '1.2.28') === true   // minor crossed
 *   crossesBreaking('1.2.0', '1.2.28') === false  // same major.minor
 *   crossesBreaking('1.2.28', '2.0.0') === true   // major crossed
 *   crossesBreaking('1.2.28', '1.2.28') === false // identity
 *
 * Malformed inputs are treated as breaking (fail safe — prefer over-signal
 * to under-signal, since the consequence of false-positive is a single
 * harmless lifeline restart, and the consequence of false-negative is the
 * exact incident class we're closing).
 */
export function crossesBreaking(prev: string | null | undefined, next: string | null | undefined): boolean {
  if (!prev || !next) return true;
  const semverRe = /^(\d+)\.(\d+)\./;
  const mp = semverRe.exec(prev);
  const mn = semverRe.exec(next);
  if (!mp || !mn) return true;
  const [, pMaj, pMin] = mp;
  const [, nMaj, nMin] = mn;
  return pMaj !== nMaj || pMin !== nMin;
}

export interface WriteSignalOpts {
  /** Project state directory (the `.instar` dir for the agent). */
  stateDir: string;
  /** Who is writing the signal — used for the audit trail. */
  requestedBy: LifelineRestartSignal['requestedBy'];
  /** Human-readable reason — picked up by the lifeline's restart log. */
  reason: string;
  previousVersion: string;
  targetVersion: string;
  /** Optional TTL in ms (default 1h). */
  ttlMs?: number;
  /** Optional clock for tests. */
  now?: number;
}

/**
 * Write the lifeline-restart signal atomically. Idempotent: if a non-expired
 * signal already exists for the SAME targetVersion, no-ops.
 *
 * Returns 'written' / 'skipped-fresh' / 'replaced-stale'.
 */
export function writeLifelineRestartSignal(opts: WriteSignalOpts): 'written' | 'skipped-fresh' | 'replaced-stale' {
  const now = opts.now ?? Date.now();
  const ttlMs = opts.ttlMs ?? 60 * 60 * 1000;
  const signalPath = path.join(opts.stateDir, SIGNAL_RELPATH);

  // Idempotency: if an existing signal targets the same version and hasn't
  // expired, don't overwrite. This prevents duplicate audit-log entries when
  // multiple writers fire on the same boundary crossing.
  let outcome: 'written' | 'skipped-fresh' | 'replaced-stale' = 'written';
  try {
    const existing = JSON.parse(fs.readFileSync(signalPath, 'utf-8')) as LifelineRestartSignal;
    const existingExpires = Date.parse(existing.expiresAt);
    if (
      existing.targetVersion === opts.targetVersion &&
      Number.isFinite(existingExpires) &&
      existingExpires > now
    ) {
      return 'skipped-fresh';
    }
    outcome = 'replaced-stale';
  } catch {
    // No existing signal or unreadable — proceed to write a fresh one.
  }

  const signal: LifelineRestartSignal = {
    requestedAt: new Date(now).toISOString(),
    requestedBy: opts.requestedBy,
    reason: opts.reason,
    previousVersion: opts.previousVersion,
    targetVersion: opts.targetVersion,
    expiresAt: new Date(now + ttlMs).toISOString(),
  };

  // Atomic write: tmp + rename to defend against partial reads under race.
  const dir = path.dirname(signalPath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = `${signalPath}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(signal, null, 2));
    fs.renameSync(tmpPath, signalPath);
  } catch (err) {
    try { SafeFsExecutor.safeUnlinkSync(tmpPath, { operation: 'src/core/version-skew.ts:writeLifelineRestartSignal-cleanup' }); } catch { /* ignore */ }
    throw err;
  }
  return outcome;
}

/**
 * Read the signal. Returns null if missing, malformed, or expired.
 * The reader is expected to delete the file as the first step of acting on it
 * (so a respawn doesn't re-fire on the same signal).
 */
export function readLifelineRestartSignal(stateDir: string, now: number = Date.now()): LifelineRestartSignal | null {
  const signalPath = path.join(stateDir, SIGNAL_RELPATH);
  let raw: string;
  try {
    raw = fs.readFileSync(signalPath, 'utf-8');
  } catch {
    return null;
  }
  let parsed: LifelineRestartSignal;
  try {
    parsed = JSON.parse(raw) as LifelineRestartSignal;
  } catch {
    // Corrupt → treat as absent. The next write replaces it cleanly.
    return null;
  }
  const expires = Date.parse(parsed.expiresAt);
  if (!Number.isFinite(expires) || expires <= now) return null;
  return parsed;
}

/**
 * Delete the signal. Called by readers as the first step of acting on the
 * signal so a restart loop can't re-fire on the same write.
 */
export function clearLifelineRestartSignal(stateDir: string): void {
  const signalPath = path.join(stateDir, SIGNAL_RELPATH);
  try { SafeFsExecutor.safeUnlinkSync(signalPath, { operation: 'src/core/version-skew.ts:clearLifelineRestartSignal' }); } catch { /* ok — already gone */ }
}

/** Absolute path of the signal file for a given state dir. */
export function lifelineRestartSignalPath(stateDir: string): string {
  return path.join(stateDir, SIGNAL_RELPATH);
}
