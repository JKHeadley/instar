/**
 * ThreadlineMCPServer — MCP Tool Server for Threadline Protocol.
 *
 * Exposes Threadline capabilities as up to 9 MCP tools:
 *   - threadline_discover         — Find Threadline-capable agents
 *   - threadline_send             — Send a message (with optional reply wait)
 *   - threadline_history          — Get conversation history (participant-only)
 *   - threadline_agents           — List known agents and status
 *   - threadline_delete           — Delete a thread permanently
 *   - threadline_registry_search  — Search the persistent agent registry (if registry available)
 *   - threadline_registry_update  — Update your registry listing (if registry available)
 *   - threadline_registry_status  — Check your registration status (if registry available)
 *   - threadline_registry_get     — Look up an agent by ID (if registry available)
 *
 * Transports:
 *   - stdio (default, local)  — No auth required
 *   - SSE (network)           — Bearer token auth
 *   - HTTP streamable (network) — Bearer token auth
 *
 * Part of Threadline Protocol Phase 6B (Network Interop).
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AgentDiscovery } from './AgentDiscovery.js';
import type { ThreadResumeMap } from './ThreadResumeMap.js';
import type { AgentTrustManager } from './AgentTrustManager.js';
import type { MCPAuth, MCPTokenInfo } from './MCPAuth.js';
export interface ThreadlineMCPServerConfig {
    /** Name of this agent */
    agentName: string;
    /** Threadline protocol version */
    protocolVersion: string;
    /** Transport mode */
    transport: 'stdio' | 'sse' | 'streamable-http';
    /** Port for network transports (SSE, streamable-http) */
    port?: number;
    /** Whether this is a network transport (requires auth) */
    requireAuth: boolean;
}
/** Registry REST API client for registry tools */
export interface RegistryClient {
    /** Make an authenticated REST call to the registry. Returns status + parsed JSON. */
    fetch(path: string, options?: {
        method?: string;
        body?: unknown;
    }): Promise<{
        status: number;
        data: unknown;
    }>;
    /** Whether the registry client has a valid token */
    hasToken(): boolean;
}
export interface ThreadlineMCPDeps {
    /** Agent discovery service */
    discovery: AgentDiscovery;
    /** Thread resume map for thread state */
    threadResumeMap: ThreadResumeMap;
    /** Agent trust manager for trust levels */
    trustManager: AgentTrustManager;
    /** MCP auth for network transports (null for stdio) */
    auth: MCPAuth | null;
    /** Message sender function — sends a message and optionally waits for reply */
    sendMessage: (params: SendMessageParams) => Promise<SendMessageResult>;
    /** Thread history retriever */
    getThreadHistory: (threadId: string, limit: number, before?: string) => Promise<ThreadHistoryResult>;
    /** Registry REST API client (null if registry not available) */
    registry: RegistryClient | null;
    /** State directory (.instar path) for config access */
    stateDir?: string;
}
export interface SendMessageParams {
    targetAgent: string;
    threadId?: string;
    message: string;
    waitForReply: boolean;
    timeoutSeconds: number;
}
export interface SendMessageResult {
    success: boolean;
    threadId: string;
    messageId: string;
    reply?: string;
    replyFrom?: string;
    error?: string;
}
export interface ThreadHistoryMessage {
    id: string;
    from: string;
    body: string;
    timestamp: string;
    threadId: string;
}
export interface ThreadHistoryResult {
    threadId: string;
    messages: ThreadHistoryMessage[];
    totalCount: number;
    hasMore: boolean;
}
/**
 * Tracks the authenticated identity for the current request.
 * For stdio: always authorized (local operator).
 * For network: set by bearer token validation.
 */
interface RequestContext {
    /** Whether the request is authenticated */
    authenticated: boolean;
    /** Token info if authenticated via bearer token */
    tokenInfo?: MCPTokenInfo;
    /** Whether this is a local (stdio) connection */
    isLocal: boolean;
}
export declare class ThreadlineMCPServer {
    private readonly mcpServer;
    private readonly config;
    private readonly deps;
    private requestContext;
    private started;
    constructor(config: ThreadlineMCPServerConfig, deps: ThreadlineMCPDeps);
    /**
     * Start the MCP server with the configured transport.
     * For stdio: connects to process stdin/stdout.
     * For network transports: returns the McpServer for external wiring.
     */
    start(): Promise<void>;
    /**
     * Stop the MCP server.
     */
    stop(): Promise<void>;
    /**
     * Get the underlying McpServer for external transport wiring.
     * Used by SSE/streamable-http integrations.
     */
    getServer(): McpServer;
    /**
     * Set the auth context for the current request (network transports).
     * Called by the HTTP middleware before tool handlers execute.
     */
    setRequestContext(ctx: RequestContext): void;
    /**
     * Validate a bearer token and set the request context.
     * Returns true if the token is valid.
     */
    authenticateBearer(rawToken: string): boolean;
    private checkAuth;
    private registerTools;
    private registerDiscoverTool;
    private registerSendTool;
    private registerHistoryTool;
    private registerAgentsTool;
    private registerDeleteTool;
    private registerTrustTool;
    private registerRelayTool;
    /** Resolve the .instar/config.json path from the state directory */
    private resolveConfigPath;
    /** Read and parse config.json */
    private readConfig;
    /** Write config.json atomically */
    private writeConfig;
    private frameRegistryEntry;
    private registerRegistrySearchTool;
    private registerRegistryUpdateTool;
    private registerRegistryStatusTool;
    private registerRegistryGetTool;
}
export {};
//# sourceMappingURL=ThreadlineMCPServer.d.ts.map