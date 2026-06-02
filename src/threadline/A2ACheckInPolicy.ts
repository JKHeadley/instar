/**
 * A2ACheckInPolicy — the pure decision core of Layer 4 (THREADLINE-A2A-COHERENCE-SPEC).
 *
 * Layer 4 keeps the operator in the loop during an agent-to-agent conversation WITHOUT
 * flooding them (the Near-Silent Notifications lesson + the PromiseBeacon a2a-reply-wait flood).
 * Two surfaces, decided here as a pure function (no I/O — the I/O shell handles redaction,
 * the LlmQueue summarizer call, rate-limiting, and routing):
 *
 *   1. SALIENCE  — something action-required or a usable result happened (a decision the peer
 *                  raised, a completed handshake). Surfaces to the user's bound topic.
 *   2. HEARTBEAT — the operator's silence-breaker refinement (2026-06-02): the conversation is
 *                  still active AND nothing has surfaced to the user for `heartbeatIntervalMs`
 *                  (default 5-10 min). A brief "still talking to <peer>" so the user is never
 *                  left in the dark — the exact two-hour-silence that motivated the spec.
 *   3. NONE      — nothing to say; stay quiet (the default — routine churn does NOT surface).
 *
 * The heartbeat RESETS on any surface (salience or heartbeat both update `lastSurfaceAt`), so
 * the user never gets a heartbeat right after a salience surface for the same gap.
 */

export type CheckInKind = 'salience' | 'heartbeat' | 'none';

export interface CheckInDecisionInput {
  /** Is the a2a conversation still active (not resolved/idle-closed)? */
  conversationActive: boolean;
  /** A salient event occurred this tick (action-required / usable-result). */
  hasSalientEvent: boolean;
  /** Epoch ms of the last time ANY check-in surfaced to the user's topic (0 if never). */
  lastSurfaceAt: number;
  /** Now, epoch ms. */
  now: number;
  /** Silence-breaker interval (default 5-10 min). Heartbeat only fires after this much silence. */
  heartbeatIntervalMs: number;
  /** Is the silence-breaker heartbeat enabled? (Layer 4 ships default-off; this is the live flag.) */
  heartbeatEnabled: boolean;
}

export interface CheckInDecision {
  kind: CheckInKind;
  /** Human-readable reason (for the audit log + tests). */
  reason: string;
}

/**
 * Decide whether — and how — to check in with the operator about an a2a conversation.
 * Pure: no clock, no I/O. The caller passes `now` and the live config.
 *
 * Order matters: salience always wins (it's the meaningful surface); the heartbeat is the
 * fallback that only fires to BREAK silence, never on top of a recent surface.
 */
export function decideCheckIn(input: CheckInDecisionInput): CheckInDecision {
  // Salience surface — always, regardless of timing. This is the primary, meaningful check-in.
  if (input.hasSalientEvent) {
    return { kind: 'salience', reason: 'salient event (action-required / usable result)' };
  }

  // Silence-breaker heartbeat — only when enabled, the conversation is still active, AND the
  // user has heard nothing for the full interval. This is the anti-silence guarantee.
  if (!input.heartbeatEnabled) {
    return { kind: 'none', reason: 'heartbeat disabled' };
  }
  if (!input.conversationActive) {
    return { kind: 'none', reason: 'conversation not active' };
  }
  const silenceMs = input.now - input.lastSurfaceAt;
  if (silenceMs >= input.heartbeatIntervalMs) {
    return {
      kind: 'heartbeat',
      reason: `silence-breaker: ${Math.round(silenceMs / 1000)}s since last surface >= ${Math.round(
        input.heartbeatIntervalMs / 1000,
      )}s`,
    };
  }

  return { kind: 'none', reason: `recently surfaced (${Math.round(silenceMs / 1000)}s ago)` };
}

/** Default silence-breaker interval — middle of the operator's "5-10 min" range. */
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 7 * 60_000;
