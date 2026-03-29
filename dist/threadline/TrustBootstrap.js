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
// ── Constants ────────────────────────────────────────────────────────
const DIRECTORY_TIMEOUT_MS = 10_000; // 10 seconds
// ── Default fetcher ──────────────────────────────────────────────────
const defaultFetcher = async (url, options) => {
    const controller = new AbortController();
    const timeout = options?.timeout ?? DIRECTORY_TIMEOUT_MS;
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
        const response = await fetch(url, {
            method: options?.method ?? 'GET',
            signal: controller.signal,
        });
        return {
            ok: response.ok,
            status: response.status,
            json: () => response.json(),
        };
    }
    finally {
        clearTimeout(timer);
    }
};
// ── Implementation ───────────────────────────────────────────────────
export class TrustBootstrap {
    config;
    fetcher;
    constructor(config) {
        this.config = config;
        this.fetcher = config.fetcher ?? defaultFetcher;
        this.validateConfig();
    }
    /**
     * Verify an agent's identity using the configured bootstrap strategy.
     *
     * @param agentIdentity — Unique agent identifier (e.g., name or public key hex)
     * @param evidence — Evidence the agent provides to prove identity
     */
    async verify(agentIdentity, evidence) {
        switch (this.config.strategy) {
            case 'directory-verified':
                return this.verifyViaDirectory(agentIdentity, evidence);
            case 'domain-verified':
                return this.verifyViaDNS(agentIdentity, evidence);
            case 'invitation-only':
                return this.verifyViaInvitation(agentIdentity, evidence);
            case 'open':
                return this.verifyOpen(agentIdentity, evidence);
            default:
                return {
                    verified: false,
                    trustLevel: 'untrusted',
                    reason: `Unknown bootstrap strategy: ${this.config.strategy}`,
                };
        }
    }
    /**
     * Get the current bootstrap strategy.
     */
    getStrategy() {
        return this.config.strategy;
    }
    // ── Strategy Implementations ───────────────────────────────────
    /**
     * Directory-verified: Query a trusted directory service to verify the agent's
     * public key fingerprint. Directory vouches for the agent's identity.
     */
    async verifyViaDirectory(agentIdentity, evidence) {
        if (!evidence.fingerprint) {
            return {
                verified: false,
                trustLevel: 'untrusted',
                reason: 'Directory verification requires a public key fingerprint in evidence',
            };
        }
        const directoryUrl = this.config.directoryUrl;
        const lookupUrl = `${directoryUrl.replace(/\/+$/, '')}/agents/${evidence.fingerprint}`;
        try {
            const response = await this.fetcher(lookupUrl, { timeout: DIRECTORY_TIMEOUT_MS });
            if (!response.ok) {
                if (response.status === 404) {
                    return {
                        verified: false,
                        trustLevel: 'untrusted',
                        reason: `Agent fingerprint ${evidence.fingerprint} not found in directory`,
                    };
                }
                return {
                    verified: false,
                    trustLevel: 'untrusted',
                    reason: `Directory lookup failed with status ${response.status}`,
                };
            }
            const record = await response.json();
            if (!record.verified) {
                return {
                    verified: false,
                    trustLevel: 'untrusted',
                    reason: `Directory reports agent ${evidence.fingerprint} is not verified`,
                };
            }
            // If the agent provided a public key, verify it matches the directory record
            if (evidence.publicKey && record.publicKey) {
                if (evidence.publicKey.toLowerCase() !== record.publicKey.toLowerCase()) {
                    return {
                        verified: false,
                        trustLevel: 'untrusted',
                        reason: 'Agent public key does not match directory record',
                    };
                }
            }
            // Directory-verified agents start at 'verified' trust level
            this.config.trustManager.setTrustLevel(agentIdentity, 'verified', 'paired-machine-granted', `Directory-verified via ${directoryUrl}`);
            return {
                verified: true,
                trustLevel: 'verified',
                reason: `Agent verified by directory — ${record.agentName} (verified at ${record.verifiedAt})`,
                metadata: {
                    directoryUrl,
                    agentName: record.agentName,
                    verifiedAt: record.verifiedAt,
                },
            };
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return {
                verified: false,
                trustLevel: 'untrusted',
                reason: `Directory lookup failed: ${message}`,
            };
        }
    }
    /**
     * Domain-verified: Check DNS TXT record at _threadline.{domain} for the
     * agent's public key fingerprint. Proves domain ownership.
     */
    async verifyViaDNS(agentIdentity, evidence) {
        if (!evidence.domain) {
            return {
                verified: false,
                trustLevel: 'untrusted',
                reason: 'Domain verification requires a domain in evidence',
            };
        }
        if (!evidence.fingerprint) {
            return {
                verified: false,
                trustLevel: 'untrusted',
                reason: 'Domain verification requires a public key fingerprint in evidence',
            };
        }
        const dnsVerifier = this.config.dnsVerifier;
        const result = await dnsVerifier.verify(evidence.domain, evidence.fingerprint);
        if (!result.verified) {
            return {
                verified: false,
                trustLevel: 'untrusted',
                reason: result.reason,
            };
        }
        // Domain-verified agents start at 'verified' trust level
        this.config.trustManager.setTrustLevel(agentIdentity, 'verified', 'paired-machine-granted', `Domain-verified via ${evidence.domain}`);
        return {
            verified: true,
            trustLevel: 'verified',
            reason: result.reason,
            metadata: {
                domain: evidence.domain,
                record: result.record,
            },
        };
    }
    /**
     * Invitation-only: Agent must present a valid invitation token.
     * Token is consumed on use (single-use tokens invalidated after first use).
     */
    async verifyViaInvitation(agentIdentity, evidence) {
        if (!evidence.invitationToken) {
            return {
                verified: false,
                trustLevel: 'untrusted',
                reason: 'Invitation verification requires an invitation token in evidence',
            };
        }
        const invitationManager = this.config.invitationManager;
        const consumeResult = invitationManager.consume(evidence.invitationToken, agentIdentity);
        if (consumeResult.status !== 'valid') {
            return {
                verified: false,
                trustLevel: 'untrusted',
                reason: `Invitation invalid: ${consumeResult.reason}`,
            };
        }
        // Invitation-verified agents start at 'verified' trust level
        this.config.trustManager.setTrustLevel(agentIdentity, 'verified', 'paired-machine-granted', `Invitation-verified (label: ${consumeResult.invitation?.label ?? 'none'})`);
        return {
            verified: true,
            trustLevel: 'verified',
            reason: consumeResult.reason,
            metadata: {
                invitationLabel: consumeResult.invitation?.label,
                invitationUseCount: consumeResult.invitation?.useCount,
                invitationMaxUses: consumeResult.invitation?.maxUses,
            },
        };
    }
    /**
     * Open: Any agent can initiate. No verification required.
     * Agent starts at 'untrusted' trust level.
     */
    async verifyOpen(agentIdentity, evidence) {
        // Ensure the agent has a trust profile (creates one at 'untrusted' if needed)
        this.config.trustManager.getOrCreateProfile(agentIdentity);
        return {
            verified: true,
            trustLevel: 'untrusted',
            reason: 'Open bootstrap — agent accepted at untrusted trust level',
            metadata: evidence.metadata,
        };
    }
    // ── Config Validation ──────────────────────────────────────────
    validateConfig() {
        switch (this.config.strategy) {
            case 'directory-verified':
                if (!this.config.directoryUrl) {
                    throw new Error('TrustBootstrap: directory-verified strategy requires directoryUrl');
                }
                break;
            case 'domain-verified':
                if (!this.config.dnsVerifier) {
                    throw new Error('TrustBootstrap: domain-verified strategy requires dnsVerifier');
                }
                break;
            case 'invitation-only':
                if (!this.config.invitationManager) {
                    throw new Error('TrustBootstrap: invitation-only strategy requires invitationManager');
                }
                break;
            case 'open':
                // No additional config required
                break;
        }
    }
}
//# sourceMappingURL=TrustBootstrap.js.map