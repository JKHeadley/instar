<!-- bump: patch -->
## What Changed

The context budget gains the Anchor and ledger backfill (context-budget-layered-summaries §6.1, decision 9, §12; Phase 1 S7), behind a new switch, `contextBudget.backfill.enabled` (default off, read live), on top of `contextBudget.enabled`:

- **A background lane** rebuilds existing conversations' Anchor and decisions/evolutions ledger from TopicMemory history, on the machine that owns the conversation only (a single machine owns all of them; in a pool the ownership record must name this machine, and an unknown owner is skipped). It takes conversations newest first, starts at most 20 a day, works a few per 10-minute tick in bounded pages, and keeps a small resume file so a restart neither redoes nor skips a conversation. It makes no model call: it reads the refs and referent stubs the extractor already wrote.
- **History entries are `backfilled-unconfirmed`**: usable, labelled, with their normal derivation kept beside them. Only entries bound to the operator's own message are rebuilt; agent proposals and other people's messages from history are left out. A later re-reference, affirmation or confirmation from the operator gives an entry its normal status; a withdrawal still applies.
- **One confirmation per conversation**, a new `backfill` kind in the existing confirmation queue (ranked below a live purpose change, above ordinary confirmations). The topic-intent briefing shows it only after the user has written since it was queued, as one line to fold into the reply, never as a message of its own; it is asked exactly once, in that reply, and then leaves the queue; it settles early when nothing is left unconfirmed, and the entries stay labelled until the operator's own words move them. This also closes S6's gap: old purpose changes on an existing conversation are now covered by it instead of asking nothing.
- `GET /topic/:id/anchor` gains a `backfill` block; `GET /context-budget/metrics` gains `anchors.backfill` (conversations rebuilt, entries still unconfirmed, `pendingConfirmations` for the dashboard card and Home's count, and the lane's status); `GET /context-budget/layers` gains the lane's status. A Registry-First row points agents at it.

## What to Tell Your User

Nothing changes for you unless the rebuild is switched on. When it is, I go back over older conversations in the background, a few a day, and note what each was for and which of your decisions I can find in your own messages. I treat those as unconfirmed. The next time you write in one of them, I add one line to my reply asking you to correct anything wrong; I never send it as a separate message.

## Summary of New Capabilities

- The backfill lane: owner only, newest first, 20 conversations a day, resumable, background.
- `backfilled-unconfirmed` ledger entries from history, operator-bound only.
- A `backfill` confirmation kind, asked only inside a reply after user activity.
- Pending backfill confirmations on the anchor route and in the context-budget metrics.

## Evidence

- Unit: `tests/unit/context-layer-backfill.test.ts`, `tests/unit/migrate-context-budget-backfill-row.test.ts`.
- Integration: `tests/integration/context-layer-backfill.test.ts`.
- E2E: `tests/e2e/context-layer-backfill-alive.test.ts`.
