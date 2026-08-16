/**
 * External Operation Gate — LLM-supervised safety for external service operations.
 *
 * Born from the OpenClaw email deletion incident (2026-02-25): An agent deleted
 * 200+ emails autonomously, ignoring repeated "stop" commands, because nothing
 * distinguished safe operations (read email) from destructive ones (delete 200 emails).
 *
 * Design principle: Structure > Willpower. A memory.md rule saying "don't delete
 * emails without approval" degrades as context grows. A gate that physically
 * intercepts the operation and evaluates risk does not.
 *
 * Three layers:
 * 1. Static classification — operation type × reversibility × scope → risk level
 * 2. Config permissions — per-service allow/block lists (structural floor)
 * 3. LLM evaluation — for medium+ risk, a haiku-tier model evaluates proportionality
 *
 * Integrates with AdaptiveTrust for organic permission evolution.
 */
import fs from 'node:fs';
import path from 'node:path';
import { maybeRotateJsonl } from '../utils/jsonl-rotation.js';
// ── Constants ────────────────────────────────────────────────────────
/** Default autonomy behaviors per risk level (collaborative profile) */
const DEFAULT_AUTONOMY = {
    low: 'proceed',
    medium: 'log',
    high: 'approve',
    critical: 'approve',
};
/** Autonomy profiles for the three standard levels */
export const AUTONOMY_PROFILES = {
    supervised: { low: 'log', medium: 'approve', high: 'approve', critical: 'block' },
    collaborative: { low: 'proceed', medium: 'log', high: 'approve', critical: 'approve' },
    autonomous: { low: 'proceed', medium: 'proceed', high: 'log', critical: 'approve' },
};
const DEFAULT_BATCH_CONFIG = {
    batchThreshold: 5,
    bulkThreshold: 20,
    checkpointEvery: 10,
};
// ── Risk Matrix ──────────────────────────────────────────────────────
/**
 * Compute risk level from operation dimensions.
 *
 * The matrix follows the principle: irreversible + bulk = critical,
 * read operations are always low, and risk escalates with scope.
 */
export function computeRiskLevel(mutability, reversibility, scope) {
    // Reads are always low risk
    if (mutability === 'read')
        return 'low';
    // Bulk irreversible = always critical
    if (scope === 'bulk' && reversibility === 'irreversible')
        return 'critical';
    // Bulk deletes = critical regardless of reversibility
    if (scope === 'bulk' && mutability === 'delete')
        return 'critical';
    // Any irreversible bulk = critical
    if (scope === 'bulk')
        return 'critical';
    // Batch deletes = high
    if (scope === 'batch' && mutability === 'delete')
        return 'high';
    // Batch irreversible = high
    if (scope === 'batch' && reversibility === 'irreversible')
        return 'high';
    // Single deletes = medium-to-high based on reversibility
    if (mutability === 'delete' && reversibility === 'irreversible')
        return 'high';
    if (mutability === 'delete')
        return 'medium';
    // Single irreversible writes/modifies = medium
    if (reversibility === 'irreversible')
        return 'medium';
    // Batch reversible writes/modifies = medium
    if (scope === 'batch')
        return 'medium';
    // Single reversible writes/modifies = low
    return 'low';
}
/**
 * Determine scope from item count.
 */
