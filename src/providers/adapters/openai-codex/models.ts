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
 * ⚠ RE-PROBED AGAIN 2026-06-03 (live, against Justin's ChatGPT subscription;
 * triggered by codey's CommitmentSentinel failing fleet-wide). OpenAI has
 * since RETIRED gpt-5.2 from the ChatGPT-account Codex surface — it now 400s:
 *   "The 'gpt-5.2' model is not supported when using Codex with a ChatGPT account."
 * This silently broke EVERY cheap (`fast`-tier) internal codex call — gates,
 * tone-gate, classification, CommitmentSentinel — on every codex agent, since
 * `fast` was hardcoded to gpt-5.2 below.
 *   ✅ still working 2026-06-03: gpt-5.4, gpt-5.4-mini   (both replied to a trivial probe)
 *   ❌ now rejected 2026-06-03:  gpt-5.2                 (the change since 2026-05-23)
 * gpt-5.2 was the ONLY non-reasoning model. With it gone there is no longer a
 * cheap non-reasoning option, so `fast` is moved to the cheapest model still
 * accepted — gpt-5.4-mini (already the `balanced` choice). Consequence: `fast`
 * now equals `balanced`, and cheap-call token burn rises (a reasoning model
 * burns ~50–70x more than the old gpt-5.2 on a trivial prompt). This is an
 * unavoidable cost regression — a working model beats a 400-ing one — but it
 * is worth surfacing for the codex rate-limit picture (cf the self-inflicted
 * cheap-call 429 volume). The structural fix (validate the resolved model
 * against a known-good set + auto-fall-back on a "not supported" 400, so the
 * NEXT retirement self-heals instead of breaking the fleet) is a follow-up —
 * see the Drift-risk note below; this change just stops the active bleeding.
 *
 * TOKEN-BURN observation (same trivial "reply OK" prompt, 2026-05-23):
 *   gpt-5.2 = 103 tokens · gpt-5.3-codex = 5,574 · gpt-5.5 = 7,399.
 *   The reasoning models (5.3-codex, 5.5) burn ~50-70x more than gpt-5.2
 *   even on a trivial prompt (reasoning overhead). gpt-5.2 was the cheap
 *   non-reasoning workhorse for the `fast` tier — now retired (see the
 *   2026-06-03 note above), so the cost advantage is gone fleet-wide.
 *
 * Default tier choices below favor the subscription path. The light/medium/
 * heavy mapping was confirmed by Justin on 2026-05-23 after deep research into
 * how the ChatGPT subscription meters usage (token-weighted credits in a 5h +
 * weekly window — so token-burn IS the right metric, not just an API proxy):
 *   - fast:     gpt-5.4-mini (was gpt-5.2 until its 2026-06-03 retirement; now
 *                the cheapest model still accepted on the ChatGPT account. NOTE:
 *                this is a *reasoning* model — the old non-reasoning cheap path
 *                is gone, so fast == balanced until a cheaper working model
 *                appears or the drift-resilient fallback lands.)
 *   - balanced: gpt-5.4-mini (MEDIUM — the cheapest *reasoning* model; a
 *                small worker gear for real-but-light work, e.g. searching a
 *                codebase or skimming a file. Confirmed working on the
 *                ChatGPT subscription, live-tested 2026-05-23 and 2026-06-03.)
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
 * models at the same effort.
 *
 * Callers on the API-key path can override these per-call to access the
 * full model surface (gpt-5-codex, etc.) by passing a raw model name
 * instead of a tier.
 *
 * Drift risk: model availability changes regularly (the gpt-5.2 retirement on
 * 2026-06-03 is the second such break after the 2026-04-14 `-codex` retirement).
 * This map is a Rule-3 surface and the codex event-normalizer canary catches the
 * resulting upstream errors (auth-classified error events), but the authoritative
 * fix — validate the resolved name against a known-good set and auto-fall-back on
 * a "not supported" 400 so a retirement self-heals — belongs in a dedicated
 * canary/fallback. Follow-up (the structural companion to this stop-the-bleeding
 * re-point).
 */
const TIER_TO_MODEL: Record<ModelTier, string> = {
  // fast — cheapest model accepted on the ChatGPT account. Was non-reasoning
  // gpt-5.2 until OpenAI retired it (2026-06-03, see header); gpt-5.2 now 400s
  // and broke every cheap codex call. No non-reasoning option remains, so this
  // is gpt-5.4-mini (== balanced) — a reasoning model, raising cheap-call burn,
  // but a working model beats a rejected one.
  fast: 'gpt-5.4-mini',
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
