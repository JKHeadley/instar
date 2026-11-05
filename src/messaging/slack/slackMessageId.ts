/**
 * Slack message-id derivation for numeric message stores.
 *
 * Slack identifies a message by its `ts` — a string like "1730000000.123456":
 * whole seconds since the epoch, a dot, then six digits of sub-second
 * resolution. Slack guarantees `ts` is unique within a channel, and it sorts in
 * send order.
 *
 * TopicMemory stores `message_id` as an INTEGER under
 * UNIQUE(message_id, topic_id), so a Slack `ts` has to become a number before
 * it can be stored. The dual-write this module replaces coerced every
 * non-number to 0, so every Slack message in a channel collided on
 * (0, topic_id) and `INSERT OR IGNORE` dropped all but the first — permanently,
 * with no replay source.
 *
 * Microseconds are the right unit for three reasons:
 *   1. UNIQUE — one id per Slack message, because `ts` is unique per channel.
 *   2. ORDERED — `getMessagesSinceSummary` selects `WHERE message_id > ?`, so
 *      ids must increase with send order. A hash would satisfy uniqueness and
 *      silently break incremental summarisation.
 *   3. EXACT — a microsecond id stays an exact integer in a float64 (and so in
 *      SQLite's INTEGER) for every `ts` up to the year 2255.
 *
 * Derivation is pure: the same message always yields the same id, which is what
 * keeps `INSERT OR IGNORE` idempotent across restarts and JSONL re-imports.
 */

const MICROS_PER_SECOND = 1_000_000;
const SUBSECOND_DIGITS = 6;

/** Slack `ts` shape: whole seconds, optionally a dot and sub-second digits. */
const SLACK_TS_RE = /^(\d+)(?:\.(\d+))?$/;

/**
 * Largest `ts` (in whole seconds) whose microsecond form is still an exact
 * integer in a float64 *including its sub-second part*. Beyond this, arithmetic
 * would silently round and two distinct messages could share an id — so we
 * refuse instead.
 *
 * The worst case is `.999999`, so the headroom subtracted here is one full
 * second of microseconds, not none: `floor(MAX_SAFE_INTEGER / 1e6)` would admit
 * a `ts` whose microsecond form overflows. Lands in the year 2255.
 */
export const MAX_EXACT_TS_SECONDS = Math.floor(
  (Number.MAX_SAFE_INTEGER - (MICROS_PER_SECOND - 1)) / MICROS_PER_SECOND,
);

/**
 * Convert a Slack `ts` string to an exact microsecond integer.
 *
 * Returns `null` when `ts` is not a Slack timestamp, or is far enough in the
 * future that the result would not be exact. Never throws.
 *
 * Both halves are parsed as integers and combined with integer arithmetic —
 * `parseFloat(ts) * 1e6` would round, because "1730000000.123456" has no exact
 * float64 representation.
 */
export function slackTsToMessageId(ts: string): number | null {
  const match = SLACK_TS_RE.exec(ts.trim());
  if (!match) return null;

  const seconds = Number(match[1]);
  if (!Number.isSafeInteger(seconds) || seconds > MAX_EXACT_TS_SECONDS) return null;

  // Pad a short fraction ("1730000000.5" -> 500000) and ignore digits finer
  // than Slack's six, so the unit is always microseconds.
  const micros = Number((match[2] ?? '').padEnd(SUBSECOND_DIGITS, '0').slice(0, SUBSECOND_DIGITS));

  const id = seconds * MICROS_PER_SECOND + micros;
  // Checked on the result, not only on `seconds`: a bound on the input is an
  // off-by-one away from admitting a value that rounds, and a rounded id is a
  // silent collision. This is the assertion that cannot be off by one.
  return Number.isSafeInteger(id) ? id : null;
}

/** The fields of a logged Slack message this derivation can read. */
export interface SlackMessageIdSource {
  messageId: number | string;
  /** ISO timestamp the logger stamps on every entry; used only as a fallback. */
  timestamp?: string;
}

/**
 * Derive the numeric `message_id` for a logged Slack message.
 *
 * Order of preference:
 *   1. An already-numeric `messageId` is passed through. `LogEntry.messageId`
 *      is `number | string`; the Slack adapter only ever sets a `ts` string, so
 *      this branch is defensive rather than a live path.
 *   2. `messageId` parsed as a Slack `ts` — the normal case.
 *   3. The entry's ISO `timestamp`, in microseconds. Reached only if `ts` is
 *      malformed. Millisecond resolution, so two messages inside one
 *      millisecond could still collide — but a collapse to a single id per
 *      channel is the failure this module exists to prevent, so a coarse
 *      distinct id beats a shared one.
 *
 * Returns 0 only when nothing above yields a value. 0 is the value that caused
 * the original data loss, so callers should treat it as "unknown", not as a
 * valid id.
 */
export function slackEntryMessageId(entry: SlackMessageIdSource): number {
  if (typeof entry.messageId === 'number' && Number.isSafeInteger(entry.messageId)) {
    return entry.messageId;
  }

  const fromTs = slackTsToMessageId(String(entry.messageId ?? ''));
  if (fromTs !== null) return fromTs;

  if (entry.timestamp) {
    const ms = Date.parse(entry.timestamp);
    if (Number.isFinite(ms)) {
      const micros = ms * 1000;
      if (Number.isSafeInteger(micros)) return micros;
    }
  }

  return 0;
}
