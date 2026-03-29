/**
 * SendGateway — Central review point for all outbound messages.
 *
 * Three-stage pipeline:
 *   1. PEL — Credential/PII/auth token detection (fail-closed)
 *   2. Convergence — 7 heuristic quality checks (fail-open)
 *   3. CoherenceGate — LLM specialist reviewers (fail-open, optional)
 *
 * All outbound channels must register and call review() before sending.
 * Unregistered channels are blocked by default.
 */
import type { PELContext } from './PolicyEnforcementLayer.js';
import type { CoherenceGate } from './CoherenceGate.js';
export interface OutboundChannel {
    channelId: string;
    isExternalFacing: boolean;
    defaultRecipientType: PELContext['recipientType'];
}
export interface ReviewRequest {
    message: string;
    channelId: string;
    /** Override channel default */
    isExternalFacing?: boolean;
    /** Override channel default */
    recipientType?: PELContext['recipientType'];
    /** For CoherenceGate retry tracking */
    sessionId?: string;
    /** System messages get PEL-only */
    messageOrigin?: 'agent' | 'system' | 'bridge';
    /** Additional context for LLM review */
    context?: Record<string, unknown>;
}
export interface ReviewResult {
    pass: boolean;
    reason?: string;
    blockedBy?: 'pel' | 'convergence' | 'coherence-gate' | 'unregistered';
    warnings?: string[];
    durationMs: number;
}
interface ChannelStats {
    reviewed: number;
    passed: number;
    blocked: number;
    warnings: number;
}
export declare class SendGateway {
    private pel;
    private coherenceGate;
    private channels;
    private stats;
    private stateDir;
    constructor(config: {
        stateDir: string;
        coherenceGate?: CoherenceGate;
    });
    /** Register an outbound channel. Must be called before review() for that channel. */
    register(channel: OutboundChannel): void;
    /** Get all registered channel IDs. */
    getRegisteredChannels(): string[];
    /** Check if a channel is registered. */
    isRegistered(channelId: string): boolean;
    /** Get review stats per channel. */
    getStats(): Record<string, ChannelStats>;
    /**
     * Review an outbound message through the three-stage pipeline.
     *
     * Stage 1 (PEL): Always runs. hard_block → fail-closed.
     * Stage 2 (Convergence): Skipped for system/bridge messages. Fail-open.
     * Stage 3 (CoherenceGate): Only for external, agent messages >50 chars
     *   when CoherenceGate is configured. Fail-open.
     */
    review(request: ReviewRequest): Promise<ReviewResult>;
    /** Clean up resources. */
    destroy(): void;
}
export {};
//# sourceMappingURL=SendGateway.d.ts.map