# Convergence report — census-tracker-ref-kinds

**Spec:** `docs/specs/census-tracker-ref-kinds.md`
**Author:** echo · **Rounds:** 2 · **Completed:** 2026-07-25

---

## Headline

Round 1 returned **SERIOUS ISSUES** and **inverted the design**. The spec as
first written would have been *worse than shipping nothing* — a detail worth
leading with, because the flaw was invisible from inside the reasoning that
produced it.

Round 2 returned **MINOR ISSUES** against the corrected design: three adopted,
two adjudicated and declined with recorded evidence.

## Iteration summary

| round | Standards-Conformance Gate | external cross-model | verdict |
|---|---|---|---|
| 1 | ran (0 flags) | `codex-cli:gpt-5.5` | **SERIOUS ISSUES** (5) |
| 2 | ran (0 flags) | `codex-cli:gpt-5.5` | **MINOR ISSUES** (5) |

*Caveat carried forward from the tone-gate convergence:* the conformance gate's
"0 findings" is measured against the subset of the constitution it currently
evaluates, not all ~80 standards (`ATT-conformance-partial-constitution`). It is
a real signal, not a clean bill of health, and it is not treated as one here.

Internal reviewers ran on the authoring session's model (opus). The clean-door
Anthropic reviewer was not run; the cross-family pass was `codex-cli` only, so
this is a **single-family** external read, disclosed rather than implied.

## Round 1 — the finding that changed the design

The first draft anchored the 49 pending census entries to a **spec document
path** (`spec:llm-decision-quality-meter#5.6`), resolved with a filesystem
existence check. The reasoning: documents ship with the source, so every install
can verify them.

The reviewer asked whether that was actually true.

**It is not.** `docs/` is excluded from the published package — `.npmignore`
line 8, and absent from `package.json` `files[]`. The existence check would
therefore resolve FALSE on every fleet install, converting 49 honest
`unverifiable` entries into **49 fleet-wide false `dead` ones**: a claim that
49 trackers had been deleted when none had. That is strictly worse than the
status quo, and it re-runs the exact false alarm the 2026-07-23 fix removed —
while being labelled as the completion of that fix.

Verified before accepting (`package.json` `files[]` + `.npmignore` read
directly), then the design was rewritten around a **shipped source constant**
(`BACKLOG_TRACKERS` in `src/data/provenanceCoverage.ts`), which is byte-identical
on every install by construction: no filesystem, no packaging assumption, no
sub-document anchor that drifts when a heading is renamed.

The remaining round-1 findings were absorbed by that rewrite:

| # | finding | disposition |
|---|---|---|
| 1 | `spec:<path>#<anchor>` verifies the document, never the anchor | **Moot** — no anchors exist; a registry key is the whole reference, exact-matched. |
| 2 | Path grammar underspecified (directory? extension? traversal?) | **Moot** — no paths. Keys are `^[a-z0-9][a-z0-9-]*$`. |
| 3 | Assumes docs ship everywhere | **Adopted — this is the inversion.** A packaging invariant is now asserted in CI against `package.json` so the rejected design cannot return silently. |
| 4 | Graduation criterion passes while broken (uncertainty reclassified as failure) | **Adopted.** Now three conditions: `pendingRefUnverifiable` empty AND `pendingRefDead` empty AND `pending` unchanged at 49. |
| 5 | Rollback description inaccurate | **Adopted.** The spec now states plainly that a bad ref reports `dead`, not `unverifiable`, *before* a revert — and what bounds it. |

## Round 2 — three adopted, two declined

**Adopted:**

- **Registry existence risks becoming circular** — proving a symbol resolves is
  not proving the obligation is real; a key nobody retires makes `alive` mean
  "still listed". `BacklogTracker` now requires a **`closureCondition`** (what
  must be true for the key to be deleted), CI enforces a minimum, and a second
  test forbids **orphaned keys** (registered but referenced by nothing).
- **Graduation could mask registry bloat** — aggregate counts can look healthy
  while refs drift apart. CI now pins the exact ref **distribution**: all 49 on
  one deliberate key, not a spray of near-misses.
- **Alternatives under-acknowledged** — spec §2.4 now compares GitHub issue ids
  (the honest runner-up; rejected because resolving it needs network + auth a
  fleet install lacks), commit anchors, a separate shipped manifest, and a
  replicated action log.

**Declined, with evidence (spec §2.5):**

- **"A mixed-version fleet breaks this."** Not reachable: the refs
  (`PROVENANCE_COVERAGE`) and the parser (`adjudicatePendingTracker`) compile
  into `dist/` from the *same package version*, so no install can hold new refs
  with an old parser. The only cross-machine path is the pool merge, and
  `censusDebt` is built at a single local callsite and is not pool-merged —
  checked in source, not assumed.
- **"`dead` for a malformed ref is semantically muddy; add `invalid`."**
  Correct as vocabulary, declined on reachability: the ratchet format-validates
  every pending ref *and* resolves every `backlog:` key at CI time, so a
  malformed ref cannot reach a release. An `invalid` verdict would be dead code
  guarding an impossible state, and would widen the two-bucket contract the
  2026-07-23 fix established for no operational gain.

## What the reviewer did not catch, and I did

The route previously skipped tracker adjudication entirely when
`action-queue.json` was absent (`if (liveActs !== null)`). A `backlog:` ref needs
no queue — so left alone, every fleet-stable ref would have been silently
*uncounted* on exactly the installs the new kind exists to serve. The feature
would have reported a clean `[]` for the honest reason on the dev machine and
the dishonest reason everywhere else. `liveActs` is now nullable and the null
case is handled inside the adjudicator, with the Tier-1 and Tier-2 suites
asserting the no-queue install directly.

## Decision-point classification

Both decision points classify as `invariant`, argued in the spec:
`adjudicatePendingTracker`'s verdict (a closed enumerable domain — the failure
being fixed was a *missing branch*, not a judgment call) and the tracker-ref
format ratchet (a closed-world format check at a dev-process chokepoint — the
documented Signal-vs-Authority exemption class).

## Frontloaded decisions

Five, all recorded in §2.1/§2.2: the source-constant anchor; the pure
adjudicator with no injected predicate; nullable `liveActs`; the resolvable-ref
convention already present in the file; and the ratchet accepting exactly two
kinds. No decision is deferred to build time.

## Standing caveat

This spec's own first draft is the argument for running the external pass. Two
consecutive specs in this run have come back SERIOUS ISSUES from the cross-model
reviewer after reading clean internally. A single-family external read is a
floor, not a ceiling.
