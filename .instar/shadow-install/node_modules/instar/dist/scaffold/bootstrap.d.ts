/**
 * Identity bootstrap — interactive flow for creating the agent's identity.
 *
 * On first run, walks the user through defining who their agent is.
 * Writes AGENT.md, USER.md, and MEMORY.md based on their answers.
 *
 * Every Instar agent has persistent identity, memory, and self-modification
 * capabilities. The only choice is how much initiative the agent takes.
 */
import type { AgentIdentity } from './templates.js';
/**
 * Run the interactive identity bootstrap.
 * Returns the agent identity for template generation.
 */
export declare function bootstrapIdentity(projectName: string): Promise<AgentIdentity>;
/**
 * Generate a default identity without interaction.
 * Used for non-interactive init (flags-only mode).
 */
export declare function defaultIdentity(projectName: string): AgentIdentity;
//# sourceMappingURL=bootstrap.d.ts.map