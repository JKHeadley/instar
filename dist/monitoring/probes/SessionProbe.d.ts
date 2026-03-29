/**
 * Session Probe — Tier 1 (Core Survival)
 *
 * Verifies the session management system can track, query, and report on sessions.
 * Does NOT spawn sessions (expensive, uses quota).
 */
import type { Probe } from '../SystemReviewer.js';
export interface SessionProbeDeps {
    /** List running sessions */
    listRunningSessions: () => Array<{
        id: string;
        tmuxSession: string;
        name: string;
    }>;
    /** Get session diagnostics */
    getSessionDiagnostics: () => {
        sessions: Array<{
            name: string;
            ageMinutes: number;
        }>;
    };
    /** Max sessions config */
    maxSessions: number;
    /** tmux binary path */
    tmuxPath: string;
}
export declare function createSessionProbes(deps: SessionProbeDeps): Probe[];
//# sourceMappingURL=SessionProbe.d.ts.map