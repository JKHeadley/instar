/**
 * Platform Probe — Tier 3 (Environment Readiness)
 *
 * Verifies platform-specific prerequisites are met.
 * On macOS, tests whether tmux sessions can access TCC-protected directories
 * (Desktop, Documents, Downloads) without triggering permission popups.
 * Skipped entirely on non-macOS platforms.
 */
import type { Probe } from '../SystemReviewer.js';
export interface PlatformProbeDeps {
    /** Path to the tmux binary being used */
    tmuxPath: string;
}
export declare function createPlatformProbes(deps: PlatformProbeDeps): Probe[];
//# sourceMappingURL=PlatformProbe.d.ts.map