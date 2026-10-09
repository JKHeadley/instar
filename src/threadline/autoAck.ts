/**
 * autoAck — the automatic "Message received" acknowledgement, in one place
 * (docs/specs/a2a-ack-never-acked.md).
 *
 * INVARIANT: an ack is never acked, never reaches the warrants-a-reply gate or
 * any router, and never spawns a session. It only records delivery.
 *
 * Before this module the ack went out as an ordinary `type: 'chat'` message, so
 * the receiving agent ran its whole inbound handler on it: it acked the ack
 * (until the per-sender rate limit stopped the ping-pong after about five acks
 * each way) and, when the ack was the first inbound on a thread the receiver
 * itself had started, spawned a full session to "reply" to it.
 *
 * Recognition is structural first (`type: 'ack'` on the wire), with the
 * original text recognition kept for acks from peers that predate the type.
 * Recognition decides only "this message is a delivery receipt, not content";
 * it grants nothing and blocks nothing a peer could not already do by sending
 * no message at all.
 */

import type { AdmissionTicket } from './InboundIdLedger.js';

/** The wire `type` of an automatic acknowledgement. */
export const AUTO_ACK_TYPE = 'ack';

/** The default acknowledgement text (also what older peers recognise). */
export const DEFAULT_AUTO_ACK_MESSAGE = 'Message received. Composing response...';

/**
 * Is this inbound an automatic acknowledgement? Structural only — no reading
 * of what a message means:
 *
 *  - `type === 'ack'` — the wire marker (any text, including a custom
 *    `autoAckMessage`); or
 *  - the WHOLE message is exactly the fixed sentence every release before the
 *    marker sent (`DEFAULT_AUTO_ACK_MESSAGE`). That is how an older peer's ack
 *    is recognised.
 *
 * Never a prefix, never a vocabulary: `Message received. Deploy the fix now.`
 * is content and is handled as content. An older peer configured with its own
 * ack sentence is not recognised here; its ack reaches the warrants gate, as
 * it always did.
 */
export function isAutoAckInbound(input: { type?: unknown; text?: string | null }): boolean {
  return autoAckRecognition(input) !== null;
}

/**
 * WHY an inbound was recognised as an ack — written to the server log for every
 * consumed ack, so the recognition can be audited without storing the text:
 * `exact-text` is by construction the fixed sentence and nothing else; `type`
 * is the sender's own declaration.
 */
export function autoAckRecognition(input: { type?: unknown; text?: string | null }): 'type' | 'exact-text' | null {
  if (input.type === AUTO_ACK_TYPE) return 'type';
  return (input.text ?? '').trim() === DEFAULT_AUTO_ACK_MESSAGE ? 'exact-text' : null;
}

/**
 * The older, looser text test, kept for ONE non-terminal use: a message that
 * opens like an ack must not be handed to a reply waiter as "the reply". It
 * stops nothing — the message is still handled in full.
 */
export function looksLikeAutoAckText(text: string | null | undefined): boolean {
  const t = text ?? '';
  return t.startsWith('Message received.') || t.startsWith('Message received,');
}

/**
 * The HTTP routes' field mapping: a message `body` is either a string (the
 * text; no type) or an object whose `content` (else `text`) is the text and
 * whose `type` is the wire type.
 */
export function autoAckBodyRecognition(body: unknown): 'type' | 'exact-text' | null {
  if (typeof body === 'string') return autoAckRecognition({ text: body });
  if (typeof body === 'object' && body !== null) {
    const b = body as Record<string, unknown>;
    const text = typeof b.content === 'string' ? b.content : typeof b.text === 'string' ? b.text : '';
    return autoAckRecognition({ type: b.type, text });
  }
  return null;
}

export function isAutoAckBody(body: unknown): boolean {
  return autoAckBodyRecognition(body) !== null;
}

/**
 * Per-sender ack rate limiter (flood protection — kept even though an ack is no
 * longer acked: a peer sending many real messages still gets a bounded number
 * of acks back per window).
 */
