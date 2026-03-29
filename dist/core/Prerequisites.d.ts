/**
 * Prerequisite detection and auto-installation.
 *
 * Checks for required software (tmux, Claude CLI, Node.js)
 * and offers to install missing dependencies automatically.
 */
export interface PrerequisiteResult {
    name: string;
    found: boolean;
    path?: string;
    version?: string;
    installHint: string;
    /** Whether this prerequisite can be auto-installed. */
    canAutoInstall: boolean;
    /** The command to run to auto-install this prerequisite. */
    installCommand?: string;
}
export interface PrerequisiteCheck {
    allMet: boolean;
    results: PrerequisiteResult[];
    missing: PrerequisiteResult[];
}
/**
 * Check all prerequisites and return a structured result.
 */
export declare function checkPrerequisites(): PrerequisiteCheck;
/**
 * Print prerequisite check results to console.
 * Returns true if all prerequisites are met.
 */
export declare function printPrerequisiteCheck(check: PrerequisiteCheck): boolean;
/**
 * Interactive prerequisite check that offers to install missing dependencies.
 * Returns a fresh PrerequisiteCheck after any installations.
 */
export declare function ensurePrerequisites(): Promise<PrerequisiteCheck>;
//# sourceMappingURL=Prerequisites.d.ts.map