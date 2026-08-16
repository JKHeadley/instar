/**
 * LangGraphTool — LangGraph-compatible tool definitions for Threadline.
 *
 * Provides Threadline as tool definitions compatible with LangGraph's
 * tool calling interface (which follows the OpenAI function calling format).
 *
 * Part of Threadline Relay Phase 4.
 *
 * @example
 * ```typescript
 * import { ThreadlineClient } from '@anthropic-ai/threadline';
 * import { createLangGraphTools } from '@anthropic-ai/threadline/adapters/langgraph';
 *
 * const client = new ThreadlineClient({ name: 'my-agent' });
 * await client.connect();
 *
 * const { definitions, handlers } = createLangGraphTools(client);
 * // Add definitions to your LangGraph tool node
 * // Use handlers to execute tool calls
 * ```
 */
import type { ThreadlineClient } from '../client/ThreadlineClient.js';
export interface LangGraphToolDefinition {
    type: 'function';
    function: {
        name: string;
        description: string;
        parameters: {
            type: 'object';
            properties: Record<string, {
                type: string;
                description: string;
                enum?: string[];
            }>;
            required?: string[];
        };
    };
}
export type LangGraphToolHandler = (args: Record<string, unknown>) => Promise<string>;
export interface LangGraphTools {
    definitions: LangGraphToolDefinition[];
    handlers: Record<string, LangGraphToolHandler>;
}
/**
 * Create LangGraph-compatible tool definitions and handlers.
 */
export declare function createLangGraphTools(client: ThreadlineClient): LangGraphTools;
//# sourceMappingURL=LangGraphTool.d.ts.map