/**
 * Model-tier resolution for openai-codex.
 *
 * Maps the canonical ModelTier ('fast' | 'balanced' | 'capable') onto a
 * concrete OpenAI/Codex model name. Per the deep-dive (02-codex-deep-
 * dive.md), Codex uses `--model <name>` to select. ChatGPT-subscription
 * auth restricts available models; OPENAI_API_KEY mode opens the full
 * surface.
 */

import type { ModelTier } from '../../types.js';

/**
 * Default tier-to-name map. Callers can override per-call via
 * OneShotCompletionOptions.model or AgenticSessionHeadlessOptions.model
 * (which accepts either a tier name or a raw model name).
 *
 * Model availability on the ChatGPT subscription auth path differs from
 * OPENAI_API_KEY auth. Per OpenAI Community thread 1378986 (referenced
 * 2026-05-15), several `-codex` suffixed model names were retired from
 * ChatGPT accounts on 2026-04-14 and are API-only now. Empirically
 * probed 2026-05-15 against Justin's ChatGPT Plus subscription via
 * codex-cli 0.130.0:
 *
 *   ✅ working on ChatGPT account:  gpt-5.2, gpt-5.3-codex, gpt-5.4
 *   ❌ rejected on ChatGPT account: gpt-5, gpt-5-codex, gpt-5.2-codex
 *                                   (Codex CLI's default), gpt-5.3, gpt-5.4-codex
 *
 * Default tier choices below favor the subscription path:
 *   - fast:     gpt-5.2 (cheapest working, plain ChatGPT model)
 *   - balanced: gpt-5.3-codex (coding-specialist tier)
 *   - capable:  gpt-5.4 (most powerful; burns ~20x more quota per
 *                forum reports, use sparingly)
 *
 * Callers on the API-key path can override these per-call to access the
 * full model surface (gpt-5-codex, etc.) by passing a raw model name
 * instead of a tier.
 *
 * Drift risk: model availability changes regularly. This map is a
 * Rule-3 surface and the codex event-normalizer canary catches the
 * resulting upstream errors (auth-classified error events), but the
 * authoritative-name check belongs in a dedicated canary — Phase 5
 * follow-up.
 */
const TIER_TO_MODEL: Record<ModelTier, string> = {
  fast: 'gpt-5.2',
  balanced: 'gpt-5.3-codex',
  capable: 'gpt-5.4',
};

/**
 * Resolve a tier or raw model string to a concrete model name to pass to
 * the codex CLI. If `tierOrModel` doesn't match a known tier, it's
 * returned verbatim (treated as a raw model name).
 */
export function resolveCliModelFlag(tierOrModel: string | ModelTier | undefined): string {
  if (!tierOrModel) return TIER_TO_MODEL.balanced;
  if (tierOrModel in TIER_TO_MODEL) {
    return TIER_TO_MODEL[tierOrModel as ModelTier];
  }
  return tierOrModel;
}
