// CONTRACT-EVIDENCE: EXEMPT — pure string formatting and parsing of message text; calls no platform API method and reads no new parameter or response field.
/**
 * The on-behalf marker: the visible line an agent puts on any message it sends
 * through its OPERATOR's own account (a browser signed in as them), on any
 * platform. "[Sent by Echo on Justin's behalf]" — or "…, test]" for a test.
 *
 * Operator's words (topic 134088, 2026-11-09 17:25): "add a protocol such that
 * any messages you send as me should be marked appropriately ... we worked on a
 * message signature process exactly for this in Telegram and we should
 * generalize it."
 *
 * Telegram already carries a cryptographic agent signature for this
 * (agentSignatureProvenance.ts). Slack and other platforms reached through the
 * operator's browser have no signing path, so this marker is the generalized,
 * platform-neutral part: a fixed format the agent writes, and a parser the
 * inbound side uses to label the message as not written by the account holder.
 *
 * SAFE TO TRUST WITHOUT A SIGNATURE, IN ONE DIRECTION ONLY. A marker can only
 * LOWER what a message is taken to be: "the account holder did not write this".
 * Anyone who types it just marks their own message as not theirs. It never
 * grants anything, never raises trust, and never proves which agent sent it —
 * the label says "marked as sent by <name>", never "verified".
 */

/** Names are clamped and stripped to letters, digits, space, dot, dash, underscore and apostrophe. */
function cleanName(value: string): string {
  return value.replace(/[^\p{L}\p{N} ._'-]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 48);
}

/** The marker text an agent puts at the start of a message it sends as its operator. */
export function formatOnBehalfMarker(agentName: string, operatorName: string, opts: { test?: boolean } = {}): string {
  const agent = cleanName(agentName) || 'the agent';
  const operator = cleanName(operatorName) || 'the operator';
  return `[Sent by ${agent} on ${operator}'s behalf${opts.test ? ', test' : ''}]`;
}

/** Prefix `text` with the marker (idempotent: an already-marked text is returned unchanged). */
export function markOnBehalf(text: string, agentName: string, operatorName: string, opts: { test?: boolean } = {}): string {
  if (detectOnBehalfMarker(text).marked) return text;
  return `${formatOnBehalfMarker(agentName, operatorName, opts)} ${text}`;
}

export interface OnBehalfMarkerSignal {
  marked: boolean;
  /** The agent name the marker states (unverified). */
  agentName?: string;
  /** The person the marker says it was sent for (unverified). */
  operatorName?: string;
  test?: boolean;
}

// "[Sent by <agent> on <operator>'s behalf]" with an optional short note after a
// comma (", test"), straight or curly apostrophe, any case. Recognised only at the
// very start or very end of the message, which is where a marker is written: a
// marker quoted mid-message (someone explaining the format) is not one.
const MARKER_BODY = String.raw`\[\s*sent by ([^\[\]\n]{1,48}?) on ([^\[\]\n]{1,48}?)['’]s behalf\s*(?:,\s*([^\[\]\n]{0,24}))?\]`;
const AT_START = new RegExp(`^${MARKER_BODY}`, 'i');
const AT_END = new RegExp(`${MARKER_BODY}$`, 'i');

/** Find an on-behalf marker at the start or end of `text`. Never throws. */
export function detectOnBehalfMarker(text: unknown): OnBehalfMarkerSignal {
  if (typeof text !== 'string' || !text) return { marked: false };
  const trimmed = text.trim();
  for (const m of [AT_START.exec(trimmed.slice(0, 200)), AT_END.exec(trimmed.slice(-200))]) {
    if (!m) continue;
    const agentName = cleanName(m[1]);
    const operatorName = cleanName(m[2]);
    if (!agentName || !operatorName) continue;
    return { marked: true, agentName, operatorName, test: /\btest\b/i.test(m[3] ?? '') };
  }
  return { marked: false };
}

/**
 * The sender label for an inbound message: unchanged when unmarked; otherwise it
 * names the stated agent and says the account holder did not write it.
 */
export function onBehalfSenderLabel(senderName: string, signal: OnBehalfMarkerSignal): string {
  if (!signal.marked) return senderName;
  return `${signal.agentName} on ${senderName}'s behalf, marked, not written by ${senderName}`;
}

/**
 * A history line's sender label, given the line's own text. The agent's own bot
 * lines ('Agent') are left alone; any other line carrying a marker is relabelled.
 */
export function markedHistoryLabel(label: string, text: unknown): string {
  if (label === 'Agent') return label;
  return onBehalfSenderLabel(label, detectOnBehalfMarker(text));
}

/**
 * The injection tag for a live inbound message, e.g. `[slack:C1 from Justin (uid:U1)]`.
 * When the message carries a marker, a note is added inside the tag so the session
 * reads it as sent by the named agent, not written by the account holder.
 */
export function markedInboundPrefix(prefix: string, text: unknown, senderName: string | undefined): string {
  const signal = detectOnBehalfMarker(text);
  if (!signal.marked || !prefix.endsWith(']')) return prefix;
  const who = cleanName(senderName ?? '') || 'the account holder';
  return `${prefix.slice(0, -1)} (marked: sent by ${signal.agentName} on ${who}'s behalf, not written by ${who})]`;
}
