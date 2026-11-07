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
 *
 * ── Relationship to src/core/conversationIdentity.ts ──
 *
 * That module is the governed surface for CONVERSATION identity: it mints a
 * numeric topic/conversation id from a routing key via `sumShiftHash` +
 * `walkDisplacement`, and `conversation-identity-mint-idiom-ratchet.test.ts`
 * fails CI on a fourth copy of its negated-absolute-hash mint idiom (the
 * literal form is in that test; it is deliberately NOT repeated here, because
 * the ratchet greps source text and cannot tell a comment from code). This
 * module is deliberately NOT a second copy of that: it is a different axis.
 *
 *   conversationIdentity : routing key (channel + thread) -> topic_id   [hash]
 *   this module          : one message's own ts            -> message_id [time]
 *
 * It mints nothing and hashes nothing — no absolute-value negation, no hash and
 * no collision walk here, because a message id must preserve SEND ORDER (see
 * reason 2 above) and a hash cannot. A hash would have satisfied the UNIQUE
 * constraint and moved the data loss into `getMessagesSinceSummary` instead,
 * which is the harder bug to see. If message ids ever do need minting rather
 * than deriving, that belongs in the governed module, not here.
 *
 * ── CONTRACT-EVIDENCE: EXEMPT — no API-contract surface ──
 *
 * This module makes no network call and touches no Slack API request or
 * response shape. It is a pure function from a string this process already
 * holds to a number, with no I/O of any kind, so live-API contract tests have
 * nothing here to exercise. The gate matches on the `src/messaging/slack/`
 * path, not on behaviour. Remove this marker the moment anything in this file
 * reads or writes an API payload.
 *
 * `conversationIdentity.SLACK_THREAD_TS_RE` (`/^\d{10}\.\d{6}$/`) is the
 * governed shape for a Slack *thread* ts and is intentionally not reused below:
 * it requires exactly 10 + 6 digits, and this module must also accept a ts with
 * no fraction or a short one rather than fall back and risk a coarser id. The
 * stricter form stays the right check for routing keys.
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
