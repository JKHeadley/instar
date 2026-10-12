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
 * ACT-091: the acknowledgement for a message that was received and, by the
 * warrants-reply gate's verdict, will NOT be answered. It promises nothing, so
 * the sender's delivery tracker closes the loop without reading a reply into
 * it. Sent with the `ack` wire type; an older peer (text-only recognition)
 * sees it as content, exactly as it sees a configured custom ack sentence.
 */
export const NO_REPLY_ACK_MESSAGE = 'Message received.';

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
  /**
   * ACT-091: hold our own ack until routing reports its outcome. The relay
   * handler sets it for EVERY inbound message (any hand-off can reach no live
   * consumer, not only a topic-bound reply's) and settles through
   * `createRelayAckSettler`. An inbound ack is still consumed here either way.
   */
  deferSend?: boolean;
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
  if (!input.deferSend) sendRelayAckIfAllowed(deps, input, deps.autoAckMessage ?? DEFAULT_AUTO_ACK_MESSAGE);
  return 'continue';
}

/** Send our own ack when policy allows it (trust, type, config, rate limit). */
function sendRelayAckIfAllowed(deps: RelayAckStageDeps, input: RelayAckStageInput, text: string): boolean {
  if (
    input.trustLevel !== 'untrusted'
    && input.msgType !== 'status'
    && deps.autoAckEnabled
    && !deps.isAckRateLimited(input.senderFingerprint)
  ) {
    try {
      deps.sendAck(input.senderFingerprint, text, input.threadId);
      return true;
    } catch (ackErr) {
      console.error(`[relay] Auto-ack failed: ${ackErr instanceof Error ? ackErr.message : ackErr}`);
    }
  }
  return false;
}

/**
 * ACT-091: the second half of a deferred ack. The default ack text promises a
 * reply ("Composing response..."), so it goes out ONLY when routing handed the
 * message to a live consumer. A message the warrants-reply gate decided not to
 * answer (`noReply`) is a terminal, deliberate outcome: it gets the
 * non-promising NO_REPLY_ACK_MESSAGE, so the sender's tracker records it as
 * received instead of reporting a stuck channel. Anything else — delivered to
 * no live session — gets no ack at all.
 */
export function settleDeferredRelayAck(
  deps: RelayAckStageDeps,
  input: RelayAckStageInput,
  outcome: { delivered: boolean; noReply?: boolean },
): 'sent' | 'sent-no-reply' | 'skipped-undelivered' | 'skipped-policy' {
  if (input.isAutoAck) return 'skipped-policy';
  if (outcome.noReply) return sendRelayAckIfAllowed(deps, input, NO_REPLY_ACK_MESSAGE) ? 'sent-no-reply' : 'skipped-policy';
  if (!outcome.delivered) return 'skipped-undelivered';
  return sendRelayAckIfAllowed(deps, input, deps.autoAckMessage ?? DEFAULT_AUTO_ACK_MESSAGE) ? 'sent' : 'skipped-policy';
}

/**
 * Where the relay inbound handler's routing ended (ACT-091). Each terminal exit
 * of the handler names exactly one:
 *
 *  - `pipe-spawned`       — a pipe session was created with the message as its
 *                           prompt. A live consumer has it.
 *  - `listener-delivered` — the message was appended to the warm-listener inbox
 *                           and `ListenerSessionManager.hasLiveReader()` is
 *                           still true: a reader proved itself alive within the
 *                           freshness bound, so a live consumer has it.
 *  - `listener-queued`    — the message was appended to the inbox but no live
 *                           reader is proven at that moment (the heartbeat went
 *                           stale between the routing check and the write). The
 *                           write succeeds with nobody reading, so it is a queue
 *                           write, NOT a delivery.
 *  - `router-delivered`   — `ThreadlineRouter` reported `delivered === true`.
 *  - `router-undelivered` — the router accepted, queued, refused or failed
 *                           without a live session receiving the message. This
 *                           includes a capacity refusal the spawn manager
 *                           QUEUED (`queued: true`, e.g. "Session limit reached
 *                           (5/5)"). Deliberately no ack, and no separate
 *                           "queued" receipt: see `describeUndeliveredRouterResult`.
 *  - `no-reply`           — the warrants-reply gate decided not to answer
 *                           (a no-reply verdict or an exhausted loop budget).
 */
