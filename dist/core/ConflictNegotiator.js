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
import crypto from 'node:crypto';
// ── Constants ────────────────────────────────────────────────────────
const DEFAULT_MAX_ROUNDS = 3;
const DEFAULT_ROUND_TIMEOUT = 30_000;
const DEFAULT_TOTAL_TIMEOUT = 120_000;
// ── ConflictNegotiator ───────────────────────────────────────────────
export class ConflictNegotiator {
    bus;
    machineId;
    maxRounds;
    roundTimeoutMs;
    totalTimeoutMs;
    sessions = new Map();
    onProposalReceived;
    constructor(config) {
        this.bus = config.bus;
        this.machineId = config.machineId;
        this.maxRounds = config.maxRounds ?? DEFAULT_MAX_ROUNDS;
        this.roundTimeoutMs = config.roundTimeoutMs ?? DEFAULT_ROUND_TIMEOUT;
        this.totalTimeoutMs = config.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT;
        this.onProposalReceived = config.onProposalReceived;
        this.registerHandlers();
    }
    // ── Initiate Negotiation ────────────────────────────────────────────
    /**
     * Start a negotiation with another machine about a conflicted file.
     * Returns the negotiation result when complete or timed out.
     */
    async negotiate(opts) {
        const negotiationId = `neg_${crypto.randomBytes(8).toString('hex')}`;
        const startedAt = new Date();
        // Create session
        const session = {
            id: negotiationId,
            filePath: opts.filePath,
            initiator: this.machineId,
            responder: opts.targetMachineId,
            status: 'in-progress',
            proposals: [],
            responses: [],
            currentRound: 1,
            maxRounds: this.maxRounds,
            startedAt: startedAt.toISOString(),
        };
        this.sessions.set(negotiationId, session);
        // Initial proposal
        const proposal = {
            negotiationId,
            filePath: opts.filePath,
            strategy: opts.strategy,
            sections: opts.sections,
            reasoning: opts.reasoning,
            round: 1,
            sessionId: opts.sessionId,
        };
        session.proposals.push(proposal);
        // Send proposal and wait for response
        const response = await this.sendProposalAndWait(opts.targetMachineId, proposal);
        if (!response) {
            // Timed out on first round
            session.status = 'timed-out';
            session.endedAt = new Date().toISOString();
            return this.buildResult(session, startedAt);
        }
        session.responses.push(response);
        if (response.decision === 'accept') {
            session.status = 'agreed';
            session.agreedStrategy = proposal.strategy;
            session.agreedSections = proposal.sections;
            session.endedAt = new Date().toISOString();
            return this.buildResult(session, startedAt);
        }
        if (response.decision === 'reject') {
            session.status = 'rejected';
            session.endedAt = new Date().toISOString();
            return this.buildResult(session, startedAt);
        }
        // Counter-proposal: enter negotiation loop
        return this.negotiationLoop(session, response, opts.targetMachineId, startedAt);
    }
    // ── Session Access ──────────────────────────────────────────────────
    /**
     * Get a negotiation session by ID.
     */
    getSession(negotiationId) {
        return this.sessions.get(negotiationId);
    }
    /**
     * Get all active negotiations.
     */
    getActiveNegotiations() {
        return [...this.sessions.values()].filter(s => s.status === 'in-progress');
    }
    /**
     * Get all negotiations for a specific file.
     */
    getNegotiationsForFile(filePath) {
        return [...this.sessions.values()].filter(s => s.filePath === filePath);
    }
    /**
     * Get all completed negotiations.
     */
    getCompletedNegotiations() {
        return [...this.sessions.values()].filter(s => s.status === 'agreed' || s.status === 'rejected' || s.status === 'timed-out' || s.status === 'escalated');
    }
    // ── Stats ───────────────────────────────────────────────────────────
    /**
     * Get negotiation statistics.
     */
    getStats() {
        const all = [...this.sessions.values()];
        const completed = all.filter(s => s.status !== 'in-progress' && s.status !== 'pending');
        return {
            total: all.length,
            agreed: all.filter(s => s.status === 'agreed').length,
            rejected: all.filter(s => s.status === 'rejected').length,
            timedOut: all.filter(s => s.status === 'timed-out').length,
            escalated: all.filter(s => s.status === 'escalated').length,
            inProgress: all.filter(s => s.status === 'in-progress').length,
            averageRounds: completed.length > 0
                ? completed.reduce((sum, s) => sum + s.currentRound, 0) / completed.length
                : 0,
        };
    }
    // ── Private: Negotiation Loop ───────────────────────────────────────
    async negotiationLoop(session, lastResponse, targetMachineId, startedAt) {
        let currentResponse = lastResponse;
        while (session.currentRound < this.maxRounds) {
            session.currentRound++;
            // Check total timeout
            if (Date.now() - startedAt.getTime() > this.totalTimeoutMs) {
                session.status = 'timed-out';
                session.endedAt = new Date().toISOString();
                return this.buildResult(session, startedAt);
            }
            // Build counter-counter-proposal from the counter-proposal
            if (!currentResponse.counterProposal) {
                session.status = 'rejected';
                session.endedAt = new Date().toISOString();
                return this.buildResult(session, startedAt);
            }
            const counter = currentResponse.counterProposal;
            const proposal = {
                negotiationId: session.id,
                filePath: session.filePath,
                strategy: counter.strategy,
                sections: counter.sections,
                reasoning: counter.reasoning,
                round: session.currentRound,
                sessionId: counter.sessionId,
            };
            session.proposals.push(proposal);
            // Send and wait
            const response = await this.sendProposalAndWait(targetMachineId, proposal);
            if (!response) {
                session.status = 'timed-out';
                session.endedAt = new Date().toISOString();
                return this.buildResult(session, startedAt);
            }
            session.responses.push(response);
            if (response.decision === 'accept') {
                session.status = 'agreed';
                session.agreedStrategy = proposal.strategy;
                session.agreedSections = proposal.sections;
                session.endedAt = new Date().toISOString();
                return this.buildResult(session, startedAt);
            }
            if (response.decision === 'reject') {
                session.status = 'rejected';
                session.endedAt = new Date().toISOString();
                return this.buildResult(session, startedAt);
            }
            currentResponse = response;
        }
        // Max rounds reached — escalate
        session.status = 'escalated';
        session.endedAt = new Date().toISOString();
        return this.buildResult(session, startedAt);
    }
    // ── Private: Send and Wait ──────────────────────────────────────────
    async sendProposalAndWait(targetMachineId, proposal) {
        const reply = await this.bus.request({
            type: 'negotiation-request',
            to: targetMachineId,
            payload: proposal,
            timeoutMs: this.roundTimeoutMs,
        });
        return reply?.payload ?? null;
    }
    // ── Private: Message Handlers ───────────────────────────────────────
    registerHandlers() {
        // Handle incoming negotiation requests (proposals)
        this.bus.onMessage('negotiation-request', (msg) => {
            const proposal = msg.payload;
            // Track the session from the responder side
            let session = this.sessions.get(proposal.negotiationId);
            if (!session) {
                session = {
                    id: proposal.negotiationId,
                    filePath: proposal.filePath,
                    initiator: msg.from,
                    responder: this.machineId,
                    status: 'in-progress',
                    proposals: [],
                    responses: [],
                    currentRound: proposal.round,
                    maxRounds: this.maxRounds,
                    startedAt: new Date().toISOString(),
                };
                this.sessions.set(proposal.negotiationId, session);
            }
            session.proposals.push(proposal);
            session.currentRound = proposal.round;
            // Evaluate the proposal
            let response;
            if (this.onProposalReceived) {
                response = this.onProposalReceived(proposal, msg.from);
            }
            else {
                // Default: accept the first proposal
                response = {
                    negotiationId: proposal.negotiationId,
                    decision: 'accept',
                    reason: 'Auto-accepted (no evaluation callback configured)',
                };
            }
            session.responses.push(response);
            if (response.decision === 'accept') {
                session.status = 'agreed';
                session.agreedStrategy = proposal.strategy;
                session.agreedSections = proposal.sections;
                session.endedAt = new Date().toISOString();
            }
            else if (response.decision === 'reject') {
                session.status = 'rejected';
                session.endedAt = new Date().toISOString();
            }
            // Send response back
            this.bus.send({
                type: 'negotiation-response',
                to: msg.from,
                payload: response,
                replyTo: msg.id,
            });
        });
        // Handle incoming negotiation responses
        this.bus.onMessage('negotiation-response', (_msg) => {
            // Handled by request/response pattern in AgentBus
        });
    }
    // ── Private: Result Builder ─────────────────────────────────────────
    buildResult(session, startedAt) {
        const fallbackToLLM = session.status !== 'agreed';
        return {
            negotiationId: session.id,
            status: session.status,
            strategy: session.agreedStrategy,
            sections: session.agreedSections,
            rounds: session.currentRound,
            elapsedMs: Date.now() - startedAt.getTime(),
            fallbackToLLM,
        };
    }
}
//# sourceMappingURL=ConflictNegotiator.js.map