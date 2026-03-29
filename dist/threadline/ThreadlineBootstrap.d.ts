/**
 * ThreadlineBootstrap — Auto-wires Threadline protocol into the agent server.
 *
 * Called during server boot to:
 *   1. Persist identity keys (Ed25519) across restarts
 *   2. Create HandshakeManager for crypto handshakes
 *   3. Register MCP tools into Claude Code's ~/.claude.json
 *   4. Announce agent presence for discovery
 *   5. Start discovery heartbeat
 *
 * Design: The user never sees any of this. Threadline is ON when the agent boots.
 * The agent IS the interface — users talk to their agent, the agent handles the rest.
 *
 * Part of Threadline Protocol integration (Principle #11: "I am the interface").
 */
import { HandshakeManager } from './HandshakeManager.js';
import { AgentDiscovery } from './AgentDiscovery.js';
import type { KeyPair } from './ThreadlineCrypto.js';
import { ThreadlineClient } from './client/ThreadlineClient.js';
import { InboundMessageGate } from './InboundMessageGate.js';
import { AgentTrustManager } from './AgentTrustManager.js';
export interface ThreadlineBootstrapConfig {
    /** Agent name */
    agentName: string;
    /** Agent description */
    agentDescription?: string;
    /** State directory for persistence */
    stateDir: string;
    /** Agent's project directory (for MCP registration) */
    projectDir: string;
    /** Server port */
    port: number;
    /** Enable cloud relay connection (opt-in, default: false) */
    relayEnabled?: boolean;
    /** Cloud relay URL */
    relayUrl?: string;
    /** Agent visibility on relay */
    visibility?: 'public' | 'unlisted' | 'private';
    /** Agent framework identifier */
    framework?: string;
    /** Agent capabilities */
    capabilities?: string[];
}
export interface ThreadlineBootstrapResult {
    /** Handshake manager for crypto handshakes */
    handshakeManager: HandshakeManager;
    /** Agent discovery service */
    discovery: AgentDiscovery;
    /** Identity key pair */
    identityKeys: KeyPair;
    /** Cleanup function for graceful shutdown */
    shutdown: () => Promise<void>;
    /** Cloud relay client (if relay is enabled) */
    relayClient?: ThreadlineClient;
    /** Inbound message gate (if relay is enabled) */
    inboundGate?: InboundMessageGate;
    /** Trust manager */
    trustManager?: AgentTrustManager;
}
/**
 * Bootstrap the Threadline protocol stack.
 *
 * Creates the HandshakeManager, registers MCP tools, announces presence,
 * and starts the discovery heartbeat. The ThreadlineRouter is created
 * separately in server.ts because it depends on messaging infrastructure.
 */
export declare function bootstrapThreadline(config: ThreadlineBootstrapConfig): Promise<ThreadlineBootstrapResult>;
//# sourceMappingURL=ThreadlineBootstrap.d.ts.map