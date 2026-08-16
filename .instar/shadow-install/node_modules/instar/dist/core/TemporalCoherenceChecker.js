/**
 * Temporal Coherence Checker -- Detects when draft content reflects outdated thinking.
 *
 * Born from Dawn's compaction thread incident (2026-03-01): A draft written Feb 7
 * about compaction as loss was posted after a Feb 28 essay reframed compaction as
 * choice. The draft contradicted published work, creating public incoherence.
 *
 * The problem is universal: Any agent that publishes over time will evolve.
 * Drafts frozen at an earlier point can become temporally incoherent with the
 * agent's current understanding.
 *
 * This module compares draft content against:
 *   1. Agent identity documents (AGENT.md, reflections, mission)
 *   2. Published content timeline (via PlatformActivityRegistry)
 *   3. Canonical state quick-facts (current positions on key topics)
 *
 * Uses IntelligenceProvider (Instar's LLM abstraction) for evaluation.
 * Falls back gracefully to "no issues found" when no provider is configured
 * (structural floor: temporal checking is advisory, not blocking).
 *
 * Integration points:
 *   - Standalone: checker.check(draftContent) -> TemporalCoherenceResult
 *   - With CoherenceGate: Add as a custom check before publishing
 *   - With PlatformActivityRegistry: Auto-loads published content timeline
 *   - With CanonicalState: Auto-loads agent's current positions
 */
