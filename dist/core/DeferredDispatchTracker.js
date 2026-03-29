/**
 * DeferredDispatchTracker — Manages deferred dispatch lifecycle.
 *
 * Tracks dispatches that the ContextualEvaluator deferred, with:
 * - Bounded queue (max deferred dispatches)
 * - Maximum deferral count per dispatch (auto-reject after N deferrals)
 * - Re-evaluation scheduling (every N polls)
 * - Deferral loop detection (identical reasons → auto-reject)
 * - Queue overflow handling (oldest deferred auto-rejected)
 *
 * State is persisted to disk for crash recovery.
 */
import fs from 'node:fs';
import path from 'node:path';
// ── Main Class ──────────────────────────────────────────────────────
export class DeferredDispatchTracker {
    config;
    queue = new Map();
    stateFile;
    currentPoll = 0;
    constructor(stateDir, config) {
        this.config = {
            maxDeferralCount: config?.maxDeferralCount ?? 5,
            maxDeferredDispatches: config?.maxDeferredDispatches ?? 20,
            reEvaluateEveryPolls: config?.reEvaluateEveryPolls ?? 3,
            loopDetectionThreshold: config?.loopDetectionThreshold ?? 3,
        };
        this.stateFile = path.join(stateDir, 'state', 'deferred-dispatches.json');
        this.loadState();
    }
    /**
     * Add or re-defer a dispatch. Returns what happened.
     */
    defer(dispatch, condition, reason) {
        const existing = this.queue.get(dispatch.dispatchId);
        if (existing) {
            // Re-deferral — increment count
            existing.deferCount++;
            existing.deferCondition = condition;
            existing.deferReasonHistory.push({
                reason,
                evaluatedAt: new Date().toISOString(),
            });
            existing.nextReEvaluateAtPoll = this.currentPoll + this.config.reEvaluateEveryPolls;
            // Check max deferrals
            if (existing.deferCount >= existing.maxDefers) {
                this.queue.delete(dispatch.dispatchId);
                this.saveState();
                return {
                    action: 'auto-rejected',
                    reason: `Exceeded max deferrals (${existing.maxDefers}): ${reason}`,
                };
            }
            // Check for deferral loop
            if (this.isLooping(existing)) {
                this.queue.delete(dispatch.dispatchId);
                this.saveState();
                return {
                    action: 'auto-rejected',
                    reason: `Deferral loop detected: last ${this.config.loopDetectionThreshold} reasons are identical`,
                };
            }
            this.saveState();
            return { action: 'deferred', reason: `Re-deferred (${existing.deferCount}/${existing.maxDefers})` };
        }
        // New deferral
        const state = {
            dispatchId: dispatch.dispatchId,
            deferredAt: new Date().toISOString(),
            deferCount: 1,
            maxDefers: this.config.maxDeferralCount,
            nextReEvaluateAtPoll: this.currentPoll + this.config.reEvaluateEveryPolls,
            deferCondition: condition,
            deferReasonHistory: [{ reason, evaluatedAt: new Date().toISOString() }],
            dispatch,
        };
        // Check queue overflow
        let evictedId;
        if (this.queue.size >= this.config.maxDeferredDispatches) {
            evictedId = this.evictOldest();
        }
        this.queue.set(dispatch.dispatchId, state);
        this.saveState();
        if (evictedId) {
            return {
                action: 'overflow-rejected',
                reason: `Queue full (${this.config.maxDeferredDispatches}). Evicted oldest: ${evictedId}`,
                evictedDispatchId: evictedId,
            };
        }
        return { action: 'deferred', reason: `Deferred (1/${this.config.maxDeferralCount})` };
    }
    /**
     * Get dispatches that are due for re-evaluation at the current poll.
     */
    getDueForReEvaluation() {
        const due = [];
        for (const state of this.queue.values()) {
            if (this.currentPoll >= state.nextReEvaluateAtPoll) {
                due.push(state);
            }
        }
        return due;
    }
    /**
     * Remove a dispatch from the deferred queue (e.g., after re-evaluation resolves it).
     */
    remove(dispatchId) {
        const removed = this.queue.delete(dispatchId);
        if (removed)
            this.saveState();
        return removed;
    }
    /**
     * Advance the poll counter. Call this on each AutoDispatcher tick.
     */
    advancePoll() {
        this.currentPoll++;
        this.saveState();
    }
    /**
     * Check if a dispatch is currently deferred.
     */
    isDeferred(dispatchId) {
        return this.queue.has(dispatchId);
    }
    /**
     * Get the current deferred queue state.
     */
    getState(dispatchId) {
        return this.queue.get(dispatchId);
    }
    /**
     * Get all deferred dispatches.
     */
    getAll() {
        return [...this.queue.values()];
    }
    /**
     * Current queue size.
     */
    get size() {
        return this.queue.size;
    }
    /**
     * Current poll number.
     */
    get pollCount() {
        return this.currentPoll;
    }
    // ── Private ───────────────────────────────────────────────────────
    isLooping(state) {
        const history = state.deferReasonHistory;
        const threshold = this.config.loopDetectionThreshold;
        if (history.length < threshold)
            return false;
        const recent = history.slice(-threshold);
        const firstReason = recent[0].reason.toLowerCase().trim();
        return recent.every(r => r.reason.toLowerCase().trim() === firstReason);
    }
    evictOldest() {
        let oldest = null;
        for (const state of this.queue.values()) {
            if (!oldest || state.deferredAt < oldest.deferredAt) {
                oldest = state;
            }
        }
        if (oldest) {
            this.queue.delete(oldest.dispatchId);
            return oldest.dispatchId;
        }
        return '';
    }
    loadState() {
        try {
            if (fs.existsSync(this.stateFile)) {
                const data = JSON.parse(fs.readFileSync(this.stateFile, 'utf-8'));
                this.currentPoll = data.currentPoll ?? 0;
                if (Array.isArray(data.queue)) {
                    for (const item of data.queue) {
                        this.queue.set(item.dispatchId, item);
                    }
                }
            }
        }
        catch {
            // Start fresh
        }
    }
    saveState() {
        const dir = path.dirname(this.stateFile);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        const data = {
            currentPoll: this.currentPoll,
            queue: [...this.queue.values()],
            savedAt: new Date().toISOString(),
        };
        const tmpPath = this.stateFile + `.${process.pid}.tmp`;
        try {
            fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2));
            fs.renameSync(tmpPath, this.stateFile);
        }
        catch {
            try {
                fs.unlinkSync(tmpPath);
            }
            catch { /* ignore */ }
        }
    }
}
//# sourceMappingURL=DeferredDispatchTracker.js.map