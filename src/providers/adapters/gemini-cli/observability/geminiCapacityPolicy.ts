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

import { GEMINI_DEFAULT_MODEL, isKnownGeminiModel } from '../models.js';

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
const DEFAULT_UNKNOWN_RESET_MS = 15 * 60_000;
const RESET_GRACE_MS = 5_000;

let deferredUntil = 0;
let deferredReason: string | null = null;

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

export function decideGeminiCapacityPolicy(params: {
  errorMessage: string;
  attempt: number;
  model: string;
  config?: GeminiCapacityPolicyConfig;
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
  return {
    action: 'defer',
    retryAfterMs: deferMs,
    model,
    reason: `gemini capacity exhausted; deferring calls for ${deferMs}ms`,
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
  now?: number;
}): GeminiCapacityGate {
  const now = params.now ?? Date.now();
  deferredUntil = now + Math.max(1, params.retryAfterMs) + RESET_GRACE_MS;
  deferredReason = params.reason;
  return getGeminiCapacityGate(now);
}

export function resetGeminiCapacityPolicyForTests(): void {
  deferredUntil = 0;
  deferredReason = null;
}
