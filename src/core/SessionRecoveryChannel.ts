/**
 * SessionRecoveryChannel — the cross-process request/ack channel for codex
 * session-wedge SELF-recovery.
 *
 * The constraint that shapes this (grounded 2026-06-03):
 *   - The DETECTOR (`StuckInputSentinel`) runs in the SERVER process.
 *   - The RESTART AUTHORITY (`ServerSupervisor` + `TelegramLifeline.replayQueue`)
 *     runs in the LIFELINE process.
 * So the sentinel cannot restart anything directly — it must cross the process
 * boundary. This channel is that boundary, modelled on the existing
 * version-skew signal-file pattern (`state/lifeline-restart-requested.json`)
 * but dedicated to per-session recovery and SAFE for two processes to share:
 *
 *   - `state/session-recovery-requested.json` — SOLE writer is the SERVER
 *     (sentinel requests recovery). The lifeline only READS it.
 *   - `state/session-recovery-acked.json` — SOLE writer is the LIFELINE
 *     (it acks progress/outcome). The server only READS it.
 *
 * Single-writer-per-file means there is never a cross-process write race; both
 * writes are atomic (temp+rename via SafeFsExecutor). Requests/acks are keyed by
 * sessionId and carry an `attemptId` so a stale ack from a prior escalation
 * episode can't be mistaken for the current one.
 *
 * Signal vs Authority: the request is a SIGNAL the server emits; the lifeline
 * holds the AUTHORITY to act (or decline). This module is pure I/O — it performs
 * NO restart and makes NO decision. Spec: docs/specs/CODEX-SESSION-WEDGE-SELF-RECOVERY.md
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import { SafeFsExecutor } from './SafeFsExecutor.js';

/** Escalation tier the sentinel is asking the lifeline to perform.
 *  - `redeliver`: re-deliver the pending/queued message to the wedged session
 *    (the targeted primitive — this is what cleared the live wedge).
 *  - `server-restart-replay`: graceful server restart + queue replay (the heavy
 *    fallback; highest blast radius, hard-gated by the caller). */
export type RecoveryTier = 'redeliver' | 'server-restart-replay';

/** Lifecycle of a recovery attempt as reported back by the lifeline. */
export type RecoveryOutcome = 'in-progress' | 'recovered' | 'failed';

export interface RecoveryRequest {
  /** tmux session name of the wedged session. */
  sessionId: string;
  tier: RecoveryTier;
  /** Human-readable reason (e.g. "input present ≥N ticks, no turn progress"). */
  reason: string;
  /** ISO timestamp the stall was observed. */
  observedAt: string;
  /** Unique per escalation episode — distinguishes a fresh request from a stale
   *  one for the same session. */
  attemptId: string;
  /** Who emitted it (e.g. 'StuckInputSentinel'). */
  requestedBy: string;
}

export interface RecoveryAck {
  sessionId: string;
  /** Echoes the request's attemptId so the server can match ack→request. */
  attemptId: string;
  tier: RecoveryTier;
  outcome: RecoveryOutcome;
  /** Optional detail (e.g. "Replay complete: 1 delivered"). */
  detail?: string;
  /** ISO timestamp of this ack. */
  updatedAt: string;
}

const REQUEST_RELPATH = path.join('state', 'session-recovery-requested.json');
const ACK_RELPATH = path.join('state', 'session-recovery-acked.json');
const COOLDOWN_RELPATH = path.join('state', 'session-recovery-cooldown.json');

interface RequestFile {
  version: 1;
  requests: Record<string, RecoveryRequest>;
}
interface AckFile {
  version: 1;
  acks: Record<string, RecoveryAck>;
}
/** Per-session last-restart timestamps (epoch ms). Sole writer is the LIFELINE.
 *  DURABLE so a tier-C server restart — which wipes the sentinel's in-memory
 *  escalation bound — cannot cause a restart loop: the lifeline checks this
 *  cooldown before every restart. */
interface CooldownFile {
  version: 1;
  restarts: Record<string, number>;
}

function readJsonOrNull<T>(filePath: string): T | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf8');
    if (!raw.trim()) return null;
    return JSON.parse(raw) as T;
  } catch {
    // Corrupt/torn file → treat as empty rather than throw. A subsequent write
    // overwrites it cleanly.
    return null;
  }
}

/**
 * Cross-process recovery request/ack channel. Construct on BOTH sides with the
 * same stateDir; the server uses the request* / readAck methods, the lifeline
 * uses the readPendingRequests / ack* methods. The class enforces the
 * single-writer-per-file invariant by never writing the file the other side owns.
 */
export class SessionRecoveryChannel {
  private readonly requestPath: string;
  private readonly ackPath: string;
  private readonly cooldownPath: string;

