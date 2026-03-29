/**
 * Commitment Tracker — durable promise enforcement for agent infrastructure.
 *
 * When a user asks an agent to change something, the agent says "done" — but
 * often the change doesn't stick. Sessions compact, configs revert, behavioral
 * promises get forgotten. This module closes that gap.
 *
 * Three commitment types:
 *   1. config-change  — enforced by code (auto-corrects config drift)
 *   2. behavioral     — injected into every session via hooks
 *   3. one-time-action — tracked until verified, then closed
 *
 * The CommitmentTracker runs as a server-side monitor. It does NOT depend on
 * the LLM following instructions — it enforces commitments independently.
 *
 * Lifecycle:
 *   record → verify → (auto-correct if needed) → monitor → resolve
 */
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { DegradationReporter } from './DegradationReporter.js';
// ── Implementation ────────────────────────────────────────────────
export class CommitmentTracker extends EventEmitter {
    config;
    store;
    storePath;
    rulesPath;
    interval = null;
    nextId;
    constructor(config) {
        super();
        this.config = config;
        this.storePath = path.join(config.stateDir, 'state', 'commitments.json');
        this.rulesPath = path.join(config.stateDir, 'state', 'commitment-rules.md');
        this.store = this.loadStore();
        this.nextId = this.computeNextId();
    }
    // ── Lifecycle ──────────────────────────────────────────────────
    start() {
        if (this.interval)
            return;
        const intervalMs = this.config.checkIntervalMs ?? 60_000;
        // First verification after a short delay
        setTimeout(() => this.verify(), 15_000);
        this.interval = setInterval(() => this.verify(), intervalMs);
        this.interval.unref();
        const active = this.getActive().length;
        if (active > 0) {
            console.log(`[CommitmentTracker] Started (every ${Math.round(intervalMs / 1000)}s, ${active} active commitment(s))`);
        }
        else {
            console.log(`[CommitmentTracker] Started (every ${Math.round(intervalMs / 1000)}s, no active commitments)`);
        }
    }
    stop() {
        if (this.interval) {
            clearInterval(this.interval);
            this.interval = null;
        }
    }
    // ── Commitment CRUD ────────────────────────────────────────────
    /**
     * Record a new commitment. Returns the created commitment.
     */
    record(input) {
        const id = `CMT-${String(this.nextId++).padStart(3, '0')}`;
        const commitment = {
            id,
            userRequest: input.userRequest,
            agentResponse: input.agentResponse,
            type: input.type,
            status: 'pending',
            createdAt: new Date().toISOString(),
            verificationCount: 0,
            violationCount: 0,
            topicId: input.topicId,
            source: input.source ?? 'agent',
            configPath: input.configPath,
            configExpectedValue: input.configExpectedValue,
            behavioralRule: input.behavioralRule,
            expiresAt: input.expiresAt,
            verificationMethod: input.verificationMethod,
            verificationPath: input.verificationPath,
            correctionCount: 0,
            correctionHistory: [],
            escalated: false,
        };
        this.store.commitments.push(commitment);
        this.saveStore();
        // Regenerate behavioral rules file if this is a behavioral commitment
        if (input.type === 'behavioral') {
            this.writeBehavioralRules();
        }
        console.log(`[CommitmentTracker] Recorded ${id}: "${input.userRequest}" (${input.type})`);
        this.emit('recorded', commitment);
        // Run immediate verification for config-change commitments
        if (input.type === 'config-change') {
            this.verifyOne(id);
        }
        return commitment;
    }
    /**
     * Withdraw a commitment (user changed their mind).
     */
    withdraw(id, reason) {
        const commitment = this.store.commitments.find(c => c.id === id);
        if (!commitment || commitment.status === 'withdrawn' || commitment.status === 'expired') {
            return false;
        }
        commitment.status = 'withdrawn';
        commitment.resolvedAt = new Date().toISOString();
        commitment.resolution = reason;
        this.saveStore();
        if (commitment.type === 'behavioral') {
            this.writeBehavioralRules();
        }
        console.log(`[CommitmentTracker] Withdrawn ${id}: ${reason}`);
        this.emit('withdrawn', commitment);
        return true;
    }
    /**
     * Get all active commitments (pending or verified, not expired).
     */
    getActive() {
        const now = new Date().toISOString();
        return this.store.commitments.filter(c => {
            if (c.status === 'withdrawn' || c.status === 'expired')
                return false;
            if (c.expiresAt && c.expiresAt < now)
                return false;
            // Active = pending, verified, or violated (violated is still "active" — it needs attention)
            return c.status === 'pending' || c.status === 'verified' || c.status === 'violated';
        });
    }
    /**
     * Get all commitments (including resolved).
     */
    getAll() {
        return [...this.store.commitments];
    }
    /**
     * Get a single commitment by ID.
     */
    get(id) {
        return this.store.commitments.find(c => c.id === id) ?? null;
    }
    // ── Verification ───────────────────────────────────────────────
    /**
     * Run verification on all active commitments.
     */
    verify() {
        const active = this.getActive();
        const violations = [];
        let verified = 0;
        let pending = 0;
        // Expire old commitments first
        this.expireCommitments();
        for (const commitment of active) {
            const result = this.verifyOne(commitment.id);
            if (!result)
                continue;
            if (result.passed) {
                verified++;
            }
            else {
                // Attempt auto-correction for config-change commitments
                let autoCorrected = false;
                if (commitment.type === 'config-change' && commitment.configPath !== undefined) {
                    autoCorrected = this.attemptAutoCorrection(commitment);
                }
                violations.push({
                    id: commitment.id,
                    userRequest: commitment.userRequest,
                    detail: result.detail,
                    autoCorrected,
                });
            }
        }
        pending = active.filter(c => c.status === 'pending').length;
        const report = {
            timestamp: new Date().toISOString(),
            active: active.length,
            verified,
            violated: violations.length,
            pending,
            violations,
        };
        this.emit('verification', report);
        return report;
    }
    /**
     * Verify a single commitment. Returns null if commitment not found or not active.
     */
    verifyOne(id) {
        const commitment = this.store.commitments.find(c => c.id === id);
        if (!commitment)
            return null;
        if (commitment.status === 'withdrawn' || commitment.status === 'expired')
            return null;
        let result;
        switch (commitment.type) {
            case 'config-change':
                result = this.verifyConfigChange(commitment);
                break;
            case 'behavioral':
                result = this.verifyBehavioral(commitment);
                break;
            case 'one-time-action':
                result = this.verifyOneTimeAction(commitment);
                break;
            default:
                result = { passed: false, detail: `Unknown commitment type: ${commitment.type}` };
        }
        // Update commitment status based on result
        if (result.passed) {
            const wasFirstVerification = commitment.status === 'pending';
            const wasViolated = commitment.status === 'violated';
            commitment.status = 'verified';
            commitment.lastVerifiedAt = new Date().toISOString();
            commitment.verificationCount++;
            if (wasFirstVerification && this.config.onVerified) {
                this.config.onVerified(commitment);
            }
            if (wasViolated) {
                console.log(`[CommitmentTracker] ${id} recovered: "${commitment.userRequest}"`);
            }
            // Close one-time actions after first verification
            if (commitment.type === 'one-time-action') {
                commitment.resolvedAt = new Date().toISOString();
                commitment.resolution = 'Verified complete';
            }
        }
        else {
            const wasVerified = commitment.status === 'verified';
            commitment.status = 'violated';
            commitment.violationCount++;
            if (wasVerified) {
                // Regression — was verified, now violated
                console.warn(`[CommitmentTracker] VIOLATION ${id}: "${commitment.userRequest}" — ${result.detail}`);
                if (this.config.onViolation) {
                    this.config.onViolation(commitment, result.detail);
                }
            }
        }
        this.saveStore();
        return result;
    }
    // ── Session Awareness ──────────────────────────────────────────
    /**
     * Get behavioral commitments formatted for session injection.
     * This is what hooks read and inject into new sessions.
     */
    getBehavioralContext() {
        const behavioral = this.getActive().filter(c => c.type === 'behavioral' || c.type === 'config-change');
        if (behavioral.length === 0)
            return '';
        const lines = [
            '# Active Commitments (user-requested rules)',
            '',
            'These rules were explicitly requested by the user. They override defaults.',
            '',
        ];
        for (const c of behavioral) {
            const since = c.createdAt.split('T')[0];
            const expires = c.expiresAt ? ` (expires ${c.expiresAt.split('T')[0]})` : '';
            if (c.type === 'behavioral' && c.behavioralRule) {
                lines.push(`- [${c.id}] ${c.behavioralRule}${expires} (Since ${since})`);
            }
            else if (c.type === 'config-change' && c.configPath) {
                lines.push(`- [${c.id}] Config: ${c.configPath} must be ${JSON.stringify(c.configExpectedValue)}. User request: "${c.userRequest}"${expires} (Since ${since})`);
            }
        }
        return lines.join('\n');
    }
    /**
     * Get ComponentHealth for integration with HealthChecker.
     */
    getHealth() {
        const active = this.getActive();
        const violated = active.filter(c => c.status === 'violated');
        if (active.length === 0) {
            return { status: 'healthy', message: 'No active commitments', lastCheck: new Date().toISOString() };
        }
        if (violated.length > 0) {
            return {
                status: 'degraded',
                message: `${violated.length} violated commitment(s): ${violated.map(c => c.id).join(', ')}`,
                lastCheck: new Date().toISOString(),
            };
        }
        return {
            status: 'healthy',
            message: `${active.length} commitment(s) tracked, all verified`,
            lastCheck: new Date().toISOString(),
        };
    }
    // ── Type-specific Verification ─────────────────────────────────
    verifyConfigChange(commitment) {
        if (!commitment.configPath) {
            return { passed: false, detail: 'Missing configPath on config-change commitment' };
        }
        const currentValue = this.config.liveConfig.get(commitment.configPath, undefined);
        const matches = this.deepEqual(currentValue, commitment.configExpectedValue);
        return {
            passed: matches,
            detail: matches
                ? `Config ${commitment.configPath} = ${JSON.stringify(currentValue)} (matches)`
                : `Config ${commitment.configPath} = ${JSON.stringify(currentValue)}, expected ${JSON.stringify(commitment.configExpectedValue)}`,
        };
    }
    verifyBehavioral(commitment) {
        // Behavioral commitments are "verified" if the rule text exists in the rules file
        if (!commitment.behavioralRule) {
            return { passed: false, detail: 'Missing behavioralRule on behavioral commitment' };
        }
        try {
            if (!fs.existsSync(this.rulesPath)) {
                this.writeBehavioralRules();
            }
            const content = fs.readFileSync(this.rulesPath, 'utf-8');
            const hasRule = content.includes(commitment.id);
            return {
                passed: hasRule,
                detail: hasRule ? 'Behavioral rule present in injection file' : 'Behavioral rule missing from injection file — regenerating',
            };
        }
        catch {
            return { passed: false, detail: 'Failed to read behavioral rules file' };
        }
    }
    verifyOneTimeAction(commitment) {
        switch (commitment.verificationMethod) {
            case 'config-value':
                return this.verifyConfigChange(commitment);
            case 'file-exists':
                if (!commitment.verificationPath) {
                    return { passed: false, detail: 'Missing verificationPath for file-exists check' };
                }
                const exists = fs.existsSync(commitment.verificationPath);
                return {
                    passed: exists,
                    detail: exists ? `File exists: ${commitment.verificationPath}` : `File missing: ${commitment.verificationPath}`,
                };
            case 'manual':
                // Manual commitments stay pending until explicitly resolved
                return { passed: false, detail: 'Awaiting manual verification' };
            default:
                return { passed: false, detail: `Unknown verification method: ${commitment.verificationMethod}` };
        }
    }
    // ── Auto-correction ────────────────────────────────────────────
    attemptAutoCorrection(commitment) {
        if (!commitment.configPath || commitment.configExpectedValue === undefined)
            return false;
        try {
            this.config.liveConfig.set(commitment.configPath, commitment.configExpectedValue);
            // Re-verify after correction
            const recheck = this.verifyConfigChange(commitment);
            if (recheck.passed) {
                commitment.status = 'verified';
                commitment.lastVerifiedAt = new Date().toISOString();
                commitment.verificationCount++;
                // Track correction for escalation detection
                const now = new Date().toISOString();
                commitment.correctionCount = (commitment.correctionCount ?? 0) + 1;
                commitment.correctionHistory = [...(commitment.correctionHistory ?? []), now];
                // Check for escalation: too many corrections in a time window suggests a bug
                this.checkForEscalation(commitment);
                this.saveStore();
                console.log(`[CommitmentTracker] Auto-corrected ${commitment.id}: ${commitment.configPath} → ${JSON.stringify(commitment.configExpectedValue)} (correction #${commitment.correctionCount})`);
                this.emit('corrected', commitment);
                return true;
            }
        }
        catch (err) {
            DegradationReporter.getInstance().report({
                feature: 'CommitmentTracker.attemptAutoCorrection',
                primary: `Auto-correct config drift for commitment ${commitment.id}`,
                fallback: 'Config drift persists, violation remains unresolved',
                reason: `Auto-correction failed: ${err instanceof Error ? err.message : String(err)}`,
                impact: `Commitment "${commitment.userRequest}" remains violated until next cycle`,
            });
            console.error(`[CommitmentTracker] Auto-correction failed for ${commitment.id}:`, err);
        }
        return false;
    }
    /**
     * Check if a commitment has been auto-corrected too many times,
     * suggesting a bug rather than simple drift.
     */
    checkForEscalation(commitment) {
        if (commitment.escalated)
            return; // Already escalated
        const threshold = this.config.escalationThreshold ?? 3;
        const windowMs = this.config.escalationWindowMs ?? 3_600_000; // 1 hour
        const now = Date.now();
        // Count corrections within the window
        const recentCorrections = (commitment.correctionHistory ?? []).filter(ts => {
            return (now - new Date(ts).getTime()) < windowMs;
        });
        if (recentCorrections.length >= threshold) {
            commitment.escalated = true;
            const detail = `Commitment ${commitment.id} ("${commitment.userRequest}") has been auto-corrected ${recentCorrections.length} times in the last ${Math.round(windowMs / 60_000)} minutes. Config path: ${commitment.configPath}. This pattern suggests something is actively overwriting the value — likely a bug in initialization, a conflicting process, or a default value that resets on restart.`;
            commitment.escalationDetail = detail;
            console.warn(`[CommitmentTracker] ESCALATION ${commitment.id}: ${detail}`);
            this.emit('escalation', commitment, detail);
            if (this.config.onEscalation) {
                this.config.onEscalation(commitment, detail);
            }
        }
    }
    // ── Behavioral Rules File ──────────────────────────────────────
    /**
     * Write the commitment-rules.md file for hook injection.
     */
    writeBehavioralRules() {
        const content = this.getBehavioralContext();
        try {
            const dir = path.dirname(this.rulesPath);
            fs.mkdirSync(dir, { recursive: true });
            if (content) {
                const tmpPath = `${this.rulesPath}.${process.pid}.tmp`;
                fs.writeFileSync(tmpPath, content + '\n');
                fs.renameSync(tmpPath, this.rulesPath);
            }
            else {
                // No active commitments — remove the file so hooks skip injection
                if (fs.existsSync(this.rulesPath)) {
                    fs.unlinkSync(this.rulesPath);
                }
            }
        }
        catch {
            // @silent-fallback-ok — rules file is nice-to-have, monitor catches violations anyway
        }
    }
    // ── Expiration ─────────────────────────────────────────────────
    expireCommitments() {
        const now = new Date().toISOString();
        let changed = false;
        for (const c of this.store.commitments) {
            if (c.expiresAt && c.expiresAt < now && c.status !== 'expired' && c.status !== 'withdrawn') {
                c.status = 'expired';
                c.resolvedAt = now;
                c.resolution = 'Expired';
                changed = true;
                console.log(`[CommitmentTracker] Expired ${c.id}: "${c.userRequest}"`);
            }
        }
        if (changed) {
            this.saveStore();
            this.writeBehavioralRules();
        }
    }
    // ── Persistence ────────────────────────────────────────────────
    loadStore() {
        try {
            if (fs.existsSync(this.storePath)) {
                const data = JSON.parse(fs.readFileSync(this.storePath, 'utf-8'));
                if (data.version === 1 && Array.isArray(data.commitments)) {
                    // Migrate: add self-healing fields to existing commitments
                    for (const c of data.commitments) {
                        if (c.correctionCount === undefined)
                            c.correctionCount = 0;
                        if (c.correctionHistory === undefined)
                            c.correctionHistory = [];
                        if (c.escalated === undefined)
                            c.escalated = false;
                    }
                    return data;
                }
            }
        }
        catch {
            // Start fresh on corruption
        }
        return { version: 1, commitments: [], lastModified: new Date().toISOString() };
    }
    saveStore() {
        this.store.lastModified = new Date().toISOString();
        try {
            const dir = path.dirname(this.storePath);
            fs.mkdirSync(dir, { recursive: true });
            const tmpPath = `${this.storePath}.${process.pid}.tmp`;
            fs.writeFileSync(tmpPath, JSON.stringify(this.store, null, 2) + '\n');
            fs.renameSync(tmpPath, this.storePath);
        }
        catch {
            // @silent-fallback-ok — state persistence failure, will retry next cycle
        }
    }
    computeNextId() {
        if (this.store.commitments.length === 0)
            return 1;
        const maxId = Math.max(...this.store.commitments.map(c => {
            const match = c.id.match(/CMT-(\d+)/);
            return match ? parseInt(match[1], 10) : 0;
        }));
        return maxId + 1;
    }
    // ── Utility ────────────────────────────────────────────────────
    deepEqual(a, b) {
        if (a === b)
            return true;
        if (a === null || b === null)
            return false;
        if (typeof a !== typeof b)
            return false;
        if (typeof a !== 'object')
            return false;
        const aObj = a;
        const bObj = b;
        const keys = new Set([...Object.keys(aObj), ...Object.keys(bObj)]);
        for (const key of keys) {
            if (!this.deepEqual(aObj[key], bObj[key]))
                return false;
        }
        return true;
    }
}
//# sourceMappingURL=CommitmentTracker.js.map