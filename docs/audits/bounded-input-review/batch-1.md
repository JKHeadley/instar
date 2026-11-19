# Bounded-input derivation review — batch 1

One row per baselined site, in the batch that cleared it. "Converted" means the
site now bounds through `src/core/boundedInput.ts` (or, where the code cannot
import it, discloses in the same wording) with its number derived beside it.
"Exempt" means a `bounded-input-reviewed: <why>` reason on the line. Each row
records the reading, not just the outcome.

## src/core (10 sites; baseline 43 → 33)

| Site | Reading | Outcome |
|---|---|---|
| `AutoDispatcher.ts:preview` | Preview of a dispatch in a Telegram approval message. The reader is the operator, not a model; "…" reads correctly to a person. The second pass found the message never offered the full text, so the footer now does (the agent reads it from `GET /dispatches`). | exempt |
| `DecisionQualityRecorderImpl.ts:evidenceNote` | A stored record clamped to its declared ≤500 budget, never served to a model; the only template use is a byte count in a log. Storage side. | exempt |
| `GeminiCliIntelligenceProvider.ts:message` | **Real defect.** The retry / switch-model / defer decision read the 600-char HEAD of stderr, so a 429 or retry-after line printed after a long preamble went unseen and the call failed instead of retrying. The transport adapter's twin already read the full stderr. Now the decision reads the full stderr; the thrown message keeps its 600 chars of content plus a disclosure (`GEMINI_STDERR_MESSAGE_CHARS`). The catch-path message got the same bound. | converted |
| `JobReflector.ts:cmd` | Recorded commands are evidence for the reflection; a bare 100-char cut gave the model a fragment that read as the whole command. `JOB_STEP_COMMAND_CHARS` keeps the same 100-char head plus disclosure room, so commands up to ~335 chars now appear whole. Advisory judgment, so disclose rather than refuse. | converted |
| `MessagingToneGate.ts:quote` | **Load-bearing.** B17 judges whether the operator's grant covers the asked action. The quote was cut to 280 at its source (`standing-authorization.ts`) and again here, which could drop the very grant phrase that matched. Now bounded once at the source with `STANDING_GRANT_QUOTE_CHARS` (Telegram's 4096 limit plus disclosure room, so every Telegram grant passes whole). Refusal not needed: B17's own UNDER-FIRE rule treats an uncertain grant as no grant, so a disclosed partial grant fails toward sending the ask. | converted |
| `MessagingToneGate.ts:truncated` | Recent-conversation context, last 6 messages, each 500 chars with a bare "…". Corroborating-only for the B15 carve-outs, so a cut can only make the gate stricter. Same 500 chars of content now with an in-band disclosure (`TONE_CONTEXT_MESSAGE_CHARS`). | converted |
| `PostUpdateMigrator.ts:message` | **Wrong direction.** The action-claim Stop hook sent the first 16KB of a reply to the promise classifiers, but promises usually close a reply, so a long reply lost exactly the part that mattered. The stated reason (the body-parser limit) was not the real limit: that route accepts 12MB. Now the first 16,384 characters stay byte-identical (the route's dedup with the completion-claim path fingerprints exactly that prefix) and a disclosure + the last 8,000 follow. The hook is emitted JS and cannot import the helper, hence the reviewed note. Lane B and the stored record still read the route's own 500-char head (`routes.ts`, reviewed in the routes batch). | converted (reviewed note) |
| `PostUpdateMigrator.ts:next` | A string splice (head to anchor + inserted line + rest); nothing is dropped. Matches the detector by shape only. | exempt |
| `PreCompactionFlush.ts:body` (2 declarations) | (1) Model OUTPUT held to the "max 500 chars" contract its own prompt sets, before storage. (2) A 120-char frontmatter description; the full fact is written in the same file. Both storage side. | exempt |
| `PreCompactionFlush.ts:newLines` | A MEMORY.md index pointer line; the linked file holds the full fact. | exempt |
