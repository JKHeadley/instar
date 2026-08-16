/**
 * ReflectionConsolidator — Living Skills Phase 3 (PROP-229).
 *
 * Orchestrates the weekly reflection cycle:
 * 1. Runs PatternAnalyzer across all jobs
 * 2. Deduplicates against existing EvolutionManager proposals
 * 3. Creates new proposals, learnings, and gap entries
 * 4. Returns a ConsolidationReport for notification
 *
 * Designed to be called by:
 * - `instar reflect consolidate` CLI command
 * - The `reflection-consolidation` scheduled job
 */
import { ExecutionJournal } from './ExecutionJournal.js';
import { PatternAnalyzer } from './PatternAnalyzer.js';
import { EvolutionManager } from './EvolutionManager.js';
// ─── Defaults ────────────────────────────────────────────────────────────────
const DEFAULT_DAYS = 7;
const DEFAULT_AGENT_ID = 'default';
const DEFAULT_MIN_RUNS = 3;
// ─── Consolidator ────────────────────────────────────────────────────────────
export class ReflectionConsolidator {
    journal;
    analyzer;
    evolution;
    constructor(stateDir, evolutionConfig) {
        this.journal = new ExecutionJournal(stateDir);
        this.analyzer = new PatternAnalyzer(this.journal);
        this.evolution = new EvolutionManager(evolutionConfig || { stateDir });
    }
    /**
     * Run the full consolidation cycle.
     */
    consolidate(opts) {
        const days = opts?.days ?? DEFAULT_DAYS;
        const agentId = opts?.agentId ?? DEFAULT_AGENT_ID;
        const minRuns = opts?.minRuns ?? DEFAULT_MIN_RUNS;
        const commit = opts?.commit !== false; // default true
        const analyzerOpts = { days, agentId, minRuns };
        // 1. Analyze all jobs
        const reports = this.analyzer.analyzeAll(analyzerOpts);
        // 2. Load existing proposals for deduplication
        const existingProposals = this.evolution.listProposals();
        // 3. Process each report
        const jobSummaries = [];
        const allCreatedProposals = [];
        let totalSkipped = 0;
        let totalLearnings = 0;
        for (const report of reports) {
            const summary = this.processJobReport(report, existingProposals, commit);
            jobSummaries.push(summary);
            allCreatedProposals.push(...summary._createdProposals);
            totalSkipped += summary.proposalsSkipped;
            totalLearnings += summary.learningsCreated;
        }
        return {
            jobsAnalyzed: reports.length,
            totalRunsAnalyzed: reports.reduce((sum, r) => sum + r.runsAnalyzed, 0),
            patternsDetected: reports.reduce((sum, r) => sum + r.patterns.length, 0),
            proposalsCreated: allCreatedProposals,
            proposalsSkipped: totalSkipped,
            learningsCreated: totalLearnings,
            jobSummaries: jobSummaries.map(s => {
                // Strip internal field before returning
                const { _createdProposals, ...rest } = s;
                return rest;
            }),
            consolidatedAt: new Date().toISOString(),
        };
    }
    /**
     * Generate a Telegram-ready summary from a consolidation result.
     */
    formatSummary(result) {
        if (result.patternsDetected === 0) {
            return `Living Skills Reflection — ${result.jobsAnalyzed} jobs analyzed, ${result.totalRunsAnalyzed} runs. No patterns detected.`;
        }
        const lines = [
            `📊 Living Skills Reflection`,
            ``,
            `${result.jobsAnalyzed} jobs • ${result.totalRunsAnalyzed} runs • ${result.patternsDetected} patterns`,
            ``,
        ];
        if (result.proposalsCreated.length > 0) {
            lines.push(`📝 ${result.proposalsCreated.length} new proposal(s):`);
            for (const p of result.proposalsCreated) {
                lines.push(`  • ${p.title} [${p.impact}]`);
            }
            lines.push('');
        }
        if (result.proposalsSkipped > 0) {
            lines.push(`↩️ ${result.proposalsSkipped} duplicate(s) skipped`);
        }
        if (result.learningsCreated > 0) {
            lines.push(`💡 ${result.learningsCreated} learning(s) recorded`);
        }
        // Per-job highlights
        const jobsWithHighlights = result.jobSummaries.filter(j => j.highlights.length > 0);
        if (jobsWithHighlights.length > 0) {
            lines.push('');
            lines.push('Per-job highlights:');
            for (const job of jobsWithHighlights) {
                lines.push(`  ${job.jobSlug}:`);
                for (const h of job.highlights) {
                    lines.push(`    → ${h}`);
                }
            }
        }
        return lines.join('\n');
    }
    // ─── Private ─────────────────────────────────────────────────────────────
    processJobReport(report, existingProposals, commit) {
        const createdProposals = [];
        let skipped = 0;
        let learningsCreated = 0;
        const highlights = [];
        // Convert patterns to proposals
        const candidateProposals = this.analyzer.toProposals(report);
        for (const candidate of candidateProposals) {
            // Check for duplicates: same source and similar title
            const isDuplicate = existingProposals.some(existing => existing.source === candidate.source &&
                this.titlesMatch(existing.title, candidate.title) &&
                existing.status !== 'implemented' &&
                existing.status !== 'rejected');
            if (isDuplicate) {
                skipped++;
                continue;
            }
            if (commit) {
                const proposal = this.evolution.addProposal(candidate);
                createdProposals.push(proposal);
                // Also add to existingProposals to prevent self-duplication within this run
                existingProposals.push(proposal);
            }
            else {
                // Dry run — create a fake proposal for the report
                createdProposals.push({
                    id: `DRY-${createdProposals.length + 1}`,
                    ...candidate,
                    status: 'proposed',
                    proposedAt: new Date().toISOString(),
                });
            }
        }
        // Create learnings from low-confidence patterns (novel additions)
        const novelPatterns = report.patterns.filter(p => p.type === 'novel-addition');
        for (const pattern of novelPatterns) {
            if (commit) {
                const source = {
                    agent: report.agentId,
                    platform: 'living-skills',
                    discoveredAt: new Date().toISOString(),
                };
                this.evolution.addLearning({
                    title: `Novel step in ${report.jobSlug}: "${pattern.step}"`,
                    category: 'pattern',
                    description: pattern.description,
                    source,
                    tags: ['living-skills', report.jobSlug, 'novel-step'],
                    evolutionRelevance: pattern.suggestion,
                });
                learningsCreated++;
            }
        }
        // Collect highlights (high confidence patterns)
        for (const pattern of report.patterns) {
            if (pattern.confidence === 'high') {
                highlights.push(pattern.description);
            }
        }
        return {
            jobSlug: report.jobSlug,
            runsAnalyzed: report.runsAnalyzed,
            patternsFound: report.patterns.length,
            proposalsCreated: createdProposals.length,
            proposalsSkipped: skipped,
            learningsCreated,
            highlights,
            _createdProposals: createdProposals,
        };
    }
    /**
     * Fuzzy title matching for deduplication.
     * Matches if titles are identical or if one contains the other's key step name.
     */
    titlesMatch(a, b) {
        if (a === b)
            return true;
        // Normalize: lowercase, remove quotes
        const na = a.toLowerCase().replace(/['"]/g, '');
        const nb = b.toLowerCase().replace(/['"]/g, '');
        if (na === nb)
            return true;
        // Check if they share the same step name in quotes
        const stepA = a.match(/"([^"]+)"/)?.[1];
        const stepB = b.match(/"([^"]+)"/)?.[1];
        if (stepA && stepB && stepA === stepB)
            return true;
        return false;
    }
}
//# sourceMappingURL=ReflectionConsolidator.js.map