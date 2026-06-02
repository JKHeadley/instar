# Retro-Harvest Procedure (standing how-to)

The repeatable procedure that produces a `apprenticeship-retro-harvest/v1` artifact before
every apprenticeship/mentorship instance. Defined by
`docs/specs/APPRENTICESHIP-STEP0-RETRO-HARVEST-SPEC.md` (Step 0 of the Apprenticeship Program).
Run this whenever a prior instance closes and a new one is about to begin.

> **One rule above all:** when the harvest *finds* a problem, you **record** it (a ledger
> entry + a program-need) — you do **not** stop and fix it here. Capture and carry forward.

## Steps

1. **Scope.** Identify the prior instance (`from` / `to` / `framework` / `instanceType`).
   - The **first** harvest for a pair MUST be `scopeMode: full` (no baseline exists, and the
     prerequisite is to review *ALL* notes).
   - A later harvest may be `scopeMode: incremental` — corpus delta since the prior harvest's
     `harvestedAt`, with prior artifacts as the memo.

2. **Read (bounded).** Walk the corpus, recording true **coverage extent** per source in
   `sourcesCovered` (not bare booleans — counts, and for threads `messagesRead` + `truncated`):
   - `GET /framework-issues?framework=<fw>` (all buckets) — the bug-class lessons.
   - `GET /framework-issues/playbook` — what's already generalized (avoid re-deriving).
   - The agent's memory files for the instance.
   - The instance's Telegram threads — chunk-and-reduce any thread over the token budget.
   - The shipped PRs/specs the instance produced.
   - Run under the LLM budget / circuit-breaker substrate; on exhaustion emit a `truncated:true`
     partial rather than retrying unboundedly.

3. **Extract + classify.** Every learning → a **primary** (and optional **secondary**) kind:
   - **Lesson** — framework-specific (usually a bug). Already in the ledger; reference by
     `ledger:<id>`, don't duplicate.
   - **Meta-lesson** — generalizable across frameworks. *Narrowest bin* — burden of proof is on
     cross-framework recurrence; default to **lesson** unless recurrence is shown.
   - **Process-insight** — about the mentorship/apprenticeship process itself.
   - Each item carries a canonical evidence pointer: `ledger:<id>` · `pr:<n>` ·
     `thread:<id>#<msgId>` · `memory:<slug>@<hash>#<anchor>`. **Pointers, never payloads.**

4. **Scrub.** Run an approved secret/PII scrubber over the body BEFORE write and before any
   seed; record `redaction: { scrubber, findingsRemoved, scrubbedAt }`. A failed/unknown scrub
   blocks the write.

5. **Dedup.** Drop meta-lessons already generalized in the playbook or prior harvests.

6. **Seed (optional, candidate-only).** Only *genuine bug-class generalizable* items go to the
   ledger via `POST /framework-issues/observe` (source-framework tag, closest generalizable
   bucket, terminal status only when truthful). Capture confirmed ids into `seededToPlaybook`
   with `attested:false`. Echo cannot self-promote to `extracted`; the harvest must not depend
   on the seed surfacing (open bug #50). **Process meta-lessons are NOT forced through bug
   buckets** — they live in this artifact.

7. **Emit program-needs.** Translate process-insights + recurring lessons into a prioritized
   `## What the program needs` list — each `need-NNN` with a motivating pointer + priority.
   This is the Step-1 input; Step 1 must cite these need-ids.

8. **Fidelity review (authority).** An LLM reviewer **independent of the harvesting pass**
   spot-checks sampled evidence pointers, confirms the `sourcesCovered` watermarks were accurate
   at `harvestedAt`, and stamps `fidelityReview: { reviewer, verdict, at, audit }`. `rejected`
   blocks; `partial` must name the gaps.

9. **Validate (signal) + index.** Run `node scripts/validate-retro-harvest.mjs <artifact>`
   (add `--check-live` to cross-check seeded ids against the running ledger). Update
   `docs/apprenticeship/retro-harvests/INDEX.json` with the latest harvest for the pair. The
   harvest isn't done until the validator passes AND the fidelity verdict is `faithful`
   (or `partial` with gaps named + accepted).
