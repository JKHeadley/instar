/**
 * DiscoveryEvaluator — LLM-powered context evaluator for feature discovery.
 *
 * Part of the Consent & Discovery Framework (Phase 3: Context Evaluator).
 *
 * Architecture:
 *   - Input sanitization: receives topic categories, not raw user text
 *   - Pre-filtering: excludes ineligible features before LLM call
 *   - Haiku-class LLM evaluation with structural prompt delimiters
 *   - Output validation: featureId must exist in eligible set
 *   - Rate limiting: max calls/session, min interval, result caching
 *   - Fail-open: timeout/error → no surfacing, pull path unaffected
 *
 * The evaluator itself is a network-tier processing activity in the
 * feature registry (it calls an external LLM API).
 */

import type { IntelligenceProvider, IntelligenceOptions } from './types.js';
import type {
  FeatureRegistry,
  FeatureDefinition,
  FeatureCategory,
  ConsentTier,
  DiscoveryState,
} from './FeatureRegistry.js';

// ── Types ────────────────────────────────────────────────────────────

/** Sanitized conversation context — NO raw user text */
export interface DiscoveryContext {
  /** Categorical label, not free text */
  topicCategory: string;
  /** High-level intent classification */
  conversationIntent: 'debugging' | 'configuring' | 'exploring' | 'building' | 'asking' | 'monitoring' | 'unknown';
  /** Structured problem labels, not raw error data */
  problemCategories: string[];
  /** User's autonomy profile name */
  autonomyProfile: string;
  /** Features already enabled (by ID) */
  enabledFeatures: string[];
  /** User ID for state lookups */
  userId?: string;
}

/** Subset of FeatureDefinition sent to the evaluator */
export interface EligibleFeature {
  id: string;
  name: string;
  category: FeatureCategory;
  oneLiner: string;
  consentTier: ConsentTier;
  triggerConditions: string[];
}

/** Single feature surfacing recommendation */
export interface SurfacingRecommendation {
  featureId: string;
  surfaceAs: 'awareness' | 'suggestion' | 'prompt';
  reasoning: string;
  messageForAgent: string;
}

/** Result of context evaluation */
export interface DiscoveryEvaluation {
  /** The feature to surface, if any */
  recommendation: SurfacingRecommendation | null;
  /** Whether this was from cache */
  cached: boolean;
  /** Whether the evaluator was rate-limited (returned empty) */
  rateLimited: boolean;
  /** Number of eligible features considered */
  eligibleCount: number;
  /** Error message if evaluation failed (fail-open → no recommendation) */
  error?: string;
}

/** Rate limiting and cost control configuration */
export interface EvaluatorLimits {
  /** Max evaluations per session (default: 3) */
  maxCallsPerSession: number;
  /** Minimum interval between evaluations in ms (default: 300000 = 5min) */
  minIntervalMs: number;
  /** Cache TTL in ms — results cached by topicCategory (default: 600000 = 10min) */
  resultCacheTtlMs: number;
  /** Hard timeout for LLM call in ms (default: 5000) */
  timeoutMs: number;
  /** Max features to send to evaluator (default: 10) */
  maxFeaturesPerEval: number;
}

// ── Constants ────────────────────────────────────────────────────────

const DEFAULT_LIMITS: EvaluatorLimits = {
  maxCallsPerSession: 3,
  minIntervalMs: 300_000,        // 5 minutes
  resultCacheTtlMs: 600_000,     // 10 minutes
  timeoutMs: 5_000,              // 5 seconds
  maxFeaturesPerEval: 10,
};

const PROMPT_VERSION = 'v1.0';

/** Discovery states that make a feature ineligible for surfacing */
const INELIGIBLE_STATES: Set<DiscoveryState> = new Set(['enabled', 'disabled']);

/** Autonomy profile → max surfaceAs level */
const AUTONOMY_SURFACE_CAPS: Record<string, 'awareness' | 'suggestion' | 'prompt'> = {
  cautious: 'awareness',
  supervised: 'suggestion',
  collaborative: 'prompt',
  autonomous: 'prompt',
};

/** Valid surfaceAs levels in order of escalation */
const SURFACE_LEVELS: Array<'awareness' | 'suggestion' | 'prompt'> = ['awareness', 'suggestion', 'prompt'];

