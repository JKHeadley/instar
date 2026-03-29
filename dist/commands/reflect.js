/**
 * `instar reflect job <slug>` — Show execution journal for a job.
 * `instar reflect all` — Show execution journal summary for all jobs.
 * `instar reflect analyze <slug>` — Detect patterns across execution history.
 * `instar reflect analyze --all` — Detect patterns across all jobs.
 * `instar reflect consolidate` — Run full reflection cycle (analyze + propose + learn).
 * `instar reflect run <slug>` — Run LLM-powered per-job reflection.
 *
 * Part of Living Skills (PROP-229). Reads the execution journal and
 * outputs a formatted summary of what happened during recent job runs.
 */
import pc from 'picocolors';
import { loadConfig } from '../core/Config.js';
import { ExecutionJournal } from '../core/ExecutionJournal.js';
import { JobReflector } from '../core/JobReflector.js';
import { PatternAnalyzer } from '../core/PatternAnalyzer.js';
import { ReflectionConsolidator } from '../core/ReflectionConsolidator.js';
import { AnthropicIntelligenceProvider } from '../core/AnthropicIntelligenceProvider.js';
import { ClaudeCliIntelligenceProvider } from '../core/ClaudeCliIntelligenceProvider.js';
export async function reflectJob(slug, opts) {
    const config = await loadConfig(opts.dir);
    const journal = new ExecutionJournal(config.stateDir);
    const days = opts.days || 30;
    const limit = opts.limit || 10;
    const agentId = opts.agent;
    const records = journal.read(slug, { agentId, days, limit });
    const stats = journal.stats(slug, { agentId, days });
    console.log();
    console.log(pc.bold(`Living Skills — ${slug}`));
    console.log(pc.dim(`Last ${days} days • ${stats.count} total runs`));
    if (stats.count === 0) {
        console.log(pc.yellow('\n  No execution records found.'));
        console.log(pc.dim('  Make sure livingSkills.enabled is set on this job.'));
        return;
    }
    console.log(pc.green(`  ✓ ${stats.successCount} success`) +
        (stats.failureCount > 0 ? pc.red(` • ✗ ${stats.failureCount} failed`) : '') +
        (stats.avgDurationMinutes != null ? pc.dim(` • avg ${stats.avgDurationMinutes}min`) : ''));
    console.log();
    // Table header
    console.log(pc.dim('  Date       ') +
        pc.dim('Outcome  ') +
        pc.dim('Steps  ') +
        pc.dim('Deviations  ') +
        pc.dim('Duration'));
    console.log(pc.dim('  ' + '─'.repeat(60)));
    for (const record of records) {
        const date = record.timestamp.slice(0, 10);
        const outcome = record.outcome === 'success'
            ? pc.green('✓ ok    ')
            : pc.red('✗ fail  ');
        const steps = String(record.actualSteps.length).padStart(3) + '   ';
        const devs = record.deviations.length > 0
            ? pc.yellow(String(record.deviations.length).padStart(5) + '       ')
            : pc.dim('    0       ');
        const duration = record.durationMinutes != null
            ? `${record.durationMinutes}min`
            : pc.dim('—');
        console.log(`  ${date}   ${outcome}${steps}${devs}${duration}`);
        // Show deviations inline if any
        for (const dev of record.deviations) {
            const icon = dev.type === 'addition' ? pc.green('+')
                : dev.type === 'omission' ? pc.red('-')
                    : pc.yellow('~');
            console.log(pc.dim(`             ${icon} ${dev.type}: ${dev.step}`));
        }
    }
    console.log();
}
export async function reflectAll(opts) {
    const config = await loadConfig(opts.dir);
    const journal = new ExecutionJournal(config.stateDir);
    const days = opts.days || 30;
    const agentId = opts.agent;
    const jobs = journal.listJobs(agentId);
    console.log();
    console.log(pc.bold('Living Skills — All Jobs'));
    console.log(pc.dim(`Last ${days} days`));
    if (jobs.length === 0) {
        console.log(pc.yellow('\n  No execution journals found.'));
        console.log(pc.dim('  Enable livingSkills on your jobs to start tracking.'));
        return;
    }
    console.log();
    console.log(pc.dim('  Job'.padEnd(30)) +
        pc.dim('Runs  ') +
        pc.dim('Success  ') +
        pc.dim('Fail  ') +
        pc.dim('Avg Duration'));
    console.log(pc.dim('  ' + '─'.repeat(60)));
    for (const slug of jobs) {
        const stats = journal.stats(slug, { agentId, days });
        if (stats.count === 0)
            continue;
        const name = slug.padEnd(26);
        const runs = String(stats.count).padStart(4) + '  ';
        const success = pc.green(String(stats.successCount).padStart(5) + '    ');
        const fail = stats.failureCount > 0
            ? pc.red(String(stats.failureCount).padStart(4) + '  ')
            : pc.dim('   0  ');
        const duration = stats.avgDurationMinutes != null
            ? `${stats.avgDurationMinutes}min`
            : pc.dim('—');
        console.log(`  ${name}${runs}${success}${fail}${duration}`);
    }
    console.log();
}
export async function analyzePatterns(slug, opts) {
    const config = await loadConfig(opts.dir);
    const journal = new ExecutionJournal(config.stateDir);
    const analyzer = new PatternAnalyzer(journal);
    const days = opts.days || 30;
    const agentId = opts.agent;
    const minRuns = opts.minRuns;
    const analyzerOpts = { days, agentId, minRuns };
    if (opts.all || !slug) {
        const reports = analyzer.analyzeAll(analyzerOpts);
        if (reports.length === 0) {
            console.log();
            console.log(pc.yellow('No execution journals found.'));
            console.log(pc.dim('Enable livingSkills on your jobs to start tracking.'));
            return;
        }
        for (const report of reports) {
            printPatternReport(report, opts.proposals);
        }
    }
    else {
        const report = analyzer.analyze(slug, analyzerOpts);
        printPatternReport(report, opts.proposals);
    }
}
function printPatternReport(report, showProposals) {
    console.log();
    console.log(pc.bold(`Pattern Analysis — ${report.jobSlug}`));
    console.log(pc.dim(`${report.runsAnalyzed} runs analyzed • last ${report.days} days`));
    if (report.runsAnalyzed === 0) {
        console.log(pc.yellow('\n  No execution records found.'));
        return;
    }
    // Summary line
    const parts = [
        `${report.summary.uniqueSteps} unique steps`,
        `${report.summary.definedSteps} defined`,
        `${Math.round(report.summary.successRate * 100)}% success`,
    ];
    if (report.summary.avgDurationMinutes != null) {
        parts.push(`avg ${report.summary.avgDurationMinutes}min`);
    }
    if (report.summary.durationTrend !== 'insufficient-data') {
        const trendIcon = report.summary.durationTrend === 'increasing' ? '↑'
            : report.summary.durationTrend === 'decreasing' ? '↓' : '→';
        parts.push(`trend ${trendIcon}`);
    }
    console.log(pc.dim(`  ${parts.join(' • ')}`));
    if (report.patterns.length === 0) {
        console.log(pc.green('\n  No significant patterns detected.'));
        return;
    }
    console.log();
    console.log(pc.dim(`  ${report.patterns.length} pattern(s) detected:`));
    console.log();
    for (const pattern of report.patterns) {
        printPattern(pattern);
    }
    if (showProposals) {
        const proposalAnalyzer = new PatternAnalyzer(new ExecutionJournal(report.jobSlug)); // Unused — toProposals is stateless
        const proposals = proposalAnalyzer.toProposals(report);
        if (proposals.length > 0) {
            console.log(pc.bold('  Evolution Proposals:'));
            console.log();
            for (const p of proposals) {
                console.log(`  ${pc.cyan('→')} ${p.title}`);
                console.log(pc.dim(`    type: ${p.type} • impact: ${p.impact} • effort: ${p.effort}`));
            }
            console.log();
        }
    }
}
function printPattern(pattern) {
    const confColor = pattern.confidence === 'high' ? pc.red
        : pattern.confidence === 'medium' ? pc.yellow : pc.dim;
    const confBadge = confColor(`[${pattern.confidence}]`);
    const typeIcon = {
        'consistent-addition': pc.green('+'),
        'consistent-omission': pc.red('-'),
        'novel-addition': pc.cyan('★'),
        'duration-drift': pc.yellow('⏱'),
        'gate-ineffective': pc.red('⚠'),
    };
    const icon = typeIcon[pattern.type] || '•';
    console.log(`  ${icon} ${confBadge} ${pattern.description}`);
    console.log(pc.dim(`    → ${pattern.suggestion}`));
    console.log();
}
export async function consolidateReflection(opts) {
    const config = await loadConfig(opts.dir);
    const consolidator = new ReflectionConsolidator(config.stateDir);
    const dryRun = opts.dryRun || false;
    console.log();
    if (dryRun) {
        console.log(pc.yellow(pc.bold('Living Skills Consolidation (DRY RUN)')));
    }
    else {
        console.log(pc.bold('Living Skills Consolidation'));
    }
    const result = consolidator.consolidate({
        days: opts.days,
        agentId: opts.agent,
        minRuns: opts.minRuns,
        commit: !dryRun,
    });
    console.log(pc.dim(`${result.jobsAnalyzed} jobs • ${result.totalRunsAnalyzed} runs • ${result.patternsDetected} patterns`));
    console.log();
    if (result.patternsDetected === 0) {
        console.log(pc.green('  No patterns detected. All clear.'));
        console.log();
        return;
    }
    if (result.proposalsCreated.length > 0) {
        console.log(pc.bold(`  ${result.proposalsCreated.length} new proposal(s):`));
        for (const p of result.proposalsCreated) {
            console.log(`  ${pc.cyan('→')} ${p.id}: ${p.title}`);
            console.log(pc.dim(`    impact: ${p.impact} • effort: ${p.effort} • type: ${p.type}`));
        }
        console.log();
    }
    if (result.proposalsSkipped > 0) {
        console.log(pc.dim(`  ${result.proposalsSkipped} duplicate proposal(s) skipped`));
    }
    if (result.learningsCreated > 0) {
        console.log(pc.dim(`  ${result.learningsCreated} learning(s) recorded`));
    }
    // Per-job highlights
    const withHighlights = result.jobSummaries.filter(j => j.highlights.length > 0);
    if (withHighlights.length > 0) {
        console.log();
        console.log(pc.bold('  Job Highlights:'));
        for (const job of withHighlights) {
            console.log(`  ${pc.cyan(job.jobSlug)}:`);
            for (const h of job.highlights) {
                console.log(pc.dim(`    → ${h}`));
            }
        }
    }
    console.log();
    if (!dryRun) {
        console.log(pc.dim(`  Review proposals: instar evolve --list`));
        console.log(pc.dim(`  Approve: instar evolve --approve <id>`));
    }
    console.log();
}
/**
 * Resolve an IntelligenceProvider from the environment.
 * Prefers Anthropic API (faster) → Claude CLI fallback.
 */
