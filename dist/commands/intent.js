/**
 * `instar intent reflect` — Review recent decisions against stated intent.
 * `instar intent validate` — Validate agent intent against org constraints.
 * `instar intent drift` — Detect intent drift from decision journal trends.
 *
 * Reads the decision journal and AGENT.md Intent section, then outputs
 * a human-readable summary. This is a local command — no Claude session needed.
 */
import fs from 'node:fs';
import path from 'node:path';
import pc from 'picocolors';
import { loadConfig } from '../core/Config.js';
import { DecisionJournal } from '../core/DecisionJournal.js';
import { IntentDriftDetector } from '../core/IntentDriftDetector.js';
import { OrgIntentManager } from '../core/OrgIntentManager.js';
/**
 * Extract the ## Intent section from AGENT.md content.
 * Returns the section text, or null if not found.
 */
export function extractIntentSection(agentMdContent) {
    const lines = agentMdContent.split('\n');
    let inIntent = false;
    let intentLines = [];
    for (const line of lines) {
        // Start of Intent section
        if (/^##\s+Intent\b/.test(line)) {
            inIntent = true;
            intentLines.push(line);
            continue;
        }
        // Another ## section starts — stop capturing
        if (inIntent && /^##\s+/.test(line) && !/^###/.test(line)) {
            break;
        }
        if (inIntent) {
            intentLines.push(line);
        }
    }
    if (intentLines.length === 0)
        return null;
    const text = intentLines.join('\n').trim();
    // Check if it's just the template with only HTML comments (no actual content)
    const withoutComments = text.replace(/<!--[\s\S]*?-->/g, '').replace(/^##.*$/gm, '').replace(/^###.*$/gm, '').trim();
    if (!withoutComments)
        return null;
    return text;
}
export async function intentReflect(options) {
    let config;
    try {
        config = loadConfig(options.dir);
    }
    catch (err) {
        console.log(pc.red(`Not initialized: ${err instanceof Error ? err.message : String(err)}`));
        console.log(`Run ${pc.cyan('instar init')} first.`);
        process.exit(1);
        return; // Safety: process.exit may not actually exit in test environments
    }
    const days = options.days ?? 7;
    const limit = options.limit ?? 100;
    console.log(pc.bold(`\n  Intent Reflection: ${pc.cyan(config.projectName)}\n`));
    // Read AGENT.md
    const agentMdPath = path.join(config.stateDir, 'AGENT.md');
    let intentSection = null;
    if (fs.existsSync(agentMdPath)) {
        const content = fs.readFileSync(agentMdPath, 'utf-8');
        intentSection = extractIntentSection(content);
    }
    if (!intentSection) {
        console.log(pc.yellow('  No Intent section found in AGENT.md.'));
        console.log();
        console.log(pc.dim('  Add an ## Intent section to .instar/AGENT.md to define your agent\'s'));
        console.log(pc.dim('  mission, tradeoffs, and boundaries. The decision journal will then'));
        console.log(pc.dim('  track how decisions align with stated intent.'));
        console.log();
        console.log(pc.dim('  Example:'));
        console.log(pc.dim('    ## Intent'));
        console.log(pc.dim('    ### Mission'));
        console.log(pc.dim('    Build lasting customer relationships.'));
        console.log(pc.dim('    ### Tradeoffs'));
        console.log(pc.dim('    - When speed conflicts with thoroughness: prefer thoroughness.'));
        console.log(pc.dim('    ### Boundaries'));
        console.log(pc.dim('    - Never share internal data with external parties.'));
        console.log();
    }
    else {
        console.log(pc.bold('  Stated Intent:'));
        // Indent each line of the intent section
        for (const line of intentSection.split('\n')) {
            console.log(`    ${pc.dim(line)}`);
        }
        console.log();
    }
    // Show organizational constraints if ORG-INTENT.md exists
    const orgManager = new OrgIntentManager(config.stateDir);
    const orgIntent = orgManager.parse();
    if (orgIntent) {
        console.log(pc.bold('  Organizational Constraints:'));
        if (orgIntent.constraints.length > 0) {
            for (const constraint of orgIntent.constraints) {
                console.log(`    ${pc.yellow('[ORG]')} ${constraint.text}`);
            }
        }
        else {
            console.log(pc.dim('    No constraints defined in ORG-INTENT.md.'));
        }
        console.log();
        if (orgIntent.goals.length > 0) {
            console.log(pc.bold('  Organizational Goals (defaults):'));
            for (const goal of orgIntent.goals) {
                console.log(`    ${pc.blue('[ORG]')} ${goal.text}`);
            }
            console.log();
        }
    }
    // Read decision journal
    const journal = new DecisionJournal(config.stateDir);
    const entries = journal.read({ days, limit });
    const stats = journal.stats();
    if (entries.length === 0) {
        console.log(pc.yellow('  No decision journal entries found.'));
        console.log();
        console.log(pc.dim('  Decisions are logged via POST /intent/journal when the agent'));
        console.log(pc.dim('  faces significant tradeoffs. Entries appear here automatically'));
        console.log(pc.dim('  as the agent operates.'));
        console.log();
        return;
    }
    // Summary stats
    console.log(pc.bold('  Journal Summary:'));
    console.log(`    Total entries:     ${pc.cyan(String(stats.count))}`);
    if (stats.earliest && stats.latest) {
        console.log(`    Date range:        ${pc.dim(stats.earliest.slice(0, 10))} to ${pc.dim(stats.latest.slice(0, 10))}`);
    }
    console.log(`    Conflicts flagged: ${stats.conflictCount > 0 ? pc.red(String(stats.conflictCount)) : pc.green('0')}`);
    console.log(`    Showing:           ${pc.dim(`last ${days} days, up to ${limit} entries`)}`);
    console.log();
    // Principle distribution
    if (stats.topPrinciples.length > 0) {
        console.log(pc.bold('  Principle Distribution:'));
        for (const { principle, count } of stats.topPrinciples.slice(0, 10)) {
            const bar = '█'.repeat(Math.min(count, 30));
            console.log(`    ${pc.dim(bar)} ${count}x ${principle}`);
        }
        console.log();
    }
    // Recent entries
    console.log(pc.bold(`  Recent Decisions (${entries.length}):\n`));
    for (const entry of entries.slice(0, 20)) {
        const ts = entry.timestamp.slice(0, 16).replace('T', ' ');
        const conflict = entry.conflict ? pc.red(' [CONFLICT]') : '';
        const confidence = entry.confidence !== undefined ? pc.dim(` (${Math.round(entry.confidence * 100)}% confident)`) : '';
        const principle = entry.principle ? pc.cyan(` [${entry.principle}]`) : '';
        const job = entry.jobSlug ? pc.magenta(` job:${entry.jobSlug}`) : '';
        console.log(`    ${pc.dim(ts)}${job}${conflict}`);
        console.log(`      ${entry.decision}${principle}${confidence}`);
        if (entry.alternatives && entry.alternatives.length > 0) {
            console.log(`      ${pc.dim('Alternatives: ' + entry.alternatives.join(', '))}`);
        }
        console.log();
    }
    if (entries.length > 20) {
        console.log(pc.dim(`    ... and ${entries.length - 20} more entries (use --limit to see more)`));
        console.log();
    }
}
export async function intentValidate(options) {
    let config;
    try {
        config = loadConfig(options.dir);
    }
    catch (err) {
        console.log(pc.red(`Not initialized: ${err instanceof Error ? err.message : String(err)}`));
        console.log(`Run ${pc.cyan('instar init')} first.`);
        process.exit(1);
        return;
    }
    console.log(pc.bold(`\n  Intent Validation: ${pc.cyan(config.projectName)}\n`));
    // Check for ORG-INTENT.md
    const orgManager = new OrgIntentManager(config.stateDir);
    if (!orgManager.exists()) {
        console.log(pc.yellow('  No ORG-INTENT.md found.'));
        console.log(pc.dim('  Create one with: instar intent org-init'));
        console.log();
        return;
    }
    const orgIntent = orgManager.parse();
    if (!orgIntent) {
        console.log(pc.yellow('  ORG-INTENT.md exists but contains no real content (template only).'));
        console.log(pc.dim('  Edit ORG-INTENT.md to add constraints, goals, and values.'));
        console.log();
        return;
    }
    // Check for AGENT.md Intent section
    const agentMdPath = path.join(config.stateDir, 'AGENT.md');
    let agentIntentContent = null;
    if (fs.existsSync(agentMdPath)) {
        const content = fs.readFileSync(agentMdPath, 'utf-8');
        agentIntentContent = extractIntentSection(content);
    }
    if (!agentIntentContent) {
        console.log(pc.yellow('  No Intent section found in AGENT.md.'));
        console.log(pc.dim('  Add an ## Intent section to .instar/AGENT.md to enable validation.'));
        console.log();
        return;
    }
    // Display org intent summary
    console.log(pc.bold(`  Organization: ${pc.cyan(orgIntent.name)}`));
    console.log(`  Constraints:  ${orgIntent.constraints.length}`);
    console.log(`  Goals:        ${orgIntent.goals.length}`);
    console.log();
    // Run validation
    const result = orgManager.validateAgentIntent(agentIntentContent);
    if (result.valid) {
        console.log(pc.green('  No conflicts detected between agent intent and org constraints.'));
        console.log();
    }
    else {
        console.log(pc.red(`  ${result.conflicts.length} conflict(s) detected:\n`));
        for (const conflict of result.conflicts) {
            const icon = conflict.severity === 'error' ? pc.red('[ERROR]') : pc.yellow('[WARN]');
            console.log(`    ${icon} ${conflict.description}`);
            console.log(`      Org constraint: ${pc.dim(conflict.orgConstraint)}`);
            console.log(`      Agent statement: ${pc.dim(conflict.agentStatement)}`);
            console.log();
        }
        // Log conflicts to decision journal
        const journal = new DecisionJournal(config.stateDir);
        for (const conflict of result.conflicts) {
            journal.log({
                sessionId: 'intent-validate',
                decision: `Org-agent intent conflict: ${conflict.description}`,
                principle: 'org-alignment',
                conflict: true,
                tags: ['org-intent', 'validation'],
            });
        }
        console.log(pc.dim(`  Conflicts logged to decision journal.`));
        console.log();
    }
    if (result.warnings.length > 0) {
        for (const warning of result.warnings) {
            console.log(pc.yellow(`  Warning: ${warning}`));
        }
        console.log();
    }
    // Exit with code 1 if any errors
    const hasErrors = result.conflicts.some(c => c.severity === 'error');
    if (hasErrors) {
        process.exit(1);
    }
}
export async function intentDrift(options) {
    let config;
    try {
        config = loadConfig(options.dir);
    }
    catch (err) {
        console.log(pc.red(`Not initialized: ${err instanceof Error ? err.message : String(err)}`));
        console.log(`Run ${pc.cyan('instar init')} first.`);
        process.exit(1);
        return;
    }
    const windowDays = options.window ?? 14;
    const detector = new IntentDriftDetector(config.stateDir);
    console.log(pc.bold(`\n  Intent Drift Analysis: ${pc.cyan(config.projectName)}\n`));
    // Run drift analysis
    const analysis = detector.analyze(windowDays);
    if (analysis.current.decisionCount === 0) {
        console.log(pc.yellow('  No decision journal entries found.'));
        console.log();
        console.log(pc.dim('  Decisions are logged via POST /intent/journal when the agent'));
        console.log(pc.dim('  faces significant tradeoffs. Once entries accumulate, drift'));
        console.log(pc.dim('  analysis will compare recent periods automatically.'));
        console.log();
        return;
    }
    console.log(`  Analysis Window: last ${pc.cyan(String(windowDays))} days vs preceding ${pc.cyan(String(windowDays))} days`);
    console.log();
    // Current period stats
    console.log(pc.bold('  Current Period:'));
    console.log(`    Decisions:      ${pc.cyan(String(analysis.current.decisionCount))}`);
    console.log(`    Conflict Rate:  ${formatPercent(analysis.current.conflictRate)}`);
    console.log(`    Avg Confidence: ${analysis.current.avgConfidence > 0 ? analysis.current.avgConfidence.toFixed(2) : pc.dim('n/a')}`);
    if (analysis.current.topPrinciples.length > 0) {
        const top = analysis.current.topPrinciples[0];
        console.log(`    Top Principle:  ${top.principle} (${top.count}x)`);
    }
    console.log();
    // Previous period stats
    if (analysis.previous) {
        console.log(pc.bold('  Previous Period:'));
        console.log(`    Decisions:      ${pc.cyan(String(analysis.previous.decisionCount))}`);
        console.log(`    Conflict Rate:  ${formatPercent(analysis.previous.conflictRate)}`);
        console.log(`    Avg Confidence: ${analysis.previous.avgConfidence > 0 ? analysis.previous.avgConfidence.toFixed(2) : pc.dim('n/a')}`);
        if (analysis.previous.topPrinciples.length > 0) {
            const top = analysis.previous.topPrinciples[0];
            console.log(`    Top Principle:  ${top.principle} (${top.count}x)`);
        }
        console.log();
    }
    else {
        console.log(pc.dim('  No previous period data for comparison.'));
        console.log();
    }
    // Drift signals
    if (analysis.signals.length > 0) {
        console.log(pc.bold('  Drift Signals:'));
        for (const signal of analysis.signals) {
            const icon = signal.severity === 'alert'
                ? pc.red('!!')
                : signal.severity === 'warning'
                    ? pc.yellow('!!')
                    : pc.blue('i ');
            console.log(`    ${icon} ${signal.description}`);
        }
        console.log();
    }
    else if (analysis.previous) {
        console.log(pc.green('  No drift signals detected.'));
        console.log();
    }
    // Drift score
    const driftLevel = analysis.driftScore > 0.6 ? 'high' : analysis.driftScore > 0.3 ? 'moderate' : 'low';
    const driftColor = analysis.driftScore > 0.6 ? pc.red : analysis.driftScore > 0.3 ? pc.yellow : pc.green;
    console.log(`  Drift Score: ${driftColor(`${analysis.driftScore.toFixed(2)} (${driftLevel})`)}`);
    console.log();
    // Alignment score
    const alignment = detector.alignmentScore();
    const gradeColor = alignment.grade === 'A' ? pc.green
        : alignment.grade === 'B' ? pc.cyan
            : alignment.grade === 'C' ? pc.yellow
                : pc.red;
    console.log(`  Alignment Score: ${gradeColor(`${alignment.score}/100 (${alignment.grade})`)}`);
    console.log(`    Conflict Freedom:      ${alignment.components.conflictFreedom}/100`);
    console.log(`    Confidence Level:       ${alignment.components.confidenceLevel}/100`);
    console.log(`    Principle Consistency:  ${alignment.components.principleConsistency}/100`);
    console.log(`    Journal Health:         ${alignment.components.journalHealth}/100`);
    console.log();
}
function formatPercent(rate) {
    const pct = (rate * 100).toFixed(1) + '%';
    if (rate > 0.1)
        return pc.red(pct);
    if (rate > 0)
        return pc.yellow(pct);
    return pc.green(pct);
}
//# sourceMappingURL=intent.js.map