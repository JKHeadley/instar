/**
 * relayIngressHistory — the canonical-history step for an ALREADY-AUTHORIZED
 * cross-machine relay inbound (the relay socket `gate-passed` consumer in
 * server.ts). It records the inbound leg through the one `recordThreadMessage`
 * funnel, the same as the HTTP receive path (ThreadlineEndpoints) and the
 * same-machine relay-agent route (routes.ts) already do.
 *
 * This is an observer, never an authority (docs/signal-vs-authority.md): it runs
 * after the inbound gate decided, adds no admission/allow/block policy, and its
 * outcome never gates delivery — every failure is non-fatal and surfaces through
 * the recorder's existing bounded observability (log line + one deduped
 * Attention item after a failure streak). A logged row is history, not proof the
 * message was read, submitted, or delivered.
 *
 * Exclusions (preserved from the handler's own contracts):
 *  - `probe` decisions: a probe is not a conversation message and never opens a place;
 *  - acks the handler's ack stage consumes (kinded acks and auto-acks): an ack is
 *    never routed (docs/specs/a2a-ack-never-acked.md), so it is not a history leg.
 *
 *  - a thread id outside the canonical allowlist (THREAD_ID_RE) is skipped with a
 *    warning — the log never writes a file for a shape the history routes refuse.
 *
 * Compatibility fallbacks (legacy senders):
 *  - a missing wire timestamp → this end's receive time, recorded with
 *    `createdAtSource: 'receive-time'`; never presented as a sender stamp. The
 *    unknown-sender (plaintext) bootstrap fills a missing envelope timestamp with
 *    its own receive time before the gate and marks it `timestampSynthesized`
 *    (ThreadlineBootstrap); that mark is honored here, so a synthesized value is
 *    recorded as receive time, not as the sender's stamp;
 *  - a missing message id → a stable `legacy-<sha256>` id derived from the verified
 *    sender, thread, SENDER wire timestamp (or `none` — a synthesized receive time
 *    is never a hash input) and body, so a redelivered copy dedupes instead of
 *    minting a new row. Two genuinely distinct legacy messages with the same
 *    sender, thread, body and no timestamp collapse into one row.
 *
 * The production composition is shared, not mirrored: `classifyRelayIngress` is
 * the one text/ack classification server.ts's handleGatePassedRelayMessage uses
 * (its ack stage reuses the same `kindedAck`/`isAutoAck`), and
 * `recordGatePassedIngress` is the one call it makes into this step.
 */

import { createHash } from 'node:crypto';
import { THREAD_ID_RE } from './ThreadLog.js';
import { recordThreadMessage, type ThreadMessageRecorder, type RecordThreadMessageResult } from './recordThreadMessage.js';
import { isAutoAckInbound } from './autoAck.js';
import { parseKindedAck, type KindedAckWire } from './requiredAck.js';

export interface RelayIngressHistoryInput {
  /** The gate decision reason (`probe`, `relay-authenticated`, …). */
  reason?: string;
  message: {
    /** The relay-verified sender routing fingerprint. */
    from: string;
    threadId?: string;
    messageId?: string;
    /** The original wire timestamp (ReceivedMessage.timestamp). */
    timestamp?: unknown;
    /** True when `timestamp` is this end's receive time, filled in because the wire had none. */
    timestampSynthesized?: boolean;
  };
  /** The normalized body text the handler routes (already extracted). */
  text: string;
  /** True when the handler's ack stage consumes this message (kinded ack or auto-ack). */
  ackConsumed: boolean;
  /** The thread id the handler uses when the wire carries none (matches the legacy inbox row). */
  fallbackThreadId: string;
  /** Injected for tests; default `new Date().toISOString()`. */
  receivedAt?: () => string;
}

export type RelayIngressHistoryOutcome =
  | { status: 'excluded'; reason: 'probe' | 'ack' | 'no-recorder' | 'invalid-thread-id' }
  | (RecordThreadMessageResult & { threadId: string; messageId: string; createdAtSource: 'wire' | 'receive-time' });

/** Stable compatibility id for a legacy inbound that carried no message id. */
export function legacyRelayMessageId(parts: { from: string; threadId: string; timestamp?: string; text: string }): string {
  const h = createHash('sha256').update(JSON.stringify([parts.from, parts.threadId, parts.timestamp ?? 'none', parts.text])).digest('hex');
  return `legacy-${h.slice(0, 40)}`;
}

/**
 * Record one authorized relay inbound into canonical history. Never throws.
 */