import fs from 'node:fs';
import path from 'node:path';
// ── Constants ────────────────────────────────────────────────────────
const DEFAULT_STATE_DOCUMENTS = ['AGENT.md', '.instar/reflections.md'];
const DEFAULT_MAX_CHARS_PER_DOC = 4000;
const DEFAULT_TIMELINE_WINDOW_HOURS = 720; // 30 days
const SEVERITY_ORDER = { INFO: 0, WARN: 1, BLOCK: 2 };
// ── TemporalCoherenceChecker ─────────────────────────────────────────
export class TemporalCoherenceChecker {
    config;
    constructor(config) {
        this.config = {
            ...config,
            maxCharsPerDocument: config.maxCharsPerDocument ?? DEFAULT_MAX_CHARS_PER_DOC,
            timelineWindowHours: config.timelineWindowHours ?? DEFAULT_TIMELINE_WINDOW_HOURS,
        };
    }
    // ── Main Check ────────────────────────────────────────────────────
    /**
     * Check draft content for temporal coherence against the agent's
     * current understanding and published content timeline.
     */
    async check(content) {
        if (!content.trim()) {
            return {
                assessment: 'COHERENT',
                issues: [],
                summary: 'No content to check.',
                checkedAt: new Date().toISOString(),
                llmEvaluated: false,
            };
        }
        if (!this.config.intelligence) {
            return {
                assessment: 'COHERENT',
                issues: [{
                        severity: 'INFO',
                        type: 'infrastructure_missing',
                        claim: 'No IntelligenceProvider configured',
                        suggestion: 'Configure an IntelligenceProvider for temporal coherence checking.',
                    }],
                summary: 'Temporal coherence check skipped — no IntelligenceProvider configured.',
                checkedAt: new Date().toISOString(),
                llmEvaluated: false,
            };
        }
        const currentState = this.loadCurrentState();
        const timeline = this.buildTimeline();
        if (!currentState && !timeline) {
            return {
                assessment: 'COHERENT',
                issues: [{
                        severity: 'INFO',
                        type: 'infrastructure_missing',
                        claim: 'No state documents or published content found',
                        suggestion: 'Add AGENT.md or publish content to enable temporal coherence checking.',
                    }],
                summary: 'Temporal coherence check skipped — no reference documents found.',
                checkedAt: new Date().toISOString(),
                llmEvaluated: false,
            };
        }
        const prompt = this.buildPrompt(content, currentState, timeline);
        try {
            const response = await this.config.intelligence.evaluate(prompt, {
                model: 'fast',
                temperature: 0.1,
                maxTokens: 2048,
            });
            const result = this.parseResponse(response);
            return result;
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return {
                assessment: 'COHERENT',
                issues: [{
                        severity: 'INFO',
                        type: 'evaluation_error',
                        claim: `LLM evaluation failed: ${message.slice(0, 100)}`,
                        suggestion: 'Manually check temporal coherence.',
                    }],
                summary: `Temporal coherence check failed: ${message.slice(0, 80)}`,
                checkedAt: new Date().toISOString(),
                llmEvaluated: false,
            };
        }
    }
    // ── State Loading ─────────────────────────────────────────────────
    /**
     * Load the agent's current state from configured documents.
     * Returns combined text from all found documents, or null if none exist.
     */
    loadCurrentState() {
        const documents = this.config.stateDocuments ?? DEFAULT_STATE_DOCUMENTS;
        const maxChars = this.config.maxCharsPerDocument;
        const sections = [];
        for (const docPath of documents) {
            const fullPath = path.isAbsolute(docPath)
                ? docPath
                : path.join(this.config.projectDir, docPath);
            try {
                if (fs.existsSync(fullPath)) {
                    const content = fs.readFileSync(fullPath, 'utf-8');
                    if (content.trim()) {
                        const basename = path.basename(fullPath);
                        const truncated = content.slice(0, maxChars);
                        sections.push(`[${basename}]:\n${truncated}`);
                    }
                }
            }
            catch { // @silent-fallback-ok — skipping unreadable files is graceful degradation, checker works with partial data
                // Skip unreadable files — not a fatal error
            }
        }
        // Add canonical state quick facts if available
        if (this.config.canonicalState) {
            try {
                const facts = this.config.canonicalState.getQuickFacts();
                if (facts.length > 0) {
                    const factsText = facts
                        .slice(0, 10) // Cap at 10 facts
                        .map(f => `Q: ${f.question}\nA: ${f.answer}`)
                        .join('\n');
                    sections.push(`[Quick Facts]:\n${factsText}`);
                }
            }
            catch { // @silent-fallback-ok — canonical state is optional enrichment, checker works without it
                // Skip if canonical state is broken
            }
        }
        return sections.length > 0 ? sections.join('\n\n---\n\n') : null;
    }
    /**
     * Build a timeline of published content from PlatformActivityRegistry.
     * Returns formatted text, or null if no registry or no content.
     */
    buildTimeline() {
        if (!this.config.activityRegistry)
            return null;
        try {
            const since = new Date(Date.now() - this.config.timelineWindowHours * 60 * 60 * 1000).toISOString();
            const actions = this.config.activityRegistry.query({
                status: 'posted',
                since,
                limit: 50,
            });
            if (actions.length === 0)
                return null;
            const lines = actions.map(a => {
                const date = a.timestamp.slice(0, 10);
                const platform = a.platform;
                const summary = a.summary.length > 120
                    ? a.summary.slice(0, 117) + '...'
                    : a.summary;
                return `- [${date}] (${platform}) ${summary}`;
            });
            return lines.join('\n');
        }
        catch { // @silent-fallback-ok — timeline is optional enrichment, null triggers heuristic-only path
            return null;
        }
    }
    // ── Prompt Building ───────────────────────────────────────────────
    /**
     * Build the LLM evaluation prompt.
     * Exposed for testing — allows verifying prompt construction without LLM calls.
     */
    buildPrompt(content, currentState, timeline) {
        const sections = [];
        sections.push(`You are evaluating a draft for TEMPORAL COHERENCE.

CONTEXT: An agent's understanding evolves through published content, conversations, and lessons. A draft written earlier may reflect OLDER thinking that has since been superseded. Publishing outdated perspectives as current voice creates public incoherence.

DRAFT TO EVALUATE:
${content}`);
        if (currentState) {
            sections.push(`AGENT'S CURRENT UNDERSTANDING (from latest state documents):
${currentState}`);
        }
        if (timeline) {
            sections.push(`PUBLISHED CONTENT TIMELINE (most recent first):
${timeline}`);
        }
        sections.push(`YOUR TASK:
1. Identify the key positions/perspectives/framings in the draft
2. Compare against the current state documents and published timeline
3. Flag any positions that have been SUPERSEDED or SIGNIFICANTLY EVOLVED
4. Note specific phrases that represent outdated framing

SEVERITY GUIDE:
- "BLOCK" = The draft presents a position explicitly contradicted by current state. Must be fixed before publishing.
- "WARN" = A significant evolution gap that risks public incoherence. Should be addressed.
- "INFO" = The draft could be refined to better reflect current depth, but is not wrong.

Use BLOCK sparingly — only for genuine contradictions with current published positions.

Return ONLY valid JSON:
{
  "issues": [
    {
      "severity": "BLOCK or WARN or INFO",
      "type": "superseded_perspective or evolved_framing or outdated_reference",
      "claim": "the specific phrase or position from the draft",
      "current": "what the current understanding says instead",
      "suggestion": "how to update the draft"
    }
  ],
  "assessment": "COHERENT or EVOLVED or OUTDATED",
  "summary": "One sentence summary"
}

If the draft is temporally coherent, return: {"issues": [], "assessment": "COHERENT", "summary": "Draft aligns with current understanding."}`);
        return sections.join('\n\n');
    }
    // ── Response Parsing ──────────────────────────────────────────────
    /**
     * Parse the LLM response into a structured result.
     * Handles malformed JSON, missing fields, and unexpected formats gracefully.
     */
    parseResponse(response) {
        const now = new Date().toISOString();
        // Strip markdown code fences if present
        let cleaned = response.trim();
        if (cleaned.startsWith('```')) {
            const lines = cleaned.split('\n');
            // Remove first line (```json or ```) and last line (```)
            cleaned = lines.slice(1, lines[lines.length - 1]?.trim() === '```' ? -1 : undefined).join('\n');
        }
        try {
            const parsed = JSON.parse(cleaned);
            // Validate basic structure
            const assessment = this.validateAssessment(parsed.assessment);
            const summary = typeof parsed.summary === 'string'
                ? parsed.summary.slice(0, 500)
                : 'Assessment complete.';
            const issues = [];
            if (Array.isArray(parsed.issues)) {
                for (const raw of parsed.issues) {
                    if (!raw || typeof raw !== 'object')
                        continue;
                    const severity = this.validateSeverity(raw.severity);
                    const cappedSeverity = this.capSeverity(severity);
                    issues.push({
                        severity: cappedSeverity,
                        type: this.validateIssueType(raw.type),
                        claim: typeof raw.claim === 'string' ? raw.claim.slice(0, 300) : 'Unknown claim',
                        current: typeof raw.current === 'string' ? raw.current.slice(0, 300) : undefined,
                        suggestion: typeof raw.suggestion === 'string' ? raw.suggestion.slice(0, 500) : undefined,
                    });
                }
            }
            // If assessment is OUTDATED but no issues, add a synthetic one
            if (assessment === 'OUTDATED' && issues.length === 0) {
                issues.push({
                    severity: this.capSeverity('WARN'),
                    type: 'superseded_perspective',
                    claim: 'Overall draft assessed as OUTDATED',
                    current: summary,
                    suggestion: 'Review and update from current perspective.',
                });
            }
            return {
                assessment,
                issues,
                summary,
                checkedAt: now,
                llmEvaluated: true,
            };
        }
        catch {
            return {
                assessment: 'COHERENT',
                issues: [{
                        severity: 'INFO',
                        type: 'parse_error',
                        claim: `LLM response not valid JSON: ${cleaned.slice(0, 80)}`,
                        suggestion: 'Manually check temporal coherence.',
                    }],
                summary: 'Could not parse LLM response.',
                checkedAt: now,
                llmEvaluated: true,
            };
        }
    }
    // ── Validation Helpers ────────────────────────────────────────────
    validateAssessment(value) {
        const valid = ['COHERENT', 'EVOLVED', 'OUTDATED'];
        if (typeof value === 'string' && valid.includes(value)) {
            return value;
        }
        return 'COHERENT';
    }
    validateSeverity(value) {
        const valid = ['BLOCK', 'WARN', 'INFO'];
        if (typeof value === 'string' && valid.includes(value)) {
            return value;
        }
        return 'WARN';
    }
    validateIssueType(value) {
        const valid = [
            'superseded_perspective',
            'evolved_framing',
            'outdated_reference',
            'infrastructure_missing',
            'parse_error',
            'evaluation_error',
        ];
        if (typeof value === 'string' && valid.includes(value)) {
            return value;
        }
        return 'evolved_framing';
    }
    /**
     * Cap severity at the configured maximum.
     * E.g., if maxSeverity is WARN, BLOCK issues become WARN.
     */
    capSeverity(severity) {
        if (!this.config.maxSeverity)
            return severity;
        const maxLevel = SEVERITY_ORDER[this.config.maxSeverity];
        const currentLevel = SEVERITY_ORDER[severity];
        if (currentLevel > maxLevel) {
            return this.config.maxSeverity;
        }
        return severity;
    }
    // ── Utility ───────────────────────────────────────────────────────
    /**
     * Check whether the checker has an IntelligenceProvider configured.
     */
    get hasIntelligence() {
        return !!this.config.intelligence;
    }
    /**
     * Check whether state documents exist and have content.
     */
    get hasStateDocuments() {
        return this.loadCurrentState() !== null;
    }
    /**
     * Check whether a published content timeline is available.
     */
    get hasTimeline() {
        return this.buildTimeline() !== null;
    }
}
//# sourceMappingURL=TemporalCoherenceChecker.js.map