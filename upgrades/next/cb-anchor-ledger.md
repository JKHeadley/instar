<!-- bump: patch -->
## What Changed

The context budget gains A and G, the Anchor and the decisions/evolutions ledger (context-budget-layered-summaries §6.1, §6.2; Phase 1 S6). While `contextBudget.enabled` is on:

- **The Anchor.** Each topic's Anchor is the operator's first substantive message (an opening "hey" is skipped), plus any further framing messages sent before the agent's first reply (at most three). Only the operator's own typed rows count, as U labels them; forwarded, relayed and other people's rows never anchor a topic. A topic with no such message reads `no-anchor`. The record holds pointers to the rows (message id, hash, length), never the words.
- **The ledger.** Decisions and changes of purpose ("evolutions") are recorded per entry, with `supersedes` links, and replicate per entry. They come from the topic-intent evidence model rather than a new authority:
  - **A decision** settles only when the operator's own message is bound to it and that message's referent stub says it answers or directs (`derived-settled`). It becomes `settled` when the operator re-affirms or re-references it later. Anything else is `pending`: an agent proposal, another person's message, a question, a hypothetical, a rejection, or no stub.
  - **An evolution** is a new goal stated after the Anchor. It is `user-directed` (bound to the operator's message) or `insight-derived` (the agent's), and it is `additive` or `narrowing` according to the extractor's own contradiction read, which is recorded with its evidence. It starts `tentative`. It is confirmed only by the operator: a re-reference or affirmation for their own change, and an explicit yes, after it was surfaced, for the agent's narrowing insight. Silence never confirms it. If the confirmation lapses, the operator's own change stays in force as `unconfirmed`, and an agent insight becomes `expired`. Nothing is deleted.
- **Confirmation queue, extended.** Evolution confirmations take priority over ordinary ones; a displaced confirmation is requeued, not dropped. A full queue now defers instead of dropping, with a counter. An evolution's 7-day clock starts only when the next agent reply surfaces it, and needs a user message since. The topic-intent briefing shows a pending evolution as "PURPOSE CHANGE TO CONFIRM". Queue changes now take the topic file's lock.
- **Live set.** Superseded, withdrawn and expired entries archive first. A settled or confirmed entry in the current phase, or re-referenced in the last 20 operator turns, never archives. Then newest first within about 3K tokens.

New route: `GET /topic/:id/anchor` (bearer only) returns the Anchor's row pointers, every entry's type, cause, effect, status and links, the live-set summary and the confirmation queue's shape, never message text; 503 while the layers are off. `GET /context-budget/metrics` now reports real Anchor and ledger counts in place of "anchor-ledger-not-built", and `GET /context-budget/layers` shows the builder's counters.

## What to Tell Your User

Nothing changes for you yet. On development agents I now note what each conversation was started for, using your own first real message, and keep a record of your decisions and of any change of direction. I only treat something as decided when your own message answered or directed it. If you change the purpose, I mention it once and treat it as unconfirmed until you say so, never by silence. I keep pointers to your messages, never copies.

## Summary of New Capabilities

- The Anchor per topic, from the operator's framing message rows.
- The decisions/evolutions ledger with the decision transition, supersession and live-set selection.
- Evolution confirmations in the existing confirmation queue: priority with requeue, deferral and a surfacing clock.
- `GET /topic/:id/anchor`, and Anchor and ledger counts in the context-budget metrics.

## Evidence

- Unit: `tests/unit/context-layer-anchor-ledger.test.ts`, `tests/unit/TopicIntent-pendingConfirm-evolution.test.ts`, `tests/unit/TopicIntent-pendingConfirm.test.ts`, `tests/unit/context-budget-metrics.test.ts`, `tests/unit/migrate-context-budget-anchor-row.test.ts`.
- Integration: `tests/integration/context-layer-anchor-ledger.test.ts` (real TopicMemory, the real capture loop and the production extract function, the real routes behind the bearer middleware).
- E2E: `tests/e2e/context-layer-anchor-ledger-alive.test.ts`.
