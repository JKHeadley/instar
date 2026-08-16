/**
 * SessionCredentialManager — session-scoped credential isolation.
 *
 * Instead of mutating global credential state (Keychain) during migration,
 * each session gets its credentials injected via environment variables.
 * This prevents switching for one session from disrupting all others.
 *
 * Part of the Instar Quota Migration spec (Phase 1).
 */
import { redactToken, redactEmail } from './CredentialProvider.js';
export class SessionCredentialManager {
    assignments = new Map();
    /**
     * Assign a specific account's credentials to a session.
     * The session will use these credentials exclusively.
     */
    assignAccount(sessionId, email, credentials) {
        this.assignments.set(sessionId, {
            sessionId,
            email,
            credentials,
            assignedAt: new Date().toISOString(),
        });
        console.log(`[SessionCredentialManager] Assigned ${redactEmail(email)} to session ${sessionId} ` +
            `(token: ${redactToken(credentials.accessToken)})`);
    }
    /**
     * Get the environment variables to inject into a session's process.
     * These override any global credential the process would otherwise use.
     *
     * Returns an empty object if no credentials are assigned (session uses global default).
     */
    getSessionEnv(sessionId) {
        const assignment = this.assignments.get(sessionId);
        if (!assignment)
            return {};
        return {
            ANTHROPIC_AUTH_TOKEN: assignment.credentials.accessToken,
            CLAUDE_ACCOUNT_EMAIL: assignment.email,
        };
    }
    /**
     * Get the full assignment for a session (for status/debugging).
     */
    getAssignment(sessionId) {
        return this.assignments.get(sessionId);
    }
    /**
     * Release a session's credential assignment (after session ends).
     */
    releaseSession(sessionId) {
        const had = this.assignments.has(sessionId);
        if (had) {
            const assignment = this.assignments.get(sessionId);
            console.log(`[SessionCredentialManager] Released ${redactEmail(assignment.email)} from session ${sessionId}`);
        }
        this.assignments.delete(sessionId);
        return had;
    }
    /**
     * Which sessions are currently using a given account?
     */
    getSessionsForAccount(email) {
        const sessions = [];
        for (const [sessionId, assignment] of this.assignments) {
            if (assignment.email === email) {
                sessions.push(sessionId);
            }
        }
        return sessions;
    }
    /**
     * Get all current assignments (for status display).
     */
    getAllAssignments() {
        return Array.from(this.assignments.values());
    }
    /**
     * How many sessions are currently assigned credentials?
     */
    get activeCount() {
        return this.assignments.size;
    }
    /**
     * Clear all assignments (for shutdown/reset).
     */
    clear() {
        this.assignments.clear();
    }
}
//# sourceMappingURL=SessionCredentialManager.js.map