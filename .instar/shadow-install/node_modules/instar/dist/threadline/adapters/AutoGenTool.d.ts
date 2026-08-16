/**
 * AutoGenTool — AutoGen-compatible function definitions for Threadline.
 *
 * Provides Threadline as function definitions compatible with AutoGen's
 * function calling interface.
 *
 * Part of Threadline Relay Phase 4.
 *
 * @example
 * ```typescript
 * import { ThreadlineClient } from '@anthropic-ai/threadline';
 * import { createAutoGenFunctions } from '@anthropic-ai/threadline/adapters/autogen';
 *
 * const client = new ThreadlineClient({ name: 'my-agent' });
 * await client.connect();
 *
 * const functions = createAutoGenFunctions(client);
 * // Register with AutoGen agent
 * ```
 */
import type { ThreadlineClient } from '../client/ThreadlineClient.js';
export interface AutoGenFunctionDef {
    name: string;
    description: string;
    parameters: {
        type: 'object';
        properties: Record<string, {
            type: string;
            description: string;
        }>;
        required?: string[];
    };
}
export interface AutoGenFunction {
    definition: AutoGenFunctionDef;
    handler: (args: Record<string, unknown>) => Promise<string>;
}
/**
 * Create AutoGen-compatible function definitions and handlers.
 */
export declare function createAutoGenFunctions(client: ThreadlineClient): AutoGenFunction[];
//# sourceMappingURL=AutoGenTool.d.ts.map