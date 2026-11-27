/**
 * llmErrorClass — a fixed, content-free label for a failed LLM provider call.
 *
 * Fleet reports (CMT-2289) showed PromptGate and UnjustifiedStopGate failing
 * on 100% of calls on several agents with the cause recorded nowhere: the
 * feature-metrics row said only `outcome: 'error'` and PromptGate swallowed
 * the throw. This classifier turns the thrown error into ONE value from a
 * closed set so the metrics row and any degradation report can say WHY a call
 * failed — without ever storing the error message, CLI stderr or prompt text
 * (they can carry prompt content, paths or sign-in detail).
 *
 * Pure and total: it never throws, and an unrecognised error is `other`.
 * Order matters — the most specific signal wins (a rate-limit message that
 * also says "Command failed" is `rate-limit`, not `cli-exit`).
 */

import { classifyRateLimit, RateLimitError } from './LlmCircuitBreaker.js';

export const LLM_ERROR_CLASSES = [
  'rate-limit',
  'capacity',
  'auth',
  'timeout',
  'max-turns',
  'spawn-error',
  'no-route',
  'parse',
  'cli-exit',
  'other',
] as const;

export type LlmErrorClass = (typeof LLM_ERROR_CLASSES)[number];

const CLASS_SET: ReadonlySet<string> = new Set(LLM_ERROR_CLASSES);

/** True when `value` is one of the closed-set labels (used to clamp stored values). */
export function isLlmErrorClass(value: unknown): value is LlmErrorClass {
  return typeof value === 'string' && CLASS_SET.has(value);
}

function messageOf(err: unknown): string {
  try {
    if (err instanceof Error) return `${err.name ?? ''} ${err.message ?? ''}`;
    return typeof err === 'string' ? err : '';
  } catch {
    // @silent-fallback-ok: a hostile getter must not make classification throw; it falls to 'other'.
    return '';
  }
}

/** Classify a thrown provider error into a fixed label. Never returns message text. */
export function classifyLlmError(err: unknown): LlmErrorClass {
  try {
    if (err instanceof RateLimitError) return 'rate-limit';
    const anyErr = err as { capacityUnavailable?: unknown; code?: unknown; killed?: unknown; signal?: unknown; name?: unknown } | null;
    // Structured signals first: they cannot be faked by prompt text echoed into a message.
    if (anyErr && typeof anyErr === 'object' && anyErr.capacityUnavailable === true) return 'capacity';
    if (anyErr && typeof anyErr === 'object' && (anyErr.name === 'AbortError' || anyErr.name === 'TimeoutError')) return 'timeout';
    if (anyErr && typeof anyErr === 'object' && anyErr.killed === true) return 'timeout';
    if (anyErr && typeof anyErr === 'object' && anyErr.name === 'SyntaxError') return 'parse';
    // Message shape last. A CLI error message can echo the command line (and so part of
    // the prompt), so a prompt word can occasionally pick the wrong label. The label is a
    // signal: it is stored and reported, and PromptGate uses it only to choose between its
    // 1-minute and 5-minute re-check backoff caps; it never blocks an action or a message.
    const msg = messageOf(err);
    if (classifyRateLimit(msg).isLimit) return 'rate-limit';
    if (/spawn capacity unavailable|capacity unavailable|concurrent-spawn cap|waiters-full|acquire-timeout/i.test(msg)) return 'capacity';
    if (/\bauth: |not logged in|please run \/login|invalid api key|authentication|unauthori[sz]ed|\b401\b|oauth token|credentials? (?:missing|expired|invalid)|subscription account missing/i.test(msg)) return 'auth';
    if (/\btimed? ?out\b|\btimeout\b|ETIMEDOUT|\bSIGTERM\b/i.test(msg)) return 'timeout';
    if (/max[_ -]?turns/i.test(msg)) return 'max-turns';
    if (/\bENOENT\b|\bEACCES\b|\bE2BIG\b|argument list too long|spawn .* (?:failed|error)|\bspawn\b.*\bENO/i.test(msg)) return 'spawn-error';
    if (/IntelligenceRouter: .*(?:unavailable|unverified|invalid required route)|launch guard refused|ClaudeForbidden|forbidden on this agent|no (?:provider|route|framework) (?:available|configured)/i.test(msg)) return 'no-route';
    if (/\bJSON\b|unexpected token|unexpected end of|empty completion|parse/i.test(msg)) return 'parse';
    if (/command failed|exit(?:ed)? (?:code|with)|non-zero exit|CLI error/i.test(msg)) return 'cli-exit';
    return 'other';
  } catch {
    // @silent-fallback-ok: classification is observability only; it must never throw into the failure path it labels.
    return 'other';
  }
}
