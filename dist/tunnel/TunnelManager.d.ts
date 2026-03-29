/**
 * Cloudflare Tunnel manager for Instar agents.
 *
 * Manages cloudflared tunnel lifecycle — quick tunnels (zero-config,
 * ephemeral) and named tunnels (persistent, custom domain).
 *
 * Quick tunnels require no Cloudflare account. Named tunnels require
 * a tunnel token from the Cloudflare dashboard.
 *
 * The tunnel exposes the agent's local HTTP server to the internet,
 * enabling:
 *   - Private content viewing (auth-gated rendered markdown)
 *   - Remote API access from anywhere
 *   - File serving (logs, reports, exports)
 *   - Webhook endpoints for external integrations
 */
import { EventEmitter } from 'node:events';
export interface TunnelConfig {
    /** Whether tunnel is enabled */
    enabled: boolean;
    /** Tunnel type: 'quick' (ephemeral, no account) or 'named' (persistent, requires token) */
    type: 'quick' | 'named';
    /** Cloudflare tunnel token (required for named tunnels using token auth) */
    token?: string;
    /** Config file path for named tunnels using credentials file auth */
    configFile?: string;
    /** Public hostname for named tunnels (e.g., echo.dawn-tunnel.dev) */
    hostname?: string;
    /** Local port to tunnel to */
    port: number;
    /** State directory for persisting tunnel info */
    stateDir: string;
}
export interface TunnelState {
    /** Current tunnel URL (null if not connected) */
    url: string | null;
    /** Tunnel type */
    type: 'quick' | 'named';
    /** When the tunnel was started */
    startedAt: string | null;
    /** Connection info from cloudflared */
    connectionId?: string;
    /** Connection location */
    connectionLocation?: string;
}
export interface TunnelEvents {
    url: (url: string) => void;
    connected: (info: {
        id: string;
        ip: string;
        location: string;
    }) => void;
    disconnected: () => void;
    error: (error: Error) => void;
    stopped: () => void;
}
export declare class TunnelManager extends EventEmitter {
    private config;
    private tunnel;
    private stateFile;
    private _state;
    private _stopped;
    private _autoReconnect;
    private _reconnectTimer;
    private _reconnectAttempt;
    private _startPromise;
    private static readonly MAX_RECONNECT_ATTEMPTS;
    private static readonly BASE_RECONNECT_DELAY_MS;
    private static readonly MAX_RECONNECT_DELAY_MS;
    constructor(config: TunnelConfig);
    /** Current tunnel URL, or null if not connected */
    get url(): string | null;
    /** Whether the tunnel is currently running */
    get isRunning(): boolean;
    /** Current tunnel state */
    get state(): TunnelState;
    /**
     * Start the tunnel. Ensures the cloudflared binary is installed,
     * then starts the appropriate tunnel type.
     */
    start(): Promise<string>;
    /**
     * Stop the tunnel gracefully. Intentional stops disable auto-reconnect.
     */
    stop(): Promise<void>;
    /**
     * Force-stop the tunnel with a timeout. If cloudflared doesn't respond to
     * SIGINT within `timeoutMs`, escalate to SIGKILL. Essential for sleep/wake
     * recovery where cloudflared may be a zombie process.
     */
    forceStop(timeoutMs?: number): Promise<void>;
    /**
     * Enable automatic reconnection when the tunnel disconnects unexpectedly.
     * Uses exponential backoff: 5s, 10s, 20s, ... up to 5 minutes, max 10 attempts.
     */
    enableAutoReconnect(): void;
    disableAutoReconnect(): void;
    /**
     * Attempt to reconnect the tunnel with exponential backoff.
     */
    private attemptReconnect;
    /**
     * Get the full external URL for a local path.
     * Returns null if tunnel is not connected.
     */
    getExternalUrl(localPath: string): string | null;
    private ensureBinary;
    private startQuickTunnel;
    private startNamedTunnel;
    private startConfigFileTunnel;
    private saveState;
}
//# sourceMappingURL=TunnelManager.d.ts.map