function resolveIntelligence(claudePath) {
    // Try Anthropic API first (explicit opt-in via env)
    const apiProvider = AnthropicIntelligenceProvider.fromEnv();
    if (apiProvider)
        return apiProvider;
    // Fall back to Claude CLI
    if (claudePath)
        return new ClaudeCliIntelligenceProvider(claudePath);
    return null;
}
export async function runReflection(slug, opts) {
    const config = await loadConfig(opts.dir);
    // Resolve intelligence provider
    const intelligence = resolveIntelligence(config.sessions?.claudePath);
    if (!intelligence) {
        console.log();
        console.log(pc.red('No LLM provider available for reflection.'));
        console.log(pc.dim('  Set ANTHROPIC_API_KEY or ensure Claude CLI is installed.'));
        return;
    }
    const model = opts.model || 'capable';
    const reflector = new JobReflector({
        stateDir: config.stateDir,
        intelligence,
        model,
        agentId: opts.agent,
    });
    console.log();
    console.log(pc.bold('Living Skills — LLM Reflection'));
    console.log(pc.dim(`Model: ${model}`));
    console.log();
    if (opts.all || !slug) {
        const insights = await reflector.reflectAll({ days: opts.days });
        if (insights.length === 0) {
            console.log(pc.yellow('  No reflections generated.'));
            console.log(pc.dim('  Check that jobs have execution journal data.'));
            return;
        }
        for (const insight of insights) {
            console.log(reflector.formatInsight(insight));
            console.log();
            console.log(pc.dim('─'.repeat(60)));
            console.log();
        }
    }
    else {
        const insight = await reflector.reflect(slug, {
            sessionId: opts.session,
            days: opts.days,
        });
        if (!insight) {
            console.log(pc.yellow(`  No reflection generated for "${slug}".`));
            console.log(pc.dim('  Check that the job has execution journal data.'));
            return;
        }
        console.log(reflector.formatInsight(insight));
        console.log();
    }
}
//# sourceMappingURL=reflect.js.map