  constructor(stateDir: string) {
    // stateDir is the agent's .instar dir; the signal files live under
    // <stateDir>/state/ alongside the version-skew signal.
    this.requestPath = path.join(stateDir, REQUEST_RELPATH);
    this.ackPath = path.join(stateDir, ACK_RELPATH);
    this.cooldownPath = path.join(stateDir, COOLDOWN_RELPATH);
  }

  // ---- SERVER (sentinel) side — sole writer of the request file ----

  /** Emit/refresh a recovery request for a session. Idempotent per
   *  (sessionId, attemptId): re-requesting the SAME attempt is a no-op write of
   *  identical content; a NEW attemptId replaces the prior request for that
   *  session. Returns true if the file changed. */
  requestRecovery(req: RecoveryRequest): boolean {
    const file = readJsonOrNull<RequestFile>(this.requestPath) ?? { version: 1, requests: {} };
    const existing = file.requests[req.sessionId];
    if (existing && existing.attemptId === req.attemptId && existing.tier === req.tier) {
      return false; // identical in-flight request — nothing to do
    }
    file.requests[req.sessionId] = req;
    this.writeRequests(file);
    return true;
  }

  /** Read the lifeline's ack for a session (null if none). The server matches
   *  `attemptId` to confirm the ack is for the CURRENT attempt. */
  readAck(sessionId: string): RecoveryAck | null {
    const file = readJsonOrNull<AckFile>(this.ackPath);
    return file?.acks?.[sessionId] ?? null;
  }

  /** Clear a session's request after recovery is verified (or abandoned). */
  clearRequest(sessionId: string): boolean {
    const file = readJsonOrNull<RequestFile>(this.requestPath);
    if (!file || !file.requests[sessionId]) return false;
    delete file.requests[sessionId];
    this.writeRequests(file);
    return true;
  }

  // ---- LIFELINE side — sole writer of the ack file ----

  /** All pending recovery requests (server-emitted). Empty array if none. */
  readPendingRequests(): RecoveryRequest[] {
    const file = readJsonOrNull<RequestFile>(this.requestPath);
    if (!file?.requests) return [];
    return Object.values(file.requests);
  }

  /** Record/refresh the lifeline's ack for a session. Sole writer of the ack
   *  file; overwrites the prior ack for that session (the latest outcome wins). */
  ackRecovery(ack: RecoveryAck): void {
    const file = readJsonOrNull<AckFile>(this.ackPath) ?? { version: 1, acks: {} };
    file.acks[ack.sessionId] = ack;
    this.writeAcks(file);
  }

  /** Drop a session's ack once the server has consumed it (keeps the file small). */
  clearAck(sessionId: string): boolean {
    const file = readJsonOrNull<AckFile>(this.ackPath);
    if (!file || !file.acks[sessionId]) return false;
    delete file.acks[sessionId];
    this.writeAcks(file);
    return true;
  }

  // ---- LIFELINE side — durable restart cooldown (sole writer of the cooldown file) ----

  /** Record that the lifeline performed a tier-C restart for a session. DURABLE:
   *  survives the server restart that wipes the sentinel's in-memory bound, so it
   *  is the only thing standing between a restart-can't-fix wedge and an infinite
   *  restart loop. `atEpochMs` is supplied by the caller (Date.now()). */
  recordRestart(sessionId: string, atEpochMs: number): void {
    const file = readJsonOrNull<CooldownFile>(this.cooldownPath) ?? { version: 1, restarts: {} };
    file.restarts[sessionId] = atEpochMs;
    this.ensureDir(this.cooldownPath);
    SafeFsExecutor.atomicWriteJsonSync(this.cooldownPath, file, { operation: 'SessionRecoveryChannel.recordRestart' });
  }

  /** Epoch-ms of the last tier-C restart for a session, or null if none recorded. */
  lastRestartAt(sessionId: string): number | null {
    const file = readJsonOrNull<CooldownFile>(this.cooldownPath);
    const v = file?.restarts?.[sessionId];
    return typeof v === 'number' ? v : null;
  }

  /** True if a tier-C restart for this session happened within `cooldownMs` of
   *  `nowMs` — the lifeline MUST NOT restart again while this is true (loop guard). */
  isInCooldown(sessionId: string, nowMs: number, cooldownMs: number): boolean {
    const last = this.lastRestartAt(sessionId);
    return last !== null && nowMs - last < cooldownMs;
  }

  // ---- internals ----

  private ensureDir(filePath: string): void {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }

  private writeRequests(file: RequestFile): void {
    this.ensureDir(this.requestPath);
    SafeFsExecutor.atomicWriteJsonSync(this.requestPath, file, { operation: 'SessionRecoveryChannel.writeRequests' });
  }

  private writeAcks(file: AckFile): void {
    this.ensureDir(this.ackPath);
    SafeFsExecutor.atomicWriteJsonSync(this.ackPath, file, { operation: 'SessionRecoveryChannel.writeAcks' });
  }
}
