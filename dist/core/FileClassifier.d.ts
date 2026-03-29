/**
 * FileClassifier — Routes files to appropriate merge strategies before LLM resolution.
 *
 * Not all files can be text-merged. Lockfiles need regeneration, binaries need
 * ours/theirs selection, and generated artifacts should be excluded entirely.
 * This classifier prevents wasting LLM tokens on files that have deterministic
 * resolution strategies.
 *
 * From INTELLIGENT_SYNC_SPEC Section 12 — File Classification and Special Handling.
 */
export type FileClass = 'structured-data' | 'source-code' | 'documentation' | 'lockfile' | 'binary' | 'generated' | 'large-file' | 'secret';
export type MergeStrategy = 'programmatic' | 'llm' | 'regenerate' | 'ours-theirs' | 'exclude' | 'never-sync';
export interface ClassificationResult {
    /** The classified file type. */
    fileClass: FileClass;
    /** The recommended merge strategy. */
    strategy: MergeStrategy;
    /** For lockfiles: regeneration commands [strict, fallback]. */
    regenCommands?: string[];
    /** For lockfiles: the associated manifest file (e.g., package.json). */
    manifestFile?: string;
    /** Human-readable reason for this classification. */
    reason: string;
}
export interface FileClassifierConfig {
    /** Project directory (repo root). */
    projectDir: string;
    /** Custom lockfile patterns to add. */
    extraLockfilePatterns?: string[];
    /** Custom lockfile regeneration commands. */
    extraRegenCommands?: Record<string, string[]>;
    /** Custom binary extensions to add. */
    extraBinaryExtensions?: string[];
    /** Custom generated artifact patterns to add. */
    extraExcludePatterns?: string[];
    /** Custom secret patterns to add. */
    extraSecretPatterns?: string[];
}
export declare class FileClassifier {
    private projectDir;
    private lockfilePatterns;
    private regenCommands;
    private binaryExtensions;
    private generatedPatterns;
    private secretPatterns;
    constructor(config: FileClassifierConfig);
    /**
     * Classify a file and determine its merge strategy.
     */
    classify(filePath: string): ClassificationResult;
    /**
     * Resolve a lockfile conflict by regenerating from manifest.
     * Returns true if regeneration succeeded.
     */
    regenerateLockfile(filePath: string, classification: ClassificationResult): {
        success: boolean;
        command?: string;
        error?: string;
    };
    /**
     * Resolve a binary file conflict using hash divergence detection.
     * Returns which side to pick, or 'conflict' if both sides changed.
     */
    resolveBinary(filePath: string): {
        resolution: 'ours' | 'theirs' | 'conflict';
        reason: string;
    };
    private isSecret;
    private isGenerated;
    private isLockfile;
    private isStructuredData;
    private getStageHash;
}
//# sourceMappingURL=FileClassifier.d.ts.map