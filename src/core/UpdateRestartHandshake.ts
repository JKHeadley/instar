/**
 * UpdateRestartHandshake — version-skew restart verification.
 *
 * PROBLEM (codex-instar audit Item 4): AutoUpdater currently notifies the
 * user "Just updated to vX. Restarting..." BEFORE the restart actually
 * takes effect. If the restart fails (binary mismatch, supervisor stall,
 * any reason the new process doesn't come up on the new code), the user
 * has been told the update is live when it isn't. Operators assume fixes
 * are deployed; they aren't.
 *
 * SOLUTION: A two-phase handshake.
 *
 * Phase 1 (before restart, inside the OLD process):
 *   AutoUpdater calls writePendingHandshake({
 *     expectedVersion: newVersion,
 *     previousVersion: currentVersion,
 *     deferredNotification: "Just updated to vX. ...",
 *   }).
 *   The notification is NOT sent yet — it's stashed in the handshake file.
 *
 * Phase 2 (server startup, inside the NEW process):
 *   On boot, verifyRestartHandshake() reads the file and compares
 *   ProcessIntegrity.runningVersion against expectedVersion.
 *   - Match: emit the deferredNotification (now truthful), clear the file.
 *   - Mismatch: emit an honest failure notification ("Update applied but
 *     restart didn't take effect — still running stale vY") and increment
 *     retryCount. After N failures, escalate via IMMEDIATE channel.
 *
 * File: `<stateDir>/state/restart-handshake.json`
 * Persistence: survives process restart (that's the whole point).
 */

import fs from 'node:fs';
import path from 'node:path';
import { SafeFsExecutor } from './SafeFsExecutor.js';

export interface HandshakeState {
  /** Version we expected to be running after the restart we triggered. */
  expectedVersion: string;
  /** Version we were on before applying the update. */
  previousVersion: string;
  /** Notification text the OLD process WOULD have sent immediately; we
   * deferred it so we could only send after verifying the restart took. */
  deferredNotification: string;
  /** When the handshake was written (ISO). */
  triggeredAt: string;
  /** Boot-count check attempts. Incremented each time the NEW process
   * comes up still showing runningVersion !== expectedVersion. */
  retryCount: number;
}

export interface HandshakeWriteInput {
  expectedVersion: string;
  previousVersion: string;
  deferredNotification: string;
}

export class UpdateRestartHandshake {
  private readonly filePath: string;

  constructor(stateDir: string) {
    this.filePath = path.join(stateDir, 'state', 'restart-handshake.json');
  }

  /**
   * Phase 1 — called in the OLD process before requesting a restart.
   * Atomic write: tmp + rename.
   */
  writePendingHandshake(input: HandshakeWriteInput): void {
    const state: HandshakeState = {
      expectedVersion: input.expectedVersion,
      previousVersion: input.previousVersion,
      deferredNotification: input.deferredNotification,
      triggeredAt: new Date().toISOString(),
      retryCount: 0,
    };

    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, this.filePath);
  }

  /**
   * Phase 2 — called in the NEW process at server startup.
   * Returns null when no handshake is pending.
   */
  readPendingHandshake(): HandshakeState | null {
    if (!fs.existsSync(this.filePath)) return null;
    try {
      const raw = fs.readFileSync(this.filePath, 'utf-8');
      const parsed = JSON.parse(raw) as Partial<HandshakeState>;
      if (
        typeof parsed.expectedVersion !== 'string' ||
        typeof parsed.previousVersion !== 'string' ||
        typeof parsed.deferredNotification !== 'string' ||
        typeof parsed.triggeredAt !== 'string'
      ) {
        return null;
      }
      return {
        expectedVersion: parsed.expectedVersion,
        previousVersion: parsed.previousVersion,
        deferredNotification: parsed.deferredNotification,
        triggeredAt: parsed.triggeredAt,
        retryCount: typeof parsed.retryCount === 'number' ? parsed.retryCount : 0,
      };
    } catch {
      // Corrupt or unreadable — treat as no pending handshake. Caller
      // should not block startup on a malformed marker.
      return null;
    }
  }

  /** Phase 2 — successful verification, clear the marker. */
  clearHandshake(): void {
    try {
      // safeRmSync with force:true is rm -f semantics — no throw if the
      // marker is already absent, so no existsSync guard needed.
      SafeFsExecutor.safeRmSync(this.filePath, {
        force: true,
        operation: 'UpdateRestartHandshake.clearHandshake',
      });
    } catch {
      // @silent-fallback-ok — clearing failure is non-fatal; the next
      // successful boot will rewrite or re-clear.
    }
  }

  /**
   * Phase 2 — failed verification. Bump retryCount and persist.
   * Returns the new retryCount.
   */
  bumpRetryCount(): number {
    const current = this.readPendingHandshake();
    if (!current) return 0;
    const next: HandshakeState = { ...current, retryCount: current.retryCount + 1 };
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
    fs.renameSync(tmp, this.filePath);
    return next.retryCount;
  }
}

/**
 * Outcome enum from verifyRestartHandshake — callers branch on this to
 * decide what to send and at what priority.
 */
export type HandshakeVerificationOutcome =
  | { kind: 'no-handshake' }
  | { kind: 'verified'; expectedVersion: string; previousVersion: string; deferredNotification: string }
  | { kind: 'failed'; expectedVersion: string; previousVersion: string; runningVersion: string; retryCount: number; escalate: boolean };

/**
 * Verify a pending handshake at server startup.
 *
 * - No handshake → `{kind: 'no-handshake'}`. Caller does nothing.
 * - runningVersion === expectedVersion → `{kind: 'verified', ...}`.
 *   Caller sends the deferred notification and clears the handshake.
 * - runningVersion !== expectedVersion → `{kind: 'failed', ...}`.
 *   `bumpRetryCount` is called automatically. `escalate: true` when
 *   retryCount has reached the escalation threshold (default 2 — first
 *   boot logs the failure, second boot escalates loud).
 *
 * The function does NOT clear the handshake on failure; the marker
 * persists so the NEXT boot can also verify (and escalate sooner).
 */
export function verifyRestartHandshake(opts: {
  handshake: UpdateRestartHandshake;
  runningVersion: string;
  escalationThreshold?: number;
}): HandshakeVerificationOutcome {
  const pending = opts.handshake.readPendingHandshake();
  if (!pending) return { kind: 'no-handshake' };

  if (opts.runningVersion === pending.expectedVersion) {
    return {
      kind: 'verified',
      expectedVersion: pending.expectedVersion,
      previousVersion: pending.previousVersion,
      deferredNotification: pending.deferredNotification,
    };
  }

  const threshold = opts.escalationThreshold ?? 2;
  const newRetryCount = opts.handshake.bumpRetryCount();
  return {
    kind: 'failed',
    expectedVersion: pending.expectedVersion,
    previousVersion: pending.previousVersion,
    runningVersion: opts.runningVersion,
    retryCount: newRetryCount,
    escalate: newRetryCount >= threshold,
  };
}
