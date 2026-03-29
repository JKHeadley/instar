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
// ── Function Creation ────────────────────────────────────────────────
/**
 * Create AutoGen-compatible function definitions and handlers.
 */
export function createAutoGenFunctions(client) {
    return [
        {
            definition: {
                name: 'threadline_discover',
                description: 'Discover agents on the Threadline relay. Returns a list of agents matching the filter.',
                parameters: {
                    type: 'object',
                    properties: {
                        capability: {
                            type: 'string',
                            description: 'Filter by capability (e.g., "conversation", "code-review")',
                        },
                        framework: {
                            type: 'string',
                            description: 'Filter by framework (e.g., "crewai", "autogen", "instar")',
                        },
                        name: {
                            type: 'string',
                            description: 'Filter by agent name (partial match)',
                        },
                    },
                },
            },
            handler: async (args) => {
                const agents = await client.discover({
                    capability: args.capability,
                    framework: args.framework,
                    name: args.name,
                });
                return JSON.stringify({
                    agents: agents.map(a => ({
                        agentId: a.agentId,
                        name: a.name,
                        framework: a.framework,
                        capabilities: a.capabilities,
                    })),
                    count: agents.length,
                });
            },
        },
        {
            definition: {
                name: 'threadline_send',
                description: 'Send a message to another agent. The recipient must be discovered first using threadline_discover.',
                parameters: {
                    type: 'object',
                    properties: {
                        recipientId: {
                            type: 'string',
                            description: 'The recipient agent fingerprint from discover results',
                        },
                        message: {
                            type: 'string',
                            description: 'The message text to send',
                        },
                        threadId: {
                            type: 'string',
                            description: 'Optional thread ID for continuing a conversation',
                        },
                    },
                    required: ['recipientId', 'message'],
                },
            },
            handler: async (args) => {
                const recipientId = args.recipientId;
                const message = args.message;
                const threadId = args.threadId;
                if (!recipientId || !message) {
                    return JSON.stringify({ error: 'recipientId and message are required' });
                }
                try {
                    const messageId = client.send(recipientId, message, threadId);
                    return JSON.stringify({ messageId, status: 'sent' });
                }
                catch (err) {
                    return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
                }
            },
        },
        {
            definition: {
                name: 'threadline_list_agents',
                description: 'List all previously discovered agents.',
                parameters: {
                    type: 'object',
                    properties: {},
                },
            },
            handler: async () => {
                const agents = client.getKnownAgents();
                return JSON.stringify({
                    agents: agents.map(a => ({
                        agentId: a.agentId,
                        name: a.name,
                        framework: a.framework,
                        capabilities: a.capabilities,
                    })),
                    count: agents.length,
                });
            },
        },
        {
            definition: {
                name: 'threadline_status',
                description: 'Get the Threadline connection status and agent fingerprint.',
                parameters: {
                    type: 'object',
                    properties: {},
                },
            },
            handler: async () => {
                return JSON.stringify({
                    connectionState: client.connectionState,
                    fingerprint: client.fingerprint,
                });
            },
        },
    ];
}
//# sourceMappingURL=AutoGenTool.js.map