export function scopeFromCount(count, config) {
    const batch = config?.batchThreshold ?? DEFAULT_BATCH_CONFIG.batchThreshold;
    const bulk = config?.bulkThreshold ?? DEFAULT_BATCH_CONFIG.bulkThreshold;
    if (count <= 1)
        return 'single';
    if (count <= bulk)
        return 'batch';
    return 'bulk';
}
// ── Gate Implementation ──────────────────────────────────────────────
export class ExternalOperationGate {
    config;
    logPath;
    constructor(config) {
        this.config = config;
        this.logPath = path.join(config.stateDir, 'state', 'operation-log.jsonl');
    }
    /**
     * Classify an external operation into its risk dimensions.
     */
    classify(params) {
        const scope = scopeFromCount(params.itemCount ?? 1, this.config.batchCheckpoint);
        const riskLevel = computeRiskLevel(params.mutability, params.reversibility, scope);
        return {
            mutability: params.mutability,
            reversibility: params.reversibility,
            scope,
            riskLevel,
            service: params.service,
            description: params.description,
            itemCount: params.itemCount,
        };
    }
    /**
     * Evaluate an operation through the full gate pipeline.
     *
     * Pipeline:
     * 1. Check if service is fully blocked → block
     * 2. Check if service is read-only and operation mutates → block
     * 3. Check per-service permission config → block if operation type blocked
     * 4. Classify operation risk
     * 5. Check autonomy gradient for this risk level
     * 6. For medium+ risk with intelligence provider, consult LLM
     * 7. Check batch limits and add checkpoint if needed
     * 8. Return final decision
     */
    async evaluate(params) {
        const now = new Date().toISOString();
        // Step 1: Check if service is fully blocked
        if (this.config.blockedServices?.includes(params.service)) {
            const classification = this.classify(params);
            return {
                action: 'block',
                reason: `Service "${params.service}" is fully blocked by configuration.`,
                classification,
                llmEvaluated: false,
                evaluatedAt: now,
            };
        }
        // Step 2: Check if service is read-only
        if (this.config.readOnlyServices?.includes(params.service) && params.mutability !== 'read') {
            const classification = this.classify(params);
            return {
                action: 'block',
                reason: `Service "${params.service}" is configured as read-only. ${params.mutability} operations are not allowed.`,
                classification,
                llmEvaluated: false,
                evaluatedAt: now,
            };
        }
        // Step 3: Check per-service permissions
        const serviceConfig = this.config.services?.[params.service];
        if (serviceConfig) {
            // Check blocked operations
            if (serviceConfig.blocked?.includes(params.mutability)) {
                const classification = this.classify(params);
                return {
                    action: 'block',
                    reason: `"${params.mutability}" operations are blocked for service "${params.service}" by configuration.`,
                    classification,
                    llmEvaluated: false,
                    evaluatedAt: now,
                };
            }
            // Check if operation is in allowed permissions
            if (serviceConfig.permissions.length > 0 && !serviceConfig.permissions.includes(params.mutability)) {
                const classification = this.classify(params);
                return {
                    action: 'block',
                    reason: `"${params.mutability}" is not in the allowed permissions for "${params.service}". Allowed: ${serviceConfig.permissions.join(', ')}.`,
                    classification,
                    llmEvaluated: false,
                    evaluatedAt: now,
                };
            }
        }
        // Step 4: Classify
        const classification = this.classify(params);
        // Step 5: Check autonomy gradient
        const autonomyDefaults = this.config.autonomyDefaults ?? DEFAULT_AUTONOMY;
        let behavior = autonomyDefaults[classification.riskLevel];
        // Per-service requireApproval override
        if (serviceConfig?.requireApproval?.includes(params.mutability)) {
            if (behavior === 'proceed' || behavior === 'log') {
                behavior = 'approve';
            }
        }
        // Step 6: LLM evaluation for medium+ risk (if available)
        let llmEvaluated = false;
        let llmSuggestion = null;
        if (this.config.intelligence &&
            classification.riskLevel !== 'low' &&
            behavior !== 'block') {
            llmSuggestion = await this.consultLLM(classification, params.userRequest);
            llmEvaluated = true;
            // LLM can escalate (make stricter) but not relax past the config floor
            if (llmSuggestion === 'block' || llmSuggestion === 'show-plan') {
                if (behavior === 'proceed' || behavior === 'log') {
                    behavior = 'approve'; // LLM escalated
                }
            }
        }
        // Step 7: Map autonomy behavior to gate action
        let action;
        let reason;
        switch (behavior) {
            case 'proceed':
                action = 'proceed';
                reason = `Risk level "${classification.riskLevel}" allows proceeding under current autonomy settings.`;
                break;
            case 'log':
                action = 'proceed';
                reason = `Risk level "${classification.riskLevel}" allows proceeding with logging under current autonomy settings.`;
                break;
            case 'approve':
                action = 'show-plan';
                reason = `Risk level "${classification.riskLevel}" requires approval under current autonomy settings.`;
                break;
            case 'block':
                action = 'block';
                reason = `Risk level "${classification.riskLevel}" is blocked under current autonomy settings.`;
                break;
        }
        // Override with LLM suggestion if it provided an alternative
        if (llmSuggestion === 'suggest-alternative') {
            action = 'suggest-alternative';
            reason = 'LLM evaluation suggests a safer alternative approach.';
        }
        // Step 8: Add checkpoint for batch/bulk operations
        let checkpoint;
        if (classification.scope !== 'single' && action !== 'block') {
            const batchConfig = this.config.batchCheckpoint ?? DEFAULT_BATCH_CONFIG;
            const itemCount = params.itemCount ?? 0;
            if (classification.scope === 'batch') {
                checkpoint = {
                    afterCount: batchConfig.batchThreshold,
                    totalExpected: itemCount,
                    completedSoFar: 0,
                };
            }
            else if (classification.scope === 'bulk') {
                checkpoint = {
                    afterCount: batchConfig.checkpointEvery,
                    totalExpected: itemCount,
                    completedSoFar: 0,
                };
                // Bulk operations always require plan even if autonomy says proceed
                if (action === 'proceed') {
                    action = 'show-plan';
                    reason = `Bulk operations (${itemCount} items) always require a plan before proceeding.`;
                }
            }
        }
        // Build plan text for show-plan actions
        let plan;
        if (action === 'show-plan') {
            plan = this.buildPlan(classification, checkpoint);
        }
        const decision = {
            action,
            reason,
            classification,
            plan,
            checkpoint,
            llmEvaluated,
            evaluatedAt: now,
        };
        // Log the evaluation
        this.logOperation({
            timestamp: now,
            classification,
            decision: action,
        });
        return decision;
    }
    /**
     * Consult LLM for proportionality evaluation.
     *
     * IMPORTANT: The LLM never sees the content being operated on.
     * This prevents prompt injection via email body, calendar event, etc.
     * The LLM only sees: what operation, what scope, what the user asked for.
     */
    async consultLLM(classification, userRequest) {
        if (!this.config.intelligence)
            return 'proceed';
        const prompt = [
            'You are a safety evaluator for an AI agent\'s external service operations.',
            'Evaluate whether this operation is proportional and appropriate.',
            '',
            `Service: ${classification.service}`,
            `Operation: ${classification.mutability} (${classification.description})`,
            `Reversibility: ${classification.reversibility}`,
            `Scope: ${classification.scope}${classification.itemCount ? ` (${classification.itemCount} items)` : ''}`,
            `Risk level: ${classification.riskLevel}`,
            '',
            userRequest ? `User's original request: "${userRequest}"` : 'No user request context available.',
            '',
            'Questions:',
            '1. Does this operation match what the user likely intended?',
            '2. Is the scope proportional to the request?',
            '3. Is there a less destructive way to achieve the same goal?',
            '',
            'Respond with exactly one word: proceed, show-plan, suggest-alternative, or block.',
        ].join('\n');
        try {
            const response = await this.config.intelligence.evaluate(prompt, {
                maxTokens: 10,
                temperature: 0,
            });
            const cleaned = response.trim().toLowerCase();
            if (['proceed', 'show-plan', 'suggest-alternative', 'block'].includes(cleaned)) {
                return cleaned;
            }
            // If LLM response is unparseable, default to cautious
            return 'show-plan';
        }
        catch {
            // @silent-fallback-ok — LLM fails, proceed (fail-open)
            return 'proceed';
        }
    }
    /**
     * Build a human-readable plan for the user.
     */
    buildPlan(classification, checkpoint) {
        const lines = [];
        lines.push(`I'd like to ${classification.mutability} on ${classification.service}: ${classification.description}`);
        lines.push('');
        lines.push(`Risk: ${classification.riskLevel} (${classification.reversibility}, ${classification.scope})`);
        if (classification.itemCount) {
            lines.push(`Items affected: ${classification.itemCount}`);
        }
        if (checkpoint) {
            lines.push('');
            lines.push(`I'll check in after every ${checkpoint.afterCount} items with a progress report.`);
        }
        lines.push('');
        lines.push('Approve to proceed, or tell me to adjust the approach.');
        return lines.join('\n');
    }
    /**
     * Log an operation evaluation to the JSONL log.
     */
    logOperation(entry) {
        try {
            const dir = path.dirname(this.logPath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            maybeRotateJsonl(this.logPath, { maxBytes: 5 * 1024 * 1024, keepRatio: 0.5 });
            fs.appendFileSync(this.logPath, JSON.stringify(entry) + '\n');
        }
        catch {
            // @silent-fallback-ok — logging non-critical
        }
    }
    /**
     * Read recent operation log entries.
     */
    getOperationLog(limit = 50) {
        if (!fs.existsSync(this.logPath))
            return [];
        try {
            const lines = fs.readFileSync(this.logPath, 'utf-8')
                .split('\n')
                .filter(Boolean);
            return lines
                .slice(-limit)
                .map(line => JSON.parse(line));
        }
        catch {
            // @silent-fallback-ok — log read returns empty
            return [];
        }
    }
    /**
     * Get the effective service permissions (config + defaults).
     */
    getServicePermissions(service) {
        if (this.config.blockedServices?.includes(service)) {
            return { permissions: [], blocked: ['read', 'write', 'modify', 'delete'] };
        }
        if (this.config.readOnlyServices?.includes(service)) {
            return { permissions: ['read'], blocked: ['write', 'modify', 'delete'] };
        }
        return this.config.services?.[service] ?? null;
    }
    /**
     * Get the current autonomy profile.
     */
    getAutonomyProfile() {
        return this.config.autonomyDefaults ?? DEFAULT_AUTONOMY;
    }
    /**
     * Update autonomy defaults (used by AdaptiveTrust when trust changes).
     */
    updateAutonomyDefaults(defaults) {
        this.config.autonomyDefaults = defaults;
    }
    /**
     * Update service permissions at runtime.
     */
    updateServicePermissions(service, permissions) {
        if (!this.config.services) {
            this.config.services = {};
        }
        this.config.services[service] = permissions;
    }
}
//# sourceMappingURL=ExternalOperationGate.js.map