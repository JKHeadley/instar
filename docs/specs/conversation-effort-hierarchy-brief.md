# Conversations: product brief

**State:** implementation and verification in progress; not shipped. The original v3 design, its reviews and Justin's November 5 approval are preserved in the provenance files. His later 09:50 direction governs the implementation: ordinary Conversations must work on owned machines without purchasing any outside service. This brief describes that change without treating the original approval as a new release acceptance.

## What it feels like

The dashboard and app open to a quiet **Conversations** Overview, with at most five efforts or front doors. **All** and search reach workers without making every worker a top-level tile. Opening a conversation shows its original messages first. **More** explains its authorized path, why it is there, and its front door when the server has certified one. Back returns to the actual prior screen, including search and scroll position.

An owner can create an effort, save or change its name, choose a front door, move an item with a preview, and undo an eligible move. Forgetting an effort's name is a separate privacy action: the effort's identity and original messages remain, while name removal and any unverified copies are tracked separately. The screens use the current product components. The dashboard supports its existing light and dark themes; the native app currently uses its existing dark appearance.

Decision, correction and attention cues must not imply verified evidence that the backend does not possess. The later attention increment is separate from the current correction controls; sample screens do not prove a live feature.

## Your own machines are the default

A single-machine installation works without an extra account or remote server. More installed machines use the same signed shared-state protocol. A sleeping machine may delay shared agreement, but must not disable recording a local owner edit.

The wording distinguishes real guarantees:

- **Recorded here:** this machine has durably encrypted the exact request. It may be the only copy and can be lost if this machine is destroyed.
- **Copied to another machine:** the server has actual verified custody evidence for that copy. A different machine identity alone does not establish a different physical disaster domain.
- **Committed:** every installed member has the required durable terminal proofs. Only then does the agreed shared tree change.

Pending changes and proposed placement appear separately from the agreed tree. Request identities survive app quit and uncertain replies. A missing status answer is not permission to invent a new request or silently discard the old one. The owner can check the same change, cancel it when eligible, or deliberately start a different edit after a fresh read.

An optional outside custody service can improve resilience against losing the whole owned fleet. It never gates ordinary use, and none is purchased or provisioned by this feature work. The original witness-backed Pending decision remains in the historical standards memo; it does not reinstate a required paid service.

## Recovery and privacy

An acknowledged surviving copy remains readable when other machines are offline, with sync clearly marked unavailable. That retained view is not permission to allocate new shared operations. Local changes can still be recorded while shared admission is unavailable.

A restored old backup must reconcile reachable current peer authority and erasure evidence before serving historical private names. Local hiding is immediate, while remote purge and unknown historical backups remain separate debt. Full rollback of all local authority state and keys with no reachable current authority has an explicit software-only freshness limit; an old backup cannot honestly certify global freshness or unknown backup erasure.

Permanently removing a lost installed machine requires a distinct, fresh authenticated owner decision naming that machine. It must never happen merely because a write is waiting. The owned-machine loss/replacement adapter remains implementation work at this checkpoint. No removed or stolen device is falsely reported physically erased.

## Telegram and Slack

They remain the original conversation stores and link destinations. Instar cannot rearrange an arbitrary person's Telegram or Slack sidebar, and Telegram's ordinary bot interface cannot backfill an entire topic history. The graph must say what it actually observed.

The current audience-safe chat increment provides a neutral pointer to the authenticated app, including in group or unknown-audience chats. It does not claim to deliver private graph summaries in chat. Routine worker events do not create parent-chat floods. Richer private status answers require their own verified audience and evidence path.

## Delivery boundary

Focused server, cryptographic, recovery and browser checks exist, and the native app has simulator and captured-response tests. These are distinct from a real app making signed requests to the real backend. That integration, the remaining recovery adapter, current-main integration, required release checks and runtime verification must finish before the feature is described as deployed. Sample data, a merged dependency, or a passing component suite alone is not shipment.