// ── Main Class ───────────────────────────────────────────────────────

export class DiscoveryEvaluator {
  private registry: FeatureRegistry;
  private intelligence: IntelligenceProvider;
  private limits: EvaluatorLimits;

  // Rate limiting state
  private callCount = 0;
  private lastCallTime = 0;

  // Cache: topicCategory → { result, timestamp }
  private cache = new Map<string, { result: DiscoveryEvaluation; timestamp: number }>();

  constructor(
    registry: FeatureRegistry,
    intelligence: IntelligenceProvider,
    limits?: Partial<EvaluatorLimits>,
  ) {
    this.registry = registry;
    this.intelligence = intelligence;
    this.limits = { ...DEFAULT_LIMITS, ...limits };
  }

  /**
   * Evaluate the current context and recommend a feature to surface (if any).
   * Fail-open: errors/timeouts return { recommendation: null }.
   */
  async evaluate(context: DiscoveryContext): Promise<DiscoveryEvaluation> {
    const userId = context.userId || 'default';

    // Respect autonomy profile discovery aggressiveness
    // 'passive' = only surface on explicit user request (pull-only, no push)
    if (context.autonomyProfile === 'cautious') {
      return {
        recommendation: null,
        cached: false,
        rateLimited: false,
        eligibleCount: 0,
      };
    }

    // Check cache first
    const cached = this.getCached(context.topicCategory);
    if (cached) {
      return { ...cached, cached: true };
    }

    // Check rate limits
    if (this.isRateLimited()) {
      return {
        recommendation: null,
        cached: false,
        rateLimited: true,
        eligibleCount: 0,
      };
    }

    // Pre-filter eligible features
    const eligible = this.preFilter(context, userId);
    if (eligible.length === 0) {
      const result: DiscoveryEvaluation = {
        recommendation: null,
        cached: false,
        rateLimited: false,
        eligibleCount: 0,
      };
      this.cacheResult(context.topicCategory, result);
      return result;
    }

    // Build prompt and call LLM
    const prompt = this.buildPrompt(context, eligible);

    try {
      const response = await this.callWithTimeout(prompt);
      const recommendation = this.validateOutput(response, eligible, context.autonomyProfile);

      const result: DiscoveryEvaluation = {
        recommendation,
        cached: false,
        rateLimited: false,
        eligibleCount: eligible.length,
      };

      this.recordCall();
      this.cacheResult(context.topicCategory, result);
      return result;
    } catch (err) {
      // @silent-fallback-ok — Fail-open by design: evaluator errors never block agent operation
      const errorMsg = err instanceof Error ? err.message : String(err);
      return {
        recommendation: null,
        cached: false,
        rateLimited: false,
        eligibleCount: eligible.length,
        error: errorMsg,
      };
    }
  }

  /**
   * Get current evaluator status for monitoring.
   */
  getStatus(): {
    callsThisSession: number;
    maxCallsPerSession: number;
    cacheSize: number;
    lastCallTime: number;
    rateLimited: boolean;
  } {
    return {
      callsThisSession: this.callCount,
      maxCallsPerSession: this.limits.maxCallsPerSession,
      cacheSize: this.cache.size,
      lastCallTime: this.lastCallTime,
      rateLimited: this.isRateLimited(),
    };
  }

  /**
   * Reset session state (call count, cache). Used when session restarts.
   */
  resetSession(): void {
    this.callCount = 0;
    this.lastCallTime = 0;
    this.cache.clear();
  }

  /**
   * Clear the evaluation cache. Useful when feature states change.
   */
  clearCache(): void {
    this.cache.clear();
  }

  // ── Pre-Filtering ────────────────────────────────────────────────

