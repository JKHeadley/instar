/**
 * Project scaffolding templates for fresh installs.
 *
 * These templates create a complete, runnable Claude Code project
 * from scratch — CLAUDE.md, AGENT.md, USER.md, MEMORY.md, and
 * the full .claude/ directory structure.
 *
 * Used by `instar init <project-name>` when creating a new project.
 * When augmenting an existing project, only missing files are created.
 */
export interface AgentIdentity {
    name: string;
    role: string;
    personality: string;
    userName: string;
}
/**
 * Generate AGENT.md — the agent's identity file.
 */
export declare function generateAgentMd(identity: AgentIdentity): string;
/**
 * Generate soul.md — self-authored identity workspace.
 *
 * Seeded with the personality from init. The agent grows from here.
 * Modifications governed by trust level (enforced server-side).
 */
export declare function generateSoulMd(agentName: string, personality: string, initDate: string): string;
/**
 * Generate USER.md — context about the primary user.
 */
export declare function generateUserMd(userName: string): string;
/**
 * Generate MEMORY.md — the agent's persistent memory.
 */
export declare function generateMemoryMd(agentName: string): string;
/**
 * Generate CLAUDE.md for a fresh project.
 * This is the standalone version — not the append-to-existing version.
 */
export declare function generateClaudeMd(projectName: string, agentName: string, port: number, hasTelegram: boolean, hasWhatsApp?: boolean, hasIMessage?: boolean): string;
/**
 * Generate a seed CLAUDE.md — a compact (~250 line) version containing only
 * Tier 1 content. Detailed capability documentation is served dynamically
 * by the Self-Knowledge Tree rather than loaded statically.
 */
export declare function generateSeedClaudeMd(projectName: string, agentName: string, port: number, hasTelegram: boolean, hasWhatsApp?: boolean): string;
//# sourceMappingURL=templates.d.ts.map