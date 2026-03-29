/**
 * `instar init` — Initialize agent infrastructure.
 *
 * Two modes:
 *   instar init <project-name>   — Create a new project from scratch
 *   instar init                  — Augment an existing project
 *
 * Fresh install creates:
 *   <project-name>/
 *   ├── CLAUDE.md              — Agent instructions (standalone)
 *   ├── .instar/
 *   │   ├── AGENT.md           — Agent identity
 *   │   ├── USER.md            — Primary user context
 *   │   ├── MEMORY.md          — Persistent memory
 *   │   ├── config.json        — Agent configuration
 *   │   ├── jobs.json          — Job definitions
 *   │   ├── users.json         — User profiles
 *   │   ├── hooks/             — Behavioral guardrails
 *   │   ├── state/             — Runtime state
 *   │   ├── relationships/     — Relationship tracking
 *   │   └── logs/              — Server logs
 *   ├── .claude/
 *   │   ├── settings.json      — Hook configuration
 *   │   └── scripts/           — Health watchdog, etc.
 *   └── .gitignore
 *
 * Existing project adds .instar/ and appends to CLAUDE.md.
 */
interface InitOptions {
    dir?: string;
    name?: string;
    port?: number;
    interactive?: boolean;
    /** Create a standalone agent at ~/.instar/agents/<name>/ */
    standalone?: boolean;
    /** Skip prerequisite checks (for testing). When true, uses provided or default paths. */
    skipPrereqs?: boolean;
}
/**
 * Main init entry point. Handles both fresh and existing project modes.
 */
export declare function initProject(options: InitOptions): Promise<void>;
/**
 * Refresh hooks, Claude settings, and CLAUDE.md for an existing installation.
 * Called after updates to ensure new hooks and documentation are installed.
 * Re-writes all hook files (idempotent), merges new hooks into settings,
 * appends any missing sections to CLAUDE.md, and installs scripts for
 * configured integrations (e.g., Telegram relay).
 */
export declare function refreshHooksAndSettings(projectDir: string, stateDir: string): void;
export {};
//# sourceMappingURL=init.d.ts.map