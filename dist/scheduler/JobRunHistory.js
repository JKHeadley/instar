/**
 * JobRunHistory — Persistent, searchable history of every job execution.
 *
 * History is memory. Memory should never be lost.
 *
 * Records the full lifecycle of each job run: trigger → completion,
 * with duration, result, error context, model used, output summary,
 * and LLM reflection. This is the single source of truth for
 * "what did this job do, what did it learn, and when?"
 *
 * Storage: JSONL at {stateDir}/ledger/job-runs.jsonl
 * Retention: PERMANENT. No deletion, ever. Completed runs are kept forever.
 *   On startup, the file is compacted: duplicate entries (pending → completed
 *   pairs for the same runId) are collapsed to just the final state.
 *   This saves space without losing any information.
 * Query: by slug, result, date range, with pagination
 */
import fs from 'node:fs';
import path from 'node:path';
import { DegradationReporter } from '../monitoring/DegradationReporter.js';
/** Monotonic counter to ensure unique runIds even within the same millisecond */
let runCounter = 0;
export class JobRunHistory {
    ledgerDir;
    file;
    machineId = null;
    constructor(stateDir) {
        this.ledgerDir = path.join(stateDir, 'ledger');
        this.file = path.join(this.ledgerDir, 'job-runs.jsonl');
        this.ensureDirectory();
        this.compact();
    }
    setMachineId(machineId) {
        this.machineId = machineId;
    }
    /**
     * Record that a job was triggered. Returns the runId for later completion.
     */
    recordStart(opts) {
        const runId = `${opts.slug}-${Date.now().toString(36)}-${(runCounter++).toString(36)}`;
        const run = {
            runId,
            slug: opts.slug,
            sessionId: opts.sessionId,
            trigger: opts.trigger,
            startedAt: new Date().toISOString(),
            result: 'pending',
            model: opts.model,
            machineId: this.machineId ?? undefined,
        };
        this.appendLine(run);
        return runId;
    }
    /**
     * Record that a job run completed. Updates the existing pending entry
     * by appending a completion record (JSONL is append-only — queries
     * deduplicate by taking the last entry per runId).
     */
    recordCompletion(opts) {
        // Find the pending entry to get start time
        const pending = this.findRun(opts.runId);
        if (!pending) {
            console.warn(`[JobRunHistory] No pending run found for ${opts.runId}`);
            return;
        }
        const completedAt = new Date().toISOString();
        const durationSeconds = Math.round((new Date(completedAt).getTime() - new Date(pending.startedAt).getTime()) / 1000);
        const completed = {
            ...pending,
            completedAt,
            durationSeconds,
            result: opts.result,
            error: opts.error,
            outputSummary: opts.outputSummary,
        };
        this.appendLine(completed);
    }
    /**
     * Attach an LLM reflection to a completed run.
     * Appends a new version of the run record with the reflection field set.
     * Called asynchronously after the reflection LLM call completes.
     */
    recordReflection(runId, reflection) {
        const run = this.findRun(runId);
        if (!run) {
            console.warn(`[JobRunHistory] No run found for reflection: ${runId}`);
            return;
        }
        const enriched = {
            ...run,
            reflection,
        };
        this.appendLine(enriched);
    }
    /**
     * Record a spawn error (job never made it to a session).
     */
    recordSpawnError(opts) {
        const runId = `${opts.slug}-${Date.now().toString(36)}-${(runCounter++).toString(36)}`;
        const now = new Date().toISOString();
        const run = {
            runId,
            slug: opts.slug,
            sessionId: '',
            trigger: opts.trigger,
            startedAt: now,
            completedAt: now,
            durationSeconds: 0,
            result: 'spawn-error',
            error: opts.error,
            model: opts.model,
            machineId: this.machineId ?? undefined,
        };
        this.appendLine(run);
        return runId;
    }
    /**
     * Query job run history with filters and pagination.
     */
    query(opts) {
        const all = this.getDeduplicatedRuns();
        const cutoff = opts?.sinceHours
            ? new Date(Date.now() - opts.sinceHours * 60 * 60 * 1000).toISOString()
            : undefined;
        const filtered = all.filter(r => {
            if (opts?.slug && r.slug !== opts.slug)
                return false;
            if (opts?.result && r.result !== opts.result)
                return false;
            if (cutoff && r.startedAt < cutoff)
                return false;
            return true;
        });
        // Sort by startedAt descending (most recent first)
        filtered.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
        const total = filtered.length;
        const offset = opts?.offset ?? 0;
        const limit = opts?.limit ?? 50;
        const runs = filtered.slice(offset, offset + limit);
        return { runs, total };
    }
    /**
     * Get aggregated stats for a specific job.
     */
    stats(slug, sinceHours) {
        const { runs } = this.query({ slug, sinceHours, limit: 10000 });
        const completed = runs.filter(r => r.result !== 'pending');
        const successes = completed.filter(r => r.result === 'success').length;
        const failures = completed.filter(r => r.result !== 'success').length;
        const withDuration = completed.filter(r => r.durationSeconds != null && r.durationSeconds > 0);
        const totalDuration = withDuration.reduce((sum, r) => sum + (r.durationSeconds ?? 0), 0);
        // Calculate runs per day
        let runsPerDay = 0;
        if (completed.length >= 2) {
            const oldest = new Date(completed[completed.length - 1].startedAt).getTime();
            const newest = new Date(completed[0].startedAt).getTime();
            const daySpan = Math.max(1, (newest - oldest) / (24 * 60 * 60 * 1000));
            runsPerDay = Math.round((completed.length / daySpan) * 10) / 10;
        }
        else if (completed.length === 1) {
            runsPerDay = completed.length;
        }
        // Find longest run
        let longestRun;
        if (withDuration.length > 0) {
            const longest = withDuration.reduce((max, r) => (r.durationSeconds ?? 0) > (max.durationSeconds ?? 0) ? r : max);
            longestRun = {
                durationSeconds: longest.durationSeconds,
                runId: longest.runId,
                startedAt: longest.startedAt,
            };
        }
        return {
            slug,
            totalRuns: completed.length,
            successes,
            failures,
            successRate: completed.length > 0 ? Math.round((successes / completed.length) * 1000) / 10 : 0,
            avgDurationSeconds: withDuration.length > 0 ? Math.round(totalDuration / withDuration.length) : 0,
            lastRun: runs[0],
            longestRun,
            runsPerDay,
        };
    }
    /**
     * Get stats for ALL jobs at once.
     */
    allStats(sinceHours) {
        const { runs } = this.query({ sinceHours, limit: 100000 });
        // Group by slug
        const bySlug = new Map();
        for (const run of runs) {
            const existing = bySlug.get(run.slug) ?? [];
            existing.push(run);
            bySlug.set(run.slug, existing);
        }
        // Generate stats per slug
        const result = [];
        for (const slug of bySlug.keys()) {
            result.push(this.stats(slug, sinceHours));
        }
        // Sort by most recent run
        result.sort((a, b) => {
            const aTime = a.lastRun?.startedAt ?? '';
            const bTime = b.lastRun?.startedAt ?? '';
            return bTime.localeCompare(aTime);
        });
        return result;
    }
    /**
     * Record handoff notes for the next execution.
     * Called when a job session completes and wants to leave context for the next run.
     */
    recordHandoff(runId, handoffNotes, stateSnapshot) {
        const run = this.findRun(runId);
        if (!run) {
            console.warn(`[JobRunHistory] No run found for handoff: ${runId}`);
            return;
        }
        const updated = {
            ...run,
            handoffNotes,
            stateSnapshot,
        };
        this.appendLine(updated);
    }
    /**
     * Get the most recent handoff notes for a job slug.
     * Returns notes from the last completed execution that left handoff data.
     * This is the primary continuity mechanism between job executions.
     *
     * Scans the raw JSONL in reverse (newest entries last) to correctly handle
     * runs that start within the same millisecond.
     */
    getLastHandoff(slug) {
        // Read all lines and deduplicate (last entry per runId wins)
        const all = this.readLines();
        const byId = new Map();
        for (const run of all) {
            byId.set(run.runId, run);
        }
        // Convert to array and scan in reverse append order (most recent last in file)
        const deduped = Array.from(byId.values());
        // Reverse so we check most recently appended first
        for (let i = deduped.length - 1; i >= 0; i--) {
            const run = deduped[i];
            if (run.slug === slug && run.handoffNotes && run.result !== 'pending') {
                return {
                    handoffNotes: run.handoffNotes,
                    stateSnapshot: run.stateSnapshot,
                    fromRunId: run.runId,
                    fromSession: run.sessionId,
                    completedAt: run.completedAt ?? run.startedAt,
                };
            }
        }
        return null;
    }
    /**
     * Find a specific run by ID.
     */
    findRun(runId) {
        const all = this.readLines();
        // Last entry for this runId wins (append-only dedup)
        for (let i = all.length - 1; i >= 0; i--) {
            if (all[i].runId === runId)
                return all[i];
        }
        return null;
    }
    /**
     * Read all entries and deduplicate by runId (last entry wins).
     */
    getDeduplicatedRuns() {
        const all = this.readLines();
        const byId = new Map();
        for (const run of all) {
            byId.set(run.runId, run);
        }
        return Array.from(byId.values());
    }
    ensureDirectory() {
        if (!fs.existsSync(this.ledgerDir)) {
            fs.mkdirSync(this.ledgerDir, { recursive: true });
        }
    }
    /**
     * Compact the JSONL file on startup: deduplicate entries so each runId
     * has exactly one record (the final state). This collapses pending → completed
     * pairs without losing any completed data. Nothing is ever deleted.
     */
    compact() {
        if (!fs.existsSync(this.file))
            return;
        const lines = this.readLines();
        if (lines.length === 0)
            return;
        const byId = new Map();
        for (const run of lines) {
            byId.set(run.runId, run);
        }
        const deduped = Array.from(byId.values());
        const removed = lines.length - deduped.length;
        if (removed > 0) {
            // Sort by startedAt to preserve chronological order in the file
            deduped.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
            const content = deduped.map(l => JSON.stringify(l)).join('\n') + '\n';
            fs.writeFileSync(this.file, content);
            console.log(`[JobRunHistory] Compacted ${removed} duplicate entries (${deduped.length} unique runs preserved)`);
        }
    }
    appendLine(data) {
        try {
            fs.appendFileSync(this.file, JSON.stringify(data) + '\n');
        }
        catch (error) {
            console.error(`[JobRunHistory] Failed to write:`, error);
        }
    }
    readLines() {
        if (!fs.existsSync(this.file))
            return [];
        try {
            const content = fs.readFileSync(this.file, 'utf-8').trim();
            if (!content)
                return [];
            return content.split('\n').map(line => {
                try {
                    return JSON.parse(line);
                }
                catch {
                    return null;
                }
            }).filter(Boolean);
        }
        catch (error) {
            console.error(`[JobRunHistory] Failed to read:`, error);
            DegradationReporter.getInstance().report({
                feature: 'JobRunHistory.readLines',
                primary: 'Read job run history ledger',
                fallback: 'Return empty — no historical data',
                reason: `Failed to read ledger: ${error instanceof Error ? error.message : String(error)}`,
                impact: 'Job history queries return empty results',
            });
            return [];
        }
    }
}
//# sourceMappingURL=JobRunHistory.js.map