/**
 * recordInboundAck — the ONE funnel every Threadline inbound-receive path calls
 * to record the implicit delivery ack (Robustness Phase 1, G3 / closes F4;
 * CMT-1362).
 *
 * A reply ON A THREAD is proof the peer received our prior send on that thread,
 * so an authenticated inbound message clears the matching `awaiting-ack` entry
 * (`recordAckByThread`) and bumps the peer's inbound-liveness clock
 * (`recordInboundFrom`). F4 was a pure WIRING GAP: the verified E2E relay inbound
 * path did not make these calls, so live two-way exchange never recorded acks and
 * `/threadline/peers/health` reported permanent false `stale: true` noise.
 *
 * Funnelling all inbound-receive sites through this one helper (rather than
 * copy-pasting the calls) makes the wiring testable: a wiring-integrity test
 * enumerates the inbound routes and asserts each goes through this funnel, so a
 * FUTURE inbound path that bypasses it fails the test (Structure > Willpower).
 *
 * Recording-only: this NEVER throws into inbound routing — the message has
 * already been accepted by the time it runs.
 */

import type { A2ADeliveryTracker } from './A2ADeliveryTracker.js';

/** Minimal view of the thread-owner lookup (avoids a hard ThreadResumeMap import). */
export interface ThreadOwnerLookup {
  get(threadId: string): { remoteAgent?: string } | null | undefined;
}

export interface InboundAckDeps {
  a2aDeliveryTracker?: A2ADeliveryTracker | null;
  /** Resolves a thread's canonical peer fingerprint (preferred liveness key). */
  threadResumeMap?: ThreadOwnerLookup | null;
}

export interface InboundAckMessage {
  /** The thread the inbound message belongs to (the ack key). */
  threadId?: string;
  /** The sender's canonical fingerprint, when known (liveness fallback). */
  senderFingerprint?: string;
  /** The sender's display name, when known. */
  senderName?: string | null;
}

/**
 * Record the implicit inbound ack. Idempotent and best-effort. Keys the ack on
 * `threadId` (robust to the local-vs-remote sender-identity asymmetry); keys
 * liveness by the thread owner's canonical fingerprint when resolvable, falling
 * back to the supplied sender fingerprint.
 */
export function recordInboundAck(deps: InboundAckDeps, msg: InboundAckMessage): void {
  const tracker = deps.a2aDeliveryTracker;
  if (!tracker) return;
  try {
    const ackThread = msg.threadId;
    const ownerFp = ackThread ? deps.threadResumeMap?.get(ackThread)?.remoteAgent : undefined;
    const livenessFp = ownerFp || msg.senderFingerprint;
    if (livenessFp) tracker.recordInboundFrom(livenessFp, msg.senderName ?? null);
    if (ackThread) tracker.recordAckByThread(ackThread);
  } catch (err) {
    // @silent-fallback-ok: recording-only — A2A delivery/liveness tracking must
    // never break inbound routing (the message was already accepted). Logged.
    console.warn(`[recordInboundAck] non-fatal: ${err instanceof Error ? err.message : String(err)}`);
  }
}
