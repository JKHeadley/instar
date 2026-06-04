/**
 * Gemini capacity policy.
 *
 * Gemini CLI quota failures expose reset windows in stderr (for example,
 * "quota will reset after 7h32m28s"). Without a provider-specific policy the
 * next call just spawns Gemini again, hits the same 429/QUOTA_EXHAUSTED, and
 * appears stalled. This module keeps the policy small and explicit:
 *
 * - short capacity blips can retry once after a bounded backoff;
 * - quota windows with a reset hint are deferred until that window has passed;
 * - later calls are refused locally while deferred, avoiding doomed subprocesses;
 * - fallback models must be in the verified Gemini model set.
 */

import { GEMINI_DEFAULT_MODEL, isKnownGeminiModel, KNOWN_GEMINI_MODELS } from '../models.js';
import fs from 'node:fs';
import path from 'node:path';
import { SafeFsExecutor } from '../../../../core/SafeFsExecutor.js';

export interface GeminiCapacityPolicyConfig {
  enabled?: boolean;
  /** Number of immediate retries for short capacity windows. Default 1. */
  maxImmediateRetries?: number;
  /** Retry immediately only when the parsed reset is at/below this. Default 30s. */
  immediateRetryMaxMs?: number;
  /** Backoff used when retrying and no shorter reset hint exists. Default 5s. */
  backoffMs?: number;
  /** Optional operator-selected fallback. Ignored unless it is a known Gemini model. */
  fallbackModel?: string;
  /**
   * Optional quota-state output path. When set, long Gemini capacity deferrals
   * are written as stop-state snapshots so the existing quota gate blocks
   * doomed scheduler spawns until the CLI-reported reset window passes.
   */
  quotaStateFile?: string;
}

export type GeminiCapacityAction = 'none' | 'retry' | 'defer';

export interface GeminiCapacityDecision {
  action: GeminiCapacityAction;
  retryAfterMs?: number;
  model: string;
  reason: string | null;
}

export interface GeminiCapacityGate {
  allow: boolean;
  retryAfterMs: number;
  deferredUntil: number | null;
  reason: string | null;
}

const DEFAULT_IMMEDIATE_RETRIES = 1;
const DEFAULT_IMMEDIATE_RETRY_MAX_MS = 30_000;
const DEFAULT_BACKOFF_MS = 5_000;
// Switching to a DIFFERENT model (separate quota) needs no real backoff — the
// wait the exhausted model wanted does not apply to the fresh one. Use a tiny
// delay only to avoid a tight loop in pathological cases.
const DEFAULT_MODEL_SWITCH_BACKOFF_MS = 250;
const DEFAULT_UNKNOWN_RESET_MS = 15 * 60_000;
const RESET_GRACE_MS = 5_000;

let deferredUntil = 0;
let deferredReason: string | null = null;

// Per-model exhaustion windows (model id → epoch ms its quota is expected to
// reset). The known Gemini models draw on SEPARATE quotas, so a single model
// exhausting is NOT an account-wide block: we record the exhausted model here
// and switch to a model with headroom before globally deferring. Time-based, so
// entries self-clear once a model's reported reset window has passed.
const modelExhaustedUntil = new Map<string, number>();

export function isGeminiCapacityError(message: string | null | undefined): boolean {
  if (!message) return false;
  const m = message.toLowerCase();
  return (
    /\b429\b/.test(m) ||
    m.includes('quota_exhausted') ||
    m.includes('terminalquotaerror') ||
    m.includes('resource_exhausted') ||
    /resource.?exhausted/.test(m) ||
    /rate.?limit/.test(m) ||
    m.includes('too many requests') ||
    /quota|usage.?limit|capacity/.test(m)
  );
}

