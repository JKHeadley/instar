<!-- bump: patch -->
## What Changed

The context budget gains U, the protected user corpus, with its referent stubs (context-budget-layered-summaries §6 row U, §6.2, §6.4, §8; Phase 1 S5). While `contextBudget.enabled` is on:

- **U is built from TopicMemory sender rows, never from transcript roles.** Hook output that arrives as "user" in a session transcript is not the user and never enters U. Every `from_user=1` row and every row that came through another agent is listed as a protected row reference (message id, sha256, length) with its time and a label. The operator's words are never copied into the layer store.
- **Labels and authority.** The operator's own typed rows (not forwarded, no relay or A2A origin, the sender resolved as the operator through memory privacy) are the protected class, `authority: operator`. Forwarded rows, relayed or A2A rows and other people's rows are kept and labelled `forwarded`, `relay` or `third-party`, with `authority: none`.
- **Large pastes.** A row over 4,000 characters is flagged as a pasted artifact and kept whole. The excerpt-and-pointer handling once a paste is superseded arrives with the Phase 2 folds.
- **Referent stubs ride the extractor's existing call.** For an operator message, the same topic-intent extraction call also returns a one-line bracketed stub such as "[answering: should the gate block or warn?]", with a `kind` (`answer | directive | question | hypothetical | rejection | other`) and the agent message it answers. No second model call is made. The stub is checked deterministically after the call: one line, at most 160 characters, bracketed, a known kind, a reference to a message that precedes the user's in TopicMemory, and none of the user's own sentences inside it. A rejected stub is counted and dropped; the message itself is unaffected. A valid stub is stored beside the quote as a derived record and replicates; U itself is rebuilt from rows on each machine and does not replicate.
- **Short answers count.** An operator's bare reply such as "yes" right after an agent question now reaches the same extractor call, so it gets its stub; the shed, rate and budget brakes still apply, and every operator message that got no stub is counted by reason.
- **Bounded listing.** U is listed at most 200 rows per turn from a persisted per-topic watermark (the current message first), re-listed when the operator binding changes, and a stub whose quote is relabelled is withdrawn.
- **Measured.** U's size per topic (tokens and messages, per label) and stub coverage are reported.

New route: `GET /topic/:id/user-corpus` (bearer only) returns sizes, labels, pasted-artifact flags and stub coverage, never the message text; 503 while the layers are off. `GET /context-budget/layers` now also shows U's builder counters. `TopicMemory` gains three read methods: `getUserCorpusRows`, `messagePrecedes` and `getAgentMessagesBefore`.

With the switch off, the topic-intent extractor's prompt, parse and result are byte-identical to before.

## What to Tell Your User

Nothing changes for you yet. On development agents I now keep a protected list of your own messages in each conversation, separate from forwarded or relayed messages and other people's, and note beside each one what it was answering, so "yes, the second one" still makes sense after my earlier messages are summarised away. I keep pointers to your messages, never copies of the words.

## Summary of New Capabilities

- U, the protected user corpus, built from sender rows with labels and authority.
- Referent stubs from the existing extractor call, validated deterministically.
- `GET /topic/:id/user-corpus` for U's size, labels and stub coverage.

## Evidence

- Unit: `tests/unit/context-layer-user-corpus.test.ts`, `tests/unit/referent-stub-contract.test.ts`.
- Integration: `tests/integration/context-layer-user-corpus.test.ts` (real TopicMemory, the real capture loop and production extract function, the real routes behind the bearer middleware).
- E2E: `tests/e2e/context-layer-user-corpus-alive.test.ts`.
