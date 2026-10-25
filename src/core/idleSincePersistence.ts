/**
 * Durable idle-clock seeding.
 *
 * `SessionManager.idlePromptSince` is an in-memory Map, so every server restart
 * resets each session's observed-idle clock to zero. A topic-bound session's
 * idle-kill threshold is 240 minutes (`IDLE_PROMPT_KILL_MINUTES_BOUND_TO_TOPIC`),
 * and an agent whose server restarts more often than that — auto-updates land
 * every ~30 minutes — can therefore NEVER accumulate enough observed idleness to
 * close an idle conversation. Sessions pile up until `maxSessions`, after which
 * every new conversation is refused with "Max sessions (N) reached".
 *
 * Observed live on the sagemind agent (2026-10-22): 20/20 sessions, 17 of them
 * idle at a prompt for 17-64 hours against the 240-minute limit, three server
 * restarts that day, and a refused spawn.
 *
 * The fix is to persist the idle-start instant on the session record and seed the
 * in-memory clock from it on the first idle observation after a restart. Because
 * a longer seeded clock makes a kill MORE likely, every uncertainty resolves to
 * "start the clock now" — exactly today's behaviour. This module is the pure
 * decision; SessionManager owns the I/O.
 */

/** What the caller knows when it is about to start a session's idle clock. */
export interface IdleSinceSeedInput {
  /** The persisted `session.idleSince` (ISO-8601), if the record carries one. */
  persistedIdleSince?: string;
  /**
   * Last-modified time of the session's framework transcript, in ms, or null when
   * it could not be read. The transcript grows on every turn/tool event, so a
   * mtime AFTER the persisted instant proves the session did work since then and
   * the persisted value is stale.
   */
  transcriptMtimeMs: number | null;
  /** Now, in ms. */
  now: number;
}

export type IdleSinceSeedReason =
  | 'no-persisted-value'
  | 'unparseable'
  | 'in-future'
  | 'transcript-advanced'
  | 'seeded';

export interface IdleSinceSeedVerdict {
  /**
   * The instant (ms) to seed the idle clock with, or null to use `now` — which
   * is the pre-existing behaviour and the safe direction (no kill brought
   * forward).
   */
  seedAtMs: number | null;
  reason: IdleSinceSeedReason;
}

/**
 * Decide whether a persisted idle-start instant may seed the idle clock.
 *
 * Fails toward `null` (= use `now`) on every doubt: a missing, unparseable or
 * future-dated value, and a transcript that advanced after the recorded instant.
 */
export function resolveIdleSinceSeed(input: IdleSinceSeedInput): IdleSinceSeedVerdict {
  const { persistedIdleSince, transcriptMtimeMs, now } = input;

  if (persistedIdleSince == null || persistedIdleSince === '') {
    return { seedAtMs: null, reason: 'no-persisted-value' };
  }

  const parsed = Date.parse(persistedIdleSince);
  if (!Number.isFinite(parsed)) {
    return { seedAtMs: null, reason: 'unparseable' };
  }

  if (parsed > now) {
    // A clock step (or a bad write) — never trust a future idle start.
    return { seedAtMs: null, reason: 'in-future' };
  }

  if (transcriptMtimeMs != null && transcriptMtimeMs > parsed) {
    // The session produced work after the recorded instant, so it was not idle
    // for that whole span. Start fresh rather than crediting idleness it did
    // not have.
    return { seedAtMs: null, reason: 'transcript-advanced' };
  }

  return { seedAtMs: parsed, reason: 'seeded' };
}
