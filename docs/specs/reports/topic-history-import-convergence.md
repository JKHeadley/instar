# Convergence Report — Topic history import

## Cross-model review: codex-cli:gpt-6.2-astra

A real GPT-tier external pass ran through the agent's codex CLI in all six rounds. Gemini was not authed (`gemini-not-authed`). The Anthropic clean-door reviewer was not run; the internal reviewers were Claude subagents on the authoring session's model (Opus 5.5), one combined multi-lens reviewer per round.

## ELI10 Overview

When the Mac Studio was rebuilt, it lost about 14,000 old Telegram messages. Copies of them survived on the other machines. There was no safe way to put them back. Pasting them onto the end of the message log would make old messages look brand new, and parts of the agent that watch the end of the log would act on them again. This change adds a proper "import history" action. It checks each message, skips ones the agent already has, keeps the recovered messages in their own files instead of the live log, and slots each one into its conversation at the right time. Search then finds them, and the newest real messages stay at the bottom. Recovered messages are labelled so they never count as a fresh instruction from the owner. The restore survives restarts and the existing rebuild.

## Original vs Converged

The first draft had a single side log, keyed app messages into Telegram topics, and promised a safe import without saying how. Six rounds changed it:

- Batches are immutable files published atomically. Each name carries its row count, so damage is detected.
- App messages are refused, because the app store holds them (verified 84/84). Keying them in would have frozen the summary cursor.
- Restored rows carry a new `imported` row-origin label. The user corpus gives them no authority and keeps the agent's own recovered replies out.
- The merge is set-based and deterministic, so two imports equal one replay after a rebuild.
- Imports and rebuilds share one lock.
- A live copy of a restored message supersedes it.
- The peer carrier never carries restored rows.
- A rebuild still refuses to wipe live rows when its log is missing, and also refuses on a damaged batch.
- Cumulative row and byte bounds were added.
- Re-apply goes per topic, with failures isolated.
- A failed merge is healed by a retry.
- Writes are fsynced: the batch, its directory and the audit.

## Iteration Summary

| Round | External (codex) | Internal | Design findings | Notes |
|---|---|---|---|---|
| 0 | — | Standards-Conformance Gate: ran (8 flags) | 8 signals | parent principle fixed, crash ordering, memory bounds, multi-machine posture, gap filed as fb-33f27f6a-03c |
| 1 | ran, 4 design | ran, 6 design / 5 precision | 10 | user-corpus authority, app rows vs summary cursor, tie-break determinism, half-written batch, concurrent imports, live precedence, event-loop yields |
| 2 | ran, 4 design | ran, 4 design / 4 precision | 8 | short write, retry after failed merge, supersede, cumulative bound; agent rows in corpus, rebuild/import lock, carrier, per-topic failure |
| 3 | ran, 4 design | ran, 1 design (rebutted: TopicIntentCapture re-lists) / 3 precision | 4 | byte budget, presence check inside guard, readdir errors; one accepted residual |
| 4 | ran, 4 design | ran, 1 design / 0 precision | 3 | rebuild guard regression fixed (batch never licenses a wipe), damaged-batch refusal, serialized-byte budget; two residuals accepted |
| 5 | ran, 3 design | ran, 0 design / 2 precision | 2 | line-boundary truncation (row count in name), summary-claim correction; one repeat residual |
| 6 | ran, 3 design / 1 precision | ran, 0 design / 2 precision | 0 open | published-name-only read, distinct-row count, audit fsync fixed; skew-window ordering accepted |

The externals ran every round, because the body changed every round. The Standards-Conformance Gate ran once, before round 1. Rounds 1-6 used the internal and codex reviewers.

## Proportion

Tier 2, with 1 new module, about 10 touched files and roughly 900 lines including tests. Six rounds hit the Tier-2 cap of 6, which is in line with a change that writes durable, user-visible history and edits an authority-labelling path. Most later-round findings were long-tail storage-corruption cases, each fixed cheaply.

## Left behind

These are the spec's `## Left behind` entries, each an accepted residual with its reasoning:

- a forged future id from a bearer holder;
- the TOCTOU on the file read;
- a carried row superseding a restored copy without a corpus re-list;
- a peer sending a row labelled `imported`;
- a peer-carried-only row lost on rebuild (pre-existing behaviour, fb-33f27f6a-03c);
- the ordering after a partial live supersede;
- the 5-minute skew window;
- a damaged batch making rebuilds refuse until it is repaired (fails closed);
- summaries skipping restored rows older than their cursor (low token burn);
- the measured 4.5 s event-loop hold for the largest topic.

## Experience fit

The person's stated outcome: recovered history becomes searchable, and the newest real messages stay last. The rehearsal on a copy of the Studio's real store and file showed both:

- every watched topic's newest message was unchanged;
- 13,860 rows went into 161 topics;
- a second run accepted 0.

There is no approval surface or repeated ask. The agent runs it once, after the next planned restart, as the operator directed.

## Full Findings Catalog

Recorded per round in the table above. The detailed reviewer outputs were folded into the spec sections named there (Row admission, Dedupe and precedence, Concurrency, Timestamp-ordered merge, Durability across a rebuild, Route, Left behind).

## Post-convergence amendment (second-pass review)

The instar-dev Phase 5 second-pass reviewer found that superseding inside `TopicRowWriter.writeRow` let an inbound peer-carried row strip the `imported` label. That widened authority and broke the existing "a label only narrows" rule. Fix: the supersede moved to `writeTelegramLogRow`, which only the local Telegram dual-write in `server.ts` uses. Plain `writeRow` is unchanged and never relabels. A test pins both paths. The spec's "Dedupe and precedence" section and the Left behind list were updated to match.

## Convergence verdict

Converged at round 6, the Tier-2 cap. The final internal round found nothing that changes what gets built. The final external round's three design items were fixed and tested; its remaining item is recorded in Left behind as an accepted risk, and none of the residuals is a safety or data-loss defect. Spec is ready to approve and build.
