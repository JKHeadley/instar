## What Changed

`UnjustifiedStopGate` — the authority that decides whether an agent may stop
working — is now enrolled in the LLM-Decision Quality Meter.

At ~1343 calls / 7 days it was the **highest-volume unenrolled decision point in
the census** and the second-busiest gate overall, yet nothing recorded what it
decided or on what basis. The meter can only answer "is this judgment any good?"
for points that record; this one didn't, so the question was unanswerable in
principle.

**What the row carries — identity only.** The gate reads untrusted session
content (the stop rationale and up to ten recent conversation turns). None of it
is recorded. The context is an explicit allowlist of derived values:

- `stopReasonSha256` + `stopReasonChars` — distinguishes two rationales without
  reproducing either
- `artifactCount` / `artifactKinds` — the evidence the authority could cite
- `signals` — code-derived booleans (not user text)
- `recentTurnCount` / `recentTurnChars` — conversation shape only

An allowlist rather than a filtered copy, so a future input field cannot appear
in the row by default. Tests plant a fake API key and password in the input and
assert neither reaches the serialized context.

**Declared `measurement-only`, on purpose.** Recording a decision is not grading
it. Grading this point needs a downstream fact — did work resume after an allowed
stop; did the agent genuinely continue after a refused one — and joining those
signals to a decision row is real plumbing. Rather than let `wired` imply more
than exists, the entry declares `gradingPosture: 'measurement-only'` with an
argued reason, so `findWiredWithoutGraders` reports it as an explicit posture
instead of a silent contradiction.

That distinction is the point: the easy version of this change moves a census
number and leaves a reader believing the busiest judgment call is being
evaluated. It isn't yet. Rows accumulate now so the grader has history when it
lands, rather than starting cold.

Volume is valved at `budget:300`/day (an always-on gate must not grow the archive
unbounded); the `decision_quality` row is written for every settlement regardless,
so counts stay complete.

## Evidence

- `tests/unit/unjustified-stop-gate-provenance-enrollment.test.ts` (11): the
  census declares it wired with a volume valve and content class; the
  measurement-only posture carries a real argument; the provenance block names
  the typed constant with the prompt hash; **planted secrets never reach the
  context**; the hash distinguishes different rationales (so it isn't a constant);
  empty input doesn't throw; the verdict is unchanged and `attribution` survives
  alongside the new block.
- Census ratchet: pending baseline shrinks by exactly one; typed-registration
  check independently verifies the source imports `DP_UNJUSTIFIED_STOP_GATE`.
- 72 green across the affected suites.

## What to Tell Your User

Nothing changes in how the agent behaves. This is instrumentation on an internal
judgment — no new messages, no new settings, nothing you interact with.

What it buys: the check that decides whether the agent may stop working is the
busiest judgment call in the system, and until now nothing recorded what it
decided. Now it does. So the question "is that check actually any good — too
strict, too lenient, wrong half the time?" stops being unanswerable and becomes
answerable once enough history accumulates.

Worth being precise about what is NOT true yet: the decisions are recorded, not
graded. Knowing whether a given call was *right* needs a later fact (did work
resume after a stop was allowed?) that isn't connected up yet. The record says so
explicitly rather than implying the check is being evaluated when only half of
that is in place.

None of the conversation is stored — only a fingerprint of the stop reason and
counts describing the decision's shape.

## Summary of New Capabilities

- The stop-justification authority now records every decision it makes, so its
  quality can be evaluated rather than assumed.
- Recording is identity-only by construction: an explicit allowlist of derived
  values, tested against planted secrets, so session content cannot leak into the
  provenance store.
- The census now distinguishes "recorded and gradeable" from "recorded but not
  yet gradeable", so the coverage number reflects what actually exists.
