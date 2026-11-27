/**
 * SEC-018 companion (docs/specs/owner-approved-action-stdio-transport.md): the ONE
 * server-side atomic operation that performs a gated thread deletion. BOTH MCP
 * transports funnel the gated delete through this: the in-process HTTP handler calls
 * it directly; the separate-process stdio helper calls it over the loopback
 * `POST /threadline/approved-delete` route (so the irreversible mutation and the
 * approval consume both happen in the one server process, at the authority).
 *
 * The gate is SYNCHRONOUS on purpose — it runs in the server process where the
 * in-memory `OwnerApprovedActionStore` lives, so `consume` is a single Node tick
 * (no async interface, no un-awaited-Promise fail-open). The only async hop is the
 * stdio helper's HTTP call, handled by `approvedDeleteViaHttp`, which returns THIS
 * result (or reports outcome-unknown on transport failure — never a local delete).
 *
 * Ordering is consume-THEN-mutate: crash-safe, not crash-atomic. A crash between the
 * two loses the in-memory approval on restart and leaves the thread intact, so the
 * owner simply re-taps (no journal needed). The pending card's title/why are composed
 * HERE from the server's own thread state, never from caller input.
 */
import type { ThreadResumeMap } from './ThreadResumeMap.js';
import type { OwnerApprovalGate } from './ThreadlineMCPServer.js';

export interface ApprovedDeleteInfo {
  threadId: string;
  remoteAgent?: string;
  subject?: string;
  messageCount?: number;
  state?: string;
}

export type ApprovedDeleteResult =
  | { ok: true; deleted: true; info: ApprovedDeleteInfo }
  | { ok: false; reason: 'not-found' }
  | { ok: false; reason: 'owner-approval-required' };

export interface ApprovedDeleteDeps {
  threadResumeMap: Pick<ThreadResumeMap, 'get' | 'remove'>;
  /** The in-process owner-approval gate (store + pending + enabled + machineName).
   *  Absent OR `enabled()===false` ⇒ dark: the delete proceeds with no approval
   *  (byte-identical to today). */
  ownerApproval?: OwnerApprovalGate;
}

/**
 * Authoritatively delete a thread, gated by owner approval when enabled.
 * - Thread missing → `{ ok:false, reason:'not-found' }` (registers nothing: bounds
 *   any pending-registration flood to the agent's real threads).
 * - Gate disabled/absent → delete + `{ ok:true }` (today's behaviour).
 * - Gate enabled, no valid approval → register (dedup) a server-composed pending card
 *   and return `{ ok:false, reason:'owner-approval-required' }`; do NOT delete.
 * - Gate enabled, valid approval → consume it, then (only on success) delete.
 */
export function performApprovedDelete(threadId: string, deps: ApprovedDeleteDeps): ApprovedDeleteResult {
  const threadEntry = deps.threadResumeMap.get(threadId);
  if (!threadEntry) {
    return { ok: false, reason: 'not-found' };
  }

  const gate = deps.ownerApproval;
  if (gate && gate.enabled()) {
    if (!gate.consume({ purpose: 'thread-delete', actionKey: threadId })) {
      const subject = threadEntry.subject || threadEntry.remoteAgent || 'this conversation';
      gate.registerPending({
        purpose: 'thread-delete',
        actionKey: threadId,
        title: `Delete the conversation "${subject}"?`,
        why: 'A session asked to permanently delete this thread. Approve on your phone with Face ID; expires in 5 minutes.',
        machine: gate.machineName(),
      });
      return { ok: false, reason: 'owner-approval-required' };
    }
    gate.clearPending('thread-delete', threadId);
  }

  const info: ApprovedDeleteInfo = {
    threadId,
    remoteAgent: threadEntry.remoteAgent,
    subject: threadEntry.subject,
    messageCount: threadEntry.messageCount,
    state: threadEntry.state,
  };
  deps.threadResumeMap.remove(threadId);
  return { ok: true, deleted: true, info };
}
