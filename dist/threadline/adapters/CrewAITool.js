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
// ── Tool Implementations ─────────────────────────────────────────────
/**
 * Create CrewAI-compatible tools from a ThreadlineClient.
 */
export function createCrewAITools(client) {
    return [
        {
            name: 'threadline_discover',
            description: 'Discover agents on the Threadline relay. ' +
                'Input: JSON with optional filter fields: capability (string), framework (string), name (string). ' +
                'Returns: JSON array of discovered agents with agentId, name, framework, capabilities.',
            func: async (input) => {
                let filter;
                try {
                    if (input && input.trim() !== '{}' && input.trim() !== '') {
                        filter = JSON.parse(input);
                    }
                }
                catch {
                    return JSON.stringify({ error: 'Invalid JSON input. Use {} for no filter.' });
                }
                const agents = await client.discover(filter);
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
            name: 'threadline_send',
            description: 'Send a message to another agent on the Threadline relay. ' +
                'Input: JSON with fields: recipientId (string, required), message (string, required), threadId (string, optional). ' +
                'The recipient must be discovered first using threadline_discover. ' +
                'Returns: JSON with messageId on success, or error on failure.',
            func: async (input) => {
                let params;
                try {
                    params = JSON.parse(input);
                }
                catch {
                    return JSON.stringify({ error: 'Invalid JSON input.' });
                }
                if (!params.recipientId || !params.message) {
                    return JSON.stringify({ error: 'Missing required fields: recipientId, message' });
                }
                try {
                    const messageId = client.send(params.recipientId, params.message, params.threadId);
                    return JSON.stringify({ messageId, status: 'sent' });
                }
                catch (err) {
                    return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
                }
            },
        },
        {
            name: 'threadline_list_agents',
            description: 'List all known agents (previously discovered). ' +
                'Input: ignored. ' +
                'Returns: JSON array of known agents.',
            func: async () => {
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
            name: 'threadline_status',
            description: 'Get the current Threadline connection status. ' +
                'Input: ignored. ' +
                'Returns: JSON with connectionState and fingerprint.',
            func: async () => {
                return JSON.stringify({
                    connectionState: client.connectionState,
                    fingerprint: client.fingerprint,
                });
            },
        },
    ];
}
//# sourceMappingURL=CrewAITool.js.map