<!-- bump: patch -->

## What Changed

An app conversation, and its session, can move to another machine the way a Telegram topic does: `POST /pool/transfer` with `app:<key>`, and the phone's Face ID Move. Part 3b of Justin's 2026-11-06 ask (topic 134088).

**On for development agents only** (`multiMachine.sessionPool.appConversations.enabled`, resolved through the development-agent gate). With it off, this machine doesn't advertise `appConversationsPool`, and the lease holder serves every app conversation exactly as before. It stays off for the fleet until a real two-machine move has run, because a duplicate is still possible when an attempt reached another machine before its delivery event replicates.

- **One owner per conversation.** Each moved conversation has a fenced `SessionOwnershipRegistry` record keyed `app:<key>`. A conversation that never moved has no record, and the lease holder serves it exactly as before. `AppConversationService.isOwner()` is gone: `serves(key)`, `mayReply(key)` and `currentOwner(key)` replace it.
- **Only two things move one.** A completed drain, or the operator's "Bring it back here" (`POST /pool/bring-back`, Face ID on the phone). No pins, no router placement, no overload shed, no automatic takeover.
- **Messages reach the owner.** The phone still talks to the lease holder. The holder stores the message, then delivers it, holds it (mid-move, or for the lease gate) or forwards the signed event to the owner. Forwards are acknowledged only after durable ingest. A held message that runs out at the queue's limits is finished as refused, in words.
- **Stop and pause go to the current owner,** including one draining the conversation, and abort that drain. "Intercepted" is said only on the owner's acknowledgement.
- **The lease gate.** A new lease holder serves no-record conversations only after a `session-status` round, bounded at 30 seconds.
- **Losing a conversation closes its session.** A machine that learns it no longer serves a conversation closes its copy, retried on every reconcile.
- **Older machines stay out.** Moves need `seamlessnessFlags.appConversationsPool` on every online machine. An older machine coming online brings moved conversations home; an older lease holder makes owners release theirs.
- **Support people.** Their conversation moves only to a machine advertising `memoryPrivacyEnforced`.
- **Journal.** App placement rows carry `data.sessionKey` and no numeric topic; older readers skip them. `OwnershipReconciler`, `StaleOwnerReleaseEngine`, `DuplicateSessionReconciler` and the overload shed skip `app:` keys.
- **Inbound queue.** Its drain now delivers by kind, so a queued Slack message is delivered rather than failing as a non-numeric key.

Rollback: revert. Before a deliberate downgrade, move every app conversation back to the lease holder, which releases its record. Leftover `app:` records and pins are inert for serving, but an older machine's overload shed, stranded notice, reconciler or stale-owner engine may still read them.

## What to Tell Your User

Moving a conversation from the Instar app to another of your machines is being built and proven on development agents first. Nothing changes for your agent yet: your app conversations keep working as they do now, and the app's menu says moving isn't turned on.

## Summary of New Capabilities

- `POST /pool/transfer` accepts an app conversation (`app:<key>`)
- `POST /pool/bring-back` for a moved conversation whose machine isn't answering
- The phone's Move for app conversations, and "Bring it back here" (`POST /mobile/sessions/bring-back/app:<key>`)

## Evidence

Unit, integration and two-machine end-to-end tests. The end-to-end test runs the real router, deliver handler, drain runner, conversation service and move flow on two machines over the real signed journal replication: an unmoved conversation moves, a message through the holder is answered on the target, the reply is visible from the first machine, a stop aborts a drain in progress, moving back releases the record, and a takeover outranks whatever the far side still writes. Reverting the journal receive validator fails 6 of its 9 tests.