export function parseGeminiRetryAfterMs(message: string | null | undefined): number | undefined {
  if (!message) return undefined;
  const m = message.toLowerCase();

  let match = /(?:reset|resets|retry|try again|retry-after|retry after)[^.\n]{0,40}?(?:after|in|:)?\s*(\d+(?:\.\d+)?)\s*h(?:ours?)?\s*(?:(\d+(?:\.\d+)?)\s*m(?:in(?:ute)?s?)?)?\s*(?:(\d+(?:\.\d+)?)\s*s(?:ec(?:ond)?s?)?)?/i.exec(m);
  if (match) {
    return toMs(Number(match[1]) * 3600 + Number(match[2] ?? 0) * 60 + Number(match[3] ?? 0));
  }

  match = /(?:reset|resets|retry|try again|retry-after|retry after)[^.\n]{0,40}?(?:after|in|:)?\s*(\d+(?:\.\d+)?)\s*m(?:in(?:ute)?s?)?\s*(?:(\d+(?:\.\d+)?)\s*s(?:ec(?:ond)?s?)?)?/i.exec(m);
  if (match) {
    return toMs(Number(match[1]) * 60 + Number(match[2] ?? 0));
  }

  match = /(?:reset|resets|retry|try again|retry-after|retry after)[^.\n]{0,40}?(?:after|in|:)?\s*(\d+(?:\.\d+)?)\s*s(?:ec(?:ond)?s?)?/i.exec(m);
  if (match) {
    return toMs(Number(match[1]));
  }

  return undefined;
}

function toMs(seconds: number): number | undefined {
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
  return Math.ceil(seconds * 1000);
}

export function resolveKnownGeminiFallback(
  requestedModel: string,
  config: GeminiCapacityPolicyConfig | undefined,
): string {
  const fallback = config?.fallbackModel;
  if (!fallback || !isKnownGeminiModel(fallback)) return requestedModel;
  return fallback;
}

/**
 * Pick a known Gemini model to switch to when `exhaustedModel` hit its capacity
 * limit. A candidate qualifies when it is (a) a known Gemini model, (b) not the
 * just-exhausted model, and (c) not itself inside a recorded exhaustion window
 * at `now`. Prefers an operator-configured fallback when it qualifies, otherwise
 * the first known model with headroom. Returns undefined when every known model
 * is exhausted — the genuine account-wide block case.
 */
export function pickGeminiFallbackModel(
  exhaustedModel: string,
  config: GeminiCapacityPolicyConfig | undefined,
  now: number,
): string | undefined {
  const hasHeadroom = (m: string | undefined): m is string =>
    !!m &&
    isKnownGeminiModel(m) &&
    m !== exhaustedModel &&
    (modelExhaustedUntil.get(m) ?? 0) <= now;
  if (hasHeadroom(config?.fallbackModel)) return config?.fallbackModel;
  for (const m of KNOWN_GEMINI_MODELS) {
    if (hasHeadroom(m)) return m;
  }
  return undefined;
}

