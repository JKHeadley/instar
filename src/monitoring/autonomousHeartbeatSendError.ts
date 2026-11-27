/**
 * Send-failure description and classification for the autonomous-run heartbeat.
 *
 * Why this exists (maturation review 2026-11-27): the heartbeat's evidence rows
 * recorded only `err.name`. 100 of 107 failures on the fleet were a bare
 * `TypeError`, which is what `fetch()` throws when the local
 * POST /telegram/reply request itself breaks (connection refused/reset, header
 * timeout). The row could not say which, so the failure could not explain itself.
 *
 * - `AutonomousHeartbeatSendError` carries the HTTP status and the route's own
 *   short error text when the route answered but refused.
 * - `describeHeartbeatSendError` turns any thrown value into a short, scrubbed,
 *   bounded description for the evidence row (never the message body).
 * - `isHeartbeatTopicGone` says whether the refusal means the topic itself can no
 *   longer receive (deleted/closed thread, chat gone), so the heartbeat stops
 *   trying it instead of failing every tick.
 *
 * Pure, no I/O.
 */
import { scrubSecrets } from './scrubSecrets.js';

/** Longest description written to an evidence row. */
export const SEND_ERROR_DETAIL_MAX = 160;

export class AutonomousHeartbeatSendError extends Error {
  readonly status: number;
  readonly detail: string | null;
  constructor(status: number, detail: string | null) {
    super(`Autonomous-heartbeat reply failed: ${status}${detail ? ` (${detail})` : ''}`);
    this.name = 'AutonomousHeartbeatSendError';
    this.status = status;
    this.detail = detail;
  }
}

export interface HeartbeatSendErrorDescription {
  errorName: string;
  /** Scrubbed, single-line, at most SEND_ERROR_DETAIL_MAX chars. */
  errorMessage: string;
  /** Present when the reply route answered with a non-2xx status. */
  httpStatus?: number;
  /** Underlying system/undici code when fetch() itself failed (e.g. ECONNREFUSED). */
  causeCode?: string;
}

function clamp(text: string): string {
  const oneLine = scrubSecrets(text).replace(/\s+/g, ' ').trim();
  return oneLine.length > SEND_ERROR_DETAIL_MAX ? `${oneLine.slice(0, SEND_ERROR_DETAIL_MAX - 1)}…` : oneLine;
}

/** Pull the route's `error` (or `message`) string out of a JSON body, if any. */
export function extractRouteErrorDetail(bodyText: string): string | null {
  const raw = bodyText.trim();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { error?: unknown; message?: unknown };
    const v = typeof parsed.error === 'string' ? parsed.error : typeof parsed.message === 'string' ? parsed.message : null;
    return v ? clamp(v) : null;
  } catch {
    // @silent-fallback-ok: a non-JSON body is still useful evidence; keep its first line.
    return clamp(raw.split('\n')[0] ?? '');
  }
}

export function describeHeartbeatSendError(err: unknown): HeartbeatSendErrorDescription {
  if (err instanceof AutonomousHeartbeatSendError) {
    return { errorName: err.name, errorMessage: clamp(err.message), httpStatus: err.status };
  }
  if (err instanceof Error) {
    const cause = (err as { cause?: unknown }).cause as { code?: unknown; message?: unknown } | undefined;
    const causeCode = cause && typeof cause.code === 'string' ? cause.code : undefined;
    const causeMsg = cause && typeof cause.message === 'string' && cause.message !== err.message ? `: ${cause.message}` : '';
    return { errorName: err.name, errorMessage: clamp(`${err.message}${causeMsg}`), ...(causeCode ? { causeCode } : {}) };
  }
  return { errorName: 'unknown', errorMessage: clamp(String(err)) };
}

const TOPIC_GONE = /message thread not found|thread not found|topic[ _-]?deleted|topic[ _-]?closed|chat not found/i;

/**
 * True only when the reply route answered and its error says the topic can no
 * longer receive. Transport failures (no status) are never "gone": they are
 * retried later with spacing.
 */
export function isHeartbeatTopicGone(err: unknown): boolean {
  if (!(err instanceof AutonomousHeartbeatSendError)) return false;
  if (err.status < 400 || err.status === 409 || err.status === 429 || err.status === 503) return false;
  return TOPIC_GONE.test(err.detail ?? '');
}
