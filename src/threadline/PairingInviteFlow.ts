/**
 * The invite-pairing protocol engine (docs/specs/a2a-pairing-invite-link.md §4.3–4.4).
 *
 * The implementation lives in `@sagemindai/threadline-core` (spec
 * docs/specs/threadline-standalone-pairing.md D1, rollout step 3), so an Instar agent and a
 * threadline-mcp agent run the same engine. This module re-exports it under its old path.
 * Instar wires it in ThreadlineBootstrap with AgentTrustManager as its `InviteTrust`.
 *
 * Wire messages (`type` is the control op):
 *  pair-invite-accept  B→A  plaintext  { iid, idB, fpB, owner, agent, nonce, tag, sig }
 *  pair-invite-used    A→B  encrypted  { iid, exp, nonce, sig }
 *  pair-invite-finish  A→B  encrypted  { iid, exp, nonce, sig }
 *  pair-invite-ack     B→A  encrypted  { iid, nonce, sig }
 */

export {
  PairingInviteFlow, OP_ACCEPT, OP_USED, OP_FINISH, OP_ACK, INVITE_OPS, FINISH_GRACE_MS,
} from '@sagemindai/threadline-core';
export type { OwnIdentity, InviteEvent, InviteFlowDeps, Result } from '@sagemindai/threadline-core';
