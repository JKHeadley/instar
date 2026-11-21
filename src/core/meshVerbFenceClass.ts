/**
 * Every mesh verb, classified for the minimum-build fence (identity-security piece 2d §2b).
 *
 * The record is typed against the full `MeshCommand` union, so the compiler refuses a new verb with no row, and
 * a ratchet test checks the table. While the fence is in force and a peer is below it:
 *  - to it: no `work` or `authority` verb is sent (work sent to it gives it occasions to act on old rules);
 *  - from it: `authority` verbs are refused; its `work` is accepted (work it routes to updated machines gives it
 *    nothing, and refusing it would make updated owners look dead to its old router);
 *  - `liveness` and `read` flow both ways;
 *  - `conversation` (a message for a topic the machine already owns) is still sent to it, so failover never
 *    doubles replies; new placement and moves are `work` and are not.
 *
 * Spec: docs/specs/identity-security-piece2d-fence-lease-routing.md
 */
import type { MeshCommand } from './MeshRpc.js';

export type MeshVerbFenceClass = 'liveness' | 'read' | 'conversation' | 'work' | 'authority';

export const MESH_VERB_FENCE_CLASS: Readonly<Record<MeshCommand['type'], { cls: MeshVerbFenceClass; why: string }>> = Object.freeze({
  // ── ownership and placement ──
  place: { cls: 'work', why: 'places a session on the target' },
  claim: { cls: 'authority', why: 'pulls a topic to the claimant' },
  release: { cls: 'liveness', why: 'gives ownership up; never grants anything' },
  transfer: { cls: 'work', why: 'moves a session to the target' },
  drain: { cls: 'work', why: 'orders an owner to hand a session over; never sent to a below machine' },
  'inbound-delivery-transfer': { cls: 'work', why: 'hands message-ledger custody to the target' },
  deliverMessage: { cls: 'conversation', why: "a message for a topic the recipient already owns; refusing it would read as an unreachable owner and trigger failover's double replies" },
  'ownership-nudge': { cls: 'work', why: 'asks an owner to act on its topics' },
  'interrupted-move-resume': { cls: 'work', why: 'resumes an interrupted move on the target' },
  'handback-offer': { cls: 'work', why: 'offers the lease away: never sent to a below machine; from a below holder it only gives the lease up' },
  // ── agent-to-agent ──
  'a2a-inbox-deliver': { cls: 'work', why: 'a peer agent message for the recipient to act on' },
  'a2a-relay-forward': { cls: 'work', why: 'a relayed agent message to act on' },
  'a2a-relay-forward-ack': { cls: 'read', why: 'an acknowledgement; carries no request' },
  'a2a-topic-reply-inject': { cls: 'conversation', why: "a reply into the recipient's own live session" },
  // ── credentials and acting for a machine ──
  'secret-share': { cls: 'authority', why: 'sends secrets' },
  'agent-identity-request': { cls: 'authority', why: 'sends the agent identity key' },
  'account-follow-me-mandate-deliver': { cls: 'authority', why: 'sends an account-use mandate' },
  'slice-renew': { cls: 'authority', why: 'issues a spend slice' },
  'ssh-bootstrap-advert': { cls: 'authority', why: 'asks to have its SSH key trusted' },
  'ssh-proof-publish': { cls: 'authority', why: 'publishes SSH trust proof' },
  'recovery-enrollment-advert': { cls: 'authority', why: 'enrols recovery material' },
  'email-send-forward': { cls: 'authority', why: 'sends email as the agent' },
  'org-forward': { cls: 'authority', why: 'acts on the organisation for a machine' },
  'org-apply': { cls: 'authority', why: 'applies organisation membership' },
  'cos-action': { cls: 'authority', why: 'a Chief of Staff action' },
  'cos-settle': { cls: 'authority', why: 'settles a Chief of Staff action' },
  'commitment-mutate': { cls: 'authority', why: 'changes a commitment' },
  'notification-preference': { cls: 'authority', why: "changes the owner's notification settings" },
  'telegram-origin': { cls: 'conversation', why: "a standby's replies (submit) go through the holder's bot; from a below machine only for a topic it actively owns; its other actions are reads" },
  // ── reads ──
  'capacity-report': { cls: 'read', why: 'reports load' },
  'session-status': { cls: 'read', why: 'reports session state' },
  'session-live-probe': { cls: 'read', why: 'asks whether a session is alive' },
  'pool-view-fetch': { cls: 'read', why: 'reads the pool view' },
  'pool-stream-ticket': { cls: 'read', why: 'opens a view-only stream; remote input is blocked separately' },
  'org-state-pull': { cls: 'read', why: 'reads organisation state' },
  'agent-identity-observe': { cls: 'read', why: 'reads the public identity' },
  'journal-sync': { cls: 'read', why: 'pulls journal pages' },
  'commitments-sync': { cls: 'read', why: 'pulls commitment pages' },
  'preferences-sync': { cls: 'read', why: 'pulls preference pages' },
  'state-snapshot': { cls: 'read', why: 'reads a state snapshot' },
  'topic-profile-pull': { cls: 'read', why: 'reads topic profiles' },
  'topic-history-pull': { cls: 'read', why: 'reads topic history' },
  'topic-row-pull': { cls: 'read', why: 'reads a topic row' },
  'session-transcript-pull': { cls: 'read', why: 'reads a transcript' },
  'working-set-pull': { cls: 'read', why: 'reads working-set files' },
  'app-media-pull': { cls: 'read', why: 'reads app media blobs' },
  'owner-record-push': { cls: 'read', why: 'gated separately by piece 2c (confirmed peers only)' },
  'owner-record-pull': { cls: 'read', why: 'gated separately by piece 2c (confirmed peers only)' },
  // ── Gemini pay-per-use lane (docs/specs/gemini-payg-metered-lane.md §6) ──
  'metered-gemini-call': { cls: 'authority', why: 'asks the designated machine to spend money on a metered call' },
  'metered-gemini-result': { cls: 'read', why: 'polls a forwarded call with its own result token; grants nothing' },
  'metered-stop-action': { cls: 'liveness', why: 'can only reduce spending; a below machine must still be able to stop money' },
  'designation-echo': { cls: 'read', why: 'echoes a lease-confirmation nonce and the designation seen' },
  'secret-names': { cls: 'read', why: 'vault key names only, never values' },
  'gemini-payg-setup-render': { cls: 'read', why: 'renders a setup plan; the PIN commit on that machine is the authority' },
});

