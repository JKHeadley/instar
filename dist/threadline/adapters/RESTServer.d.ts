/**
 * RESTServer — Local REST API wrapper for Threadline.
 *
 * Exposes Threadline operations as HTTP endpoints bound to localhost.
 * For frameworks that can't use WebSocket, MCP, or the programmatic API.
 *
 * Security: Bound to 127.0.0.1 only. Requires bearer token auth to prevent
 * cross-site WebSocket hijacking (CSWSH) attacks.
 *
 * Part of Threadline Relay Phase 4.
 *
 * @example
 * ```bash
 * npx @anthropic-ai/threadline serve --port 18800
 * ```
 *
 * @example
 * ```typescript
 * import { ThreadlineClient } from '@anthropic-ai/threadline';
 * import { ThreadlineRESTServer } from '@anthropic-ai/threadline/adapters/rest';
 *
 * const client = new ThreadlineClient({ name: 'my-agent' });
 * await client.connect();
 *
 * const server = new ThreadlineRESTServer(client, { port: 18800 });
 * await server.start();
 * // curl -H "Authorization: Bearer <token>" http://127.0.0.1:18800/status
 * ```
 */
import type { ThreadlineClient } from '../client/ThreadlineClient.js';
export interface RESTServerConfig {
    port: number;
    host?: string;
    tokenPath?: string;
    maxMessageHistoryPerThread?: number;
}
export declare class ThreadlineRESTServer {
    private readonly client;
    private readonly config;
    private server;
    private token;
    private running;
    /** In-memory thread history (for GET /threads/:id) */
    private readonly threadHistory;
    constructor(client: ThreadlineClient, config?: Partial<RESTServerConfig>);
    /**
     * Start the REST server.
     */
    start(): Promise<{
        port: number;
        token: string;
    }>;
    /**
     * Stop the REST server.
     */
    stop(): Promise<void>;
    get isRunning(): boolean;
    get address(): {
        host: string;
        port: number;
    } | null;
    private handleRequest;
    private handleStatus;
    private handleListAgents;
    private handleDiscover;
    private handleSend;
    private handleListThreads;
    private handleGetThread;
    private handleDeleteThread;
    private getOrCreateToken;
    private readBody;
    private sendJson;
}
//# sourceMappingURL=RESTServer.d.ts.map