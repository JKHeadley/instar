# Bounded-input derivation review — batch 4

One row per baselined site. "Converted" means the site now bounds through `src/core/boundedInput.ts` with its number derived beside it. "Refuses" means the decision is not made on a partial input. "Exempt" means a `bounded-input-reviewed: <why>` reason on the line. Each row records the reading (who consumes the value and whether a cut can change their answer), not only the outcome.

## messaging, permissions, scheduler, threadline — 12 baseline entries

| Site | Reading | Outcome |
|---|---|---|
| `threadline/WarrantsReplyGate.ts:messageSlice` | **Load-bearing, so it refuses.** This classifier can only SUPPRESS a reply to another agent, so a verdict drawn from the first 2,000 characters could silence a question asked after the cut. A message longer than `WARRANTS_REPLY_CLASSIFY_MAX_CHARS` (2000) is no longer classified. It fails toward responsive, like an absent or failing classifier, under its own signal `too-long-to-classify` (the second pass caught a first version that mislabelled it as a classifier verdict). Ordinary traffic (acks, sign-offs, short asks) still fits. Reply loops stay bounded by the soft cap, which runs first. | refuses |
| `permissions/LlmIntentClassifier.ts:userPrompt` | Slack intent and sensitivity for the permission gate. `reconcile` keeps max(deterministic tier read from the FULL text, model tier), can only narrow directedness, and drops any floorAction, so a cut can cost a refinement but never widens access. (A model tier of 4 falls back to the deterministic read, so the disclosure keeps the model from treating a fragment as complete; it does not itself escalate.) The model's action label from a partial view is still recorded in the permission ledger and observer history. 2000 of content plus disclosure room. | converted |
| `permissions/AmbientContributionGate.ts:userPrompt` | Whether to chime in on overheard chatter. A cut can only make the model less sure there is something to add. 2000 of content plus disclosure room. | converted |
| `threadline/HubIntentClassifier.ts:body` | Context turns that corroborate the hub-intent read of the current message, which is passed whole. The configured per-turn content is kept, the disclosure is added on top, and the turn stays on one line. | converted |
| `threadline/openConversationBrief.ts:text` | The model writes the operator's orientation summary from the last 10 messages. 800 of content each, now disclosed instead of a bare "…". | converted |
| `threadline/openConversationBrief.ts:snippet` | An operator-facing quoted snippet in the topic brief, which also lands in topic history. The cut is marked with "…", and the full conversation is in Threadline history. | exempt |
| `threadline/openConversationBrief.ts:slice` | Caps model OUTPUT (the brief summary) on a word boundary before display. | exempt |
| `messaging/slack/SlackAdapter.ts:truncated` | A shared file's contents in the session message. Already disclosed in-band ("[truncated, full content saved to <path>]"), with a pointer to the whole file the session can read. | exempt |
| `messaging/TelegramAdapter.ts:dSliced` | The attention-hub post body. **Not display-only** (second pass): the post lands in the topic history a later session reads. The caps (500 / 1000) are display choices, not the Telegram limit. The cut is now marked in-band with a pointer to the full attention item ("… [description cut at N of M characters; the full text is in the attention item]"), wording both a person and a model read as partial. | exempt (cut marked) |
| `messaging/TelegramAdapter.ts:title` | A fixed flood-notice label held to Telegram's 128-character topic-name limit. | exempt |
| `messaging/SpawnRequestManager.ts:selected` | Caps an ARRAY of agents drained per tick (scheduling), not text. | exempt |
| `scheduler/MentorStageBForensics.ts:title` | Parses model OUTPUT (an issue title) into a stored record. | exempt |

## Found outside the baseline

| Site | Reading | Outcome |
|---|---|---|
| `scheduler/MentorStageBForensics.ts` (prompt `signals.slice(0, 12000)` and its provenance twin) | Found by the batch-4 second pass. The lint cannot see an unnamed slice inside an array literal that is joined into a prompt. The forensics model read a silent 12,000-character head of its signals: a server-log section followed by session digests. The head is kept (the log section is the strongest evidence), the 12,000 of content is unchanged, and the cut is now disclosed. Provenance hashes the same bounded text. The detector gap is filed as feedback fb-5f1a0347-64b. | converted |
