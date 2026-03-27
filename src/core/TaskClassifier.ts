/**
 * Task Classifier — Cost-optimized routing of tasks to appropriate model tier.
 *
 * Classifies incoming tasks and routes them to appropriate Claude model tier:
 * - Haiku (5 tokens) - routine tasks, simple logic
 * - Sonnet (3 tokens) - moderate complexity, balanced performance
 * - Opus (1 token) - complex reasoning, edge cases
 *
 * Target routing frequencies (cost-optimized):
 * - Haiku: 60% (15x more than Opus's 4%)
 * - Sonnet: 36% (3x more than Opus's 4%)
 * - Opus: 4% (only for truly complex work)
 */

import type { ModelTier } from './types.js';

export interface TaskClassification {
  model: ModelTier;
  confidence: number;
  complexity: number;
  reason: string;
  indicators?: Array<{ indicator: string; tier: string }>;
}

export interface TaskContext {
  multiStep?: boolean;
  requiresReasoning?: boolean;
  multiDomain?: boolean;
  edgeCase?: boolean;
  isUndefined?: boolean;
  contextRequired?: boolean;
  timeConstraint?: 'normal' | 'urgent';
}

// Task complexity indicators
const HAIKU_INDICATORS = [
  'read', 'list', 'format', 'parse', 'summarize', 'search',
  'extract', 'validate', 'simple', 'routine', 'basic',
  'check', 'verify', 'find', 'count', 'sort'
];

const SONNET_INDICATORS = [
  'analyze', 'compare', 'refactor', 'optimize', 'debug',
  'design', 'implement', 'review', 'test', 'plan',
  'generate', 'create', 'modify', 'improve', 'enhance'
];

const OPUS_INDICATORS = [
  'architect', 'complex reasoning', 'edge case', 'novel',
  'research', 'synthesis', 'strategic', 'novel approach',
  'breakthrough', 'multi-step reasoning', 'ambiguous'
];

// Complexity factors
const COMPLEXITY_FACTORS = {
  multiStep: 2,
  requiresReasoning: 3,
  multiDomain: 2,
  edgeCase: 3,
  undefined: 2,
  contextRequired: 1,
  timeConstraint: 1
};

/**
 * Routing weights for cost-optimized distribution.
 * Used by orchestration layer for probabilistic routing.
 */
export const ROUTING_WEIGHTS = {
  haiku: 0.60,  // 60% - 15x more than Opus
  sonnet: 0.36, // 36% - 3x more than Opus
  opus: 0.04    // 4% - base rate for complex work
};

/**
 * Analyze a task description and return model tier recommendation.
 */
export function analyzeTask(taskDescription: string, context: TaskContext = {}): TaskClassification {
  if (!taskDescription || typeof taskDescription !== 'string') {
    return {
      model: 'haiku',
      confidence: 0.5,
      reason: 'Invalid task description',
      complexity: 0
    };
  }

  const description = taskDescription.toLowerCase();
  let complexityScore = 1;
  const matchedIndicators: Array<{ indicator: string; tier: string }> = [];

  // Count indicator matches - weighted by tier
  HAIKU_INDICATORS.forEach(indicator => {
    if (description.includes(indicator)) {
      complexityScore += 0.5;
      matchedIndicators.push({ indicator, tier: 'haiku' });
    }
  });

  SONNET_INDICATORS.forEach(indicator => {
    if (description.includes(indicator)) {
      complexityScore += 1.5;
      matchedIndicators.push({ indicator, tier: 'sonnet' });
    }
  });

  OPUS_INDICATORS.forEach(indicator => {
    if (description.includes(indicator)) {
      complexityScore += 2.5;
      matchedIndicators.push({ indicator, tier: 'opus' });
    }
  });

  // Apply context-based complexity factors
  if (context.multiStep) complexityScore += COMPLEXITY_FACTORS.multiStep;
  if (context.requiresReasoning) complexityScore += COMPLEXITY_FACTORS.requiresReasoning;
  if (context.multiDomain) complexityScore += COMPLEXITY_FACTORS.multiDomain;
  if (context.edgeCase) complexityScore += COMPLEXITY_FACTORS.edgeCase;
  if (context.isUndefined || complexityScore < 1.5) complexityScore += COMPLEXITY_FACTORS.undefined;
  if (context.contextRequired) complexityScore += COMPLEXITY_FACTORS.contextRequired;
  if (context.timeConstraint === 'urgent') complexityScore += COMPLEXITY_FACTORS.timeConstraint;

  // Normalize complexity score
  const normalizedComplexity = Math.min(10, complexityScore);

  // Determine model tier based on complexity
  let model: ModelTier;
  let confidence: number;

  if (normalizedComplexity < 2) {
    model = 'haiku';
    confidence = 0.9;
  } else if (normalizedComplexity < 4) {
    model = 'haiku';
    confidence = 0.7;
  } else if (normalizedComplexity < 6) {
    model = 'sonnet';
    confidence = 0.8;
  } else if (normalizedComplexity < 8) {
    model = 'sonnet';
    confidence = 0.7;
  } else {
    model = 'opus';
    confidence = 0.85;
  }

  // Generate reasoning
  const reasons = [];
  if (matchedIndicators.length > 0) {
    const tierCounts: Record<string, number> = {};
    matchedIndicators.forEach(m => {
      tierCounts[m.tier] = (tierCounts[m.tier] || 0) + 1;
    });
    reasons.push(`Matched indicators: ${Object.entries(tierCounts).map(([t, c]) => `${c}x ${t}`).join(', ')}`);
  }
  reasons.push(`Complexity: ${normalizedComplexity.toFixed(2)}/10`);

  return {
    model,
    confidence,
    complexity: normalizedComplexity,
    reason: reasons.join(' | '),
    indicators: matchedIndicators.length > 0 ? matchedIndicators : undefined
  };
}

/**
 * Override classification based on confidence level.
 * If confidence is low, bump to next tier to avoid errors from underfitting.
 */
export function shouldOverrideWithComplexityBudget(classification: TaskClassification): ModelTier {
  if (classification.confidence < 0.6 && classification.model === 'haiku') {
    return 'sonnet';
  }
  if (classification.confidence < 0.65 && classification.model === 'sonnet') {
    return 'opus';
  }
  return classification.model;
}
