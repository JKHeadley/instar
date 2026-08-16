/**
 * ConflictNegotiator — Pre-merge conflict negotiation between agents.
 *
 * Before committing to a merge strategy, agents can negotiate:
 *   1. Propose a resolution strategy ("I'll take the left side of file X")
 *   2. Counter-propose ("Actually, my changes to lines 10-50 are more recent")
 *   3. Accept or reject proposals
 *   4. Escalate to human if negotiation fails
 *
 * The negotiation protocol has a round limit to prevent deadlocks.
 * If no agreement is reached within the limit, it falls back to
 * the tiered conflict resolution system (LLMConflictResolver).
 *
 * From INTELLIGENT_SYNC_SPEC Section 7.4 and Phase 7 (Live Conflict Negotiation).
 */
import type { AgentBus } from './AgentBus.js';
export type NegotiationStatus = 'pending' | 'in-progress' | 'agreed' | 'rejected' | 'timed-out' | 'escalated';
export type ResolutionStrategy = 'take-ours' | 'take-theirs' | 'merge-by-section' | 'merge-by-line-range' | 'llm-resolve' | 'human-resolve';
export interface NegotiationProposal {
    /** Unique negotiation ID. */
    negotiationId: string;
    /** File path in conflict. */
    filePath: string;
    /** Proposed resolution strategy. */
    strategy: ResolutionStrategy;
    /** Proposed file sections (for section-based strategies). */
    sections?: SectionClaim[];
    /** Free-text reasoning for the proposal. */
    reasoning: string;
    /** Current round number. */
    round: number;
    /** Session ID of the proposer. */
    sessionId?: string;
}
export interface SectionClaim {
    /** Who claims this section. */
    claimedBy: 'proposer' | 'responder';
    /** Start line (1-indexed, inclusive). */
    startLine: number;
    /** End line (1-indexed, inclusive). */
    endLine: number;
    /** Brief description of what this section does. */
    description: string;
}
export interface NegotiationResponse {
    /** Negotiation ID being responded to. */
    negotiationId: string;
    /** Response decision. */
    decision: 'accept' | 'reject' | 'counter';
    /** Counter-proposal (only if decision is 'counter'). */
    counterProposal?: Omit<NegotiationProposal, 'negotiationId' | 'round'>;
    /** Reason for the decision. */
    reason: string;
}
export interface NegotiationSession {
    /** Unique negotiation ID. */
    id: string;
    /** File in conflict. */
    filePath: string;
    /** Machine that initiated the negotiation. */
    initiator: string;
    /** Machine being negotiated with. */
    responder: string;
    /** Current status. */
    status: NegotiationStatus;
    /** All proposals exchanged. */
    proposals: NegotiationProposal[];
    /** All responses exchanged. */
    responses: NegotiationResponse[];
    /** Current round. */
    currentRound: number;
    /** Maximum rounds before escalation. */
    maxRounds: number;
    /** When the negotiation started. */
    startedAt: string;
    /** When the negotiation ended. */
    endedAt?: string;
    /** Final agreed strategy (if agreed). */
    agreedStrategy?: ResolutionStrategy;
    /** Final section claims (if section-based). */
    agreedSections?: SectionClaim[];
}
export interface NegotiationResult {
    /** The negotiation ID. */
    negotiationId: string;
    /** Final status. */
    status: NegotiationStatus;
    /** Agreed strategy (if any). */
    strategy?: ResolutionStrategy;
    /** Agreed sections (if section-based). */
    sections?: SectionClaim[];
    /** Total rounds used. */
    rounds: number;
    /** Time elapsed in ms. */
    elapsedMs: number;
    /** Whether to fall back to LLM resolution. */
    fallbackToLLM: boolean;
}
export interface ConflictNegotiatorConfig {
    /** The AgentBus instance. */
    bus: AgentBus;
    /** This machine's ID. */
    machineId: string;
    /** Maximum negotiation rounds (default: 3). */
    maxRounds?: number;
    /** Timeout per round in ms (default: 30s). */
    roundTimeoutMs?: number;
    /** Total negotiation timeout in ms (default: 120s). */
    totalTimeoutMs?: number;
    /** Callback to evaluate an incoming proposal. */
    onProposalReceived?: (proposal: NegotiationProposal, from: string) => NegotiationResponse;
}
export declare class ConflictNegotiator {
    private bus;
    private machineId;
    private maxRounds;
    private roundTimeoutMs;
    private totalTimeoutMs;
    private sessions;
    private onProposalReceived?;
    constructor(config: ConflictNegotiatorConfig);
    /**
     * Start a negotiation with another machine about a conflicted file.
     * Returns the negotiation result when complete or timed out.
     */
    negotiate(opts: {
        targetMachineId: string;
        filePath: string;
        strategy: ResolutionStrategy;
        sections?: SectionClaim[];
        reasoning: string;
        sessionId?: string;
    }): Promise<NegotiationResult>;
    /**
     * Get a negotiation session by ID.
     */
    getSession(negotiationId: string): NegotiationSession | undefined;
    /**
     * Get all active negotiations.
     */
    getActiveNegotiations(): NegotiationSession[];
    /**
     * Get all negotiations for a specific file.
     */
    getNegotiationsForFile(filePath: string): NegotiationSession[];
    /**
     * Get all completed negotiations.
     */
    getCompletedNegotiations(): NegotiationSession[];
    /**
     * Get negotiation statistics.
     */
    getStats(): {
        total: number;
        agreed: number;
        rejected: number;
        timedOut: number;
        escalated: number;
        inProgress: number;
        averageRounds: number;
    };
    private negotiationLoop;
    private sendProposalAndWait;
    private registerHandlers;
    private buildResult;
}
//# sourceMappingURL=ConflictNegotiator.d.ts.map