/** §2b: may this verb be sent TO a below machine? */
export function fenceAllowsTo(type: MeshCommand['type']): boolean {
  const c = MESH_VERB_FENCE_CLASS[type]?.cls;
  return c === 'liveness' || c === 'read' || c === 'conversation';
}

/** §2b: may this verb be accepted FROM a below machine? */
export function fenceAllowsFrom(type: MeshCommand['type']): boolean {
  const c = MESH_VERB_FENCE_CLASS[type]?.cls;
  return c !== undefined && c !== 'authority';
}

/**
 * The live fence policy (§2b). Null until the owner record wiring installs one; nothing is refused before the
 * record is enrolled above Basic with a fence in force, so the default refuses nothing.
 */
export interface MeshFencePolicy {
  /** A reason to refuse sending `command` to `machineId`, or null. */
  refuseTo(machineId: string, command: MeshCommand): string | null;
  /** A reason to refuse `command` arriving from `machineId`, or null. */
  refuseFrom(machineId: string, command: MeshCommand): string | null;
}

let policy: MeshFencePolicy | null = null;

export function setMeshFencePolicy(p: MeshFencePolicy | null): void { policy = p; }

export function meshFenceRefusesTo(machineId: string, command: MeshCommand): string | null {
  try { return policy?.refuseTo(machineId, command) ?? null; } catch { return null; /* @silent-fallback-ok: a policy error refuses nothing; the agent-wide hold (§1) still covers privileged effects */ }
}

export function meshFenceRefusesFrom(machineId: string, command: MeshCommand): string | null {
  try { return policy?.refuseFrom(machineId, command) ?? null; } catch { return null; /* @silent-fallback-ok: a policy error refuses nothing; the agent-wide hold (§1) still covers privileged effects */ }
}

/** Piece 2d: is a machine below the fence in force? A tiny predicate other modules (placement, the pool stream,
 *  the journal) can read without importing the owner-record machinery. False until the wiring installs it. */
let belowPredicate: ((machineId: string) => boolean) | null = null;
export function setBelowFencePredicate(fn: ((machineId: string) => boolean) | null): void { belowPredicate = fn; }
export function isBelowFence(machineId: string | null | undefined): boolean {
  if (!machineId || !belowPredicate) return false;
  try { return belowPredicate(machineId); } catch { return false; /* @silent-fallback-ok: a predicate error refuses nothing; the agent-wide hold still covers privileged effects */ }
}