export function recordRelayIngressHistory(
  recorder: ThreadMessageRecorder | null | undefined,
  input: RelayIngressHistoryInput,
): RelayIngressHistoryOutcome {
  if (input.reason === 'probe') return { status: 'excluded', reason: 'probe' };
  if (input.ackConsumed) return { status: 'excluded', reason: 'ack' };
  if (!recorder) return { status: 'excluded', reason: 'no-recorder' };

  const m = input.message;
  const threadId = m.threadId || input.fallbackThreadId;
  // The canonical log keys a file by thread id: only the allowlisted shapes the
  // history routes can read are recorded (traversal defense, FD-7). A wire-less
  // thread gets the handler's synthetic `auto-…` id, which is not a canonical
  // shape — that leg stays in the legacy inbox only (pre-existing limitation).
  if (!THREAD_ID_RE.test(threadId)) {
    warnSkippedThreadId(m.from, threadId);
    return { status: 'excluded', reason: 'invalid-thread-id' };
  }
  const present = typeof m.timestamp === 'string' && m.timestamp.length > 0 ? m.timestamp : undefined;
  // Only a SENDER stamp is a wire timestamp; a bootstrap-synthesized receive time is not.
  const wireTs = m.timestampSynthesized === true ? undefined : present;
  const messageId = m.messageId || legacyRelayMessageId({ from: m.from, threadId, timestamp: wireTs, text: input.text });
  const createdAt = wireTs ?? (m.timestampSynthesized === true ? present : undefined) ?? (input.receivedAt ?? (() => new Date().toISOString()))();
  try {
    const res = recordThreadMessage(recorder, {
      threadId,
      messageId,
      direction: 'inbound',
      body: input.text,
      createdAt,
      ...(wireTs ? {} : { createdAtSource: 'receive-time' as const }),
      peerFingerprint: m.from,
      author: { agentFingerprint: m.from },
    });
    return { ...res, threadId, messageId, createdAtSource: wireTs ? 'wire' : 'receive-time' };
  } catch (err) {
    // record() never throws by contract; this guards a wrapped recorder (contact hook).
    console.warn(`[relay] canonical history record failed (non-fatal): ${err instanceof Error ? err.message : err}`);
    return { status: 'append-failed', contentDigest: '', threadId, messageId, createdAtSource: wireTs ? 'wire' : 'receive-time' };
  }
}

/**
 * P2: the skipped-thread-id warning carries a peer-controlled value. JSON-quote it
 * (a newline cannot forge a log line) and warn at most once per peer per window.
 */
const SKIP_WARN_WINDOW_MS = 10 * 60_000;
const SKIP_WARN_MAX_PEERS = 256;
const skipWarnedAt = new Map<string, number>();
function warnSkippedThreadId(peer: string, threadId: string): void {
  const now = Date.now();
  const last = skipWarnedAt.get(peer);
  if (last !== undefined && now - last < SKIP_WARN_WINDOW_MS) return;
  if (skipWarnedAt.size >= SKIP_WARN_MAX_PEERS) skipWarnedAt.clear();
  skipWarnedAt.set(peer, now);
  console.warn(`[relay] canonical history skipped: thread id is not a canonical shape (peer ${JSON.stringify(String(peer).slice(0, 16))}, thread ${JSON.stringify(threadId.slice(0, 48))}); further skips for this peer are not logged for 10 min`);
}

/** The handler's text normalization + ack classification, computed once and shared. */
export interface RelayIngressClassification {
  textContent: string;
  msgType: unknown;
  /** The legacy/typed auto-ack ("Message received…" or `type: ack`). */
  isAutoAck: boolean;
  /** A kinded ack (a2a-required-acknowledgment D1), or null. */
  kindedAck: KindedAckWire | null;
}

/**
 * The ONE classification handleGatePassedRelayMessage uses for routing, the ack
 * stage and the history step (so the history exclusion can never drift from what
 * the ack stage consumes). Behavior is the handler's original inline code.
 */
export function classifyRelayIngress(msg: { content: unknown }): RelayIngressClassification {
  let textContent: string;
  if (typeof msg.content === 'string') { textContent = msg.content; }
  else if (typeof msg.content === 'object' && msg.content !== null) {
    const c = msg.content as Record<string, unknown>;
    textContent = String(c.content ?? c.text ?? JSON.stringify(msg.content));
  } else { textContent = JSON.stringify(msg.content); }
  const msgType = typeof msg.content === 'object' && msg.content !== null ? (msg.content as Record<string, unknown>).type : undefined;
  const isAutoAck = isAutoAckInbound({ type: msgType, text: textContent });
  return { textContent, msgType, isAutoAck, kindedAck: parseKindedAck(msg.content) };
}

/**
 * The single call server.ts makes from handleGatePassedRelayMessage (after the
 * ledger commit, before the waiter and every routing branch). Never throws.
 */
export function recordGatePassedIngress(
  recorder: ThreadMessageRecorder | null | undefined,
  decision: { reason?: string; message: RelayIngressHistoryInput['message'] },
  cls: RelayIngressClassification,
  fallbackThreadId: string,
): RelayIngressHistoryOutcome {
  return recordRelayIngressHistory(recorder, {
    reason: decision.reason,
    message: decision.message,
    text: cls.textContent,
    ackConsumed: cls.isAutoAck || !!cls.kindedAck,
    fallbackThreadId,
  });
}
