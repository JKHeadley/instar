/**
 * DispatchDecisionJournal — Dispatch-specific decision journal with query capabilities.
 *
 * Extends the base DecisionJournal to provide dispatch-specific logging and
 * querying. This is the observability foundation for the Discernment Layer.
 *
 * Storage: Same JSONL file as DecisionJournal (decision-journal.jsonl).
 * Dispatch entries are distinguished by `type: 'dispatch'` field.
 *
 * Milestone 1: Logging + querying. All entries are structural (auto-applied).
 * Milestone 4: LLM evaluation adds contextual entries.
 */
import fs from 'node:fs';
import path from 'node:path';
import { DecisionJournal } from './DecisionJournal.js';
import { DegradationReporter } from '../monitoring/DegradationReporter.js';
import { maybeRotateJsonl } from '../utils/jsonl-rotation.js';
export class DispatchDecisionJournal {
    journalFile;
    baseJournal;
    constructor(stateDir) {
        this.journalFile = path.join(stateDir, 'decision-journal.jsonl');
        this.baseJournal = new DecisionJournal(stateDir);
    }
    /**
     * Log a dispatch integration decision.
     */
    logDispatchDecision(entry) {
        const full = {
            ...entry,
            type: 'dispatch',
            // Map dispatchDecision to the base 'decision' field for compatibility
            decision: `dispatch:${entry.dispatchDecision}`,
            timestamp: new Date().toISOString(),
        };
        // Ensure parent directory exists (lazy creation)
        const dir = path.dirname(this.journalFile);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        maybeRotateJsonl(this.journalFile);
        fs.appendFileSync(this.journalFile, JSON.stringify(full) + '\n');
        return full;
    }
    /**
     * Query dispatch decision entries with filtering.
     */
    query(options) {
        const all = this.readDispatchEntries();
        const cutoff = options?.days
            ? new Date(Date.now() - options.days * 24 * 60 * 60 * 1000).toISOString()
            : undefined;
        let filtered = all.filter(e => {
            if (cutoff && e.timestamp < cutoff)
                return false;
            if (options?.dispatchId && e.dispatchId !== options.dispatchId)
                return false;
            if (options?.decision && e.dispatchDecision !== options.decision)
                return false;
            if (options?.dispatchType && e.dispatchType !== options.dispatchType)
                return false;
            if (options?.evaluationMethod && e.evaluationMethod !== options.evaluationMethod)
                return false;
            if (options?.tag && (!e.tags || !e.tags.includes(options.tag)))
                return false;
            return true;
        });
        // Most recent first. JSONL is append-only so line index breaks ties.
        // We tag entries with _lineIndex in readDispatchEntries for stable ordering.
        filtered.sort((a, b) => {
            const timeDiff = b.timestamp.localeCompare(a.timestamp);
            if (timeDiff !== 0)
                return timeDiff;
            // Same timestamp: later line = more recent
            return (b._lineIndex ?? 0) - (a._lineIndex ?? 0);
        });
        if (options?.limit) {
            filtered = filtered.slice(0, options.limit);
        }
        return filtered;
    }
    /**
     * Get the decision for a specific dispatch ID.
     * Returns the most recent decision if multiple exist (e.g., defer then accept).
     */
    getDecisionForDispatch(dispatchId) {
        const entries = this.query({ dispatchId, limit: 1 });
        return entries[0] ?? null;
    }
    /**
     * Check if a dispatch has already been decided on.
     */
    hasDecision(dispatchId) {
        return this.getDecisionForDispatch(dispatchId) !== null;
    }
    /**
     * Get aggregate statistics for dispatch decisions.
     */
    stats(options) {
        const entries = options?.days
            ? this.query({ days: options.days })
            : this.readDispatchEntries();
        if (entries.length === 0) {
            return {
                total: 0,
                byDecision: {},
                byDispatchType: {},
                byEvaluationMethod: {},
                acceptanceRate: 0,
                earliest: null,
                latest: null,
            };
        }
        const byDecision = {};
        const byDispatchType = {};
        const byEvaluationMethod = {};
        for (const entry of entries) {
            byDecision[entry.dispatchDecision] = (byDecision[entry.dispatchDecision] || 0) + 1;
            byDispatchType[entry.dispatchType] = (byDispatchType[entry.dispatchType] || 0) + 1;
            byEvaluationMethod[entry.evaluationMethod] = (byEvaluationMethod[entry.evaluationMethod] || 0) + 1;
        }
        // Sort chronologically for earliest/latest
        const sorted = [...entries].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
        const acceptCount = byDecision['accept'] || 0;
        return {
            total: entries.length,
            byDecision,
            byDispatchType,
            byEvaluationMethod,
            acceptanceRate: entries.length > 0 ? acceptCount / entries.length : 0,
            earliest: sorted[0].timestamp,
            latest: sorted[sorted.length - 1].timestamp,
        };
    }
    /**
     * Get the underlying base journal (for non-dispatch queries).
     */
    getBaseJournal() {
        return this.baseJournal;
    }
    /**
     * Read only dispatch-type entries from the JSONL file.
     */
    readDispatchEntries() {
        if (!fs.existsSync(this.journalFile))
            return [];
        try {
            const content = fs.readFileSync(this.journalFile, 'utf-8').trim();
            if (!content)
                return [];
            const lines = content.split('\n');
            const entries = [];
            for (let i = 0; i < lines.length; i++) {
                try {
                    const parsed = JSON.parse(lines[i]);
                    if (parsed.type === 'dispatch') {
                        // Tag with line index for stable sort tiebreaking
                        parsed._lineIndex = i;
                        entries.push(parsed);
                    }
                }
                catch {
                    // Skip corrupt lines
                }
            }
            return entries;
        }
        catch (error) {
            console.error(`[DispatchDecisionJournal] Failed to read ${this.journalFile}:`, error);
            DegradationReporter.getInstance().report({
                feature: 'DispatchDecisionJournal.readDispatchEntries',
                primary: 'Read dispatch decisions from JSONL',
                fallback: 'Return empty array — no dispatch history',
                reason: `Failed to read journal: ${error instanceof Error ? error.message : String(error)}`,
                impact: 'Discernment Layer lacks dispatch decision data',
            });
            return [];
        }
    }
}
//# sourceMappingURL=DispatchDecisionJournal.js.map