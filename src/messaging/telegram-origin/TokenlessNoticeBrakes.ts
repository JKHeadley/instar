/**
 * TokenlessNoticeBrakes — the pure brakes behind the self-triggered notices a token-less
 * standby emits (standby-durable-forward-without-token §2, §8, §9). Production and the
 * convergence models in src/testing/selfActionRegistry.ts share these functions, so the
 * ratchet proves the same brake that ships.
 */

/** Waits between re-post attempts of one attention item after a failed attempt. */
export const HUB_REPOST_BACKOFF_MS: readonly number[] = Object.freeze([60_000, 5 * 60_000, 30 * 60_000, 2 * 60 * 60_000]);
/** Failed re-post attempts after which an item is dropped from the re-post list. It stays
 * open on the dashboard; only the extra hub post is given up. */
export const HUB_REPOST_MAX_ATTEMPTS = 8;

export interface HubRepostState { attempts: number; lastAt: number }

/**
 * Whether one pending hub re-post may be tried now. `undefined` state means it was never
 * tried. After a failure it waits along HUB_REPOST_BACKOFF_MS (the last step repeats), and
 * after HUB_REPOST_MAX_ATTEMPTS failures it is given up.
 */
export function hubRepostDecision(state: HubRepostState | undefined, now: number): 'due' | 'wait' | 'give-up' {
  if (!state || state.attempts <= 0) return 'due';
  if (state.attempts >= HUB_REPOST_MAX_ATTEMPTS) return 'give-up';
  const wait = HUB_REPOST_BACKOFF_MS[Math.min(state.attempts - 1, HUB_REPOST_BACKOFF_MS.length - 1)];
  return now - state.lastAt >= wait ? 'due' : 'wait';
}

/**
 * The account-changed item (§2): one item per (sealed, live) bot pair, re-raised only when a
 * NEW topic joins it. Returns true when `topic` is new for `key` (and records it).
 */
export function noteAccountChangedTopic(listed: Map<string, Set<string>>, key: string, topic: string): boolean {
  const topics = listed.get(key) ?? new Set<string>();
  if (topics.has(topic)) return false;
  topics.add(topic);
  listed.set(key, topics);
  return true;
}

/** An expired forward is reported until its durable `expiryReportedAt` marker is written. */
export function heldExpiryReportDue(row: { state: string; expiryReportedAt: number | null }): boolean {
  return row.state === 'expired' && row.expiryReportedAt === null;
}
