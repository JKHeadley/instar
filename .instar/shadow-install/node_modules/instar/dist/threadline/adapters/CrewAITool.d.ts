/**
 * CrewAITool — CrewAI-compatible tool wrapper for Threadline.
 *
 * Provides Threadline messaging as a CrewAI tool that agents can use
 * to discover and communicate with other agents on the relay.
 *
 * Part of Threadline Relay Phase 4.
 *
 * @example
 * ```typescript
 * import { ThreadlineClient } from '@anthropic-ai/threadline';
 * import { createCrewAITools } from '@anthropic-ai/threadline/adapters/crewai';
 *
 * const client = new ThreadlineClient({ name: 'my-agent' });
 * await client.connect();
 *
 * const tools = createCrewAITools(client);
 * // tools.discover, tools.send, tools.listAgents, tools.status
 * ```
 */
import type { ThreadlineClient } from '../client/ThreadlineClient.js';
export interface CrewAIToolDefinition {
    name: string;
    description: string;
    func: (input: string) => Promise<string>;
}
/**
 * Create CrewAI-compatible tools from a ThreadlineClient.
 */
export declare function createCrewAITools(client: ThreadlineClient): CrewAIToolDefinition[];
//# sourceMappingURL=CrewAITool.d.ts.map