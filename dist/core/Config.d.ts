/**
 * Auto-detection and configuration management.
 *
 * Finds tmux, Claude CLI, and project structure automatically.
 * Adapted from dawn-server's config.ts — the battle-tested version.
 */
import type { InstarConfig } from './types.js';
export declare function getInstarVersion(): string;
export declare function detectGitPath(): string | null;
export declare function detectGhPath(): string | null;
export declare function detectTmuxPath(): string | null;
export declare function detectClaudePath(): string | null;
export declare function detectProjectDir(startDir?: string): string;
/**
 * Get the path to the standalone agents directory.
 */
export declare function standaloneAgentsDir(): string;
/**
 * Resolve an agent directory from a name or path.
 *
 * Resolution order:
 * 1. If nameOrPath is an absolute path under ~/.instar/agents/ or cwd, use it
 * 2. If nameOrPath matches a standalone agent name, return ~/.instar/agents/<name>/
 * 3. If no argument, use detectProjectDir() (existing behavior)
 */
export declare function resolveAgentDir(nameOrPath?: string): string;
export declare function loadConfig(projectDir?: string): InstarConfig;
/**
 * Ensure the state directory structure exists.
 */
export declare function ensureStateDir(stateDir: string): void;
//# sourceMappingURL=Config.d.ts.map