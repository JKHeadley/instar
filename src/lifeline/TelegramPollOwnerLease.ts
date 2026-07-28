/**
 * TelegramPollOwnerLease — structural prevention of the Telegram 409 dual-poll.
 *
 * Background (Task 4 of the 2026-05-27 silent-stalls postmortem; spec
 * docs/specs/SELF-PROPAGATION-HARNESS-SPEC.md). Telegram allows exactly one
 * long-poller per bot token. instar has two potential pollers — the lifeline
 * (canonical, forwards to the server) and the server's `TelegramAdapter`
 * (`telegram.start()`). The server only enters send-only mode when started with
 * `--no-telegram` or on a standby machine; nothing structurally detects that a
 * lifeline already owns the poll slot. Start the server without `--no-telegram`
 * while a lifeline polls the same token → guaranteed 409 (this is what bit the
 * 2026-05-27 live test deploy). Operator discipline, not structure.
 *
 * This module fixes the class permanently: the lifeline writes a small lease
 * file each successful poll tick ("I am polling for THIS token"); the server,
 * before `telegram.start()`, reads it and auto-demotes to send-only when a
 * live lease for its own token is present. Then dual-polling cannot happen
 * regardless of flags. Fail-OPEN: a stale/absent/mismatched lease ⇒ server
 * polls as today (no regression for setups without a lifeline).
 *
 * Security: the lease stores a SHA-256 hash of the bot token, never the token.
 *
 * Spec: docs/specs/SELF-PROPAGATION-HARNESS-SPEC.md (Part 1).
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { SafeFsExecutor } from '../core/SafeFsExecutor.js';

/** SHA-256 of the bot token (hex). The lease NEVER holds the raw token. */
export function tokenHash(botToken: string): string {
  return createHash('sha256').update(botToken, 'utf8').digest('hex');
}

export interface PollOwnerLease {
  /** lifeline process pid that owns the poll slot. */
  pid: number;
  /** SHA-256 hash of the bot token the lifeline is polling for. */
  tokenHash: string;
  /** Monotonic refresh timestamp (Date.now() ms) of the last successful poll. */
  heartbeatTs: number;
  /** Lease schema version (forward-compat). */
  v: 1;
}

/** Default staleness threshold (ms). A lease whose heartbeatTs is older than
 *  this is treated as absent. 90s is comfortably > 2 × Telegram long-poll
 *  timeout (30s) + backoff, but short enough to clear within ~minute when the
 *  lifeline genuinely dies. */
export const DEFAULT_LEASE_STALE_MS = 90_000;

/** Conventional path under the agent's stateDir. */
export function leasePath(stateDir: string): string {
  return join(stateDir, 'telegram-poll-owner.json');
}

/**
 * Write/refresh the lease. Atomic via tmp+rename so a partial write can never
 * be seen by the reader. Best-effort: any failure is logged and swallowed —
 * a lease-write hiccup must NEVER take down the polling loop.
 */
export function writeLease(
  stateDir: string,
  botToken: string,
  pid: number,
  now: number = Date.now(),
): void {
  const lease: PollOwnerLease = {
    pid,
    tokenHash: tokenHash(botToken),
    heartbeatTs: now,
    v: 1,
  };
  const target = leasePath(stateDir);
  const tmp = `${target}.${pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    try { mkdirSync(dirname(target), { recursive: true }); } catch { /* dir exists */ }
    writeFileSync(tmp, JSON.stringify(lease));
    renameSync(tmp, target);
  } catch (err) {
    try { SafeFsExecutor.safeUnlinkSync(tmp, { operation: 'src/lifeline/TelegramPollOwnerLease.ts:writeLease' }); } catch { /* ignore */ }
    // Never throw — polling is what matters.
    console.warn(`[poll-owner-lease] write failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Read the lease. Returns null when:
 *   - the file doesn't exist
 *   - the file is unparseable / wrong shape
 *   - heartbeatTs is older than staleMs (treated as a dead lifeline)
 *
 * Fail-OPEN at every error path — a read hiccup must NEVER cause the server to
 * incorrectly demote to send-only (that would silence a fine agent).
 */
export function readLease(
  stateDir: string,
  now: number = Date.now(),
  staleMs: number = DEFAULT_LEASE_STALE_MS,
): PollOwnerLease | null {
  const target = leasePath(stateDir);
  if (!existsSync(target)) return null;
  try {
    const raw = readFileSync(target, 'utf8');
    const parsed = JSON.parse(raw) as Partial<PollOwnerLease>;
    if (
      typeof parsed !== 'object' || parsed === null ||
      typeof parsed.pid !== 'number' ||
      typeof parsed.tokenHash !== 'string' || parsed.tokenHash.length === 0 ||
      typeof parsed.heartbeatTs !== 'number' ||
      parsed.v !== 1
    ) {
      return null;
    }
    if (now - parsed.heartbeatTs > staleMs) return null;
    return parsed as PollOwnerLease;
  } catch {
    return null;
  }
}

/**
 * The server's decision question, in one place: "given the bot token I'd be
 * about to poll for, does a live lifeline already own the slot?" True ⇒ the
 * server should demote to send-only. False ⇒ poll as today (fail-OPEN: missing
 * lease, mismatched token, or any read failure all answer false).
 */
export function lifelineOwnsPoll(
  stateDir: string,
  botToken: string,
  now: number = Date.now(),
  staleMs: number = DEFAULT_LEASE_STALE_MS,
): boolean {
  const lease = readLease(stateDir, now, staleMs);
  if (!lease) return false;
  return lease.tokenHash === tokenHash(botToken);
}