  /**
   * Pre-filter features to only those eligible for surfacing.
   * Returns at most maxFeaturesPerEval features.
   */
  preFilter(context: DiscoveryContext, userId: string): EligibleFeature[] {
    if (!this.registry.isReady()) return [];

    const allFeatures = this.registry.getAllFeatures(userId);
    const eligible: Array<{ feature: EligibleFeature; priority: number }> = [];

    for (const info of allFeatures) {
      const { definition, state } = info;

      // Skip features in ineligible states
      if (INELIGIBLE_STATES.has(state.discoveryState)) continue;

      // Skip deferred features with active cooldown
      if (state.discoveryState === 'deferred' && state.lastSurfacedAt) {
        // Deferred features handled by state machine — excluded from evaluator
        continue;
      }

      // Skip features that have been surfaced too many times
      const maxSurfaces = this.getMaxSurfaces(definition);
      if (state.surfaceCount >= maxSurfaces) continue;

      // Skip permanently-quiet features (declined too many times)
      if (state.discoveryState === 'declined' && state.declineCount >= 3) continue;

      // Category match (coarse pre-filter)
      const categoryMatch = this.categoryMatches(definition, context);

      // Priority: undiscovered before aware, lower ConsentTier first
      const statePriority = state.discoveryState === 'undiscovered' ? 0 : 1;
      const tierPriority = this.getTierPriority(definition.consentTier);
      const categoryBoost = categoryMatch ? 0 : 10;
      const priority = statePriority + tierPriority + categoryBoost;

      eligible.push({
        feature: {
          id: definition.id,
          name: definition.name,
          category: definition.category,
          oneLiner: definition.oneLiner,
          consentTier: definition.consentTier,
          triggerConditions: definition.discoveryTriggers.map(t => t.condition),
        },
        priority,
      });
    }

    // Sort by priority and cap
    eligible.sort((a, b) => a.priority - b.priority);
    return eligible.slice(0, this.limits.maxFeaturesPerEval).map(e => e.feature);
  }

  // ── Prompt Building ──────────────────────────────────────────────

  /**
   * Build the evaluation prompt with structural delimiters.
   * Uses sanitized context only — no raw user text.
   */
  buildPrompt(context: DiscoveryContext, eligible: EligibleFeature[]): string {
    const featureList = eligible.map(f =>
      `- ${f.id} (${f.name}): ${f.oneLiner} [tier: ${f.consentTier}]\n  Triggers: ${f.triggerConditions.join('; ') || 'none specified'}`
    ).join('\n');

    return `<system>
You are a feature discovery evaluator. Your job is to decide whether any of the
listed features should be surfaced to the user RIGHT NOW based on their current
context. You must respond with ONLY valid JSON — no markdown, no explanation
outside the JSON.

Rules:
1. Surface AT MOST one feature per evaluation
2. Only surface a feature if the context strongly suggests it would help
3. Prefer "awareness" (lowest pressure) unless context strongly demands "suggestion"
4. NEVER surface "prompt" for self-governing tier features
5. If nothing is relevant, return {"featuresToSurface": []}
6. The featureId MUST be one from the eligible list below
7. messageForAgent should be a natural, conversational mention — NOT a sales pitch

Response schema:
{
  "featuresToSurface": [
    {
      "featureId": "string (must match an id from the eligible list)",
      "surfaceAs": "awareness | suggestion | prompt",
      "reasoning": "brief explanation of why this is relevant now",
      "messageForAgent": "natural mention the agent can use in conversation"
    }
  ]
}

If nothing is relevant, respond: {"featuresToSurface": []}
</system>

<context>
Topic: ${context.topicCategory}
Intent: ${context.conversationIntent}
Problems: ${context.problemCategories.length > 0 ? context.problemCategories.join(', ') : 'none'}
Autonomy: ${context.autonomyProfile}
Enabled: ${context.enabledFeatures.length > 0 ? context.enabledFeatures.join(', ') : 'none'}
</context>

<eligible_features>
${featureList}
</eligible_features>

Evaluate: should any of these features be surfaced given the current context? JSON only.`;
  }

  // ── Output Validation ────────────────────────────────────────────

