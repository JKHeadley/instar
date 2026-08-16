/**
 * Project Mapper — Auto-generates a territory map of the project structure.
 *
 * Scans the project directory and produces a human-readable map that
 * agents can reference to understand their spatial context: what files
 * exist, what they do, and how they relate.
 *
 * Born from the Luna incident (2026-02-25): An agent modified the wrong
 * project because it had no spatial awareness of its working environment.
 * A project map would have shown "you are HERE, working on THIS project."
 *
 * Inspired by Dawn's Guardian Territory Map (95 domains, 9,147 files).
 * Simplified for general-purpose agents: focused, practical, auto-generated.
 */
export interface ProjectMapConfig {
    /** Project root directory */
    projectDir: string;
    /** Instar state directory */
    stateDir: string;
    /** Max depth for directory traversal (default: 4) */
    maxDepth?: number;
    /** Directories to skip (default: node_modules, .git, dist, etc.) */
    skipDirs?: string[];
    /** Max files to enumerate per directory (default: 50) */
    maxFilesPerDir?: number;
}
export interface ProjectMapEntry {
    /** Relative path from project root */
    path: string;
    /** 'file' or 'directory' */
    type: 'file' | 'directory';
    /** File count (for directories) */
    fileCount?: number;
    /** File extension */
    extension?: string;
}
export interface ProjectMap {
    /** Project name (from package.json, CLAUDE.md, or directory name) */
    projectName: string;
    /** Absolute path to project root */
    projectDir: string;
    /** Git remote URL (if git repo) */
    gitRemote: string | null;
    /** Current git branch */
    gitBranch: string | null;
    /** Total file count */
    totalFiles: number;
    /** Top-level directory summary */
    directories: Array<{
        name: string;
        description: string;
        fileCount: number;
    }>;
    /** Key files (configs, entry points, etc.) */
    keyFiles: string[];
    /** Detected project type (nextjs, express, library, etc.) */
    projectType: string;
    /** Deployment targets detected */
    deploymentTargets: string[];
    /** Generated at timestamp */
    generatedAt: string;
}
export declare class ProjectMapper {
    private config;
    private skipDirs;
    constructor(config: ProjectMapConfig);
    /**
     * Generate a full project map.
     */
    generate(): ProjectMap;
    /**
     * Generate and save the project map to .instar/project-map.json + .md
     */
    generateAndSave(): ProjectMap;
    /**
     * Convert a project map to human-readable markdown for session injection.
     */
    toMarkdown(map: ProjectMap): string;
    /**
     * Get a compact summary for session-start injection (max ~20 lines).
     */
    getCompactSummary(map?: ProjectMap): string;
    /**
     * Load a previously saved project map.
     */
    loadSavedMap(): ProjectMap | null;
    private detectProjectName;
    private detectGitRemote;
    private detectGitBranch;
    private detectProjectType;
    private detectDeploymentTargets;
    private scanTopLevelDirs;
    private describeDirectory;
    private findKeyFiles;
    private countFiles;
}
//# sourceMappingURL=ProjectMapper.d.ts.map