export function decideGeminiCapacityPolicy(params: {
  errorMessage: string;
  attempt: number;
  model: string;
  config?: GeminiCapacityPolicyConfig;
  now?: number;
}): GeminiCapacityDecision {
  const { errorMessage, attempt, model, config } = params;
  if (config?.enabled === false || !isGeminiCapacityError(errorMessage)) {
    return { action: 'none', model, reason: null };
  }

  const retryAfterMs = parseGeminiRetryAfterMs(errorMessage);
  const maxImmediateRetries = config?.maxImmediateRetries ?? DEFAULT_IMMEDIATE_RETRIES;
  const immediateRetryMaxMs = config?.immediateRetryMaxMs ?? DEFAULT_IMMEDIATE_RETRY_MAX_MS;

  if (
    attempt < maxImmediateRetries &&
    (retryAfterMs === undefined || retryAfterMs <= immediateRetryMaxMs)
  ) {
    const wait = retryAfterMs ?? config?.backoffMs ?? DEFAULT_BACKOFF_MS;
    return {
      action: 'retry',
      retryAfterMs: wait,
      model: resolveKnownGeminiFallback(model, config),
      reason: `gemini capacity limit; retrying after ${wait}ms`,
    };
  }

  const deferMs = retryAfterMs ?? DEFAULT_UNKNOWN_RESET_MS;
  const now = params.now ?? Date.now();
  // Per-model exhaustion is NOT an account-wide block — the known Gemini models
  // (flash, pro) draw on SEPARATE quotas. Record this model's window, then switch
  // to a model with headroom before globally deferring. The switch also means we
  // do NOT write the global stop-state for a single-model exhaustion (the caller
  // only records a deferral on action:'defer'), which is what made instar report
  // a fully-available account as "blocked". Mirrors the codex auto-swap policy.
  modelExhaustedUntil.set(model, now + deferMs);
  const fallback = pickGeminiFallbackModel(model, config, now);
  if (fallback) {
    return {
      action: 'retry',
      retryAfterMs: DEFAULT_MODEL_SWITCH_BACKOFF_MS,
      model: fallback,
      reason: `gemini model ${model} exhausted; switching to ${fallback} (separate quota may have headroom)`,
    };
  }
  // Every known model is exhausted — a genuine account-wide block.
  return {
    action: 'defer',
    retryAfterMs: deferMs,
    model,
    reason: `gemini capacity exhausted on all known models; deferring calls for ${deferMs}ms`,
  };
}

export function getGeminiCapacityGate(now = Date.now()): GeminiCapacityGate {
  if (deferredUntil <= now) {
    return { allow: true, retryAfterMs: 0, deferredUntil: null, reason: null };
  }
  return {
    allow: false,
    retryAfterMs: deferredUntil - now,
    deferredUntil,
    reason: deferredReason,
  };
}

export function recordGeminiCapacityDeferral(params: {
  retryAfterMs: number;
  reason: string;
  model?: string;
  quotaStateFile?: string;
  now?: number;
}): GeminiCapacityGate {
  const now = params.now ?? Date.now();
  deferredUntil = now + Math.max(1, params.retryAfterMs) + RESET_GRACE_MS;
  deferredReason = params.reason;
  if (params.quotaStateFile) {
    try {
      writeGeminiQuotaState({
        quotaStateFile: params.quotaStateFile,
        blockedUntil: deferredUntil,
        reason: params.reason,
        model: params.model ?? GEMINI_DEFAULT_MODEL,
        now,
      });
    } catch (err) {
      console.warn(
        `[gemini-capacity-policy] failed to persist quota state: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
  return getGeminiCapacityGate(now);
}

function writeGeminiQuotaState(params: {
  quotaStateFile: string;
  blockedUntil: number;
  reason: string;
  model: string;
  now: number;
}): void {
  const state = {
    usagePercent: 0,
    fiveHourPercent: 100,
    source: 'gemini-cli-capacity',
    // 'account': this stop-state is only written once EVERY known model is
    // exhausted (the genuine account-wide block). A single model exhausting no
    // longer reaches here — the policy switches to a model with headroom first —
    // so a reader can trust `recommendation:'stop'` here means the agent really
    // is out of capacity, not just one model.
    scope: 'account',
    model: params.model,
    blockedUntil: new Date(params.blockedUntil).toISOString(),
    blockReason: params.reason,
    lastUpdated: new Date(params.now).toISOString(),
    recommendation: 'stop',
  };

  const dir = path.dirname(params.quotaStateFile);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${params.quotaStateFile}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, params.quotaStateFile);
  } catch (err) {
    try {
      SafeFsExecutor.safeUnlinkSync(tmp, {
        operation: 'geminiCapacityPolicy.writeGeminiQuotaState.cleanup',
      });
    } catch { /* best-effort cleanup */ }
    throw err;
  }
}

export function resetGeminiCapacityPolicyForTests(): void {
  deferredUntil = 0;
  deferredReason = null;
  modelExhaustedUntil.clear();
}
