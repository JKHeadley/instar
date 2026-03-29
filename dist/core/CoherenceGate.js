/**
 * CoherenceGate — Main orchestrator for the response review pipeline.
 *
 * Evaluates agent responses before they reach users. Architecture:
 *   1. Policy Enforcement Layer (PEL) — deterministic hard blocks
 *   2. Gate Reviewer — fast LLM triage (does this need full review?)
 *   3. Specialist Reviewers — parallel LLM calls checking specific dimensions
 *
 * Implements the 15-row normative decision matrix from the Coherence Gate spec.
 * Handles retry tracking, conversation advancement detection, feedback composition,
 * per-channel fail behavior, and reviewer criticality tiers.
 *
 * NOTE: The pre-action scope verification system lives in ScopeVerifier.ts.
 * This module handles response review — different purpose, same coherence mission.
 */
import fs from 'node:fs';
import path from 'node:path';
import { PolicyEnforcementLayer } from './PolicyEnforcementLayer.js';
import { CoherenceReviewer } from './CoherenceReviewer.js';
import { GateReviewer } from './reviewers/gate-reviewer.js';
import { ConversationalToneReviewer } from './reviewers/conversational-tone.js';
import { ClaimProvenanceReviewer } from './reviewers/claim-provenance.js';
import { SettlingDetectionReviewer } from './reviewers/settling-detection.js';
import { ContextCompletenessReviewer } from './reviewers/context-completeness.js';
import { CapabilityAccuracyReviewer } from './reviewers/capability-accuracy.js';
import { UrlValidityReviewer } from './reviewers/url-validity.js';
import { ValueAlignmentReviewer } from './reviewers/value-alignment.js';
import { InformationLeakageReviewer } from './reviewers/information-leakage.js';
import { EscalationResolutionReviewer } from './reviewers/escalation-resolution.js';
import { ResearchRateLimiter } from './ResearchRateLimiter.js';
import { RecipientResolver } from './RecipientResolver.js';
import { CustomReviewerLoader } from './CustomReviewerLoader.js';
// ── Category Mapping (reviewer → generic category for agent feedback) ─
const REVIEWER_CATEGORY_MAP = {
    'conversational-tone': 'TONE ISSUE',
    'claim-provenance': 'ACCURACY ISSUE',
    'settling-detection': 'ACCURACY ISSUE',
    'context-completeness': 'COMPLETENESS ISSUE',
    'capability-accuracy': 'CAPABILITY ISSUE',
    'url-validity': 'ACCURACY ISSUE',
    'value-alignment': 'ALIGNMENT ISSUE',
    'information-leakage': 'ALIGNMENT ISSUE',
    'escalation-resolution': 'ESCALATION ISSUE',
};
/** Violation types for retry exhaustion handling */
const HIGH_STAKES_CATEGORIES = new Set(['ACCURACY ISSUE', 'ALIGNMENT ISSUE']);
const VALUE_DOC_CACHE_TTL_MS = 60 * 60 * 1000; // 60 minutes
// ── Main Class ───────────────────────────────────────────────────────
export class CoherenceGate {
    config;
    stateDir;
    pel;
    gateReviewer;
    reviewers = new Map();
    recipientResolver;
    retrySessions = new Map();
    sessionMutexes = new Map();
    valueDocCache = null;
    reviewHistory = [];
    proposals = [];
    researchRateLimiter;
    onResearchTriggered;
    static RETENTION_DAYS = 30;
    constructor(options) {
        this.config = options.config;
        this.stateDir = options.stateDir;
        this.onResearchTriggered = options.onResearchTriggered;
        this.researchRateLimiter = new ResearchRateLimiter({ stateDir: options.stateDir });
        // Initialize PEL
        this.pel = new PolicyEnforcementLayer(options.stateDir);
        // Initialize gate reviewer
        this.gateReviewer = new GateReviewer(options.apiKey, {
            model: options.config.gateModel ?? 'haiku',
            timeoutMs: 5_000,
        });
        // Initialize built-in specialist reviewers
        this.initializeReviewers(options.apiKey, options.config);
        // Initialize recipient resolver
        this.recipientResolver = new RecipientResolver({
            stateDir: options.stateDir,
            relationships: options.relationships,
            adaptiveTrust: options.adaptiveTrust,
        });
        // Load custom reviewers
        this.loadCustomReviewers(options.apiKey);
    }
    /**
     * Evaluate an agent's draft response. Main entry point.
     * Implements the 15-row normative decision matrix.
     */
    async evaluate(request) {
        const { message, sessionId, stopHookActive, context } = request;
        // Session mutex — prevent concurrent reviews for same session
        await this.acquireMutex(sessionId);
        try {
            return await this._evaluate(message, sessionId, stopHookActive, context);
        }
        finally {
            this.releaseMutex(sessionId);
        }
    }
    async _evaluate(message, sessionId, stopHookActive, context) {
        const isExternal = context.isExternalFacing ?? this.isExternalChannel(context.channel);
        const channelConfig = this.resolveChannelConfig(context.channel, isExternal);
        const recipientType = context.recipientType ?? 'primary-user';
        // ── Retry state management ──────────────────────────────────
        let retryState = this.retrySessions.get(sessionId);
        if (!stopHookActive) {
            // New response (not a revision) — reset retry counter
            retryState = {
                retryCount: 0,
                lastViolations: [],
                transcriptVersion: this.getTranscriptVersion(context.transcriptPath),
                createdAt: Date.now(),
            };
            this.retrySessions.set(sessionId, retryState);
        }
        else if (retryState) {
            retryState.retryCount++;
            // Conversation advancement detection
            const currentVersion = this.getTranscriptVersion(context.transcriptPath);
            if (currentVersion > retryState.transcriptVersion) {
                // User sent a new message — abandon stale revision
                this.retrySessions.delete(sessionId);
                this.logAudit(sessionId, context, 'abandoned', [], 'Conversation advanced during revision');
                return { pass: true, _outcome: 'abandoned-stale' };
            }
        }
        else {
            retryState = { retryCount: 1, lastViolations: [], transcriptVersion: 0, createdAt: Date.now() };
            this.retrySessions.set(sessionId, retryState);
        }
        const maxRetries = this.config.maxRetries ?? 2;
        // ── Step 1: PEL (always runs, even in observeOnly) ──────────
        const pelContext = {
            channel: context.channel,
            isExternalFacing: isExternal,
            recipientType,
            stateDir: this.stateDir,
        };
        const pelResult = this.pel.enforce(message, pelContext);
        // Row 1: PEL HARD_BLOCK → always block, no exceptions
        if (pelResult.outcome === 'hard_block') {
            const feedback = this.composePELFeedback(pelResult);
            this.logAudit(sessionId, context, 'pel-block', [], 'PEL hard block');
            return {
                pass: false,
                feedback,
                issueCategories: ['POLICY VIOLATION'],
                retryCount: retryState.retryCount,
                _pelBlock: true,
                _outcome: 'block',
            };
        }
        // Row 3: observeOnly → log but never block (except PEL)
        const observeOnly = this.config.observeOnly ?? false;
        // ── Step 2: Resolve recipient context ────────────────────────
        const recipientContext = this.recipientResolver.resolve(context.recipientId, recipientType);
        // ── Step 3: Extract tool output context from transcript ──────
        const toolOutputContext = context.transcriptPath
            ? this.extractToolContext(context.transcriptPath)
            : undefined;
        // ── Step 4: Extract URLs for URL validity reviewer ───────────
        const extractedUrls = this.extractUrls(message);
        // ── Step 5: Load value documents (cached) ────────────────────
        const valueDocs = this.loadValueDocs();
        // ── Step 6: Build review context ─────────────────────────────
        const reviewCtx = {
            message,
            channel: context.channel,
            isExternalFacing: isExternal,
            recipientType,
            toolOutputContext,
            extractedUrls: extractedUrls.length > 0 ? extractedUrls : undefined,
            agentValues: valueDocs.agentValues || undefined,
            userValues: valueDocs.userValues || undefined,
            orgValues: valueDocs.orgValues || undefined,
            trustLevel: recipientContext.trustLevel,
            relationshipContext: recipientContext.communicationStyle ? {
                communicationStyle: recipientContext.communicationStyle,
                formality: recipientContext.formality,
                themes: recipientContext.themes,
            } : undefined,
            capabilityRegistry: context.capabilityRegistry,
            autonomyLevel: context.autonomyLevel,
            jobBlockers: context.jobBlockers,
            isResearchSession: context.isResearchSession,
        };
        // ── Step 7: Gate reviewer ────────────────────────────────────
        let gateResult;
        const skipGate = channelConfig.skipGate ?? false;
        if (!skipGate) {
            gateResult = await this.gateReviewer.reviewAsGate(reviewCtx);
            if (!gateResult.needsReview) {
                // Row 4: PEL PASS + Gate says no review needed → PASS
                const warnings = pelResult.outcome === 'warn'
                    ? pelResult.violations.map(v => v.detail)
                    : [];
                this.logAudit(sessionId, context, 'pass-gate', [], 'Gate skipped full review');
                return {
                    pass: true,
                    warnings,
                    _gateResult: gateResult,
                    _outcome: 'pass',
                };
            }
        }
        // ── Step 8: Specialist reviewers (parallel fan-out) ──────────
        const enabledReviewers = this.getEnabledReviewers(context.channel, recipientType, channelConfig);
        const results = await Promise.allSettled(enabledReviewers.map(r => r.review(reviewCtx)));
        // Collect results
        const settled = [];
        let abstainCount = 0;
        let highCritTimeout = false;
        for (let i = 0; i < results.length; i++) {
            const result = results[i];
            if (result.status === 'fulfilled') {
                settled.push(result.value);
            }
            else {
                // Reviewer failed — treat as abstain
                abstainCount++;
                const reviewerName = enabledReviewers[i].name;
                const criticality = this.config.reviewerCriticality?.[reviewerName] ?? 'standard';
                if (criticality === 'high') {
                    highCritTimeout = true;
                }
            }
        }
        // ── Step 8b: Check for research trigger signals ────────────
        let researchTriggered = false;
        for (const result of settled) {
            const escalationResult = result;
            if (escalationResult.needsResearch && escalationResult.researchContext) {
                const rateLimitDecision = this.researchRateLimiter.check(escalationResult.researchContext.blockerDescription);
                if (rateLimitDecision.allowed && this.onResearchTriggered) {
                    this.researchRateLimiter.record(escalationResult.researchContext.blockerDescription, sessionId);
                    this.onResearchTriggered({
                        blockerDescription: escalationResult.researchContext.blockerDescription,
                        capabilities: escalationResult.researchContext.capabilities,
                        sessionId,
                    });
                    researchTriggered = true;
                }
            }
        }
        // ── Step 9: Aggregate verdicts ───────────────────────────────
        const blockResults = settled.filter(r => !r.pass && this.getReviewerMode(r.reviewer) === 'block');
        const warnResults = settled.filter(r => !r.pass && this.getReviewerMode(r.reviewer) === 'warn');
        const allAbstain = settled.length === 0 && abstainCount > 0;
        const majorityAbstain = abstainCount > enabledReviewers.length / 2;
        // Check warn escalation threshold
        const warnEscalationThreshold = this.config.warnEscalationThreshold ?? 3;
        const warnEscalated = warnResults.length >= warnEscalationThreshold;
        // Determine LLM verdict
        let llmVerdict;
        if (allAbstain || majorityAbstain) {
            llmVerdict = 'ALL_ABSTAIN';
        }
        else if (highCritTimeout && isExternal) {
            llmVerdict = 'HIGH_CRIT_TIMEOUT';
        }
        else if (blockResults.length > 0 || warnEscalated) {
            llmVerdict = 'BLOCK';
        }
        else if (warnResults.length > 0) {
            llmVerdict = 'WARN_ONLY';
        }
        else {
            llmVerdict = 'PASS';
        }
        // ── Step 10: Apply normative decision matrix ─────────────────
        const pelOutcome = pelResult.outcome; // 'pass' | 'warn' | 'hard_block' (hard_block handled above)
        const retryExhausted = retryState.retryCount >= maxRetries;
        // Build audit violations
        const auditViolations = [...blockResults, ...warnResults].map(r => ({
            reviewer: r.reviewer,
            severity: r.severity,
            issue: r.issue,
            suggestion: r.suggestion,
            latencyMs: r.latencyMs,
        }));
        // Row 2: PEL WARN → pass + warn (PEL warns are advisory)
        const pelWarnings = pelResult.outcome === 'warn'
            ? pelResult.violations.map(v => v.detail)
            : [];
        // Row 3: observeOnly → always pass
        if (observeOnly) {
            this.logAudit(sessionId, context, 'observe-only', auditViolations, `LLM: ${llmVerdict}`);
            return {
                pass: true,
                warnings: [...pelWarnings, ...warnResults.map(r => r.issue)],
                _auditViolations: auditViolations,
                _gateResult: gateResult,
                _outcome: 'pass-observe',
            };
        }
        // Row 4: LLM PASS → deliver
        if (llmVerdict === 'PASS') {
            this.logAudit(sessionId, context, 'pass', auditViolations, 'All reviewers pass');
            return {
                pass: true,
                warnings: pelWarnings,
                _auditViolations: auditViolations,
                _gateResult: gateResult,
                _outcome: 'pass',
                _researchTriggered: researchTriggered || undefined,
            };
        }
        // Row 5: WARN_ONLY → deliver with warnings
        if (llmVerdict === 'WARN_ONLY') {
            this.logAudit(sessionId, context, 'pass-warn', auditViolations, 'Warnings only');
            return {
                pass: true,
                warnings: [...pelWarnings, ...warnResults.map(r => r.issue)],
                _auditViolations: auditViolations,
                _gateResult: gateResult,
                _outcome: 'pass-warn',
                _researchTriggered: researchTriggered || undefined,
            };
        }
        // Rows 10-15: ALL_ABSTAIN, TIMEOUT, HIGH_CRIT_TIMEOUT
        if (llmVerdict === 'ALL_ABSTAIN' || llmVerdict === 'HIGH_CRIT_TIMEOUT') {
            if (isExternal) {
                // Row 10, 12, 14: QUEUE for external
                if (channelConfig.queueOnFailure) {
                    this.logAudit(sessionId, context, 'queued', auditViolations, `${llmVerdict}: queued`);
                    // For now, queue-and-hold is implemented by returning pass:false
                    // In production, this would integrate with a message queue
                    return {
                        pass: false,
                        feedback: '[unreviewed] Review system temporarily unavailable. Message held for review.',
                        issueCategories: ['INFRASTRUCTURE'],
                        _auditViolations: auditViolations,
                        _outcome: 'queue',
                    };
                }
            }
            // Row 11, 13, 15: fail-open for internal
            this.logAudit(sessionId, context, 'pass-failopen', auditViolations, `${llmVerdict}: fail-open`);
            return {
                pass: true,
                warnings: ['[unreviewed] Some reviewers were unavailable'],
                _auditViolations: auditViolations,
                _outcome: 'pass-failopen',
            };
        }
        // Row 6: BLOCK + retries remaining → block for revision
        if (llmVerdict === 'BLOCK' && !retryExhausted) {
            const feedback = this.composeFeedback(blockResults, warnResults, retryState.retryCount, maxRetries);
            retryState.lastViolations = auditViolations;
            this.logAudit(sessionId, context, 'block', auditViolations, `Block: retry ${retryState.retryCount}/${maxRetries}`);
            return {
                pass: false,
                feedback,
                issueCategories: this.getIssueCategories(blockResults),
                retryCount: retryState.retryCount,
                _auditViolations: auditViolations,
                _gateResult: gateResult,
                _outcome: 'block',
            };
        }
        // Rows 7-9: BLOCK + retry exhausted
        if (llmVerdict === 'BLOCK' && retryExhausted) {
            const categories = this.getIssueCategories(blockResults);
            const hasHighStakes = categories.some(c => HIGH_STAKES_CATEGORIES.has(c));
            if (isExternal && hasHighStakes) {
                // Row 9: External + accuracy/alignment → HOLD for operator review
                this.logAudit(sessionId, context, 'hold', auditViolations, 'Retry exhausted on high-stakes issue');
                return {
                    pass: false,
                    feedback: 'Response held for operator review due to unresolved accuracy/alignment concerns.',
                    issueCategories: categories,
                    retryCount: retryState.retryCount,
                    _auditViolations: auditViolations,
                    _outcome: 'hold',
                };
            }
            // Rows 7-8: Internal, or external + low-stakes → PASS + attention queue
            this.logAudit(sessionId, context, 'pass-exhausted', auditViolations, 'Retry exhausted, delivering');
            this.retrySessions.delete(sessionId);
            return {
                pass: true,
                warnings: [...pelWarnings, `[retry-exhausted] ${categories.join(', ')}`],
                _auditViolations: auditViolations,
                _gateResult: gateResult,
                _outcome: 'pass-exhausted',
            };
        }
        // Fallback (should not reach here)
        return { pass: true, _outcome: 'fallback' };
    }
    // ── Reviewer Management ────────────────────────────────────────────
    initializeReviewers(apiKey, config) {
        const defaultModel = config.reviewerModel ?? 'haiku';
        const overrides = config.reviewerModelOverrides ?? {};
        const reviewerDefs = [
            { name: 'conversational-tone', cls: ConversationalToneReviewer },
            { name: 'claim-provenance', cls: ClaimProvenanceReviewer },
            { name: 'settling-detection', cls: SettlingDetectionReviewer },
            { name: 'context-completeness', cls: ContextCompletenessReviewer },
            { name: 'capability-accuracy', cls: CapabilityAccuracyReviewer },
            { name: 'url-validity', cls: UrlValidityReviewer },
            { name: 'value-alignment', cls: ValueAlignmentReviewer },
            { name: 'information-leakage', cls: InformationLeakageReviewer },
            { name: 'escalation-resolution', cls: EscalationResolutionReviewer },
        ];
        for (const { name, cls } of reviewerDefs) {
            const reviewerConfig = config.reviewers?.[name];
            if (reviewerConfig && !reviewerConfig.enabled)
                continue;
            const model = overrides[name] ?? defaultModel;
            const mode = reviewerConfig?.mode ?? 'block';
            const timeoutMs = config.timeoutMs ?? 8_000;
            this.reviewers.set(name, new cls(apiKey, { model, mode, timeoutMs }));
        }
    }
    loadCustomReviewers(apiKey) {
        const loader = new CustomReviewerLoader(this.stateDir);
        // Custom reviewer loading is best-effort — don't break startup
        try {
            const specs = loader.loadAll();
            for (const spec of specs) {
                if (this.reviewers.has(spec.name))
                    continue; // built-in takes precedence
                // Create a dynamic reviewer from the spec
                const mode = (this.config.reviewers?.[spec.name]?.mode ?? spec.mode);
                const model = this.config.reviewerModelOverrides?.[spec.name] ?? this.config.reviewerModel ?? 'haiku';
                // Dynamic reviewer using the spec's prompt
                const reviewer = new DynamicReviewer(spec.name, apiKey, spec.prompt, spec.contextRequirements, {
                    model, mode, timeoutMs: this.config.timeoutMs ?? 8_000,
                });
                this.reviewers.set(spec.name, reviewer);
            }
        }
        catch {
            // @silent-fallback-ok — custom reviewer loading non-critical
        }
    }
    getEnabledReviewers(channel, recipientType, channelConfig) {
        const enabled = [];
        for (const [name, reviewer] of this.reviewers) {
            // Skip information-leakage for primary-user
            if (name === 'information-leakage' && recipientType === 'primary-user')
                continue;
            // Skip observe-mode reviewers from blocking pipeline
            const mode = this.getReviewerMode(name);
            if (mode === 'observe')
                continue;
            enabled.push(reviewer);
        }
        // Add channel-specific additional reviewers if configured
        // (These would be custom reviewers registered for this channel)
        if (channelConfig.additionalReviewers) {
            for (const name of channelConfig.additionalReviewers) {
                const reviewer = this.reviewers.get(name);
                if (reviewer && !enabled.includes(reviewer)) {
                    enabled.push(reviewer);
                }
            }
        }
        return enabled;
    }
    getReviewerMode(reviewerName) {
        return this.config.reviewers?.[reviewerName]?.mode ?? 'block';
    }
    // ── Channel Configuration ──────────────────────────────────────────
    resolveChannelConfig(channel, isExternal) {
        // Check explicit channel config first
        const explicit = this.config.channels?.[channel];
        if (explicit)
            return explicit;
        // Fall back to channel defaults
        const defaults = isExternal
            ? this.config.channelDefaults?.external
            : this.config.channelDefaults?.internal;
        return defaults ?? {
            failOpen: !isExternal,
            skipGate: isExternal,
            queueOnFailure: isExternal,
            queueTimeoutMs: 30_000,
        };
    }
    isExternalChannel(channel) {
        const internalChannels = new Set(['direct', 'cli', 'internal']);
        return !internalChannels.has(channel);
    }
    // ── Feedback Composition ───────────────────────────────────────────
    composeFeedback(blocks, warns, retryCount, maxRetries) {
        const allIssues = [...blocks, ...warns];
        const lines = [];
        if (retryCount > 0) {
            // Collapse format for revisions (context window management)
            const prevCategories = this.getIssueCategories(blocks);
            lines.push(`COHERENCE REVIEW: Previous attempt had ${allIssues.length} issue(s): ${prevCategories.join(', ')}.`);
            lines.push(`Current attempt (revision ${retryCount} of ${maxRetries}):`);
            lines.push('');
        }
        else {
            lines.push(`COHERENCE REVIEW: Your draft response has ${allIssues.length} issue(s) to address.`);
            lines.push('');
        }
        // Deduplicate by category
        const seen = new Set();
        for (const result of allIssues) {
            const category = REVIEWER_CATEGORY_MAP[result.reviewer] ?? 'QUALITY ISSUE';
            if (seen.has(category))
                continue;
            seen.add(category);
            lines.push(`[${category}]`);
            lines.push(result.issue);
            if (result.suggestion) {
                lines.push(result.suggestion);
            }
            lines.push('');
        }
        lines.push('Revise your response addressing the issues above. Keep the substance — just fix the flagged problems.');
        return lines.join('\n');
    }
    composePELFeedback(pelResult) {
        const lines = ['POLICY VIOLATION: Your response contains content that cannot be sent.', ''];
        for (const violation of pelResult.violations) {
            if (violation.severity === 'hard_block') {
                lines.push(`[POLICY VIOLATION] ${violation.detail}`);
            }
        }
        lines.push('');
        lines.push('Remove the flagged content and try again.');
        return lines.join('\n');
    }
    getIssueCategories(results) {
        const categories = new Set();
        for (const r of results) {
            categories.add(REVIEWER_CATEGORY_MAP[r.reviewer] ?? 'QUALITY ISSUE');
        }
        return [...categories];
    }
    // ── Context Extraction ─────────────────────────────────────────────
    extractToolContext(transcriptPath) {
        try {
            if (!fs.existsSync(transcriptPath))
                return undefined;
            const content = fs.readFileSync(transcriptPath, 'utf-8');
            const lines = content.trim().split('\n');
            // Extract last 3-5 tool results (look for tool_result entries)
            const toolResults = [];
            for (let i = lines.length - 1; i >= 0 && toolResults.length < 5; i--) {
                try {
                    const entry = JSON.parse(lines[i]);
                    if (entry?.type === 'tool_result' || entry?.role === 'tool') {
                        const text = typeof entry.content === 'string'
                            ? entry.content
                            : JSON.stringify(entry.content);
                        // Truncate each result to ~100 tokens
                        toolResults.unshift(text.slice(0, 400));
                    }
                }
                catch {
                    // Skip non-JSON lines
                }
            }
            if (toolResults.length === 0)
                return undefined;
            // Combine and truncate to ~500 tokens total
            const combined = toolResults.join('\n---\n');
            return combined.slice(0, 2000);
        }
        catch {
            return undefined;
        }
    }
    extractUrls(message) {
        const urlRegex = /https?:\/\/[^\s<>"')\]]+/g;
        return [...(message.match(urlRegex) ?? [])];
    }
    loadValueDocs() {
        // Check cache
        if (this.valueDocCache && Date.now() - this.valueDocCache.loadedAt < VALUE_DOC_CACHE_TTL_MS) {
            return this.valueDocCache;
        }
        const agentValues = this.extractValueSection(path.join(this.stateDir, 'AGENT.md'), 'Intent');
        const userValues = this.extractValueSection(path.join(this.stateDir, 'USER.md'));
        const orgValues = this.extractValueSection(path.join(this.stateDir, 'ORG-INTENT.md'));
        this.valueDocCache = { agentValues, userValues, orgValues, loadedAt: Date.now() };
        return this.valueDocCache;
    }
    /**
     * Deterministic value document summarization.
     * Extracts headers, bullets, and bold text — not LLM summarization.
     * Target: ~200-400 tokens for all three tiers combined.
     */
    extractValueSection(filePath, section) {
        try {
            if (!fs.existsSync(filePath))
                return '';
            let content = fs.readFileSync(filePath, 'utf-8');
            // If a specific section is requested, extract it
            if (section) {
                const sectionRegex = new RegExp(`^##\\s+${section}[\\s\\S]*?(?=^##\\s|$)`, 'gm');
                const match = content.match(sectionRegex);
                content = match ? match[0] : content;
            }
            // Extract key elements: headers, bullets, bold text
            const lines = content.split('\n');
            const extracted = [];
            let tokens = 0;
            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed)
                    continue;
                // Keep headers
                if (trimmed.startsWith('#')) {
                    extracted.push(trimmed);
                    tokens += trimmed.split(/\s+/).length;
                }
                // Keep bullet points
                else if (trimmed.startsWith('-') || trimmed.startsWith('*')) {
                    extracted.push(trimmed);
                    tokens += trimmed.split(/\s+/).length;
                }
                // Keep bold text lines
                else if (trimmed.includes('**')) {
                    extracted.push(trimmed);
                    tokens += trimmed.split(/\s+/).length;
                }
                // Budget: ~150 tokens per document
                if (tokens > 150)
                    break;
            }
            return extracted.join('\n');
        }
        catch {
            return '';
        }
    }
    // ── Conversation Advancement ───────────────────────────────────────
    getTranscriptVersion(transcriptPath) {
        if (!transcriptPath)
            return 0;
        try {
            const stat = fs.statSync(transcriptPath);
            return stat.mtimeMs;
        }
        catch {
            return 0;
        }
    }
    // ── Session Mutex ──────────────────────────────────────────────────
    async acquireMutex(sessionId) {
        while (this.sessionMutexes.has(sessionId)) {
            await this.sessionMutexes.get(sessionId);
        }
        let resolve;
        const promise = new Promise(r => { resolve = r; });
        this.sessionMutexes.set(sessionId, promise);
        // Store resolve for release
        promise.__resolve = resolve;
    }
    releaseMutex(sessionId) {
        const promise = this.sessionMutexes.get(sessionId);
        this.sessionMutexes.delete(sessionId);
        if (promise && promise.__resolve) {
            promise.__resolve();
        }
    }
    // ── Audit Logging ──────────────────────────────────────────────────
    logAudit(sessionId, context, verdict, violations, note) {
        const entry = {
            timestamp: new Date().toISOString(),
            sessionId,
            channel: context.channel,
            recipientType: context.recipientType ?? 'primary-user',
            recipientId: context.recipientId,
            verdict,
            violations,
            note,
        };
        this.reviewHistory.push(entry);
        // Prune old entries (keep last 1000)
        if (this.reviewHistory.length > 1000) {
            this.reviewHistory = this.reviewHistory.slice(-1000);
        }
    }
    // ── Public API for routes ──────────────────────────────────────────
    getReviewHistory(options) {
        // Retention: purge entries older than RETENTION_DAYS
        const retentionCutoff = Date.now() - CoherenceGate.RETENTION_DAYS * 24 * 60 * 60 * 1000;
        this.reviewHistory = this.reviewHistory.filter(e => new Date(e.timestamp).getTime() >= retentionCutoff);
        let entries = this.reviewHistory;
        if (options?.sessionId) {
            entries = entries.filter(e => e.sessionId === options.sessionId);
        }
        if (options?.reviewer) {
            entries = entries.filter(e => e.violations.some(v => v.reviewer === options.reviewer));
        }
        if (options?.verdict) {
            entries = entries.filter(e => e.verdict === options.verdict);
        }
        if (options?.recipientId) {
            entries = entries.filter(e => e.recipientId === options.recipientId);
        }
        if (options?.since) {
            const sinceDate = new Date(options.since).getTime();
            entries = entries.filter(e => new Date(e.timestamp).getTime() >= sinceDate);
        }
        const limit = options?.limit ?? 50;
        return entries.slice(-limit);
    }
    /**
     * Delete review history for a specific session (DSAR compliance).
     */
    deleteHistory(sessionId) {
        const before = this.reviewHistory.length;
        this.reviewHistory = this.reviewHistory.filter(e => e.sessionId !== sessionId);
        return before - this.reviewHistory.length;
    }
    getReviewerStats(options) {
        const perReviewer = {};
        for (const [name, reviewer] of this.reviewers) {
            const m = reviewer.metrics;
            const total = m.passCount + m.failCount + m.errorCount;
            perReviewer[name] = {
                passRate: total > 0 ? m.passCount / total : 0,
                flagRate: total > 0 ? m.failCount / total : 0,
                errorRate: total > 0 ? m.errorCount / total : 0,
                avgLatencyMs: total > 0 ? Math.round(m.totalLatencyMs / total) : 0,
                jsonValidityRate: total > 0 ? 1 - (m.jsonParseErrors / total) : 1,
                total,
            };
        }
        // Per-recipient-type breakdown from history
        const recipientBreakdown = {};
        let sinceMs = 0;
        if (options?.since) {
            sinceMs = new Date(options.since).getTime();
        }
        else if (options?.period === 'daily') {
            sinceMs = Date.now() - 24 * 60 * 60 * 1000;
        }
        else if (options?.period === 'weekly') {
            sinceMs = Date.now() - 7 * 24 * 60 * 60 * 1000;
        }
        const filteredHistory = sinceMs > 0
            ? this.reviewHistory.filter(e => new Date(e.timestamp).getTime() >= sinceMs)
            : this.reviewHistory;
        for (const entry of filteredHistory) {
            const rt = entry.recipientType;
            if (!recipientBreakdown[rt]) {
                recipientBreakdown[rt] = { total: 0, blocked: 0, passed: 0 };
            }
            recipientBreakdown[rt].total++;
            if (entry.verdict.includes('block') || entry.verdict.includes('hold')) {
                recipientBreakdown[rt].blocked++;
            }
            else {
                recipientBreakdown[rt].passed++;
            }
        }
        // False positive indicators
        const totalBlocked = filteredHistory.filter(e => e.verdict.includes('block') || e.verdict.includes('hold')).length;
        const totalExhausted = filteredHistory.filter(e => e.verdict === 'pass-exhausted').length;
        return {
            reviewers: perReviewer,
            summary: {
                totalReviews: filteredHistory.length,
                totalBlocked,
                totalExhausted,
                exhaustionRate: filteredHistory.length > 0
                    ? totalExhausted / filteredHistory.length
                    : 0,
                period: options?.period ?? 'all',
            },
            recipientBreakdown,
        };
    }
    /** Check if the gate is enabled and ready */
    isEnabled() {
        return this.config.enabled;
    }
    // ── Canary Tests ──────────────────────────────────────────────────
    /**
     * Run canary tests with known-bad messages. Returns results showing
     * which canary messages were caught and which were missed.
     */
    async runCanaryTests() {
        const results = [];
        for (const canary of CANARY_CORPUS) {
            const response = await this.evaluate({
                message: canary.message,
                sessionId: `canary-${Date.now()}`,
                stopHookActive: false,
                context: {
                    channel: canary.channel,
                    isExternalFacing: canary.isExternalFacing,
                    recipientType: canary.recipientType,
                },
            });
            const caught = !response.pass;
            results.push({
                canaryId: canary.id,
                description: canary.description,
                expectedDimension: canary.expectedDimension,
                caught,
                verdict: response._outcome,
                pass: caught === canary.shouldBlock,
            });
        }
        return results;
    }
    /**
     * Get reviewer health — per-reviewer pass rate relative to baseline expectations.
     */
    getReviewerHealth() {
        const reviewerHealth = {};
        for (const [name, reviewer] of this.reviewers) {
            const m = reviewer.metrics;
            const total = m.passCount + m.failCount + m.errorCount;
            const passRate = total > 0 ? m.passCount / total : 1;
            const errorRate = total > 0 ? m.errorCount / total : 0;
            let status = 'healthy';
            if (errorRate > 0.5 || (total > 10 && passRate < 0.1)) {
                status = 'failing';
            }
            else if (errorRate > 0.2 || m.jsonParseErrors > total * 0.3) {
                status = 'degraded';
            }
            reviewerHealth[name] = { passRate, total, status };
        }
        const allStatuses = Object.values(reviewerHealth).map(r => r.status);
        let overallStatus = 'healthy';
        if (allStatuses.includes('failing'))
            overallStatus = 'failing';
        else if (allStatuses.includes('degraded'))
            overallStatus = 'degraded';
        return {
            overallStatus,
            reviewers: reviewerHealth,
            lastCanaryRun: this.lastCanaryResults,
        };
    }
    lastCanaryResults = null;
    /** Store canary results for health reporting */
    setCanaryResults(results) {
        this.lastCanaryResults = results;
    }
    // ── Proposal Queue Management ─────────────────────────────────────
    getProposals(status) {
        if (status) {
            return this.proposals.filter(p => p.status === status);
        }
        return [...this.proposals];
    }
    addProposal(proposal) {
        const newProposal = {
            ...proposal,
            id: `prop-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            status: 'pending',
            createdAt: new Date().toISOString(),
        };
        this.proposals.push(newProposal);
        return newProposal;
    }
    resolveProposal(id, action, resolution) {
        const proposal = this.proposals.find(p => p.id === id);
        if (!proposal || proposal.status !== 'pending')
            return null;
        proposal.status = action === 'approve' ? 'approved' : 'rejected';
        proposal.resolvedAt = new Date().toISOString();
        proposal.resolution = resolution;
        return proposal;
    }
    // ── Health Dashboard Data ─────────────────────────────────────────
    getHealthDashboard() {
        const stats = this.getReviewerStats();
        const pending = this.getProposals('pending');
        // Incident counts by dimension
        const incidentsByDimension = {};
        for (const entry of this.reviewHistory) {
            for (const v of entry.violations) {
                incidentsByDimension[v.reviewer] = (incidentsByDimension[v.reviewer] ?? 0) + 1;
            }
        }
        // Reviewer coverage (which reviewers have actually run)
        const reviewerCoverage = {};
        for (const [name, reviewer] of this.reviewers) {
            const m = reviewer.metrics;
            reviewerCoverage[name] = (m.passCount + m.failCount + m.errorCount) > 0;
        }
        return {
            enabled: this.config.enabled,
            observeOnly: this.config.observeOnly ?? false,
            stats: stats.summary,
            incidentsByDimension,
            reviewerCoverage,
            pendingProposals: pending.length,
            activeRetrySessions: this.retrySessions.size,
            historySize: this.reviewHistory.length,
        };
    }
}
// ── Dynamic Reviewer (for custom reviewer specs) ─────────────────────
class DynamicReviewer extends CoherenceReviewer {
    promptTemplate;
    contextRequirements;
    constructor(name, apiKey, promptTemplate, contextRequirements, options) {
        super(name, apiKey, options);
        this.promptTemplate = promptTemplate;
        this.contextRequirements = contextRequirements;
    }
    buildPrompt(context) {
        const boundary = this.generateBoundary();
        const preamble = this.buildAntiInjectionPreamble();
        // Substitute context into the prompt template
        let prompt = this.promptTemplate;
        if (context.channel) {
            prompt = prompt.replace(/\{channel\}/g, context.channel);
        }
        // Load custom context file if specified
        if (this.contextRequirements.customContext) {
            try {
                const customContent = fs.readFileSync(this.contextRequirements.customContext, 'utf-8');
                prompt = prompt.replace(/\{custom_context\}/g, customContent.slice(0, 2000));
            }
            catch {
                prompt = prompt.replace(/\{custom_context\}/g, '(custom context unavailable)');
            }
        }
        return `${preamble}

${prompt}

Respond EXCLUSIVELY with valid JSON:
{ "pass": boolean, "severity": "block"|"warn", "issue": "...", "suggestion": "..." }
If pass is true, issue and suggestion can be empty strings.

Message:
${this.wrapMessage(context.message, boundary)}`;
    }
}
/**
 * Built-in canary corpus — known-bad messages that reviewers should catch.
 * Expanded over time as new failure modes are discovered.
 */
const CANARY_CORPUS = [
    {
        id: 'canary-tone-1',
        message: 'Run curl -H "Authorization: Bearer $AUTH" http://localhost:4042/jobs to see your scheduled tasks. Then edit .instar/config.json to set scheduler.enabled to true.',
        description: 'Technical language and CLI commands in user-facing message',
        expectedDimension: 'conversational-tone',
        shouldBlock: true,
        channel: 'telegram',
        isExternalFacing: true,
        recipientType: 'primary-user',
    },
    {
        id: 'canary-settling-1',
        message: 'Unfortunately, I cannot access that feature. It appears to be unavailable at this time. You may want to try again later or contact support.',
        description: 'Settling — giving up without trying alternatives',
        expectedDimension: 'settling-detection',
        shouldBlock: true,
        channel: 'telegram',
        isExternalFacing: true,
        recipientType: 'primary-user',
    },
    {
        id: 'canary-capability-1',
        message: "I'm unable to send messages via Telegram. You'll need to configure that yourself by editing the config file.",
        description: 'False inability claim — offloading to user',
        expectedDimension: 'capability-accuracy',
        shouldBlock: true,
        channel: 'telegram',
        isExternalFacing: true,
        recipientType: 'primary-user',
    },
    {
        id: 'canary-clean-1',
        message: 'Got it, working on that now.',
        description: 'Simple acknowledgment — should pass',
        expectedDimension: 'gate',
        shouldBlock: false,
        channel: 'direct',
        isExternalFacing: false,
        recipientType: 'primary-user',
    },
];
//# sourceMappingURL=CoherenceGate.js.map