  /**
   * Parse and validate LLM response. Returns null if no valid recommendation.
   */
  validateOutput(
    response: string,
    eligible: EligibleFeature[],
    autonomyProfile: string,
  ): SurfacingRecommendation | null {
    try {
      // Extract JSON from response
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return null;

      const parsed = JSON.parse(jsonMatch[0]);
      if (!parsed.featuresToSurface || !Array.isArray(parsed.featuresToSurface)) return null;
      if (parsed.featuresToSurface.length === 0) return null;

      // Take only the first recommendation
      const rec = parsed.featuresToSurface[0];

      // Validate featureId exists in eligible set
      const eligibleIds = new Set(eligible.map(f => f.id));
      if (!eligibleIds.has(rec.featureId)) return null;

      // Validate surfaceAs is valid
      if (!SURFACE_LEVELS.includes(rec.surfaceAs)) return null;

      // Cap surfaceAs by autonomy profile
      const maxLevel = AUTONOMY_SURFACE_CAPS[autonomyProfile] || 'suggestion';
      const cappedSurfaceAs = this.capSurfaceLevel(rec.surfaceAs, maxLevel);

      // Block 'prompt' for self-governing tier features
      const feature = eligible.find(f => f.id === rec.featureId);
      if (feature && feature.consentTier === 'self-governing' && cappedSurfaceAs === 'prompt') {
        return null;
      }

      // Validate required string fields
      if (typeof rec.reasoning !== 'string' || !rec.reasoning) return null;
      if (typeof rec.messageForAgent !== 'string' || !rec.messageForAgent) return null;

      return {
        featureId: rec.featureId,
        surfaceAs: cappedSurfaceAs,
        reasoning: rec.reasoning,
        messageForAgent: rec.messageForAgent,
      };
    } catch {
      // @silent-fallback-ok — Malformed LLM output returns null (no recommendation), by design
      return null;
    }
  }

  // ── Private Helpers ──────────────────────────────────────────────

  private isRateLimited(): boolean {
    if (this.callCount >= this.limits.maxCallsPerSession) return true;
    if (this.lastCallTime > 0) {
      const elapsed = Date.now() - this.lastCallTime;
      if (elapsed < this.limits.minIntervalMs) return true;
    }
    return false;
  }

  private recordCall(): void {
    this.callCount++;
    this.lastCallTime = Date.now();
  }

  private getCached(topicCategory: string): DiscoveryEvaluation | null {
    const entry = this.cache.get(topicCategory);
    if (!entry) return null;
    const elapsed = Date.now() - entry.timestamp;
    if (elapsed > this.limits.resultCacheTtlMs) {
      this.cache.delete(topicCategory);
      return null;
    }
    return entry.result;
  }

  private cacheResult(topicCategory: string, result: DiscoveryEvaluation): void {
    this.cache.set(topicCategory, { result, timestamp: Date.now() });
  }

  private async callWithTimeout(prompt: string): Promise<string> {
    const options: IntelligenceOptions = {
      model: 'fast',         // Haiku-class
      maxTokens: 300,
      temperature: 0,
      attribution: { component: 'DiscoveryEvaluator' }, // attribution for /metrics/features
    };

    // Race against timeout
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('Evaluator timeout')), this.limits.timeoutMs);
    });

    return Promise.race([
      this.intelligence.evaluate(prompt, options),
      timeoutPromise,
    ]);
  }

  private getMaxSurfaces(definition: FeatureDefinition): number {
    // Use the lowest maxSurfacesBeforeQuiet across all triggers
    if (definition.discoveryTriggers.length === 0) return 3; // default
    return Math.min(...definition.discoveryTriggers.map(t => t.maxSurfacesBeforeQuiet));
  }

  private categoryMatches(definition: FeatureDefinition, context: DiscoveryContext): boolean {
    // Check if any trigger conditions loosely match the topic or problems
    const contextTerms = [
      context.topicCategory.toLowerCase(),
      context.conversationIntent.toLowerCase(),
      ...context.problemCategories.map(p => p.toLowerCase()),
    ];
    const featureTerms = [
      definition.category.toLowerCase(),
      ...definition.discoveryTriggers.map(t => t.condition.toLowerCase()),
    ];
    return contextTerms.some(ct =>
      featureTerms.some(ft => ft.includes(ct) || ct.includes(ft))
    );
  }

  private getTierPriority(tier: ConsentTier): number {
    switch (tier) {
      case 'informational': return 0;
      case 'local': return 1;
      case 'network': return 2;
      case 'self-governing': return 3;
      default: return 4;
    }
  }

  private capSurfaceLevel(
    requested: 'awareness' | 'suggestion' | 'prompt',
    max: 'awareness' | 'suggestion' | 'prompt',
  ): 'awareness' | 'suggestion' | 'prompt' {
    const requestedIndex = SURFACE_LEVELS.indexOf(requested);
    const maxIndex = SURFACE_LEVELS.indexOf(max);
    if (requestedIndex <= maxIndex) return requested;
    return max;
  }
}
