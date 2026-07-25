/** Deterministic UX assertions for Tier-3 user-surface tests. */
import type { Clock } from './clock.js';

const INTERNAL_ID = /\b(?:CMT|ACT|PR)[-_#]?\d+\b/i;
const FILE_PATH = /(?:^|\s)(?:\/|\.\.\/|src\/|tests\/)[^\s]+/;
const CONFIG_KEY = /\b[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*){2,}\b/;
const JARGON_CLASSES = [/\b(?:hydration|idempotency|backpressure|fan[- ]?out|reconciliation)\b/i];

function requireText(text: unknown, label: string): asserts text is string {
  if (typeof text !== 'string' || text.trim().length === 0) throw new Error(`${label} must be plain user-visible text`);
}

/** Reject internal identifiers, paths, config keys, and known implementation jargon. */
export function assertPlainEnglish(text: unknown): asserts text is string {
  requireText(text, 'text');
  if (INTERNAL_ID.test(text) || FILE_PATH.test(text) || CONFIG_KEY.test(text) || JARGON_CLASSES.some((p) => p.test(text))) {
    throw new Error('text contains implementation detail or jargon');
  }
}

/** Every failure must explain what happened and give the user a next action. */
export function assertHonestFailure(state: unknown): asserts state is { message: string; actionable: boolean } {
  if (!state || typeof state !== 'object') throw new Error('failure state is missing');
  const candidate = state as { message?: unknown; actionable?: unknown; ok?: unknown };
  requireText(candidate.message, 'failure message');
  if (candidate.ok === true) throw new Error('success state cannot be asserted as a failure');
  if (candidate.actionable !== true) throw new Error('failure message must include an actionable next step');
  assertPlainEnglish(candidate.message);
}

/** A queue must not contain an expired/stale entry that can be redelivered. */
export function assertNoZombie(queue: unknown): asserts queue is Array<Record<string, unknown>> {
  if (!Array.isArray(queue)) throw new Error('queue must be an array');
  for (const item of queue) {
    if (!item || typeof item !== 'object') throw new Error('queue contains an invalid entry');
    const row = item as { status?: unknown; expiresAt?: unknown; nextAttemptAt?: unknown; createdAt?: unknown };
    if (row.status === 'queued' && row.expiresAt && Date.parse(String(row.expiresAt)) <= Date.now()) {
      throw new Error('queue contains an expired queued entry');
    }
    if (row.status === 'queued' && row.nextAttemptAt && Date.parse(String(row.nextAttemptAt)) > Date.now()) continue;
    if (row.status === 'queued' && row.createdAt && Date.now() - Date.parse(String(row.createdAt)) > 24 * 60 * 60 * 1000) {
      throw new Error('queue contains a stale queued entry');
    }
  }
}

/** Assert that a visible event landed within its declared bound. */
export function assertTimely(events: unknown, boundMs: number, clock: Clock): void {
  if (!Array.isArray(events) || events.length === 0) throw new Error('timely response event is missing');
  if (!Number.isFinite(boundMs) || boundMs < 0) throw new Error('timely bound must be non-negative');
  if (!clock || typeof clock.now !== 'function') throw new Error('timely assertion requires an injected clock');
  const now = clock.now();
  const visible = events.find((event) => event && typeof event === 'object' && (event as { userVisible?: unknown }).userVisible !== false);
  if (!visible || typeof (visible as { startedAt?: unknown }).startedAt !== 'number' || typeof (visible as { at?: unknown }).at !== 'number') {
    throw new Error('timely response event is malformed');
  }
  const event = visible as { startedAt: number; at: number };
  if (event.at > now || event.at - event.startedAt > boundMs) throw new Error('user-visible response exceeded its time bound');
}
