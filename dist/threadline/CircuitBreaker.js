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
import fs from 'node:fs';
import path from 'node:path';
// ── Constants ────────────────────────────────────────────────────────
/** Number of consecutive failures before circuit opens */
const FAILURE_THRESHOLD = 5;
/** Auto-reset timeout in milliseconds (1 hour) */
const AUTO_RESET_MS = 60 * 60 * 1000;
/** Window for counting activations (24 hours) */
const ACTIVATION_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Number of activations in window that triggers auto-downgrade */
const DOWNGRADE_ACTIVATION_THRESHOLD = 3;
// ── Helpers ──────────────────────────────────────────────────────────
function atomicWrite(filePath, data) {
    const tmpPath = `${filePath}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    try {
        fs.writeFileSync(tmpPath, data);
        fs.renameSync(tmpPath, filePath);
    }
    catch (err) {
        try {
            fs.unlinkSync(tmpPath);
        }
        catch { /* ignore */ }
        throw err;
    }
}
function safeJsonParse(filePath, fallback) {
    try {
        if (!fs.existsSync(filePath))
            return fallback;
        return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    }
    catch {
        return fallback;
    }
}
export class CircuitBreaker {
    threadlineDir;
    filePath;
    circuits;
    trustManager;
    nowFn;
    constructor(options) {
        this.threadlineDir = path.join(options.stateDir, 'threadline');
        fs.mkdirSync(this.threadlineDir, { recursive: true });
        this.filePath = path.join(this.threadlineDir, 'circuit-breaker.json');
        this.trustManager = options.trustManager ?? null;
        this.nowFn = options.nowFn ?? (() => Date.now());
        this.circuits = this.loadCircuits();
    }
    // ── Success / Failure Recording ─────────────────────────────────
    /**
     * Record a successful interaction with an agent.
     * If circuit is half-open, closes it.
     */
    recordSuccess(agentName) {
        const circuit = this.getOrCreateCircuit(agentName);
        circuit.consecutiveFailures = 0;
        circuit.totalSuccesses++;
        circuit.lastSuccess = new Date(this.nowFn()).toISOString();
        if (circuit.state === 'half-open') {
            circuit.state = 'closed';
            circuit.resetAt = new Date(this.nowFn()).toISOString();
        }
        this.save();
    }
    /**
     * Record a failed interaction with an agent.
     * Opens circuit after FAILURE_THRESHOLD consecutive failures.
     */
    recordFailure(agentName) {
        const circuit = this.getOrCreateCircuit(agentName);
        circuit.consecutiveFailures++;
        circuit.totalFailures++;
        circuit.lastFailure = new Date(this.nowFn()).toISOString();
        if (circuit.state === 'half-open') {
            // Failure during half-open → reopen
            this.openCircuit(circuit);
        }
        else if (circuit.state === 'closed' && circuit.consecutiveFailures >= FAILURE_THRESHOLD) {
            this.openCircuit(circuit);
        }
        this.save();
    }
    // ── State Queries ───────────────────────────────────────────────
    /**
     * Check if circuit is open (or should auto-transition to half-open).
     * Returns true if the circuit is open (messages should be queued).
     */
    isOpen(agentName) {
        const circuit = this.circuits[agentName];
        if (!circuit)
            return false;
        if (circuit.state === 'open') {
            // Check if auto-reset period has elapsed
            if (circuit.openedAt) {
                const elapsed = this.nowFn() - new Date(circuit.openedAt).getTime();
                if (elapsed >= AUTO_RESET_MS) {
                    // Transition to half-open
                    circuit.state = 'half-open';
                    this.save();
                    return false; // Half-open allows one attempt
                }
            }
            return true;
        }
        return false;
    }
    /**
     * Get the current circuit state for an agent.
     * Applies auto-reset logic before returning.
     */
    getState(agentName) {
        const circuit = this.circuits[agentName];
        if (!circuit)
            return null;
        // Apply auto-reset if needed
        if (circuit.state === 'open' && circuit.openedAt) {
            const elapsed = this.nowFn() - new Date(circuit.openedAt).getTime();
            if (elapsed >= AUTO_RESET_MS) {
                circuit.state = 'half-open';
                this.save();
            }
        }
        return { ...circuit };
    }
    /**
     * Get all circuit states.
     */
    getAllStates() {
        return Object.values(this.circuits).map(c => ({ ...c }));
    }
    // ── Manual Reset ────────────────────────────────────────────────
    /**
     * Manually reset a circuit (user intervention).
     * Clears consecutive failures and closes the circuit.
     */
    reset(agentName) {
        const circuit = this.circuits[agentName];
        if (!circuit)
            return false;
        circuit.state = 'closed';
        circuit.consecutiveFailures = 0;
        circuit.resetAt = new Date(this.nowFn()).toISOString();
        circuit.openedAt = undefined;
        this.save();
        return true;
    }
    // ── Auto-Downgrade Check ────────────────────────────────────────
    /**
     * Check if 3 activations in 24h should trigger trust auto-downgrade.
     * Called internally when a circuit opens.
     * Returns true if downgrade was triggered.
     */
    checkAutoDowngrade(agentName) {
        const circuit = this.circuits[agentName];
        if (!circuit)
            return false;
        // Clean up old activations outside the window
        const windowStart = this.nowFn() - ACTIVATION_WINDOW_MS;
        circuit.activationsInWindow = circuit.activationsInWindow.filter(a => new Date(a.timestamp).getTime() > windowStart);
        if (circuit.activationsInWindow.length >= DOWNGRADE_ACTIVATION_THRESHOLD) {
            if (this.trustManager) {
                this.trustManager.autoDowngrade(agentName, `Circuit breaker activated ${circuit.activationsInWindow.length} times in 24 hours`);
                return true;
            }
        }
        return false;
    }
    // ── Persistence ─────────────────────────────────────────────────
    /**
     * Force reload from disk.
     */
    reload() {
        this.circuits = this.loadCircuits();
    }
    // ── Private ─────────────────────────────────────────────────────
    getOrCreateCircuit(agentName) {
        if (!this.circuits[agentName]) {
            this.circuits[agentName] = {
                agent: agentName,
                state: 'closed',
                consecutiveFailures: 0,
                totalFailures: 0,
                totalSuccesses: 0,
                activationCount: 0,
                activationsInWindow: [],
            };
        }
        return this.circuits[agentName];
    }
    openCircuit(circuit) {
        circuit.state = 'open';
        circuit.openedAt = new Date(this.nowFn()).toISOString();
        circuit.activationCount++;
        circuit.activationsInWindow.push({
            timestamp: new Date(this.nowFn()).toISOString(),
        });
        this.save();
        // Check for auto-downgrade after opening
        this.checkAutoDowngrade(circuit.agent);
    }
    loadCircuits() {
        const data = safeJsonParse(this.filePath, {
            circuits: {},
            updatedAt: '',
        });
        return data.circuits;
    }
    save() {
        try {
            const data = {
                circuits: this.circuits,
                updatedAt: new Date(this.nowFn()).toISOString(),
            };
            atomicWrite(this.filePath, JSON.stringify(data, null, 2));
        }
        catch {
            // Save failure should not break circuit evaluation
        }
    }
}
//# sourceMappingURL=CircuitBreaker.js.map