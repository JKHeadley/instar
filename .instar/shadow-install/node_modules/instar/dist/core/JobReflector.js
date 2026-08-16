/**
 * JobReflector — LLM-powered per-job reflection (Living Skills Phase 4, PROP-229).
 *
 * Runs after job completion (enabled by default when livingSkills.enabled is true).
 * Uses IntelligenceProvider to produce qualitative analysis beyond what
 * PatternAnalyzer does mechanically:
 *
 * - WHY did deviations happen? (not just that they happened)
 * - Is the job evolving toward a different purpose?
 * - Are there retroactive corrections needed for past outputs?
 * - What would an ideal execution look like?
 *
 * Falls back gracefully when no IntelligenceProvider is configured.
 */
import { ExecutionJournal } from './ExecutionJournal.js';
import { PatternAnalyzer } from './PatternAnalyzer.js';
// ─── Prompt Template ─────────────────────────────────────────────────────────
function buildReflectionPrompt(record, patternReport, recentRecords) {
    const lines = [
        'You are analyzing a job execution for an AI agent scheduling system.',
        'Provide a structured reflection on what happened and what could improve.',
        '',
        '## Current Execution',
        `Job: ${record.jobSlug}`,
        `Session: ${record.sessionId}`,
        `Outcome: ${record.outcome}`,
        `Duration: ${record.durationMinutes != null ? `${record.durationMinutes} minutes` : 'unknown'}`,
        `Defined steps: ${record.definedSteps.length > 0 ? record.definedSteps.join(', ') : 'none'}`,
        '',
        '### Actual Steps Taken:',
    ];
    if (record.actualSteps.length === 0) {
        lines.push('  (no steps recorded)');
    }
    else {
        for (const step of record.actualSteps) {
            const src = step.source === 'hook' ? '[hook]' : '[agent]';
            const cmd = step.command ? ` — ${step.command.slice(0, 100)}` : '';
            lines.push(`  ${src} ${step.step}${cmd}`);
        }
    }
    if (record.deviations.length > 0) {
        lines.push('');
        lines.push('### Deviations from Definition:');
        for (const dev of record.deviations) {
            lines.push(`  ${dev.type}: ${dev.step}${dev.reason ? ` (${dev.reason})` : ''}`);
        }
    }
    if (recentRecords.length > 1) {
        lines.push('');
        lines.push(`## Historical Context (${recentRecords.length} recent runs)`);
        const outcomes = recentRecords.map(r => r.outcome);
        const successRate = outcomes.filter(o => o === 'success').length / outcomes.length;
        lines.push(`  Success rate: ${Math.round(successRate * 100)}%`);
        const durations = recentRecords
            .filter(r => r.durationMinutes != null)
            .map(r => r.durationMinutes);
        if (durations.length > 0) {
            const avg = durations.reduce((a, b) => a + b, 0) / durations.length;
            lines.push(`  Avg duration: ${Math.round(avg * 10) / 10} min`);
        }
    }
    if (patternReport && patternReport.patterns.length > 0) {
        lines.push('');
        lines.push('## Detected Patterns:');
        for (const p of patternReport.patterns) {
            lines.push(`  [${p.confidence}] ${p.type}: ${p.description}`);
        }
    }
    lines.push('');
    lines.push('## Your Analysis');
    lines.push('Respond in this exact JSON format:');
    lines.push('```json');
    lines.push('{');
    lines.push('  "summary": "One-paragraph summary of the execution",');
    lines.push('  "strengths": ["What went well (1-3 items)"],');
    lines.push('  "improvements": ["What could improve (1-3 items)"],');
    lines.push('  "deviationAnalysis": "Why did deviations happen? null if no deviations",');
    lines.push('  "purposeDrift": "Is this job evolving toward a different purpose? null if stable",');
    lines.push('  "retroactiveCorrections": ["Past outputs that should be revisited, if any"],');
    lines.push('  "suggestedChanges": ["Concrete changes to the job definition, if any"]');
    lines.push('}');
    lines.push('```');
    return lines.join('\n');
}
// ─── Reflector ───────────────────────────────────────────────────────────────
export class JobReflector {
    config;
    journal;
    analyzer;
    constructor(config) {
        this.config = config;
        this.journal = new ExecutionJournal(config.stateDir);
        this.analyzer = new PatternAnalyzer(this.journal);
    }
    /**
     * Reflect on the most recent execution of a job.
     * Returns null if no intelligence provider is configured.
     */
    async reflect(jobSlug, opts) {
        if (!this.config.intelligence) {
            return null;
        }
        const agentId = this.config.agentId || 'default';
        const days = opts?.days || 30;
        // Get execution records
        const records = this.journal.read(jobSlug, { agentId, days });
        if (records.length === 0)
            return null;
        // Find the target record
        let targetRecord;
        if (opts?.sessionId) {
            const found = records.find(r => r.sessionId === opts.sessionId);
            if (!found)
                return null;
            targetRecord = found;
        }
        else {
            // Most recent (records are newest-first)
            targetRecord = records[0];
        }
        // Get pattern report if requested
        let patternReport = null;
        if (opts?.includePatterns !== false) {
            patternReport = this.analyzer.analyze(jobSlug, { agentId, days });
            // Only include if there are meaningful patterns
            if (patternReport.patterns.length === 0)
                patternReport = null;
        }
        // Build prompt
        const prompt = buildReflectionPrompt(targetRecord, patternReport, records);
        // Call LLM
        const model = this.config.model || 'capable';
        const maxTokens = this.config.maxTokens || 1500;
        let rawResponse;
        try {
            rawResponse = await this.config.intelligence.evaluate(prompt, {
                model,
                maxTokens,
                temperature: 0.3,
            });
        }
        catch {
            return null;
        }
        // Parse response
        return this.parseResponse(rawResponse, jobSlug, targetRecord.sessionId);
    }
    /**
     * Reflect on the latest execution of all jobs that have livingSkills.perJobReflection enabled.
     */
    async reflectAll(opts) {
        if (!this.config.intelligence)
            return [];
        const agentId = this.config.agentId || 'default';
        const jobs = this.journal.listJobs(agentId);
        const insights = [];
        for (const slug of jobs) {
            const insight = await this.reflect(slug, opts);
            if (insight)
                insights.push(insight);
        }
        return insights;
    }
    /**
     * Parse the LLM's JSON response into a ReflectionInsight.
     */
    parseResponse(rawResponse, jobSlug, sessionId) {
        // Extract JSON from response (may be wrapped in markdown code blocks)
        const jsonMatch = rawResponse.match(/```(?:json)?\s*([\s\S]*?)```/) ||
            rawResponse.match(/(\{[\s\S]*\})/);
        const defaults = {
            jobSlug,
            sessionId,
            reflectedAt: new Date().toISOString(),
            summary: 'Unable to parse reflection response.',
            strengths: [],
            improvements: [],
            deviationAnalysis: null,
            purposeDrift: null,
            retroactiveCorrections: [],
            suggestedChanges: [],
            rawResponse,
        };
        if (!jsonMatch)
            return defaults;
        try {
            const parsed = JSON.parse(jsonMatch[1]);
            return {
                jobSlug,
                sessionId,
                reflectedAt: new Date().toISOString(),
                summary: typeof parsed.summary === 'string' ? parsed.summary : defaults.summary,
                strengths: Array.isArray(parsed.strengths) ? parsed.strengths.filter((s) => typeof s === 'string') : [],
                improvements: Array.isArray(parsed.improvements) ? parsed.improvements.filter((s) => typeof s === 'string') : [],
                deviationAnalysis: typeof parsed.deviationAnalysis === 'string' ? parsed.deviationAnalysis : null,
                purposeDrift: typeof parsed.purposeDrift === 'string' ? parsed.purposeDrift : null,
                retroactiveCorrections: Array.isArray(parsed.retroactiveCorrections) ? parsed.retroactiveCorrections.filter((s) => typeof s === 'string') : [],
                suggestedChanges: Array.isArray(parsed.suggestedChanges) ? parsed.suggestedChanges.filter((s) => typeof s === 'string') : [],
                rawResponse,
            };
        }
        catch {
            return defaults;
        }
    }
    /**
     * Format an insight for Telegram notification.
     */
    formatInsight(insight) {
        const lines = [
            `🔍 Reflection: ${insight.jobSlug}`,
            '',
            insight.summary,
        ];
        if (insight.strengths.length > 0) {
            lines.push('');
            lines.push('Strengths:');
            for (const s of insight.strengths) {
                lines.push(`  ✓ ${s}`);
            }
        }
        if (insight.improvements.length > 0) {
            lines.push('');
            lines.push('Improvements:');
            for (const i of insight.improvements) {
                lines.push(`  → ${i}`);
            }
        }
        if (insight.deviationAnalysis) {
            lines.push('');
            lines.push(`Deviations: ${insight.deviationAnalysis}`);
        }
        if (insight.suggestedChanges.length > 0) {
            lines.push('');
            lines.push('Suggested changes:');
            for (const c of insight.suggestedChanges) {
                lines.push(`  • ${c}`);
            }
        }
        return lines.join('\n');
    }
}
//# sourceMappingURL=JobReflector.js.map