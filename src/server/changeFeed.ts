/**
 * The change feed for Telegram and Slack history reads (docs/specs/telegram-slack-change-feed.md).
 *
 * A caller passes `after`: the time of the newest row it already holds. The read answers only the
 * rows logged at or after that time minus a lookback window. Row times are not strictly ordered
 * (machines and senders stamp them separately), so the window re-sends the last two minutes and the
 * caller de-duplicates by row id. A read-side filter only: it never widens what a caller may read.
 */

export const CHANGE_FEED_LOOKBACK_MS = 120_000;

export interface ChangeFeedAfter {
  /** The time the caller passed, in epoch milliseconds. */
  afterMs: number;
  /** `afterMs` minus the lookback: rows at or after this come back. */
  cutoffMs: number;
}

/**
 * Parses `after`: absent → null; an ISO time or epoch milliseconds → the window; anything else →
 * 'invalid' (the route answers 400).
 */
export function parseChangeFeedAfter(raw: unknown, opts: { allowEpochMs?: boolean } = {}): ChangeFeedAfter | null | 'invalid' {
  if (raw === undefined) return null;
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 64) return 'invalid';
  const allowEpoch = opts.allowEpochMs !== false;
  const afterMs = /^\d+$/.test(raw) ? (allowEpoch ? Number(raw) : NaN) : Date.parse(raw);
  if (!Number.isFinite(afterMs) || afterMs < 0) return 'invalid';
  return { afterMs, cutoffMs: afterMs - CHANGE_FEED_LOOKBACK_MS };
}

/** Whether a row's time is at or after the cutoff. A row with no readable time is kept (never silently dropped). */
export function atOrAfterCutoff(at: unknown, cutoffMs: number): boolean {
  const ms = typeof at === 'number' ? at : typeof at === 'string' ? Date.parse(at) : NaN;
  return !Number.isFinite(ms) || ms >= cutoffMs;
}

/** The `changeFeed` field an answer carries, so a caller can tell the server honoured `after`. */
export function changeFeedEcho(feed: ChangeFeedAfter): { since: string; lookbackMs: number } {
  return { since: new Date(Math.max(0, feed.cutoffMs)).toISOString(), lookbackMs: CHANGE_FEED_LOOKBACK_MS };
}
