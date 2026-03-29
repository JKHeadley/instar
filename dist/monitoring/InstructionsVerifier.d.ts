/**
 * InstructionsVerifier — Tracks and verifies Claude Code instruction file loading.
 *
 * When Claude Code starts, it loads CLAUDE.md files and fires InstructionsLoaded
 * for each one. This module:
 *   1. Records which files loaded (called from the InstructionsLoaded hook)
 *   2. Verifies that expected files were loaded (called from session-start hook)
 *   3. Alerts if critical identity context is missing
 *
 * Part of the Claude Code Feature Integration Audit:
 * - Item 3 (New Hook Events): InstructionsLoaded for identity verification (H4)
 *
 * Lifecycle:
 *   InstructionsLoaded fires (per file) -> recordLoad() appends to tracking file
 *   SessionStart fires (after all instructions load) -> verify() checks expectations
 */
export interface InstructionLoadRecord {
    /** ISO timestamp when recorded */
    timestamp: string;
    /** Path to the loaded instruction file */
    filePath: string;
    /** Memory type: User, Project, Local, Managed */
    memoryType: string;
    /** Why it loaded: eager (startup), lazy (subdirectory trigger) */
    loadReason?: string;
    /** Claude Code session ID */
    sessionId?: string;
}
export interface VerificationResult {
    /** Whether all expected files were found */
    passed: boolean;
    /** Files that were expected but not loaded */
    missing: string[];
    /** Files that were loaded */
    loaded: InstructionLoadRecord[];
    /** Human-readable summary */
    summary: string;
}
export interface InstructionsVerifierConfig {
    /** State directory for persisting tracking data */
    stateDir: string;
    /**
     * Patterns that MUST match at least one loaded file path.
     * Uses substring matching (not regex) for simplicity.
     * Default: ['CLAUDE.md'] — at minimum, the project CLAUDE.md should load.
     */
    expectedPatterns?: string[];
}
export declare class InstructionsVerifier {
    private config;
    private trackingDir;
    constructor(config: InstructionsVerifierConfig);
    /**
     * Record an instruction file load. Called from the InstructionsLoaded hook.
     */
    recordLoad(record: Omit<InstructionLoadRecord, 'timestamp'>): void;
    /**
     * Get all recorded loads for a session.
     */
    getLoads(sessionId?: string): InstructionLoadRecord[];
    /**
     * Verify that expected instruction files were loaded.
     * Call this from the session-start hook after InstructionsLoaded events fire.
     */
    verify(sessionId?: string): VerificationResult;
    /**
     * Clear tracking data for a session (e.g., on session restart).
     */
    clearSession(sessionId?: string): void;
    /**
     * List all sessions with tracking data.
     */
    listSessions(): string[];
    private getTrackingFile;
}
//# sourceMappingURL=InstructionsVerifier.d.ts.map