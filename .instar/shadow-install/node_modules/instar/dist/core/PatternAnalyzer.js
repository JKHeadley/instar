/**
 * PatternAnalyzer — Cross-execution pattern detection for Living Skills (PROP-229).
 *
 * Reads execution journals across runs and detects:
 * - Consistent additions: steps appearing in ≥60% of runs but not in definition
 * - Consistent omissions: defined steps skipped in ≥50% of runs
 * - Novel additions: steps appearing for the first time
 * - Duration drift: execution time trending significantly up/down
 * - Gate effectiveness: whether gate commands consistently pass or fail
 *
 * Outputs a PatternReport with scored findings and optional EvolutionManager proposals.
 */
// ─── Defaults ────────────────────────────────────────────────────────────────
const DEFAULT_MIN_RUNS = 3;
const DEFAULT_ADDITION_THRESHOLD = 0.6;
const DEFAULT_OMISSION_THRESHOLD = 0.5;
const DEFAULT_DRIFT_MULTIPLIER = 2.0;
const DEFAULT_DAYS = 30;
const DEFAULT_AGENT_ID = 'default';
// ─── Analyzer ────────────────────────────────────────────────────────────────
export class PatternAnalyzer {
    journal;
    constructor(journal) {
        this.journal = journal;
    }
    /**
     * Analyze execution records for a job and detect patterns.
     */
    analyze(jobSlug, opts) {
        const minRuns = opts?.minRuns ?? DEFAULT_MIN_RUNS;
        const additionThreshold = opts?.additionThreshold ?? DEFAULT_ADDITION_THRESHOLD;
        const omissionThreshold = opts?.omissionThreshold ?? DEFAULT_OMISSION_THRESHOLD;
        const driftMultiplier = opts?.durationDriftMultiplier ?? DEFAULT_DRIFT_MULTIPLIER;
        const days = opts?.days ?? DEFAULT_DAYS;
        const agentId = opts?.agentId ?? DEFAULT_AGENT_ID;
        const records = this.journal.read(jobSlug, { agentId, days });
        const patterns = [];
        // Collect all unique step names and defined steps across runs
        const stepOccurrences = new Map();
        const definedStepSet = new Set();
        const allUniqueSteps = new Set();
        for (const record of records) {
            // Track defined steps (union across all runs — definitions may evolve)
            for (const ds of record.definedSteps) {
                definedStepSet.add(ds);
            }
            // Track actual step occurrences
            for (const step of record.actualSteps) {
                allUniqueSteps.add(step.step);
                stepOccurrences.set(step.step, (stepOccurrences.get(step.step) || 0) + 1);
            }
        }
        const totalRuns = records.length;
        if (totalRuns >= minRuns) {
            // Detect consistent additions
            patterns.push(...this.detectConsistentAdditions(stepOccurrences, definedStepSet, totalRuns, additionThreshold));
            // Detect consistent omissions
            patterns.push(...this.detectConsistentOmissions(records, definedStepSet, totalRuns, omissionThreshold));
            // Detect duration drift
            const durationPattern = this.detectDurationDrift(records, driftMultiplier);
            if (durationPattern)
                patterns.push(durationPattern);
            // Detect gate ineffectiveness
            const gatePattern = this.detectGateIneffective(records);
            if (gatePattern)
                patterns.push(gatePattern);
        }
        // Always detect novel additions (even with fewer runs)
        if (totalRuns >= 1) {
            patterns.push(...this.detectNovelAdditions(records, definedStepSet));
        }
        // Sort: high confidence first, then by rate descending
        const confidenceOrder = { high: 0, medium: 1, low: 2 };
        patterns.sort((a, b) => {
            const cDiff = confidenceOrder[a.confidence] - confidenceOrder[b.confidence];
            if (cDiff !== 0)
                return cDiff;
            return b.rate - a.rate;
        });
        // Compute summary
        const durations = records
            .map(r => r.durationMinutes)
            .filter((d) => d != null);
        const avgDuration = durations.length > 0
            ? Math.round((durations.reduce((a, b) => a + b, 0) / durations.length) * 10) / 10
            : null;
        return {
            jobSlug,
            agentId,
            runsAnalyzed: totalRuns,
            days,
            patterns,
            summary: {
                uniqueSteps: allUniqueSteps.size,
                definedSteps: definedStepSet.size,
                avgDurationMinutes: avgDuration,
                durationTrend: this.computeDurationTrend(records),
                successRate: totalRuns > 0
                    ? Math.round((records.filter(r => r.outcome === 'success').length / totalRuns) * 100) / 100
                    : 0,
            },
            analyzedAt: new Date().toISOString(),
        };
    }
    /**
     * Analyze all jobs and return reports.
     */
    analyzeAll(opts) {
        const agentId = opts?.agentId ?? DEFAULT_AGENT_ID;
        const jobs = this.journal.listJobs(agentId);
        return jobs.map(slug => this.analyze(slug, opts));
    }
    /**
     * Generate evolution proposals from a pattern report.
     * Returns proposal-ready objects (caller is responsible for submitting to EvolutionManager).
     */
    toProposals(report) {
        const proposals = [];
        for (const pattern of report.patterns) {
            // Only generate proposals for high/medium confidence patterns
            if (pattern.confidence === 'low')
                continue;
            const proposal = this.patternToProposal(report.jobSlug, pattern);
            if (proposal)
                proposals.push(proposal);
        }
        return proposals;
    }
    // ─── Private: Pattern Detection ──────────────────────────────────────────
    /**
     * Steps appearing in ≥threshold of runs but not in the job definition.
     */
    detectConsistentAdditions(stepOccurrences, definedSteps, totalRuns, threshold) {
        const patterns = [];
        for (const [step, count] of stepOccurrences) {
            if (definedSteps.has(step))
                continue;
            const rate = count / totalRuns;
            if (rate >= threshold) {
                patterns.push({
                    type: 'consistent-addition',
                    description: `Step "${step}" appears in ${count}/${totalRuns} runs (${Math.round(rate * 100)}%) but is not in the job definition`,
                    confidence: rate >= 0.8 ? 'high' : 'medium',
                    step,
                    occurrences: count,
                    totalRuns,
                    rate,
                    suggestion: `Consider adding "${step}" to the job's definedSteps`,
                });
            }
        }
        return patterns;
    }
    /**
     * Defined steps that are skipped in ≥threshold of runs.
     */
    detectConsistentOmissions(records, definedSteps, totalRuns, threshold) {
        const patterns = [];
        // Count how many times each defined step is actually executed
        const executedCounts = new Map();
        for (const ds of definedSteps) {
            executedCounts.set(ds, 0);
        }
        for (const record of records) {
            const actualStepNames = new Set(record.actualSteps.map(s => s.step));
            for (const ds of definedSteps) {
                if (actualStepNames.has(ds)) {
                    executedCounts.set(ds, (executedCounts.get(ds) || 0) + 1);
                }
            }
        }
        for (const [step, executedCount] of executedCounts) {
            const omittedCount = totalRuns - executedCount;
            const omissionRate = omittedCount / totalRuns;
            if (omissionRate >= threshold) {
                patterns.push({
                    type: 'consistent-omission',
                    description: `Defined step "${step}" was skipped in ${omittedCount}/${totalRuns} runs (${Math.round(omissionRate * 100)}%)`,
                    confidence: omissionRate >= 0.8 ? 'high' : 'medium',
                    step,
                    occurrences: omittedCount,
                    totalRuns,
                    rate: omissionRate,
                    suggestion: `Consider removing "${step}" from the job's definedSteps — it may no longer be relevant`,
                });
            }
        }
        return patterns;
    }
    /**
     * Steps appearing for the first time (only in the most recent run).
     */
    detectNovelAdditions(records, definedSteps) {
        if (records.length === 0)
            return [];
        const patterns = [];
        // records are newest-first from journal.read()
        const latestRun = records[0];
        const olderRuns = records.slice(1);
        // Collect all steps from older runs
        const previousSteps = new Set();
        for (const record of olderRuns) {
            for (const step of record.actualSteps) {
                previousSteps.add(step.step);
            }
        }
        // Check latest run for novel steps
        for (const step of latestRun.actualSteps) {
            if (!previousSteps.has(step.step) && !definedSteps.has(step.step)) {
                // First time seeing this step AND it's not in definition
                patterns.push({
                    type: 'novel-addition',
                    description: `New step "${step.step}" appeared for the first time in the latest run`,
                    confidence: 'low',
                    step: step.step,
                    occurrences: 1,
                    totalRuns: records.length,
                    rate: 1 / records.length,
                    suggestion: `Monitor "${step.step}" — if it recurs, it may become a consistent addition`,
                });
            }
        }
        return patterns;
    }
    /**
     * Duration trending significantly above historical average.
     * Uses linear regression on the last N runs to detect trend direction.
     */
    detectDurationDrift(records, driftMultiplier) {
        const durations = records
            .filter(r => r.durationMinutes != null)
            .map(r => ({ timestamp: r.timestamp, duration: r.durationMinutes }));
        if (durations.length < 3)
            return null;
        // Sort oldest to newest for trend analysis
        durations.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
        const avg = durations.reduce((s, d) => s + d.duration, 0) / durations.length;
        // Compare first half average to second half average
        const mid = Math.floor(durations.length / 2);
        const firstHalf = durations.slice(0, mid);
        const secondHalf = durations.slice(mid);
        const firstAvg = firstHalf.reduce((s, d) => s + d.duration, 0) / firstHalf.length;
        const secondAvg = secondHalf.reduce((s, d) => s + d.duration, 0) / secondHalf.length;
        // Check if the second half is significantly different from first half
        if (firstAvg === 0)
            return null;
        const ratio = secondAvg / firstAvg;
        if (ratio >= driftMultiplier) {
            return {
                type: 'duration-drift',
                description: `Duration trending up: recent average ${Math.round(secondAvg * 10) / 10}min vs earlier ${Math.round(firstAvg * 10) / 10}min (${Math.round(ratio * 10) / 10}x increase)`,
                confidence: ratio >= 3 ? 'high' : 'medium',
                step: null,
                occurrences: secondHalf.length,
                totalRuns: durations.length,
                rate: ratio,
                suggestion: 'Investigate why execution time is increasing — may indicate scope creep or environmental issues',
                evidence: {
                    firstHalfAvg: Math.round(firstAvg * 10) / 10,
                    secondHalfAvg: Math.round(secondAvg * 10) / 10,
                    ratio: Math.round(ratio * 10) / 10,
                    overallAvg: Math.round(avg * 10) / 10,
                },
            };
        }
        if (ratio <= 1 / driftMultiplier) {
            return {
                type: 'duration-drift',
                description: `Duration trending down: recent average ${Math.round(secondAvg * 10) / 10}min vs earlier ${Math.round(firstAvg * 10) / 10}min (${Math.round((1 / ratio) * 10) / 10}x decrease)`,
                confidence: 'medium',
                step: null,
                occurrences: secondHalf.length,
                totalRuns: durations.length,
                rate: ratio,
                suggestion: 'Duration has decreased significantly — the job may have become more efficient or may be skipping steps',
                evidence: {
                    firstHalfAvg: Math.round(firstAvg * 10) / 10,
                    secondHalfAvg: Math.round(secondAvg * 10) / 10,
                    ratio: Math.round(ratio * 10) / 10,
                    overallAvg: Math.round(avg * 10) / 10,
                },
            };
        }
        return null;
    }
    /**
     * Detect if gate commands are consistently finding nothing to do.
     * If a job consistently runs but has 0 actual steps, the gate may be ineffective.
     */
    detectGateIneffective(records) {
        const emptyRuns = records.filter(r => r.actualSteps.length === 0);
        if (emptyRuns.length === 0)
            return null;
        const rate = emptyRuns.length / records.length;
        if (rate >= 0.5) {
            return {
                type: 'gate-ineffective',
                description: `${emptyRuns.length}/${records.length} runs (${Math.round(rate * 100)}%) completed with zero steps — the gate may not be filtering effectively`,
                confidence: rate >= 0.8 ? 'high' : 'medium',
                step: null,
                occurrences: emptyRuns.length,
                totalRuns: records.length,
                rate,
                suggestion: 'Review the job\'s gate command — it may be passing too easily, causing unnecessary executions',
            };
        }
        return null;
    }
    // ─── Private: Duration Trend ─────────────────────────────────────────────
    computeDurationTrend(records) {
        const durations = records
            .filter(r => r.durationMinutes != null)
            .map(r => ({ timestamp: r.timestamp, duration: r.durationMinutes }));
        if (durations.length < 3)
            return 'insufficient-data';
        // Sort oldest to newest
        durations.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
        const mid = Math.floor(durations.length / 2);
        const firstAvg = durations.slice(0, mid).reduce((s, d) => s + d.duration, 0) / mid;
        const secondAvg = durations.slice(mid).reduce((s, d) => s + d.duration, 0) / (durations.length - mid);
        if (firstAvg === 0)
            return 'stable';
        const ratio = secondAvg / firstAvg;
        if (ratio >= 1.5)
            return 'increasing';
        if (ratio <= 0.67)
            return 'decreasing';
        return 'stable';
    }
    // ─── Private: Pattern → Proposal Mapping ─────────────────────────────────
    patternToProposal(jobSlug, pattern) {
        const source = `living-skills:${jobSlug}`;
        const proposedBy = 'living-skills-analyzer';
        const tags = ['living-skills', jobSlug, pattern.type];
        switch (pattern.type) {
            case 'consistent-addition':
                return {
                    title: `Add "${pattern.step}" to ${jobSlug} definition`,
                    source,
                    description: `${pattern.description}. ${pattern.suggestion}`,
                    type: 'workflow',
                    impact: pattern.confidence === 'high' ? 'medium' : 'low',
                    effort: 'low',
                    proposedBy,
                    tags,
                };
            case 'consistent-omission':
                return {
                    title: `Remove "${pattern.step}" from ${jobSlug} definition`,
                    source,
                    description: `${pattern.description}. ${pattern.suggestion}`,
                    type: 'workflow',
                    impact: 'low',
                    effort: 'low',
                    proposedBy,
                    tags,
                };
            case 'duration-drift':
                return {
                    title: `Investigate duration drift in ${jobSlug}`,
                    source,
                    description: `${pattern.description}. ${pattern.suggestion}`,
                    type: 'performance',
                    impact: 'medium',
                    effort: 'medium',
                    proposedBy,
                    tags,
                };
            case 'gate-ineffective':
                return {
                    title: `Review gate effectiveness for ${jobSlug}`,
                    source,
                    description: `${pattern.description}. ${pattern.suggestion}`,
                    type: 'infrastructure',
                    impact: 'medium',
                    effort: 'medium',
                    proposedBy,
                    tags,
                };
            case 'novel-addition':
                // Novel additions are informational — no proposal needed
                return null;
            default:
                return null;
        }
    }
}
//# sourceMappingURL=PatternAnalyzer.js.map