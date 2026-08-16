/**
 * TrustBootstrap — Trust verification strategies for internet agent discovery.
 *
 * Four bootstrap strategies:
 * - directory-verified: Agent registered in a trusted directory service
 * - domain-verified: DNS TXT record proves domain ownership
 * - invitation-only: Agent must present a valid invitation token
 * - open: Any agent can initiate, starts at 'untrusted'
 *
 * Part of Threadline Protocol Phase 6C.
 */
import type { AgentTrustManager, AgentTrustLevel } from './AgentTrustManager.js';
import type { InvitationManager } from './InvitationManager.js';
import type { DNSVerifier } from './DNSVerifier.js';
import type { HttpFetcher } from './AgentDiscovery.js';
export type TrustBootstrapStrategy = 'directory-verified' | 'domain-verified' | 'invitation-only' | 'open';
export interface TrustBootstrapConfig {
    /** Bootstrap strategy to use */
    strategy: TrustBootstrapStrategy;
    /** State directory for persistence */
    stateDir: string;
    /** Directory service URL (required for 'directory-verified' strategy) */
    directoryUrl?: string;
    /** Invitation manager instance (required for 'invitation-only' strategy) */
    invitationManager?: InvitationManager;
    /** DNS verifier instance (required for 'domain-verified' strategy) */
    dnsVerifier?: DNSVerifier;
    /** Trust manager for setting initial trust levels */
    trustManager: AgentTrustManager;
    /** Injectable HTTP fetcher for directory lookups (default: native fetch) */
    fetcher?: HttpFetcher;
}
export interface BootstrapEvidence {
    /** Agent's Ed25519 public key fingerprint (SHA-256 hex of public key) */
    fingerprint?: string;
    /** Agent's Ed25519 public key (hex-encoded) */
    publicKey?: string;
    /** Domain the agent claims to represent (for domain-verified) */
    domain?: string;
    /** Invitation token (for invitation-only) */
    invitationToken?: string;
    /** Additional metadata from the agent */
    metadata?: Record<string, unknown>;
}
export interface BootstrapResult {
    /** Whether verification succeeded */
    verified: boolean;
    /** Trust level assigned to the agent */
    trustLevel: AgentTrustLevel;
    /** Human-readable explanation */
    reason: string;
    /** Additional metadata from verification process */
    metadata?: Record<string, unknown>;
}
export declare class TrustBootstrap {
    private readonly config;
    private readonly fetcher;
    constructor(config: TrustBootstrapConfig);
    /**
     * Verify an agent's identity using the configured bootstrap strategy.
     *
     * @param agentIdentity — Unique agent identifier (e.g., name or public key hex)
     * @param evidence — Evidence the agent provides to prove identity
     */
    verify(agentIdentity: string, evidence: BootstrapEvidence): Promise<BootstrapResult>;
    /**
     * Get the current bootstrap strategy.
     */
    getStrategy(): TrustBootstrapStrategy;
    /**
     * Directory-verified: Query a trusted directory service to verify the agent's
     * public key fingerprint. Directory vouches for the agent's identity.
     */
    private verifyViaDirectory;
    /**
     * Domain-verified: Check DNS TXT record at _threadline.{domain} for the
     * agent's public key fingerprint. Proves domain ownership.
     */
    private verifyViaDNS;
    /**
     * Invitation-only: Agent must present a valid invitation token.
     * Token is consumed on use (single-use tokens invalidated after first use).
     */
    private verifyViaInvitation;
    /**
     * Open: Any agent can initiate. No verification required.
     * Agent starts at 'untrusted' trust level.
     */
    private verifyOpen;
    private validateConfig;
}
//# sourceMappingURL=TrustBootstrap.d.ts.map