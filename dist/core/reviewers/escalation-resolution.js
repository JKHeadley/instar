/**
 * Escalation Resolution Reviewer — Catches unnecessary human escalation.
 *
 * Part of Autonomy Guard (PROP-232). Detects when an agent claims "needs human"
 * for tasks it could resolve itself, given its capability registry and known
 * blocker resolutions.
 *
 * Integrates into CoherenceGate as a specialist reviewer.
 * Autonomy-level-aware: strictness modulates by user-configured autonomy level.
 */
import { CoherenceReviewer } from '../CoherenceReviewer.js';
// ---------------------------------------------------------------------------
// Autonomy guidance — how strict to be at each level
// ---------------------------------------------------------------------------
const AUTONOMY_GUIDANCE = {
    autonomous: 'This agent is configured as AUTONOMOUS. The bar for allowing escalation should be HIGH. ' +
        'Only allow if the agent genuinely lacks the capability.',
    collaborative: 'This agent is COLLABORATIVE. Apply balanced judgment — block clear unnecessary escalations, ' +
        'allow genuine ones.',
    supervised: 'This agent is SUPERVISED. Apply moderate judgment — only block obviously unnecessary escalations.',
    cautious: 'This agent is CAUTIOUS. Allow most escalations — only block if the resolution is trivially ' +
        'obvious from capabilities.',
};
// ---------------------------------------------------------------------------
// Reviewer implementation
// ---------------------------------------------------------------------------
export class EscalationResolutionReviewer extends CoherenceReviewer {
    constructor(apiKey, options) {
        super('escalation-resolution', apiKey, options);
    }
    /**
     * Override review() to handle recursion guard and extended result type.
     */
    async review(context) {
        // Recursion guard: skip review entirely for research sessions
        if (context.isResearchSession) {
            return {
                pass: true,
                severity: 'warn',
                issue: '',
                suggestion: '',
                reviewer: this.name,
                latencyMs: 0,
            };
        }
        // Check for known blocker match BEFORE LLM evaluation (O(1) lookup)
        const blockerMatch = this.matchKnownBlocker(context);
        if (blockerMatch) {
            this.metrics.failCount++;
            return {
                pass: false,
                severity: 'block',
                issue: `Known blocker detected: "${blockerMatch.description}"`,
                suggestion: `Resolution (from prior experience): ${blockerMatch.resolution}` +
                    (blockerMatch.toolsNeeded?.length ? `\nTools needed: ${blockerMatch.toolsNeeded.join(', ')}` : '') +
                    (blockerMatch.credentials ? `\nCredentials: ${blockerMatch.credentials}` : ''),
                reviewer: this.name,
                latencyMs: 0,
            };
        }
        // LLM evaluation with confidence-aware research trigger
        const start = Date.now();
        try {
            const prompt = this.buildPrompt(context);
            const timeoutMs = this.options.timeoutMs ?? 8_000;
            const raw = await Promise.race([
                this.callApi(prompt),
                new Promise((_, reject) => setTimeout(() => reject(new Error('Reviewer timeout')), timeoutMs)),
            ]);
            const parsed = this.parseEscalationResponse(raw);
            const latencyMs = Date.now() - start;
            this.metrics.totalLatencyMs += latencyMs;
            // Research trigger: confidence < 0.5 and would block → signal for research instead
            if (parsed.confidence < 0.5 && !parsed.pass) {
                this.metrics.passCount++; // Don't block — pass through with research signal
                return {
                    pass: true,
                    severity: 'warn',
                    issue: 'Ambiguous escalation — research triggered',
                    suggestion: 'A research agent is investigating whether this can be self-resolved.',
                    reviewer: this.name,
                    latencyMs,
                    needsResearch: true,
                    researchContext: {
                        blockerDescription: parsed.issue,
                        capabilities: context.capabilityRegistry,
                    },
                };
            }
            if (parsed.pass) {
                this.metrics.passCount++;
            }
            else {
                this.metrics.failCount++;
            }
            return {
                pass: parsed.pass,
                severity: parsed.severity,
                issue: parsed.issue,
                suggestion: parsed.suggestion,
                reviewer: this.name,
                latencyMs,
            };
        }
        catch {
            const latencyMs = Date.now() - start;
            this.metrics.totalLatencyMs += latencyMs;
            this.metrics.errorCount++;
            return {
                pass: true,
                severity: 'warn',
                issue: '',
                suggestion: '',
                reviewer: this.name,
                latencyMs,
            };
        }
    }
    /**
     * Parse LLM response with confidence extraction.
     */
    parseEscalationResponse(raw) {
        const failOpen = { pass: true, severity: 'warn', issue: '', suggestion: '', confidence: 1.0 };
        try {
            const jsonMatch = raw.match(/\{[\s\S]*\}/);
            if (!jsonMatch)
                return failOpen;
            const parsed = JSON.parse(jsonMatch[0]);
            if (typeof parsed['pass'] !== 'boolean')
                return failOpen;
            return {
                pass: parsed['pass'],
                severity: parsed['severity'] ?? 'warn',
                issue: parsed['issue'] ?? '',
                suggestion: parsed['suggestion'] ?? '',
                confidence: typeof parsed['confidence'] === 'number' ? parsed['confidence'] : 1.0,
            };
        }
        catch {
            return failOpen;
        }
    }
    buildPrompt(context) {
        const boundary = this.generateBoundary();
        const preamble = this.buildAntiInjectionPreamble();
        const autonomyLevel = context.autonomyLevel ?? 'collaborative';
        const guidance = AUTONOMY_GUIDANCE[autonomyLevel];
        const capabilitySummary = context.capabilityRegistry
            ? this.sanitizeRegistry(context.capabilityRegistry)
            : 'No capability registry available — evaluate based on message content only.';
        return `${preamble}

You are checking whether an AI agent is unnecessarily escalating to a human
when it has the capability to resolve the issue itself.

${guidance}

Agent capabilities (tools, accounts, auth methods — NO secrets included):
${capabilitySummary}

Flag when the message:
- Asks a human to do something the agent could do with its listed capabilities
- Claims "needs human action" for a task within the agent's tool set
- Defers to a human without evidence of having tried available tools
- Writes instructions for a human to follow when the agent has browser/CLI access

DO NOT flag when:
- The agent genuinely lacks the capability (no relevant tools or credentials)
- The issue involves billing, legal decisions, or safety concerns
- The agent has tried and documented why its tools are insufficient
- The escalation is about credentials the agent genuinely doesn't have

${context.toolOutputContext ? `Recent tool context:\n${context.toolOutputContext}` : 'No tool context available'}

Respond EXCLUSIVELY with valid JSON:
{ "pass": boolean, "severity": "block"|"warn", "issue": "...", "suggestion": "...", "confidence": 0.0 }

If confidence < 0.8 and you would block, set severity to "warn" instead.

Message:
${this.wrapMessage(context.message, boundary)}`;
    }
    /**
     * Sanitize the capability registry before sending to LLM.
     * Strips credential details, keeps only capability descriptions.
     */
    sanitizeRegistry(registry) {
        const sanitized = {};
        if (registry.authentication) {
            sanitized.authentication = Object.fromEntries(Object.entries(registry.authentication).map(([k, v]) => [k, {
                    tool: v.tool,
                    platforms: v.platforms,
                }]));
        }
        if (registry.tools) {
            // Strip knownIssues to prevent injection via notes fields
            sanitized.tools = Object.fromEntries(Object.entries(registry.tools).map(([k, v]) => [k, {
                    tool: v.tool,
                    capabilities: v.capabilities,
                }]));
        }
        if (registry.accountsOwned) {
            // Anonymize: only show that an account exists, not the handle
            sanitized.accountsOwned = Object.fromEntries(Object.entries(registry.accountsOwned).map(([k, v]) => [k, {
                    hasAccount: true,
                    authMethod: v.authMethod,
                }]));
        }
        // Never include credentials section in LLM context
        return JSON.stringify(sanitized, null, 2);
    }
    /**
     * Check if the agent's output matches a known blocker pattern.
     * Returns the matching blocker if found, null otherwise.
     */
    matchKnownBlocker(context) {
        if (!context.jobBlockers)
            return null;
        const messageLower = context.message.toLowerCase();
        for (const [_key, blocker] of Object.entries(context.jobBlockers)) {
            // Skip expired blockers
            if (blocker.expiresAt && new Date(blocker.expiresAt) < new Date())
                continue;
            // Skip pending blockers (not yet confirmed)
            if (blocker.status === 'pending')
                continue;
            // Simple substring match on blocker description keywords
            const descWords = blocker.description.toLowerCase().split(/\s+/).filter(w => w.length > 3);
            const matchCount = descWords.filter(w => messageLower.includes(w)).length;
            const matchRatio = descWords.length > 0 ? matchCount / descWords.length : 0;
            // Require >50% keyword overlap for a match
            if (matchRatio > 0.5) {
                return blocker;
            }
        }
        return null;
    }
}
//# sourceMappingURL=escalation-resolution.js.map