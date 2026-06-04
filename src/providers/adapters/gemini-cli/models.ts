/**
 * Model-tier resolution for gemini-cli.
 *
 * Maps the canonical ModelTier ('fast' | 'balanced' | 'capable') onto a
 * concrete Gemini model name. Gemini CLI selects the model via `-m <name>`.
 *
 * Verified facts (apprenticeship Step 2, gemini CLI v0.25.2, authed via
 * `~/.gemini` OAuth):
 *   - `gemini -m gemini-2.5-flash "<prompt>"` → clean stdout, exit 0. This
 *     is the verified-working default and the `fast`/`balanced` tier.
 *   - `gemini-2.5-pro` is the capable/heavy tier (the `route.ts` KNOWN_MODELS
 *     list already names it). It is NOT re-probed here — the exact ids beyond
 *     the verified `gemini-2.5-flash` are a §6 build-time discovery item, kept
 *     in sync with `resolveModelForFramework('gemini-cli', …)`.
 *
 * Drift risk: model availability changes per Gemini version. This map is a
 * Rule-3 surface; the authoritative-name check belongs in a dedicated canary
 * (a §6 conditional, added when the model surface is characterized).
 */

import type { ModelTier } from '../../types.js';

export const KNOWN_GEMINI_MODELS = [
  'gemini-2.5-flash',
  'gemini-2.5-pro',
] as const;

export type KnownGeminiModel = typeof KNOWN_GEMINI_MODELS[number];

export function isKnownGeminiModel(model: string | undefined): model is KnownGeminiModel {
  return typeof model === 'string' && (KNOWN_GEMINI_MODELS as readonly string[]).includes(model);
}

const TIER_TO_MODEL: Record<ModelTier, KnownGeminiModel> = {
  // light/fast — the verified-working one-shot default.
  fast: 'gemini-2.5-flash',
  // medium — balanced; same flash model (verified one-shot path).
  balanced: 'gemini-2.5-flash',
  // heavy — frontier; the pro tier for hard problems + main chat.
  capable: 'gemini-2.5-pro',
};

/** The default model when no tier or id is supplied. */
export const GEMINI_DEFAULT_MODEL: KnownGeminiModel = 'gemini-2.5-flash';

/**
 * Resolve a tier or raw model string to a concrete model name to pass to the
 * gemini CLI's `-m` flag. Explicit caller model ids pass through; automatic
 * fallback selection is constrained separately by resolveKnownGeminiFallback.
 */
export function resolveCliModelFlag(tierOrModel: string | ModelTier | undefined): string {
  if (!tierOrModel) return GEMINI_DEFAULT_MODEL;
  if (tierOrModel in TIER_TO_MODEL) {
    return TIER_TO_MODEL[tierOrModel as ModelTier];
  }
  return tierOrModel;
}
