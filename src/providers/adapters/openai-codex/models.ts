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
 * ChatGPT accounts on 2026-04-14 and are API-only now.
 *
 * RE-PROBED 2026-05-23 against Justin's ChatGPT subscription via
 * codex-cli 0.133.0 (live, during the codex test harness):
 *
 *   ✅ working on ChatGPT account:  gpt-5.2, gpt-5.3-codex, gpt-5.4, gpt-5.4-mini, gpt-5.5
 *   ❌ rejected on ChatGPT account: gpt-5.5-codex, gpt-5.4-codex
 *                                   ("not supported when using Codex with a
 *                                   ChatGPT account"), and the older
 *                                   gpt-5, gpt-5-codex, gpt-5.2-codex, gpt-5.3.
 *   Pattern holds: plain gpt-5.x models work; `-codex` suffix is API-only
 *   EXCEPT the grandfathered gpt-5.3-codex.
 *
 * TOKEN-BURN observation (same trivial "reply OK" prompt, 2026-05-23):
 *   gpt-5.2 = 103 tokens · gpt-5.3-codex = 5,574 · gpt-5.5 = 7,399.
 *   The reasoning models (5.3-codex, 5.5) burn ~50-70x more than gpt-5.2
 *   even on a trivial prompt (reasoning overhead). This is why the `fast`
 *   tier — used by cheap internal calls (gates, tone-gate, classification)
 *   — MUST stay on gpt-5.2: routing those through a reasoning model would
 *   torch quota. The reasoning burn is only worth it for real session work.
 *
 * Default tier choices below favor the subscription path. The light/medium/
 * heavy mapping was confirmed by Justin on 2026-05-23 after deep research into
 * how the ChatGPT subscription meters usage (token-weighted credits in a 5h +
 * weekly window — so token-burn IS the right metric, not just an API proxy):
 *   - fast:     gpt-5.2 (LIGHT — non-reasoning, answers directly with ~0
 *                thinking tokens; cheapest working model; keep for all cheap
 *                internal LLM calls — gates, tone, classification. ~50-70x
 *                cheaper than the reasoning models even on a trivial prompt.
 *                Use the BASE gpt-5.2, NOT gpt-5.2-codex — the latter is a
 *                reasoning model and loses the non-reasoning cost advantage.)
 *   - balanced: gpt-5.4-mini (MEDIUM — the cheapest *reasoning* model; a
 *                small worker gear for real-but-light work, e.g. searching a
 *                codebase or skimming a file. "mini" = small *within the
 *                reasoning tier*, not lighter than non-reasoning gpt-5.2 — it
 *                still emits reasoning tokens on trivial prompts, so it is the
 *                WRONG choice for the fast tier. Confirmed working on the
 *                ChatGPT subscription, live-tested 2026-05-23.)
 *   - capable:  gpt-5.5 (HEAVY — newest frontier reasoning model + Codex CLI's
 *                own default; the main interactive session resolves here.
 *                Reserve for hard problems + the user's main chat.)
 *
 * Reasoning effort (model_reasoning_effort): low | medium | high | xhigh.
 * 'minimal' is GPT-5-only (errors on gpt-5.5). Empirically, on a TRIVIAL
 * prompt the effort levels barely differ (low=7.4k, medium=8.9k, high=7.4k
 * tokens) because the cost is dominated by Codex CLI's fixed per-invocation
 * overhead (see openai/codex#19996), not reasoning — the effort delta only
 * shows on complex tasks. codey's ~/.codex/config.toml sets medium (OpenAI's
 * recommended default); gpt-5.5 also uses fewer reasoning tokens than prior
 * models at the same effort. The real cheap-call quota win is the fast tier
 * (gpt-5.2), not turning reasoning down on a heavyweight model.
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
  // light — non-reasoning, ~0 thinking tokens; all cheap internal calls.
  fast: 'gpt-5.2',
  // medium — cheapest reasoning model; everyday light work / worker subagents.
  balanced: 'gpt-5.4-mini',
  // heavy — frontier reasoning model; hard problems + the user's main chat.
  capable: 'gpt-5.5',
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
