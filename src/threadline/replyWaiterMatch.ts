/**
 * Which inbound message may resolve a waiting threadline send ("reply waiter")?
 *
 * A waiter is keyed by thread id, and thread ids are not secret from every peer
 * (shared multi-party threads, same-machine agents, leaked ids). So the thread id
 * alone never decides: when the send knows the fingerprint it was routed to, only a
 * message proven to come from that fingerprint resolves it — on every agent, not
 * only multi-person ones. The multi-person memory-privacy rule (the addressed peer,
 * never under `linkedPeerReplies: post-only`) still applies on top.
 */
export interface ReplyWaiterIdentity {
  /** The fingerprint this send addressed (fingerprint or owner-curated nickname), memory-privacy rule. */
  recipientFp?: string | null;
  /** The full routing fingerprint the send was actually delivered to, when known. */
  routedFp?: string | null;
}

export interface ReplyWaiterContext {
  /** Sender fingerprint proven by the transport (relay authentication or a verified local signature); null when unproven. */
  senderFp: string | null | undefined;
  multiPerson: boolean;
  linkedPeerReplies: string;
  /**
   * When the sender is unproven and the waiter has a routed fingerprint: allow (true) or refuse (false).
   * The relay path always has a proven sender. The local route allows it, because only a holder of
   * this agent's own token can reach that route at all.
   */
  allowUnprovenSender: boolean;
}

export function replyWaiterAccepts(waiter: ReplyWaiterIdentity, ctx: ReplyWaiterContext): boolean {
  const sender = ctx.senderFp ? ctx.senderFp.toLowerCase() : null;
  const routed = waiter.routedFp ? waiter.routedFp.toLowerCase() : null;
  if (routed) {
    if (sender) {
      if (sender !== routed) return false;
    } else if (!ctx.allowUnprovenSender) {
      return false;
    }
  }
  if (ctx.multiPerson) {
    return ctx.linkedPeerReplies === 'deliver' && !!waiter.recipientFp && !!sender && waiter.recipientFp === sender;
  }
  return true;
}
