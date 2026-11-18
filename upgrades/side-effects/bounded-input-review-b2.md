# Side-Effects Review — bounded-input derivation review, batch 2

**Version / slug:** `bounded-input-review-b2`
**Date:** `2026-11-18`
**Author:** `Echo (M5)`
**Second-pass reviewer:** `independent reviewer subagent (concur, round 2)`

## Summary of the change

This is batch 2 of 4 for `STD-SUBCOUNTDOWN-bounded-input-derivation-review`. It covers 11 baseline entries: `commands/server.ts` ×5, `server/routes.ts` (`histText`), plus `ResumeValidator`, `SeamlessOrchestratorEngine`, `TemporalCoherenceChecker` ×2 and `TopicSummarizer`. On this branch the baseline goes from 43 to 32. Batch 1 (PR in flight) removes a disjoint 10, so the two compose to 22. `src/core/boundedInput.ts` gains `boundedEnds` (keep the start and the end, disclose the middle) and `BOUNDED_ENDS_MIN_CHARS`; the single-ended floor stays 235, pinned by a test. Tier 1. The per-site readings are in `docs/audits/bounded-input-review/batch-2.md`.

Behaviour changes:
- **Session history, every renderer** (`TopicMemory.formatContextForSession`, its JSONL fallback in `server.ts`, and two `routes.ts` handlers): the per-message bound is now `SESSION_HISTORY_MESSAGE_CHARS` = 4096 + disclosure room, up from a silent 2000.
  - Every Telegram message now reaches a fresh session whole. Longer messages say they were cut.
  - The two `TopicMemory` cuts were not in the baseline: the file builds no prompt itself, so the lint never saw them. They are fixed with their twin.
- **Promise revival fields** (2000), **helper-death snippet** (160), **summarizer messages** (1000) and **preload-ranker focus** (200): each keeps its content size and now discloses a cut in-band.
  - The helper snippet keeps its TAIL, where a dying helper's error usually is.
  - Preload-ranker paths keep their END, so the file name survives.
- **Temporal state documents** (configured, default 4000) keep BOTH ends via `boundedEnds`, because the newest understanding is usually last (`reflections.md` is most likely an append-only log; AGENT.md ends with its Identity History). The bound is floored at that helper's minimum, so a small configured value cannot throw.
- **Block-level disclosure** in two prompts, where per-item markers would overflow a derived budget:
  - ResumeValidator's topic header now says each message is shown up to 200 characters, and a cut message ends in ` …[cut]`.
  - The temporal timeline header now says summaries are cut to 120 and end in "...".
- **Exempt:** two key parses in `server.ts`, and one model-output clamp.

## Decision-point inventory

- Resume coherence validator: modify input. A header line is added, and a cut message gets a 7-character tag; content is unchanged.
- Temporal coherence checker (advisory, can say BLOCK): modify input. A cut state document now keeps both ends with the middle disclosed, and the timeline header says entries are cut.
- Preload residual ranker (advisory, with a deterministic fallback): modify input. Paths keep their end, and cuts are disclosed.
- Topic summarizer: modify input. A cut is disclosed.
- Fresh-session bootstrap and revived-promise session: modify input. Longer messages are kept whole, and cuts are disclosed.
- Helper-death alert: modify input. A cut is disclosed.

No decision logic changes, and no check gains or loses authority.

---

## 1. Over-block

None. The temporal checker can now see that its state is partial. Its prompt asks for BLOCK only on explicit contradiction, and a disclosed gap is a reason not to claim one.

## 2. Under-block

- A message longer than 4096 characters still loses its tail in session history. The cut is now disclosed.
- The summarizer still keeps only the first 1000 characters of a long message, now disclosed. Raising that number would multiply across up to 200 messages per prompt.
- ResumeValidator's `extractContent` (300) and the JSONL sampling are not in the baseline and are untouched.

## 3. Level-of-abstraction fit

The history bound is one exported constant shared by the primary path and its fallback, so the two cannot drift. Block-level disclosures sit in the prompt header that introduces the block.

## 4. Signal vs authority compliance

Compliant (`docs/signal-vs-authority.md`). Only inputs change.

## 4b. Judgment-point check

No new static heuristic at a competing-signals decision point.

## 5. Interactions

