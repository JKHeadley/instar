/**
 * CircuitBreaker — Per-agent circuit breaker for inter-agent communication.
 *
 * Part of Threadline Protocol Phase 5 (Section 7.9). Prevents cascading failures
 * when a remote agent becomes unreliable.
 *
 * Circuit breaker rules:
 * - 5 consecutive errors → circuit opens
 * - Open circuit → all messages queued (not delivered), user notified
 * - Auto-reset after 1 hour (transition to half-open, then closed on first success)
 * - 3 circuit breaks in 24h → auto-downgrade trust to untrusted
 * - Manual reset via user intervention at any time
 *
 * Storage: {stateDir}/threadline/circuit-breaker.json
 */
import type { AgentTrustManager } from './AgentTrustManager.js';
export type CircuitStateValue = 'closed' | 'open' | 'half-open';
export interface CircuitState {
    agent: string;
    state: CircuitStateValue;
    consecutiveFailures: number;
    totalFailures: number;
    totalSuccesses: number;
    lastFailure?: string;
    lastSuccess?: string;
    openedAt?: string;
    resetAt?: string;
    activationCount: number;
    activationsInWindow: {
        timestamp: string;
    }[];
}
export declare class CircuitBreaker {
    private readonly threadlineDir;
    private readonly filePath;
    private circuits;
    private trustManager;
    private nowFn;
    constructor(options: {
        stateDir: string;
        trustManager?: AgentTrustManager;
        /** Injectable clock for testing */
        nowFn?: () => number;
    });
    /**
     * Record a successful interaction with an agent.
     * If circuit is half-open, closes it.
     */
    recordSuccess(agentName: string): void;
    /**
     * Record a failed interaction with an agent.
     * Opens circuit after FAILURE_THRESHOLD consecutive failures.
     */
    recordFailure(agentName: string): void;
    /**
     * Check if circuit is open (or should auto-transition to half-open).
     * Returns true if the circuit is open (messages should be queued).
     */
    isOpen(agentName: string): boolean;
    /**
     * Get the current circuit state for an agent.
     * Applies auto-reset logic before returning.
     */
    getState(agentName: string): CircuitState | null;
    /**
     * Get all circuit states.
     */
    getAllStates(): CircuitState[];
    /**
     * Manually reset a circuit (user intervention).
     * Clears consecutive failures and closes the circuit.
     */
    reset(agentName: string): boolean;
    /**
     * Check if 3 activations in 24h should trigger trust auto-downgrade.
     * Called internally when a circuit opens.
     * Returns true if downgrade was triggered.
     */
    checkAutoDowngrade(agentName: string): boolean;
    /**
     * Force reload from disk.
     */
    reload(): void;
    private getOrCreateCircuit;
    private openCircuit;
    private loadCircuits;
    private save;
}
//# sourceMappingURL=CircuitBreaker.d.ts.map