/**
 * relayVerdict — the fixed vocabulary the sender uses for what the relay said
 * about one message (docs/specs/a2a-honest-delivery-outcomes.md §1).
 *
 * The relay's `ack` / `delivery_expired` / `error` frames carry human-readable
 * prose. None of that prose may reach an agent's context (a separately hosted
 * service writing into a model's input is an injection path), so every reason
 * is mapped HERE to a fixed code by prefix, and the raw string is clamped and
 * kept for the tracker + audit log only. The prefix table is a BRIDGE until the
 * relay carries a structured code (ACT-017): an unmapped reason is `unmapped`
 * with UNKNOWN retryability — never a guess in either direction.
 */

export type RelayVerdictStatus = 'delivered' | 'queued' | 'rejected' | 'expired' | 'unconfirmed';

export type RelayReasonCode =
  | 'queue-full'
  | 'rate-limited'
  | 'routing-refused'
  | 'banned'
  | 'unmapped';

export interface RelayVerdict {
  messageId: string;
  status: RelayVerdictStatus;
  /** Fixed code (§1 table). Present for `rejected`, `unconfirmed`(banned) and when the relay sent a reason. */
  reasonCode?: RelayReasonCode;
  /** Clamped relay text — tracker/audit only, never returned to an agent. */
  reason?: string;
  /** `true` = a later resend may succeed; `false` = it will not; `null` = unknown (`unmapped`). */
  retryLater?: boolean | null;
  /** Seconds the relay will hold a `queued` message (clamped by the consumer). */
  ttlSec?: number;
  /** For `expired`: the recipient the relay discarded the copy for. */
  recipientId?: string;
}

/** Max chars of relay prose kept anywhere. */
export const RELAY_REASON_MAX_CHARS = 200;

/** Relay-hold ceiling the consumer trusts (seconds). */
export const RELAY_TTL_CLAMP_SEC = 24 * 60 * 60;

/**
 * Prefix table — the relay's actual strings (RelayServer / MessageRouter /
 * AbuseDetector). Order matters only for overlapping prefixes (none today).
 */
const REASON_PREFIXES: Array<{ prefix: string; code: RelayReasonCode; retryLater: boolean | null }> = [
  { prefix: 'Offline queue full', code: 'queue-full', retryLater: true },
  { prefix: 'Rate limited', code: 'rate-limited', retryLater: true },
  { prefix: 'New agent rate limit', code: 'rate-limited', retryLater: true },
  { prefix: 'No pending A2A task', code: 'routing-refused', retryLater: false },
  { prefix: 'Duplicate message ID', code: 'routing-refused', retryLater: false },
  { prefix: 'Recipient socket not available', code: 'routing-refused', retryLater: false },
  { prefix: 'Failed to send to recipient', code: 'routing-refused', retryLater: false },
  { prefix: 'Recipient not connected', code: 'routing-refused', retryLater: false },
  { prefix: 'Sender fingerprint mismatch', code: 'routing-refused', retryLater: false },
  { prefix: 'Envelope too large', code: 'routing-refused', retryLater: false },
];

// Control, DEL, zero-width, line/para separators, bidi overrides, isolates, BOM.
// Built from a string so no literal separator character sits inside a regex.
const UNSAFE_CHARS = new RegExp('[\\u0000-\\u001f\\u007f\\u200b-\\u200f\\u2028-\\u202e\\u2066-\\u2069\\ufeff]', 'g');

/** Strip control, bidi and zero-width characters, then clamp. */
export function clampRelayReason(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || raw.length === 0) return undefined;
  const cleaned = raw.replace(UNSAFE_CHARS, '');
  return cleaned.slice(0, RELAY_REASON_MAX_CHARS);
}

export interface MappedReason {
  code: RelayReasonCode;
  retryLater: boolean | null;
  /** True when no prefix matched (the drift signal). */
  unmapped: boolean;
}

/** Map relay prose to a fixed code. Any other router reason is `routing-refused`; an empty/absent reason is `unmapped`. */
export function mapRelayReason(raw: unknown): MappedReason {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!text) return { code: 'unmapped', retryLater: null, unmapped: true };
  for (const row of REASON_PREFIXES) {
    if (text.startsWith(row.prefix)) return { code: row.code, retryLater: row.retryLater, unmapped: false };
  }
  // The spec's "any other router reason" row is deliberately NOT a wildcard:
  // only text the relay's router is known to emit maps to routing-refused.
  // Unknown wording is a drift signal, not a refusal class.
  return { code: 'unmapped', retryLater: null, unmapped: true };
}

/** Clamp a relay `ttl` (seconds). Absent / non-finite / negative → the default hold (24 h). */
export function clampRelayTtlSec(ttl: unknown): number {
  const n = typeof ttl === 'number' ? ttl : Number.NaN;
  if (!Number.isFinite(n) || n < 0) return RELAY_TTL_CLAMP_SEC;
  return Math.min(n, RELAY_TTL_CLAMP_SEC);
}

/** Whole hours the relay will hold a queued message, from the CLAMPED ttl. */
export function relayHoldHours(ttl: unknown): number {
  return Math.max(1, Math.ceil(clampRelayTtlSec(ttl) / 3600));
}

/** Exact wire value of the relay's ban error code (lowercase). */
export const RELAY_BANNED_CODE = 'banned';
