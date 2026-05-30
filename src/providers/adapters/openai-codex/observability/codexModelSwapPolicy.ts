/**
 * Codex rate-limit model-swap policy.
 *
 * Justin's ask (2026-05-30): "swap to GPT-5.3-Codex-Spark when the other usage
 * hits the limit." Codex's primary model (e.g. gpt-5.5) and a fallback like
 * Codex-Spark draw on SEPARATE account quota buckets, so when the main model's
 * weekly window is exhausted, launching the next session on the fallback keeps
 * the agent working instead of stalling on a depleted window.
 *
 * This module is the DECISION; it holds no authority of its own. The pure
 * `resolveCodexLaunchModel` takes a usage snapshot (from `readLatestCodexUsage`,
 * the authoritative on-disk rate-limit reader) and the operator config and
 * returns which model the NEXT codex session should launch with. A running
 * session can't change model mid-turn, so the swap naturally applies at launch.
 *
 * Safe-by-default: ships DARK. With `enabled` false (the default) or no
 * `fallbackModel` set, it is a no-op and adds zero overhead to the spawn path.
 * The fallback model id is OPERATOR CONFIG — never hardcoded — because the exact
 * Codex-Spark `--model` string + its subscription availability is the account
 * owner's to confirm (it is not in instar's probed model list).
 *
 * RULE 3.1 RATIONALE
 *   Criticality: medium (cost-routing; never blocks a launch)
 *   Frequency:   per codex session launch, only when enabled
 *   Stability:   stable (pure decision over a structured snapshot)
 *   Fallback:    no swap (launch with the requested model) on any uncertainty
 *   Verdict:     pure policy + best-effort usage read; unit-tested both sides
 */

import type { CodexUsageSnapshot } from './codexRateLimitReader.js';
import { readLatestCodexUsage } from './codexRateLimitReader.js';

/** Operator config for the swap, read from `.instar/config.json` → codex.rateLimitModelSwap. */
export interface CodexModelSwapConfig {
  /** Master switch. Default false — the feature ships dark. */
  enabled?: boolean;
  /**
   * The model to launch on when the main model's window is exhausted (e.g. the
   * Codex-Spark model id). REQUIRED to swap — no default, because the exact id +
   * subscription availability is the account owner's to confirm.
   */
  fallbackModel?: string;
  /**
   * Swap when the weekly (secondary) window's remaining percent is at or below
   * this. Default 10. The authoritative `rate_limit_reached_type` flag also
   * triggers a swap regardless of this threshold.
   */
  weeklyRemainingThreshold?: number;
}

export interface CodexModelSwapDecision {
  /** The model the session should launch with (the request, unchanged, or the fallback). */
  model: string | undefined;
  /** True only when the policy actually substituted the fallback. */
  swapped: boolean;
  /** Human-readable reason when swapped, else null. */
  reason: string | null;
}

export const DEFAULT_WEEKLY_REMAINING_THRESHOLD = 10;

/**
 * Pure decision: given the framework, the requested model, the operator config,
 * and the current codex usage snapshot, return which model to launch with.
 * Never throws. Returns the requested model unchanged on any reason not to swap.
 */
export function resolveCodexLaunchModel(params: {
  framework: string;
  requestedModel: string | undefined;
  config: CodexModelSwapConfig | undefined;
  usage: CodexUsageSnapshot | null;
}): CodexModelSwapDecision {
  const { framework, requestedModel, config, usage } = params;
  const noSwap: CodexModelSwapDecision = { model: requestedModel, swapped: false, reason: null };

  if (framework !== 'codex-cli') return noSwap;
  if (!config?.enabled) return noSwap;
  const fallback = config.fallbackModel;
  if (!fallback) return noSwap; // nothing to swap to — operator hasn't set the id
  // Already on the fallback → don't re-swap (no-op / avoids a confusing log).
  if (requestedModel && requestedModel === fallback) return noSwap;
  if (!usage) return noSwap; // couldn't read usage → conservative: launch as requested

  const threshold = config.weeklyRemainingThreshold ?? DEFAULT_WEEKLY_REMAINING_THRESHOLD;
  const reached = usage.rateLimitReachedType; // authoritative "a window is hit NOW"
  const weeklyRemaining = usage.secondary?.remainingPercent;

  const reachedHit = reached !== null && reached !== undefined;
  const weeklyLow = typeof weeklyRemaining === 'number' && weeklyRemaining <= threshold;
  if (!reachedHit && !weeklyLow) return noSwap;

  return {
    model: fallback,
    swapped: true,
    reason: reachedHit
      ? `codex rate_limit_reached_type=${reached}; swapping launch model to ${fallback}`
      : `codex weekly window at ${weeklyRemaining}% remaining (<= ${threshold}%); swapping launch model to ${fallback}`,
  };
}

/**
 * Best-effort async wrapper used on the spawn path. Reads the current codex
 * usage (only when the feature is enabled — disabled = zero disk I/O) and
 * applies {@link resolveCodexLaunchModel}. NEVER throws and NEVER blocks a
 * launch: any read failure resolves to "no swap" (launch with the requested
 * model). `readUsage` is injectable for tests.
 */
export async function resolveCodexLaunchModelWithUsage(params: {
  framework: string;
  requestedModel: string | undefined;
  config: CodexModelSwapConfig | undefined;
  codexHome?: string;
  readUsage?: (opts: { codexHome?: string }) => Promise<CodexUsageSnapshot | null>;
}): Promise<CodexModelSwapDecision> {
  const { framework, requestedModel, config, codexHome } = params;
  const noSwap: CodexModelSwapDecision = { model: requestedModel, swapped: false, reason: null };

  // Fast paths that avoid any disk read when the feature can't act.
  if (framework !== 'codex-cli') return noSwap;
  if (!config?.enabled || !config.fallbackModel) return noSwap;
  if (requestedModel && requestedModel === config.fallbackModel) return noSwap;

  const read = params.readUsage ?? readLatestCodexUsage;
  let usage: CodexUsageSnapshot | null = null;
  try {
    usage = await read({ codexHome });
  } catch {
    return noSwap; // best-effort: never block a launch on a usage read
  }
  return resolveCodexLaunchModel({ framework, requestedModel, config, usage });
}
