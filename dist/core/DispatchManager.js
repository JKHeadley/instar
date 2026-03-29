/**
 * Dispatch Manager — receives and integrates intelligence from Dawn.
 *
 * The counterpart to FeedbackManager: while feedback flows agent → Dawn,
 * dispatches flow Dawn → agent. This is the "collective intelligence"
 * distribution channel.
 *
 * Security model:
 *   Layer 1 (Transport): HTTPS only, source URL validation
 *   Layer 2 (Identity): Sends agent identification headers
 *   Layer 3 (Intelligence): Agent evaluates dispatch content before applying
 *
 * Dispatches are stored locally in .instar/state/dispatches.json and
 * can be loaded into agent context for behavioral integration.
 */
import fs from 'node:fs';
import path from 'node:path';
/** Types that are safe for auto-apply (no security risk from automated integration) */
const AUTO_APPLY_SAFE_TYPES = new Set([
    'lesson', 'strategy',
]);
/** Priorities that are safe for auto-apply (exclude critical — those deserve human eyes) */
const AUTO_APPLY_SAFE_PRIORITIES = new Set([
    'low', 'normal', 'high',
]);
export class DispatchManager {
    config;
    dispatchFile;
    version;
    lastCheckFile;
    contextFile;
    constructor(config) {
        if (config.dispatchUrl) {
            DispatchManager.validateDispatchUrl(config.dispatchUrl);
        }
        this.config = config;
        this.dispatchFile = config.dispatchFile;
        this.version = config.version || '0.0.0';
        this.lastCheckFile = config.dispatchFile.replace('.json', '-last-check.json');
        this.contextFile = config.dispatchFile.replace('dispatches.json', 'dispatch-context.md');
    }
    /** Validate dispatch URL is HTTPS and not internal. */
    static validateDispatchUrl(url) {
        let parsed;
        try {
            parsed = new URL(url);
        }
        catch {
            throw new Error(`DispatchManager: invalid dispatch URL: ${url}`);
        }
        if (parsed.protocol !== 'https:') {
            throw new Error('DispatchManager: dispatch URL must use HTTPS');
        }
        const host = parsed.hostname.toLowerCase();
        if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '0.0.0.0' ||
            host.startsWith('10.') || host.startsWith('192.168.') || host.endsWith('.local') ||
            host.startsWith('169.254.') || host === '[::1]') {
            throw new Error('DispatchManager: dispatch URL must not point to internal addresses');
        }
    }
    /** Standard headers identifying this agent. */
    get requestHeaders() {
        return {
            'Accept': 'application/json',
            'User-Agent': `instar/${this.version} (node/${process.version})`,
            'X-Instar-Version': this.version,
        };
    }
    /**
     * Poll for new dispatches since last check.
     */
    async check() {
        if (!this.config.enabled || !this.config.dispatchUrl) {
            return { newCount: 0, dispatches: [], checkedAt: new Date().toISOString() };
        }
        const lastCheck = this.getLastCheckTime();
        const now = new Date().toISOString();
        try {
            const url = new URL(this.config.dispatchUrl);
            if (lastCheck) {
                url.searchParams.set('since', lastCheck);
            }
            const response = await fetch(url.toString(), {
                method: 'GET',
                headers: this.requestHeaders,
                signal: AbortSignal.timeout(15000),
            });
            if (!response.ok) {
                const errorText = await response.text().catch(() => 'Unknown error');
                return {
                    newCount: 0,
                    dispatches: [],
                    checkedAt: now,
                    error: `Server returned ${response.status}: ${errorText}`,
                };
            }
            const data = await response.json();
            // Filter out dispatches we already have
            const existing = this.loadDispatches();
            const existingIds = new Set(existing.map(d => d.dispatchId));
            const newDispatches = data.dispatches
                .filter(d => !existingIds.has(d.dispatchId))
                .map(d => ({
                dispatchId: d.dispatchId,
                type: d.type,
                title: d.title,
                content: d.content,
                priority: (d.priority || 'normal'),
                minVersion: d.minVersion,
                maxVersion: d.maxVersion,
                createdAt: d.createdAt,
                receivedAt: now,
                applied: false,
            }));
            // Append new dispatches
            if (newDispatches.length > 0) {
                this.appendDispatches(newDispatches);
            }
            // Save last check time
            this.saveLastCheckTime(now);
            return {
                newCount: newDispatches.length,
                dispatches: newDispatches,
                checkedAt: now,
            };
        }
        catch (err) {
            return {
                newCount: 0,
                dispatches: [],
                checkedAt: now,
                error: err instanceof Error ? err.message : String(err),
            };
        }
    }
    /**
     * List all received dispatches.
     */
    list() {
        return this.loadDispatches();
    }
    /**
     * List only unapplied dispatches (includes those pending approval).
     */
    pending() {
        return this.loadDispatches().filter(d => !d.applied);
    }
    /**
     * List only dispatches awaiting human approval.
     */
    pendingApproval() {
        return this.loadDispatches().filter(d => d.pendingApproval === true && !d.applied);
    }
    /**
     * Approve a dispatch that was pending human sign-off.
     * Clears pendingApproval and marks as applied with an accepted evaluation.
     */
    approve(dispatchId) {
        const dispatches = this.loadDispatches();
        const dispatch = dispatches.find(d => d.dispatchId === dispatchId);
        if (!dispatch || !dispatch.pendingApproval)
            return false;
        dispatch.pendingApproval = false;
        dispatch.applied = true;
        dispatch.evaluation = {
            decision: 'accepted',
            reason: 'Human-approved',
            evaluatedAt: new Date().toISOString(),
            auto: false,
        };
        this.saveDispatches(dispatches);
        this.rebuildContextFile();
        return true;
    }
    /**
     * Reject a dispatch that was pending human sign-off.
     * Clears pendingApproval and records a rejection evaluation.
     */
    reject(dispatchId, reason) {
        const dispatches = this.loadDispatches();
        const dispatch = dispatches.find(d => d.dispatchId === dispatchId);
        if (!dispatch || !dispatch.pendingApproval)
            return false;
        dispatch.pendingApproval = false;
        dispatch.evaluation = {
            decision: 'rejected',
            reason,
            evaluatedAt: new Date().toISOString(),
            auto: false,
        };
        this.saveDispatches(dispatches);
        return true;
    }
    /**
     * Mark a dispatch as pending human approval.
     */
    markPendingApproval(dispatchId) {
        const dispatches = this.loadDispatches();
        const dispatch = dispatches.find(d => d.dispatchId === dispatchId);
        if (!dispatch)
            return false;
        dispatch.pendingApproval = true;
        this.saveDispatches(dispatches);
        return true;
    }
    /**
     * Mark a dispatch as applied.
     */
    markApplied(dispatchId) {
        const dispatches = this.loadDispatches();
        const dispatch = dispatches.find(d => d.dispatchId === dispatchId);
        if (!dispatch)
            return false;
        dispatch.applied = true;
        this.saveDispatches(dispatches);
        return true;
    }
    /**
     * Get a single dispatch by ID.
     */
    get(dispatchId) {
        return this.loadDispatches().find(d => d.dispatchId === dispatchId) ?? null;
    }
    /**
     * Generate a context string for loading into agent sessions.
     * Returns pending high-priority dispatches formatted for LLM consumption.
     */
    generateContext() {
        const pending = this.pending();
        if (pending.length === 0)
            return '';
        // Sort by priority (critical > high > normal > low)
        const priorityOrder = { critical: 0, high: 1, normal: 2, low: 3 };
        pending.sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority]);
        const lines = [
            '## Intelligence Dispatches',
            '',
            `${pending.length} pending dispatch${pending.length === 1 ? '' : 'es'} from Dawn:`,
            '',
        ];
        for (const d of pending) {
            const priorityTag = d.priority === 'critical' ? ' [CRITICAL]' :
                d.priority === 'high' ? ' [HIGH]' : '';
            lines.push(`### ${d.title}${priorityTag}`);
            lines.push(`Type: ${d.type} | ID: ${d.dispatchId}`);
            lines.push('');
            lines.push(d.content);
            lines.push('');
        }
        return lines.join('\n');
    }
    // ── Phase 2: Intelligent Application ────────────────────────────
    /**
     * Evaluate a dispatch — record whether it was accepted, rejected, or deferred.
     * This is the "intelligence as security" layer: the agent decides.
     */
    evaluate(dispatchId, decision, reason) {
        const dispatches = this.loadDispatches();
        const dispatch = dispatches.find(d => d.dispatchId === dispatchId);
        if (!dispatch)
            return false;
        dispatch.evaluation = {
            decision,
            reason,
            evaluatedAt: new Date().toISOString(),
            auto: false,
        };
        // If accepted, also mark as applied
        if (decision === 'accepted') {
            dispatch.applied = true;
        }
        this.saveDispatches(dispatches);
        return true;
    }
    /**
     * Apply a dispatch to the persistent context file.
     * This writes the dispatch content to .instar/state/dispatch-context.md
     * which agents load at session start for behavioral integration.
     */
    applyToContext(dispatchId) {
        const dispatch = this.get(dispatchId);
        if (!dispatch)
            return false;
        // Mark as applied if not already
        if (!dispatch.applied) {
            this.markApplied(dispatchId);
        }
        // Rebuild the context file from all applied dispatches
        this.rebuildContextFile();
        return true;
    }
    /**
     * Check for new dispatches and auto-apply safe ones.
     * Auto-apply criteria:
     *   - autoApply must be enabled in config
     *   - dispatch type must be in AUTO_APPLY_SAFE_TYPES (lesson, strategy)
     *   - dispatch priority must not be critical
     *   - security dispatches are NEVER auto-applied (need agent review)
     *   - behavioral/configuration dispatches need agent review
     */
    async checkAndAutoApply() {
        const result = await this.check();
        if (result.newCount === 0 || !this.config.autoApply) {
            return result;
        }
        let autoApplied = 0;
        const dispatches = this.loadDispatches();
        for (const newDispatch of result.dispatches) {
            const stored = dispatches.find(d => d.dispatchId === newDispatch.dispatchId);
            if (!stored || stored.applied)
                continue;
            if (this.isSafeForAutoApply(stored)) {
                stored.applied = true;
                stored.evaluation = {
                    decision: 'accepted',
                    reason: `Auto-applied: ${stored.type} dispatch with ${stored.priority} priority`,
                    evaluatedAt: new Date().toISOString(),
                    auto: true,
                };
                autoApplied++;
            }
        }
        if (autoApplied > 0) {
            this.saveDispatches(dispatches);
            this.rebuildContextFile();
        }
        return { ...result, autoApplied };
    }
    /**
     * Check whether a dispatch is safe for automatic application.
     */
    isSafeForAutoApply(dispatch) {
        return AUTO_APPLY_SAFE_TYPES.has(dispatch.type) &&
            AUTO_APPLY_SAFE_PRIORITIES.has(dispatch.priority);
    }
    /**
     * Get the path to the persistent context file.
     */
    getContextFilePath() {
        return this.contextFile;
    }
    /**
     * Read the current context file contents (for agent session loading).
     */
    readContextFile() {
        if (!fs.existsSync(this.contextFile))
            return '';
        try {
            return fs.readFileSync(this.contextFile, 'utf-8');
        }
        catch {
            // @silent-fallback-ok — context file returns empty
            return '';
        }
    }
    // ── Phase 3: Feedback Loop Closure ─────────────────────────────
    /**
     * Record feedback on a dispatch — was it helpful?
     * This is the agent-side of the feedback loop. The route handler
     * should also forward this to FeedbackManager for upstream delivery.
     */
    recordFeedback(dispatchId, helpful, comment) {
        const dispatches = this.loadDispatches();
        const dispatch = dispatches.find(d => d.dispatchId === dispatchId);
        if (!dispatch)
            return false;
        dispatch.feedback = {
            helpful,
            comment,
            feedbackAt: new Date().toISOString(),
        };
        this.saveDispatches(dispatches);
        return true;
    }
    /**
     * Get aggregate stats about dispatch effectiveness.
     */
    stats() {
        const dispatches = this.loadDispatches();
        const byType = {};
        let applied = 0;
        let pending = 0;
        let rejected = 0;
        let helpfulCount = 0;
        let unhelpfulCount = 0;
        for (const d of dispatches) {
            // Per-type tracking
            if (!byType[d.type]) {
                byType[d.type] = { total: 0, applied: 0, helpful: 0 };
            }
            byType[d.type].total++;
            if (d.applied) {
                applied++;
                byType[d.type].applied++;
            }
            else if (d.evaluation?.decision === 'rejected') {
                rejected++;
            }
            else {
                pending++;
            }
            if (d.feedback?.helpful === true) {
                helpfulCount++;
                byType[d.type].helpful++;
            }
            else if (d.feedback?.helpful === false) {
                unhelpfulCount++;
            }
        }
        return {
            total: dispatches.length,
            applied,
            pending,
            rejected,
            helpfulCount,
            unhelpfulCount,
            byType,
        };
    }
    /**
     * Get dispatches that have feedback (for upstream aggregation).
     */
    withFeedback() {
        return this.loadDispatches().filter(d => d.feedback != null);
    }
    /**
     * Rebuild the persistent context file from all applied dispatches.
     * This is the file that agents load at session start.
     */
    rebuildContextFile() {
        const applied = this.loadDispatches().filter(d => d.applied);
        if (applied.length === 0) {
            // Remove context file if no applied dispatches
            if (fs.existsSync(this.contextFile)) {
                fs.unlinkSync(this.contextFile);
            }
            return;
        }
        // Sort by type, then by creation date
        const typeOrder = {
            security: 0, behavioral: 1, configuration: 2, strategy: 3, lesson: 4,
        };
        applied.sort((a, b) => {
            const typeDiff = (typeOrder[a.type] ?? 5) - (typeOrder[b.type] ?? 5);
            return typeDiff !== 0 ? typeDiff : a.createdAt.localeCompare(b.createdAt);
        });
        const lines = [
            '# Intelligence Dispatches (Applied)',
            '',
            '> This file is auto-generated from applied dispatches.',
            '> It is loaded into agent sessions for behavioral integration.',
            `> Last updated: ${new Date().toISOString()}`,
            '',
        ];
        // Group by type
        let currentType = '';
        for (const d of applied) {
            if (d.type !== currentType) {
                currentType = d.type;
                lines.push(`## ${currentType.charAt(0).toUpperCase() + currentType.slice(1)} Dispatches`);
                lines.push('');
            }
            lines.push(`### ${d.title}`);
            lines.push('');
            lines.push(d.content);
            lines.push('');
        }
        const dir = path.dirname(this.contextFile);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(this.contextFile, lines.join('\n'));
    }
    // ── Private helpers ──────────────────────────────────────────────
    loadDispatches() {
        if (!fs.existsSync(this.dispatchFile))
            return [];
        try {
            return JSON.parse(fs.readFileSync(this.dispatchFile, 'utf-8'));
        }
        catch {
            return [];
        }
    }
    saveDispatches(items) {
        const dir = path.dirname(this.dispatchFile);
        fs.mkdirSync(dir, { recursive: true });
        const tmpPath = `${this.dispatchFile}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
        try {
            fs.writeFileSync(tmpPath, JSON.stringify(items, null, 2));
            fs.renameSync(tmpPath, this.dispatchFile);
        }
        catch (err) {
            try {
                fs.unlinkSync(tmpPath);
            }
            catch { /* ignore */ }
            throw err;
        }
    }
    appendDispatches(newItems) {
        const items = this.loadDispatches();
        items.push(...newItems);
        // Cap at 500 dispatches
        const capped = items.length > 500 ? items.slice(-500) : items;
        this.saveDispatches(capped);
    }
    getLastCheckTime() {
        if (!fs.existsSync(this.lastCheckFile))
            return null;
        try {
            const data = JSON.parse(fs.readFileSync(this.lastCheckFile, 'utf-8'));
            return data.lastCheck || null;
        }
        catch {
            // @silent-fallback-ok — last check returns null
            return null;
        }
    }
    saveLastCheckTime(time) {
        const dir = path.dirname(this.lastCheckFile);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(this.lastCheckFile, JSON.stringify({ lastCheck: time }));
    }
}
//# sourceMappingURL=DispatchManager.js.map