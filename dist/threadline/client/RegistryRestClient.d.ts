/**
 * RegistryRestClient — Lightweight REST client for the Threadline agent registry.
 *
 * Connects to the relay via WebSocket to authenticate and obtain a JWT token,
 * then uses that token for REST API calls to the registry.
 *
 * Used by mcp-stdio-entry to give built-in Threadline MCP tools registry access.
 * Part of Threadline Agent Registry Phase 3.
 */
import type { RegistryClient } from '../ThreadlineMCPServer.js';
import type { IdentityInfo } from './IdentityManager.js';
export interface RegistryRestClientConfig {
    /** Relay WebSocket URL (e.g., wss://relay.threadline.dev/v1/connect) */
    relayUrl: string;
    /** Agent identity (Ed25519 keys) */
    identity: IdentityInfo;
    /** Agent display name */
    agentName: string;
    /** Agent capabilities */
    capabilities?: string[];
    /** Agent framework */
    framework?: string;
    /** Whether to register in the registry */
    listed?: boolean;
}
export declare class RegistryRestClient implements RegistryClient {
    private readonly config;
    private token;
    private tokenExpires;
    private baseUrl;
    constructor(config: RegistryRestClientConfig);
    /**
     * Connect to the relay to authenticate and obtain a registry JWT token.
     * Must be called before using fetch().
     */
    authenticate(): Promise<void>;
    hasToken(): boolean;
    fetch(path: string, options?: {
        method?: string;
        body?: unknown;
    }): Promise<{
        status: number;
        data: unknown;
    }>;
}
//# sourceMappingURL=RegistryRestClient.d.ts.map