- **Bootstrap size:** the worst case grows from 50 × 2000 to 50 × ~4.3k characters, and only when every recent message is maximal. The bootstrap already writes the full context inline by design ("no truncation").
- **Context-budget standing packet:** when present, it replaces the summary, not the recent-message lines. Unaffected.
- **Revived-promise prompt:** `cap()` swaps backticks before bounding, so the marker (which has none) cannot break the fenced block.
- **Preload ranker:** the line format is preserved (`oneLine` folds the marker's newline). `parseResidual` reads only the JSON index array.
- **`server.ts` now imports `TopicMemory.js`:** `TopicMemory` imports nothing from `commands/`, so there is no cycle.
- **Stage-B certified set:** none of the changed files (`TopicMemory.ts` included) is in the certified closure; `stage-b-certified-fingerprint --check` is OK on this branch.
- **Compaction resume and heal re-seed** also render `formatContextForSession(topicId, 20)` and write it to a file the session must Read. The worst case grows from ~40k to ~86k characters plus the summary, and only if all 20 recent messages are maximal. That is near one Read call's token ceiling, so a recovering session may page the read (the Read tool takes offset/limit); nothing is lost.
- **`routes.ts` now imports `TopicMemory.js`** for the shared constant. `TopicMemory` imports nothing from `server/`, so there is no cycle.
- **`boundedInput.ts`:** `boundedEnds` is additive. The middle wording is no longer than the existing two, so `BOUNDED_INPUT_MIN_CHARS`, and every bound derived from it, is unchanged.

## 6. External surfaces

There are no new routes, config keys or operator-visible strings. Model prompts change as described. Sessions see longer history lines.

## 6b. Operator-surface quality

No operator surface is touched.

## 7. Multi-machine posture

Machine-local by design. These are pure in-process transforms on the machine that builds the prompt.

## 8. Rollback cost

Revert the PR. Nothing is stored or migrated.

## Conclusion

Eleven baseline entries cleared: seven converted and four exempted. Two exempted sites gained a block-level disclosure in their prompt headers. Three real defects were found:
- Session history half-cut a Telegram-length operator message, on every renderer, including two cuts the lint could not see.
- The preload ranker dropped file names from long paths.
- The temporal checker read only the start of state documents whose newest content is at the end.

The second pass changed the design once (temporal direction → `boundedEnds`; helper snippet → tail) and corrected three statements in this artifact.

---

## Second-pass review (if required)

**Reviewer:** independent reviewer subagent (Claude Opus 5.5, fresh context, read-only), two rounds
**Independent read of the artifact: concur**

Round 1 raised CONCERN: (1) the temporal checker kept the HEAD of state documents whose newest content is at the end (`reflections.md` is most likely an append-only log; AGENT.md ends with Identity History), so a head cut dropped the newest understanding, and the batch test pinned that wrong outcome; (2) the compaction resume / heal re-seed path (20 messages) was missing from §5; (3) the helper-death snippet kept the head while the error is usually at the end; (4) the wireup test replica still used the old slice; (5) three artifact statements were wrong (Stage-B closure, promise field content size, pending reviewer); (6) ResumeValidator could not distinguish an exactly-200 message from a cut one; (7) constants between imports and a duplicate import. All fixed: `boundedEnds` added and used for state documents, the snippet keeps its tail, promise fields keep 2000 of content, cut messages carry a short tag, §5 and the summary corrected. Round 2: CONCUR. Its one remaining nit (a constant between import statements in `server.ts`) is fixed in this commit.

---

## Evidence pointers

- `tests/unit/bounded-input-review-batch2.test.ts`: path tail kept and disclosed; temporal document keeps both ends and discloses the middle; floor honoured without a throw.
- `tests/unit/bounded-judgment-input.test.ts`: `boundedEnds` keeps both ends, exact omitted count, floor refusal, astral text at the floor, single-ended floor unchanged.
- `tests/unit/ResumeValidator.test.ts`: an exactly-200 message is untagged; a cut one carries ` …[cut]`.
- `tests/unit/HelperWatchdog.wireup.test.ts`: the replica now uses the real bound and direction.
- `tests/unit/topic-memory.test.ts`: a 3,000-character instruction arrives whole; a 9,000-character one is cut and disclosed.
- `tests/unit/topic-summarizer.test.ts`: the cut is disclosed in `buildSummaryPrompt` and through `summarize`.
- Six of these fail when only the changed logic lines are reverted to main's, and pass on this branch.
- `lint-bounded-judgment-input`: clean at 33 on this branch.

---

## Class-Closure Declaration (display-only mirror)

The defects fixed are instances of silently cut judgment input. The standing guard for that class is `scripts/lint-bounded-judgment-input.mjs`, a shrink-only baseline with a ceiling. This batch shrinks its population. The two `TopicMemory` cuts show the guard's known blind spot: it scans only files that build prompts, while a helper that renders prompt text in another file is unseen. That gap is reported in the PR body, not widened silently.