export type RelayRoutingOutcome =
  | 'pipe-spawned'
  | 'listener-delivered'
  | 'listener-queued'
  | 'router-delivered'
  | 'router-undelivered'
  | 'no-reply';

export type RelayAckSettlement =
  | ReturnType<typeof settleDeferredRelayAck>
  /** The stage already sent (or consumed) the ack; there is nothing to settle. */
  | 'not-deferred'
  /** `settle` was already called for this message; nothing more is sent. */
  | 'already-settled';

/**
 * The log wording for a router result that reached no live session.
 *
 * DECISION (ACT-091, queued spawns): a capacity refusal that the spawn manager
 * queued (`queued: true`; only reported when `SpawnRequestManager`'s queue
 * actually admitted the payload) keeps the message for a later spawn. It still
 * gets NO ack, and we do not send a third fixed "received, queued" text:
 *
 *  - The queue is in memory, bounded per agent and globally, and expires entries
 *    after 10 minutes, and a later arrival can evict an older entry. "Queued" is
 *    a hope of a later session, not a hand-off to one, so a receipt would claim
 *    more than we know.
 *  - A new ack text is recognised as an ack only through the `ack` wire type.
 *    `isAutoAckInbound` matches untyped text only when it is exactly
 *    DEFAULT_AUTO_ACK_MESSAGE, and `looksLikeAutoAckText` (prefix "Message
 *    received." / "Message received,") only spares a reply waiter and stops
 *    nothing. A peer from before the wire type routes ANY ack text to a session
 *    as a message, so a queued receipt would spend a session on that peer at the
 *    moment our own side is out of sessions.
 *
 * If the queued message later reaches a session, that session's reply is the
 * sender's acknowledgement. The wording below names the queued case so the log
 * says "queued", not "lost".
 */
export function describeUndeliveredRouterResult(result: { queued?: boolean; error?: string }): string {
  if (result.queued === true) {
    const why = result.error ? `: ${result.error.replace(/^Spawn denied:\s*/, '')}` : '';
    return `queued for a later session spawn${why} — no live session has it yet`;
  }
  return 'no live session received the message';
}

/** Did a live consumer receive the message on this outcome? */
export function relayOutcomeDelivered(outcome: RelayRoutingOutcome): boolean {
  return outcome === 'pipe-spawned' || outcome === 'listener-delivered' || outcome === 'router-delivered';
}

export interface RelayAckSettler {
  /** Settle the deferred ack with the routing outcome. First call wins. */
  settle(outcome: RelayRoutingOutcome): RelayAckSettlement;
  /** The outcome `settle` was called with, or null while routing is in flight. */
  readonly outcome: RelayRoutingOutcome | null;
}

/**
 * ACT-091: one deferred ack for one inbound relay message. The promising ack
 * ("Composing response...") goes out only for an outcome where a live consumer
 * has the message; `no-reply` gets the non-promising NO_REPLY_ACK_MESSAGE; a
 * queue write or an undelivered router result gets no ack, so the sender's
 * delivery tracker keeps the message as unacknowledged — which is true. A
 * handler exit that never calls `settle` (a throw) also sends nothing.
 *
 * One-shot: a second `settle` sends nothing, so a path that falls through to
 * another hand-off after settling can never ack twice.
 */
export function createRelayAckSettler(deps: RelayAckStageDeps, input: RelayAckStageInput): RelayAckSettler {
  let settled: RelayRoutingOutcome | null = null;
  return {
    get outcome() { return settled; },
    settle(outcome: RelayRoutingOutcome): RelayAckSettlement {
      if (settled !== null) return 'already-settled';
      settled = outcome;
      if (!input.deferSend) return 'not-deferred';
      return settleDeferredRelayAck(deps, input, {
        delivered: relayOutcomeDelivered(outcome),
        noReply: outcome === 'no-reply',
      });
    },
  };
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
