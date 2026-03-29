/**
 * `instar relay start|stop|status` — Manage the Threadline relay server.
 *
 * The relay is a standalone WebSocket server that enables agent-to-agent
 * communication. Agents connect via outbound WebSocket, authenticate with
 * Ed25519 signatures, and exchange E2E encrypted messages.
 *
 * Environment variables:
 *   RELAY_PORT        — WebSocket port (default: 8787)
 *   RELAY_HOST        — Bind address (default: 0.0.0.0)
 *   RELAY_ADMIN_KEY   — Admin API bearer token (required for admin endpoints)
 *   RELAY_ADMIN_PORT  — Admin API port (default: 9091)
 */
export interface RelayStartOptions {
    port?: number;
    host?: string;
    adminPort?: number;
    adminKey?: string;
    foreground?: boolean;
    dataDir?: string;
}
export declare function startRelay(opts: RelayStartOptions): Promise<void>;
export declare function relayStatus(opts: {
    port?: number;
}): Promise<void>;
//# sourceMappingURL=relay.d.ts.map