export function createAckRateLimiter(limit: number, windowMs: number, now: () => number = Date.now): (fingerprint: string) => boolean {
  const ackTimestamps = new Map<string, number[]>();
  return function isAckRateLimited(fingerprint: string): boolean {
    const t = now();
    const filtered = (ackTimestamps.get(fingerprint) ?? []).filter(ts => t - ts < windowMs);
    ackTimestamps.set(fingerprint, filtered);
    if (filtered.length >= limit) return true;
    filtered.push(t);
    return false;
  };
}

export interface RelayAckStageDeps {
  /** `threadline.autoAck !== false`. */
  autoAckEnabled: boolean;
  /** `threadline.autoAckMessage`, when configured. */
  autoAckMessage?: string;
  isAckRateLimited: (fingerprint: string) => boolean;
  /** Sends the ack on the wire (`ThreadlineClient.sendAck`). May throw. */
  sendAck: (recipient: string, text: string, threadId?: string) => void;
  /** Records the implicit delivery ack (`recordInboundAck`). Never throws. */
  recordDelivery: () => void;
}

export interface RelayAckStageInput {
  isAutoAck: boolean;
  trustLevel: string;
  /** The inbound's wire `type` (acks are never sent for `status`). */
  msgType: unknown;
  senderFingerprint: string;
  threadId?: string;
  ticket: AdmissionTicket | null;
}

/**
 * The ack stage of the relay inbound handler. Runs FIRST, before the inbox
 * append, the Telegram mirror, the warrants gate and every router.
 *
 *  - inbound IS an ack → record delivery, write the ledger disposition
 *    `no-reply`, and tell the caller to stop (`'ack-consumed'`). Nothing is sent.
 *  - otherwise → send our own ack when allowed, and let the caller continue.
 */
export function runRelayAckStage(deps: RelayAckStageDeps, input: RelayAckStageInput): 'ack-consumed' | 'continue' {
  if (input.isAutoAck) {
    deps.recordDelivery();
    input.ticket?.recordNoReply();
    return 'ack-consumed';
  }
  if (
    input.trustLevel !== 'untrusted'
    && input.msgType !== 'status'
    && deps.autoAckEnabled
    && !deps.isAckRateLimited(input.senderFingerprint)
  ) {
    try {
      deps.sendAck(input.senderFingerprint, deps.autoAckMessage ?? DEFAULT_AUTO_ACK_MESSAGE, input.threadId);
    } catch (ackErr) {
      console.error(`[relay] Auto-ack failed: ${ackErr instanceof Error ? ackErr.message : ackErr}`);
    }
  }
  return 'continue';
}

// ── Plaintext wire format (shared by the sender and the receiver) ──────

/** Build the base64 JSON payload of a plaintext relay message. */
export function encodePlaintextPayload(text: string, type: string, resend?: boolean): string {
  return Buffer.from(JSON.stringify({
    text,
    type,
    ...(resend ? { resend: true } : {}),
  })).toString('base64');
}

/**
 * Decode a plaintext (unknown-sender) relay payload. Returns null when the
 * payload cannot be decoded at all.
 */
export function decodePlaintextPayload(payload: unknown): { text: string; type?: string; resend: boolean } | null {
  try {
    const parsed = JSON.parse(Buffer.from(payload as string, 'base64').toString('utf-8'));
    if (typeof parsed === 'object' && parsed !== null && 'text' in parsed) {
      return {
        text: String(parsed.text),
        type: parsed.type as string | undefined,
        // inbound-id ledger §5: `resend` travels INSIDE the message body.
        resend: (parsed as { resend?: unknown }).resend === true,
      };
    }
    if (typeof parsed === 'string') return { text: parsed, resend: false };
    return { text: JSON.stringify(parsed), resend: false };
  } catch {
    // @silent-fallback-ok — the caller substitutes its "[undecryptable …]" text.
    return null;
  }
}
