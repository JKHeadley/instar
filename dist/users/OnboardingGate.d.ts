/**
 * OnboardingGate — Atomic consent gating for multi-user onboarding.
 *
 * Prevents the onboarding race condition (Gap 13, User-Agent Topology Spec):
 *   If two rapid messages arrive from an unknown user during onboarding,
 *   and isAuthorized() + onboarding trigger are not atomic, the user
 *   can bypass consent.
 *
 * The gate ensures:
 *   1. Only ONE onboarding session exists per user (no duplicates)
 *   2. Messages are buffered during 'pending' state (max MAX_PENDING_MESSAGES)
 *   3. Consent must be recorded before authorization is granted
 *   4. Stale pending sessions are auto-rejected after ONBOARDING_TIMEOUT_MINUTES
 *   5. All state transitions are synchronous (no async gaps for races)
 *
 * State machine:
 *   unknown → pending → consented → authorized (happy path)
 *   unknown → pending → rejected (user declines)
 *   pending → rejected → pending (user retries)
 */
import type { OnboardingSession } from '../core/types.js';
export interface PendingMessage {
    text: string;
    topicId: number;
    telegramUserId: number;
    timestamp: string;
}
export interface GateDecision {
    /** Whether the message should be processed */
    allowed: boolean;
    /** Reason for the decision */
    reason: 'authorized' | 'pending' | 'buffered' | 'rejected' | 'buffer-full' | 'timed-out';
    /** The current onboarding session, if one exists */
    session?: OnboardingSession;
    /** Buffered messages released on authorization */
    releasedMessages?: PendingMessage[];
}
export declare class OnboardingGate {
    /** Active onboarding sessions keyed by telegramUserId */
    private sessions;
    /** Buffered messages for pending users */
    private buffers;
    /** Set of authorized telegramUserIds (fast lookup) */
    private authorizedUsers;
    /**
     * Pre-authorize a user (e.g., loaded from persisted state).
     * Skips the onboarding flow entirely.
     */
    preAuthorize(telegramUserId: number): void;
    /**
     * Check if a user is authorized (has completed onboarding).
     */
    isAuthorized(telegramUserId: number): boolean;
    /**
     * Gate a message from a user. Returns a decision about whether to process it.
     *
     * This is the ATOMIC entry point — it handles the full check-and-act cycle
     * synchronously to prevent race conditions.
     */
    gate(telegramUserId: number, name: string, topicId: number, messageText: string): GateDecision;
    /**
     * Record user consent. Transitions pending → consented.
     * Returns null if no pending session or invalid transition.
     */
    recordConsent(telegramUserId: number): OnboardingSession | null;
    /**
     * Authorize a user after consent. Transitions consented → authorized.
     * Returns the released buffered messages, or null if invalid transition.
     *
     * CRITICAL: This is the only path to authorization. Cannot bypass consent.
     */
    authorize(telegramUserId: number): GateDecision | null;
    /**
     * Reject a user. Transitions pending → rejected.
     */
    reject(telegramUserId: number): OnboardingSession | null;
    /**
     * Allow a rejected user to retry onboarding.
     * Transitions rejected → pending.
     */
    allowRetry(telegramUserId: number): OnboardingSession | null;
    /**
     * Get the current onboarding session for a user.
     */
    getSession(telegramUserId: number): OnboardingSession | null;
    /**
     * Get buffered messages for a user.
     */
    getBufferedMessages(telegramUserId: number): PendingMessage[];
    /**
     * Clean up timed-out sessions. Returns the count of cleaned sessions.
     * Should be called periodically (e.g., every minute).
     */
    cleanupTimedOut(): number;
    /**
     * Get stats about the gate's current state.
     */
    stats(): {
        authorizedCount: number;
        pendingCount: number;
        totalBufferedMessages: number;
    };
    private bufferMessage;
    private isTimedOut;
    private cleanupSession;
}
//# sourceMappingURL=OnboardingGate.d.ts.map