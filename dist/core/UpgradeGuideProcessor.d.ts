/**
 * Upgrade Guide Processor — the "intelligence" layer of knowledge upgrades.
 *
 * PostUpdateMigrator handles mechanical patches (hooks, scripts, CLAUDE.md sections).
 * UpgradeGuideProcessor delivers higher-level guidance that each agent processes
 * intelligently based on its own evolved context.
 *
 * Each Instar version can ship with an upgrade guide (markdown file in upgrades/).
 * These guides contain:
 *   - What changed and why
 *   - Suggested actions the agent should take
 *   - Configuration hints
 *   - Behavioral guidance
 *
 * The agent reads the guide and decides how to integrate it — because every agent
 * is different, evolving separately, and best-positioned to know how new capabilities
 * fit into its own situation.
 *
 * Flow:
 *   1. `instar migrate` runs (from NEW binary after npm update)
 *   2. PostUpdateMigrator patches files mechanically
 *   3. UpgradeGuideProcessor finds unprocessed guides
 *   4. Writes pending guide to `.instar/state/pending-upgrade-guide.md`
 *   5. Session-start hook detects the file and injects it into agent context
 *   6. Agent reads, processes, and acts on the guidance
 *   7. Next `instar migrate` marks previous guides as processed
 *
 * Born from Justin's vision: "It's literally guidance. Each agent is different,
 * evolving separately — they are best-informed and most knowledgeable on how
 * to ingest these upgrades and apply to their own situation."
 */
export interface UpgradeGuideResult {
    /** Guides that were found and are pending processing by the agent */
    pendingGuides: string[];
    /** Guides already processed by the agent */
    alreadyProcessed: string[];
    /** The combined guide content for the agent to read (empty if none pending) */
    guideContent: string;
    /** Path where the pending guide was written (for session-start hook) */
    pendingGuidePath: string | null;
}
export interface UpgradeGuideConfig {
    /** The .instar state directory */
    stateDir: string;
    /** Current installed version (to determine which guides are new) */
    currentVersion: string;
    /** Version the agent upgraded FROM — only guides newer than this are delivered.
     *  If omitted, falls back to processed-upgrades.json state (legacy behavior). */
    previousVersion?: string;
}
export declare class UpgradeGuideProcessor {
    private stateDir;
    private currentVersion;
    private previousVersion;
    private processedFile;
    private pendingGuidePath;
    constructor(config: UpgradeGuideConfig);
    /**
     * Find and deliver any unprocessed upgrade guides.
     *
     * Scans the `upgrades/` directory bundled with the instar package,
     * compares against the processed state, and writes any new guides
     * to a pending file for the agent to read.
     */
    process(): UpgradeGuideResult;
    /**
     * Check if there's a pending upgrade guide waiting for the agent.
     * Used by the session-start hook.
     */
    hasPendingGuide(): boolean;
    /**
     * Get the pending guide content (for session-start hook injection).
     */
    getPendingGuide(): string | null;
    /**
     * Clear the pending guide (called after the agent has processed it).
     */
    clearPendingGuide(): void;
    /**
     * Find the upgrades/ directory bundled with the instar package.
     * Resolves relative to this module's location on disk.
     */
    private findUpgradesDir;
    /**
     * Get all available upgrade guides, sorted by version.
     */
    private getAvailableGuides;
    /**
     * Get the list of versions whose guides have already been processed.
     */
    private getProcessedVersions;
    /**
     * Mark versions as processed (their guides have been delivered to the agent).
     */
    private markProcessed;
    /**
     * Remove the pending guide file.
     */
    private cleanPendingGuide;
    /**
     * Compare two semver strings. Returns negative if a < b, positive if a > b, 0 if equal.
     */
    private compareSemver;
}
//# sourceMappingURL=UpgradeGuideProcessor.d.ts.map