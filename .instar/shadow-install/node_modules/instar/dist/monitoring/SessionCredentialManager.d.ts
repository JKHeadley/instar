/**
 * SessionCredentialManager — session-scoped credential isolation.
 *
 * Instead of mutating global credential state (Keychain) during migration,
 * each session gets its credentials injected via environment variables.
 * This prevents switching for one session from disrupting all others.
 *
 * Part of the Instar Quota Migration spec (Phase 1).
 */
import type { ClaudeCredentials } from './CredentialProvider.js';
export interface SessionCredentialAssignment {
    sessionId: string;
    email: string;
    credentials: ClaudeCredentials;
    assignedAt: string;
}
export declare class SessionCredentialManager {
    private assignments;
    /**
     * Assign a specific account's credentials to a session.
     * The session will use these credentials exclusively.
     */
    assignAccount(sessionId: string, email: string, credentials: ClaudeCredentials): void;
    /**
     * Get the environment variables to inject into a session's process.
     * These override any global credential the process would otherwise use.
     *
     * Returns an empty object if no credentials are assigned (session uses global default).
     */
    getSessionEnv(sessionId: string): Record<string, string>;
    /**
     * Get the full assignment for a session (for status/debugging).
     */
    getAssignment(sessionId: string): SessionCredentialAssignment | undefined;
    /**
     * Release a session's credential assignment (after session ends).
     */
    releaseSession(sessionId: string): boolean;
    /**
     * Which sessions are currently using a given account?
     */
    getSessionsForAccount(email: string): string[];
    /**
     * Get all current assignments (for status display).
     */
    getAllAssignments(): SessionCredentialAssignment[];
    /**
     * How many sessions are currently assigned credentials?
     */
    get activeCount(): number;
    /**
     * Clear all assignments (for shutdown/reset).
     */
    clear(): void;
}
//# sourceMappingURL=SessionCredentialManager.d.ts.map