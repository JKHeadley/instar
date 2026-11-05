/**
 * requiredAck — the wire shape and pure rules of
 * docs/specs/a2a-required-acknowledgment.md. Dependency-free on purpose: the
 * codec in `autoAck.ts`, the inbound gate and the ledger wiring all read it.
 *
 * INVARIANT (from a2a-ack-never-acked): a kinded ack is never acked, never
 * routed, and never starts or wakes a session.
 */

/** The advertised capability value. A higher value from a later version is still understood as "has kinded acks". */
export const ACK_KINDS_VERSION = 1;

export const HELD_STATES = ['queued', 'waiting', 'refused', 'dropped', 'unknown', 'unacknowledged'] as const;
export type HeldState = (typeof HELD_STATES)[number];

/** The closed `reason` set: display only, decides nothing. Not peer prose. */
export const HELD_REASONS = ['session-limit', 'cooldown', 'memory-pressure', 'quota', 'other', 'busy', 'expired', 'evicted', 'restart'] as const;
export type HeldReason = (typeof HELD_REASONS)[number];

export const MAX_ACK_REF_IDS = 20;
export const MAX_SUMMARY_CHARS = 280;

/** The frozen wire field. `ackRef` is local to the receiver and never travels. */
export interface KindedAckWire {
  kind: string;
  state?: string;
  reason?: string;
  refMessageIds: string[];
  summary?: string;
}

/**
 * The `ack` field of a `type: 'ack'` message, or null when this is not a kinded
 * ack. An unknown `kind` is still a kinded ack: it is consumed and otherwise
 * ignored. Purely structural.
 */
export function parseKindedAck(content: unknown): KindedAckWire | null {
  if (typeof content !== 'object' || content === null) return null;
  const c = content as { type?: unknown; ack?: unknown };
  if (c.type !== 'ack') return null;
  if (typeof c.ack !== 'object' || c.ack === null) return null;
  const a = c.ack as Record<string, unknown>;
  return {
    kind: typeof a.kind === 'string' ? a.kind : '',
    ...(typeof a.state === 'string' ? { state: a.state } : {}),
    ...(typeof a.reason === 'string' ? { reason: a.reason } : {}),
    refMessageIds: Array.isArray(a.refMessageIds)
      ? a.refMessageIds.filter((x): x is string => typeof x === 'string' && x.length > 0).slice(0, MAX_ACK_REF_IDS)
      : [],
    ...(typeof a.summary === 'string' ? { summary: a.summary } : {}),
  };
}

export function isHeldState(v: unknown): v is HeldState {
  return typeof v === 'string' && (HELD_STATES as readonly string[]).includes(v);
}

export function isHeldReason(v: unknown): v is HeldReason {
  return typeof v === 'string' && (HELD_REASONS as readonly string[]).includes(v);
}

/** `queued`/`waiting`/`refused` < `unacknowledged` < `unknown` < `dropped` < `read`. */
export function heldStateRank(state: string | null | undefined): number {
  switch (state) {
    case 'queued': case 'waiting': case 'refused': return 1;
    case 'unacknowledged': return 2;
    case 'unknown': return 3;
    case 'dropped': return 4;
    case 'read': return 5;
    default: return 0;
  }
}

/** One line, control characters stripped, bounded. The result is still peer text. */
export function sanitizeAckSummary(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const line = raw.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim();
  return line ? line.slice(0, MAX_SUMMARY_CHARS) : null;
}

/** The session's own summary: 1 to 280 characters, single line. Returns why it is refused, or null. */
export function summaryProblem(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.trim().length === 0) return 'summary is required';
  if (raw.length > MAX_SUMMARY_CHARS) return `summary must be at most ${MAX_SUMMARY_CHARS} characters`;
  if (/[\r\n\u2028\u2029]/.test(raw)) return 'summary must be a single line';
  return null;
}

/** The fixed receipt texts. They contain nothing from the original message. */
export const HELD_TEXT = {
  received: 'Received by the server. No session has read this yet. It could be lost.',
  pending: 'Received by the server. A session may not have seen it yet.',
  expired: 'This expired before a session read it.',
  evicted: 'This was pushed out of the waiting queue before a session read it.',
  restart: 'A restart interrupted this. It may not have reached a session.',
  unacknowledged: "A session has this and hasn't acknowledged it.",
  read: 'A session acknowledged this.',
} as const;

/**
 * The instruction that travels with a watched message. Fixed text plus the
 * server's own handle: a peer's message id is never shown to a session as server
 * text, because the sender chooses it and the relay does not validate it.
 */
export function requiredAckInstruction(ackRef: string): string {
  return `[server notice: another agent is waiting to hear that this message was received. Before starting work, acknowledge it: call threadline_ack with ackRefs ["${ackRef}"] and a one-line summary, in your own words, of what was asked. If the answer is quick, just reply instead.]`;
}

/** The reminder typed into a session. Fixed text and server handles only. */
export function requiredAckReminder(ackRefs: string[]): string {
  return `[server notice: another agent is still waiting to hear that its message was received. Call threadline_ack with ackRefs ${JSON.stringify(ackRefs)} and a one-line summary, in your own words, of what was asked, or reply to it. Then carry on with your work.]`;
}

/**
 * Map a spawn refusal to the closed `reason` set. A closed display mapping that
 * decides nothing. A peer without a trust profile gets `busy` in place of the
 * capacity reasons, so capacity is not told to strangers.
 */
export function refusalReason(error: string | undefined, hasTrustProfile: boolean): HeldReason {
  const text = error ?? '';
  let reason: HeldReason = 'other';
  if (/session limit/i.test(text)) reason = 'session-limit';
  else if (/cooldown/i.test(text)) reason = 'cooldown';
  else if (/memory pressure/i.test(text)) reason = 'memory-pressure';
  else if (/quota/i.test(text)) reason = 'quota';
  return hasTrustProfile ? reason : 'busy';
}
