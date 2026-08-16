/**
 * JobClaimManager — Distributed job deduplication via AgentBus.
 *
 * Before executing a scheduled job, the owning machine broadcasts a
 * `work-announcement` claim via AgentBus. Other machines see the claim
 * and skip the job. When the job completes, a `work-complete` message
 * signals other machines that the claim is released.
 *
 * Claim semantics:
 *   - At-most-once execution with idempotency keys (claimId)
 *   - Claims expire if no work-complete within timeout
 *   - Partition mode: proceed independently when no peers are reachable
 *   - Local ledger persisted to disk for crash recovery
 *
 * Part of Phase 4C (User-Agent Topology Spec — Gap 5).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
// ── Constants ────────────────────────────────────────────────────────
const DEFAULT_CLAIM_TIMEOUT_MS = 30 * 60_000; // 30 minutes
const DEFAULT_PRUNE_INTERVAL_MS = 5 * 60_000; // 5 minutes
const CLAIMS_FILE = 'job-claims.json';
// ── JobClaimManager ──────────────────────────────────────────────────
export class JobClaimManager extends EventEmitter {
    bus;
    machineId;
    stateDir;
    defaultClaimTimeoutMs;
    pruneIntervalMs;
    claims = new Map(); // keyed by jobSlug
    claimsDir;
    pruneTimer = null;
    constructor(config) {
        super();
        this.bus = config.bus;
        this.machineId = config.machineId;
        this.stateDir = config.stateDir;
        this.defaultClaimTimeoutMs = config.defaultClaimTimeoutMs ?? DEFAULT_CLAIM_TIMEOUT_MS;
        this.pruneIntervalMs = config.pruneIntervalMs ?? DEFAULT_PRUNE_INTERVAL_MS;
        this.claimsDir = path.join(config.stateDir, 'state');
        if (!fs.existsSync(this.claimsDir)) {
            fs.mkdirSync(this.claimsDir, { recursive: true });
        }
        // Load persisted claims on startup
        this.loadClaims();
        // Register AgentBus message handlers
        this.registerHandlers();
        // Start periodic claim pruning
        this.startPruning();
    }
    // ── Claiming ────────────────────────────────────────────────────────
    /**
     * Attempt to claim a job before execution.
     *
     * Returns a `claimId` if the claim succeeds, or `null` if another
     * machine already holds an active claim on this job.
     *
     * @param jobSlug - The job to claim.
     * @param timeoutMs - Claim timeout (default: defaultClaimTimeoutMs).
     */
    async tryClaim(jobSlug, timeoutMs) {
        // Prune expired claims first
        this.pruneExpired();
        // Check for active claim
        const existing = this.claims.get(jobSlug);
        if (existing && !existing.completed) {
            // Someone already claimed this job and the claim is still active
            if (existing.machineId === this.machineId) {
                // We already claimed it — return existing claim
                return existing.claimId;
            }
            // Another machine claimed it — reject
            return null;
        }
        // Generate claim
        const claimId = `claim_${crypto.randomBytes(8).toString('hex')}`;
        const now = new Date();
        const timeout = timeoutMs ?? this.defaultClaimTimeoutMs;
        const expiresAt = new Date(now.getTime() + timeout).toISOString();
        const claim = {
            claimId,
            jobSlug,
            machineId: this.machineId,
            claimedAt: now.toISOString(),
            expiresAt,
            completed: false,
        };
        // Record locally
        this.claims.set(jobSlug, claim);
        this.saveClaims();
        // Broadcast via AgentBus
        await this.bus.send({
            type: 'work-announcement',
            to: '*',
            payload: {
                claimId,
                jobSlug,
                machineId: this.machineId,
                expiresAt,
            },
        });
        return claimId;
    }
    /**
     * Signal that a claimed job has completed.
     *
     * @param jobSlug - The job that completed.
     * @param result - Success or failure.
     */
    async completeClaim(jobSlug, result) {
        const claim = this.claims.get(jobSlug);
        if (!claim || claim.machineId !== this.machineId)
            return;
        // Update local state
        claim.completed = true;
        claim.result = result;
        claim.completedAt = new Date().toISOString();
        this.saveClaims();
        // Broadcast completion
        await this.bus.send({
            type: 'work-complete',
            to: '*',
            payload: {
                claimId: claim.claimId,
                jobSlug,
                machineId: this.machineId,
                result,
            },
        });
    }
    // ── Queries ─────────────────────────────────────────────────────────
    /**
     * Check if a job has an active (non-expired, non-completed) claim
     * from another machine.
     */
    hasRemoteClaim(jobSlug) {
        this.pruneExpired();
        const claim = this.claims.get(jobSlug);
        if (!claim)
            return false;
        if (claim.completed)
            return false;
        if (claim.machineId === this.machineId)
            return false;
        return true;
    }
    /**
     * Get the active claim for a job (if any).
     */
    getClaim(jobSlug) {
        this.pruneExpired();
        return this.claims.get(jobSlug);
    }
    /**
     * Get all active (non-expired, non-completed) claims.
     */
    getActiveClaims() {
        this.pruneExpired();
        return Array.from(this.claims.values()).filter(c => !c.completed);
    }
    /**
     * Get all claims (including completed and expired for diagnostics).
     */
    getAllClaims() {
        return Array.from(this.claims.values());
    }
    // ── Lifecycle ───────────────────────────────────────────────────────
    /**
     * Stop the claim manager (clear timers, save state).
     */
    destroy() {
        if (this.pruneTimer) {
            clearInterval(this.pruneTimer);
            this.pruneTimer = null;
        }
        this.saveClaims();
    }
    // ── Private: Message Handlers ─────────────────────────────────────
    registerHandlers() {
        // Handle incoming job claims from other machines
        this.bus.onMessage('work-announcement', (msg) => {
            const payload = msg.payload;
            // Only process claims with the expected shape (claimId + jobSlug)
            if (!payload.claimId || !payload.jobSlug)
                return;
            const claim = {
                claimId: payload.claimId,
                jobSlug: payload.jobSlug,
                machineId: payload.machineId,
                claimedAt: msg.timestamp,
                expiresAt: payload.expiresAt,
                completed: false,
            };
            // Only accept if no existing non-expired claim from a different machine,
            // or if the new claim supersedes (first-writer-wins by timestamp)
            const existing = this.claims.get(payload.jobSlug);
            if (!existing || existing.completed || this.isExpired(existing)) {
                this.claims.set(payload.jobSlug, claim);
                this.saveClaims();
                this.emit('claim-received', claim);
            }
            // If there's an existing active claim, the first claimer wins
        });
        // Handle incoming job completions from other machines
        this.bus.onMessage('work-complete', (msg) => {
            const payload = msg.payload;
            if (!payload.claimId || !payload.jobSlug)
                return;
            const claim = this.claims.get(payload.jobSlug);
            if (claim && claim.claimId === payload.claimId) {
                claim.completed = true;
                claim.result = payload.result;
                claim.completedAt = msg.timestamp;
                this.saveClaims();
                this.emit('complete-received', payload);
            }
        });
    }
    // ── Private: Pruning ──────────────────────────────────────────────
    startPruning() {
        this.pruneTimer = setInterval(() => {
            this.pruneExpired();
        }, this.pruneIntervalMs);
        if (this.pruneTimer.unref) {
            this.pruneTimer.unref();
        }
    }
    /**
     * Remove expired and completed claims from the ledger.
     * Expired claims are claims where expiresAt has passed and no
     * work-complete was received — the claiming machine may have crashed.
     */
    pruneExpired() {
        const now = Date.now();
        let pruned = 0;
        for (const [slug, claim] of this.claims) {
            if (claim.completed) {
                // Completed claims: remove after 1 hour (for diagnostics retention)
                const completedAt = claim.completedAt ? new Date(claim.completedAt).getTime() : now;
                if (now - completedAt > 60 * 60_000) {
                    this.claims.delete(slug);
                    pruned++;
                }
            }
            else if (this.isExpired(claim)) {
                // Expired claims: remove and emit event
                this.claims.delete(slug);
                this.emit('claim-expired', claim);
                pruned++;
            }
        }
        if (pruned > 0) {
            this.saveClaims();
        }
        return pruned;
    }
    isExpired(claim) {
        return Date.now() > new Date(claim.expiresAt).getTime();
    }
    // ── Private: Persistence ──────────────────────────────────────────
    loadClaims() {
        const filePath = path.join(this.claimsDir, CLAIMS_FILE);
        try {
            const content = fs.readFileSync(filePath, 'utf-8');
            const data = JSON.parse(content);
            this.claims.clear();
            for (const claim of data) {
                this.claims.set(claim.jobSlug, claim);
            }
        }
        catch {
            // File may not exist yet — start with empty ledger
        }
    }
    saveClaims() {
        const filePath = path.join(this.claimsDir, CLAIMS_FILE);
        const data = Array.from(this.claims.values());
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
    }
}
//# sourceMappingURL=JobClaimManager.js.map